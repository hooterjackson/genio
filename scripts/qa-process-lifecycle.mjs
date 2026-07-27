import { readFile, rm } from "node:fs/promises";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function qaProcessIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "EPERM",
    );
  }
}

export function qaProcessGroupIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "EPERM",
    );
  }
}

export function signalQaProcessGroup(pid, signal) {
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

export async function readOwnedQaWebServerLease(leasePath, ownershipToken) {
  const raw = await readFile(leasePath, "utf8").catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (raw === null) return null;
  const lease = JSON.parse(raw);
  if (
    !lease
    || typeof lease !== "object"
    || lease.ownershipToken !== ownershipToken
    || !Number.isInteger(lease.pid)
    || lease.pid < 2
  ) {
    throw new Error("Browser QA webserver ownership lease is invalid");
  }
  return { pid: lease.pid };
}

async function waitUntilStopped(pid, {
  timeoutMs,
  pollMs,
  processIsAlive,
  pause,
}) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!processIsAlive(pid)) return true;
    await pause(pollMs);
  }
  return !processIsAlive(pid);
}

export async function terminateOwnedQaWebServer({
  leasePath,
  ownershipToken,
  gracefulTimeoutMs = 2_000,
  forceTimeoutMs = 1_000,
  pollMs = 50,
  processGroupIsAlive = qaProcessGroupIsAlive,
  signalProcessGroup = signalQaProcessGroup,
  pause = delay,
}) {
  const lease = await readOwnedQaWebServerLease(leasePath, ownershipToken);
  if (!lease) return { found: false, stopped: true };

  try {
    if (processGroupIsAlive(lease.pid)) {
      signalProcessGroup(lease.pid, "SIGTERM");
      const stoppedGracefully = await waitUntilStopped(lease.pid, {
        timeoutMs: gracefulTimeoutMs,
        pollMs,
        processIsAlive: processGroupIsAlive,
        pause,
      });
      if (!stoppedGracefully) {
        signalProcessGroup(lease.pid, "SIGKILL");
        const stoppedForcibly = await waitUntilStopped(lease.pid, {
          timeoutMs: forceTimeoutMs,
          pollMs,
          processIsAlive: processGroupIsAlive,
          pause,
        });
        if (!stoppedForcibly) {
          throw new Error(`Browser QA webserver process group ${lease.pid} did not stop`);
        }
      }
    }
    return { found: true, stopped: true };
  } finally {
    await rm(leasePath, { force: true });
  }
}
