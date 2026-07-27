import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { qaProcessIsAlive } from "./qa-process-lifecycle.mjs";

const port = process.argv[2];
const hostname = process.argv[3] || "127.0.0.1";
if (!port || !/^\d+$/u.test(port)) throw new Error("QA web server requires a numeric port");

const vinextCli = fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url));
const environment = {
  ...process.env,
  WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || ".wrangler/wrangler.log",
  // The Worker deliberately refuses its local preview fallback unless the QA
  // harness opts in. Never rely on an ambient developer-shell value here.
  GENIO_QA_LOCAL_PREVIEW: "1",
};
const leasePath = process.env.GENIO_QA_WEBSERVER_LEASE_PATH?.trim() ?? "";
const ownershipToken =
  process.env.GENIO_QA_WEBSERVER_OWNERSHIP_TOKEN?.trim() ?? "";
const runnerPid = Number.parseInt(
  process.env.GENIO_QA_RUNNER_PID?.trim() ?? "",
  10,
);
if (Boolean(leasePath) !== Boolean(ownershipToken)) {
  throw new Error("QA webserver ownership lease is incomplete");
}
if (leasePath) {
  if (!/^[0-9a-f-]{36}$/iu.test(ownershipToken)) {
    throw new Error("QA webserver ownership token is invalid");
  }
  if (!Number.isInteger(runnerPid) || runnerPid < 2) {
    throw new Error("QA webserver runner PID is invalid");
  }
  writeFileSync(
    leasePath,
    JSON.stringify({ ownershipToken, pid: process.pid }),
    { encoding: "utf8", flag: "wx" },
  );
}

let currentChild;
let currentChildPid;
let receivedSignal;

function signalProcessTree(pid, signal, child = currentChild) {
  if (!pid) return;
  try {
    // Vinext is a direct child of this wrapper. Signal that child during an
    // ordinary shutdown; Playwright's outer process group remains responsible
    // for any descendants during a hard runner shutdown.
    if (child?.pid === pid) child.kill(signal);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function signalChild(signal) {
  signalProcessTree(currentChildPid, signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    receivedSignal = signal;
    // This wrapper is itself managed by Playwright's outer process group. Do
    // not use an equal grace timer here: signal the direct Vinext child
    // synchronously and let Playwright clean up any remaining descendants.
    signalChild("SIGKILL");
  });
}

process.once("exit", () => {
  signalChild("SIGKILL");
  // The outer QA runner owns this lease. Preserve it until that runner has
  // verified the entire webserver process group stopped; the wrapper leader
  // can exit before a descendant in its group does.
});

const runnerMonitor = leasePath
  ? setInterval(() => {
      if (qaProcessIsAlive(runnerPid)) return;
      receivedSignal = receivedSignal || "SIGTERM";
      signalChild("SIGKILL");
      if (!currentChildPid) propagateSignal("SIGTERM");
    }, 250)
  : null;
runnerMonitor?.unref();

function runStage(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vinextCli, ...arguments_], {
      stdio: "inherit",
      env: environment,
      detached: false,
    });
    currentChild = child;
    currentChildPid = child.pid;
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      signalProcessTree(child.pid, "SIGKILL", child);
      currentChild = undefined;
      currentChildPid = undefined;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      // Clear any still-addressable direct child before dropping its captured
      // PID. Playwright's outer process group handles descendant cleanup.
      signalProcessTree(child.pid, "SIGKILL", child);
      currentChild = undefined;
      currentChildPid = undefined;
      resolve({ code, signal });
    });
  });
}

function propagateSignal(signal) {
  // The first signal was consumed by our forwarding handler. Re-send it after
  // the child tree exits so this wrapper has the conventional signal status.
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
}

// Browser QA runs against a production bundle. The dev server's module graph
// can be invalidated while parallel WebKit contexts are loading, which tests
// hot-reload behavior instead of the artifact deployed to Sites.
const build = await runStage(["build"]);
if (build.signal || receivedSignal) {
  propagateSignal(receivedSignal || build.signal);
} else if (build.code !== 0) {
  process.exitCode = build.code ?? 1;
} else {
  const server = await runStage(["start", "--port", port, "--hostname", hostname]);
  if (server.signal || receivedSignal) propagateSignal(receivedSignal || server.signal);
  else process.exitCode = server.code ?? 1;
}
