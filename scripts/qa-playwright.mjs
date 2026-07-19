import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { playwrightProjectRuns } from "./qa-playwright-args.mjs";

const host = "127.0.0.1";
const suiteLockDirectory = join(tmpdir(), "genio-playwright-suite.lock");
const localHostnames = new Set(["localhost", "127.0.0.1"]);
const responsiveProjectCooldownMs = 1_500;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

async function acquireSuiteLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(suiteLockDirectory);
      try {
        await writeFile(join(suiteLockDirectory, "owner.json"), JSON.stringify({ pid: process.pid }));
      } catch (error) {
        await rm(suiteLockDirectory, { recursive: true, force: true });
        throw error;
      }
      return;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      let owner = await readFile(join(suiteLockDirectory, "owner.json"), "utf8")
        .then((value) => JSON.parse(value))
        .catch(() => null);
      // mkdir is atomic, but the winning process still needs a moment to write
      // its owner record. Do not mistake that initialization window for a
      // stale lock and allow two suites to build into the same output folder.
      for (let ownerAttempt = 0; !owner && ownerAttempt < 10; ownerAttempt += 1) {
        await delay(100);
        owner = await readFile(join(suiteLockDirectory, "owner.json"), "utf8")
          .then((value) => JSON.parse(value))
          .catch(() => null);
      }
      if (processIsAlive(Number(owner?.pid))) {
        throw new Error(`Another browser QA process is already running (PID ${owner.pid})`);
      }
      await rm(suiteLockDirectory, { recursive: true, force: true });
    }
  }
  throw new Error("Browser QA could not acquire its process lock");
}

function portIsAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(
        new Error(`Browser QA cannot bind ${host}:${port} while probing for a preview port`, {
          cause: error,
        }),
      );
    });
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function availablePort() {
  for (let port = 4173; port <= 4199; port += 1) {
    if (await portIsAvailable(port)) return port;
  }

  // A developer may legitimately have the preferred preview range occupied.
  // Let the OS select an ephemeral port instead of making browser QA fail for
  // reasons unrelated to the application under test.
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      reject(new Error(`Browser QA cannot bind an ephemeral port on ${host}`, { cause: error }));
    });
    server.listen(0, host, () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Browser QA could not reserve an ephemeral localhost port"));
      });
    });
  });
}

const suppliedBaseUrl = process.env.PLAYWRIGHT_BASE_URL?.trim();
const suppliedTarget = suppliedBaseUrl ? new URL(suppliedBaseUrl) : null;
const startsLocalServer = suppliedTarget === null || localHostnames.has(suppliedTarget.hostname);
if (suppliedTarget && startsLocalServer && !suppliedTarget.port) {
  throw new Error("A local PLAYWRIGHT_BASE_URL must include an explicit port");
}
if (startsLocalServer) await acquireSuiteLock();
if (startsLocalServer) process.once("exit", cleanupLocalLocks);
const reservedPort = suppliedBaseUrl ? null : await availablePort();
const baseURL = suppliedBaseUrl || `http://${host}:${reservedPort}`;
const playwrightCli = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));

function cleanupLocalLocks() {
  if (!startsLocalServer) return;
  const owner = (() => {
    try {
      return JSON.parse(readFileSync(join(suiteLockDirectory, "owner.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  // Never remove a lock that was replaced after this process acquired it.
  if (Number(owner?.pid) !== process.pid) return;
  rmSync(suiteLockDirectory, { recursive: true, force: true });
}

let child;
let forceKillTimer;
let receivedSignal;

function signalChild(signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
  }
}

process.once("exit", () => {
  signalChild("SIGTERM");
});

process.stdout.write(`Browser QA target: ${baseURL}\n`);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    receivedSignal = signal;
    signalChild(signal);
    forceKillTimer = setTimeout(() => signalChild("SIGKILL"), 5_000);
    forceKillTimer.unref();
  });
}

function runPlaywright(arguments_, projectName) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [playwrightCli, "test", ...arguments_], {
      stdio: "inherit",
      env: {
        ...process.env,
        PLAYWRIGHT_BASE_URL: baseURL,
        ...(projectName ? { PLAYWRIGHT_HTML_OUTPUT_DIR: `playwright-report/${projectName}` } : {}),
      },
      detached: process.platform !== "win32",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      // Each responsive project receives a fresh Vinext preview. Kill any
      // process-group residue before the next project starts so closed RSC
      // streams cannot accumulate and poison later tests.
      signalChild("SIGKILL");
      child = undefined;
      resolve({ code: code ?? 1, signal });
    });
  });
}

// `pnpm run test:e2e -- ...` forwards the delimiter itself to this wrapper.
// The helper strips it before Playwright parses project and test filters.
const runs = playwrightProjectRuns(process.argv.slice(2));

let failed = false;
for (const [index, run] of runs.entries()) {
  if (receivedSignal) break;
  process.stdout.write(`\nBrowser QA project: ${run.projectName ?? "explicit selection"}\n`);
  const result = await runPlaywright(run.arguments_, run.projectName);
  if (result.signal) {
    receivedSignal = receivedSignal || result.signal;
    break;
  }
  if (result.code !== 0) failed = true;
  // WebKit helper processes can briefly outlive the Playwright process group
  // on macOS. Give them a bounded drain window before booting the next
  // responsive project; otherwise a long matrix can cascade one late timeout
  // into unrelated failures even though every project passes in isolation.
  if (index < runs.length - 1 && !receivedSignal) await delay(responsiveProjectCooldownMs);
}

if (forceKillTimer) clearTimeout(forceKillTimer);
if (receivedSignal) {
  cleanupLocalLocks();
  process.removeAllListeners(receivedSignal);
  process.kill(process.pid, receivedSignal);
} else {
  process.exitCode = failed ? 1 : 0;
}
