import { spawn } from "node:child_process";
import process from "node:process";

try {
  process.loadEnvFile?.(".env.local");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const children = [
  spawn(process.execPath, ["--experimental-transform-types", "server/index.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(process.execPath, ["--experimental-transform-types", "server/worker-runner.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn("node_modules/.bin/vinext", ["dev"], {
    stdio: "inherit",
    env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
  }),
];

const stop = () => children.forEach((child) => child.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
children.forEach((child) => child.on("exit", (code) => {
  if (code && code !== 0) process.exitCode = code;
  stop();
}));
