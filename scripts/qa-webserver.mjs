import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

process.once("exit", () => signalChild("SIGKILL"));

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
