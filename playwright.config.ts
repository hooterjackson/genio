import { defineConfig, devices } from "@playwright/test";
import { qaWebServerEnvironment } from "./scripts/qa-playwright-args.mjs";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:4173";
const parsedBaseURL = new URL(baseURL);
const startsLocalServer = ["localhost", "127.0.0.1"].includes(parsedBaseURL.hostname);
if (startsLocalServer && !parsedBaseURL.port) {
  throw new Error("A local PLAYWRIGHT_BASE_URL must include an explicit port");
}
const devPort = parsedBaseURL.port;
const devHostname = parsedBaseURL.hostname;
const nodeBinary = process.execPath;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // Vinext's local RSC worker can lose its connection when too many responsive
  // projects navigate at once. Match CI's conservative concurrency locally so
  // browser QA measures the product instead of overloading its preview server.
  workers: 2,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  timeout: 30_000,
  expect: { timeout: 7_500 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    reducedMotion: "reduce",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    { name: "mobile-320", use: { ...devices["iPhone SE"], viewport: { width: 320, height: 720 } } },
    { name: "mobile-390", use: { ...devices["iPhone 14"], viewport: { width: 390, height: 844 } } },
    { name: "mobile-430", use: { ...devices["iPhone 14 Pro Max"], viewport: { width: 430, height: 932 } } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
  ],
  webServer: startsLocalServer
    ? {
        // Playwright launches this through a detached shell. `exec` replaces
        // that shell so the wrapper PID written to the ownership lease is also
        // the webserver process-group ID used by the outer cleanup.
        command: `exec ${nodeBinary} scripts/qa-webserver.mjs ${devPort} ${devHostname}`,
        url: baseURL,
        // Browser QA needs its own production bundle and Worker bindings.
        // Reusing an unrelated preview can silently omit OWNER_EMAIL, skip
        // private-owner coverage, or test stale client assets.
        reuseExistingServer: false,
        // A cold Vinext production build can take several minutes on a fresh
        // CI runner before the preview server becomes ready.
        timeout: 300_000,
        env: qaWebServerEnvironment(process.env),
      }
    : undefined,
});
