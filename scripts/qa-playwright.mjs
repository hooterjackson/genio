import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const suiteLockDirectory = join(tmpdir(), "genio-playwright-suite.lock");
const localHostnames = new Set(["localhost", "127.0.0.1"]);

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
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function availablePort() {
  for (let port = 4173; port <= 4199; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error("Browser QA could not find a free localhost port from 4173 through 4199");
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
child = spawn(process.execPath, [playwrightCli, "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_BASE_URL: baseURL },
  detached: process.platform !== "win32",
});

child.once("error", (error) => {
  cleanupLocalLocks();
  throw error;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    signalChild(signal);
    forceKillTimer = setTimeout(() => signalChild("SIGKILL"), 5_000);
    forceKillTimer.unref();
  });
}
child.once("exit", (code, signal) => {
  if (forceKillTimer) clearTimeout(forceKillTimer);
  // Playwright should have stopped its configured web server before exiting.
  // Kill any process-group residue so a failed runner cannot poison the next
  // suite with a stale Vinext or Wrangler listener.
  signalChild("SIGKILL");
  if (signal) {
    // Signal termination does not reliably run Node's normal `exit` handlers.
    // Release our owned lock before re-emitting the child's signal.
    cleanupLocalLocks();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
