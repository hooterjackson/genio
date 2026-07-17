import { defineConfig, devices } from "@playwright/test";

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
  // Vinext's local RSC worker can lose its connection when every responsive
  // project starts at once. Keep enough concurrency for fast feedback without
  // turning browser QA into a dev-server stress test.
  workers: process.env.CI ? 2 : 4,
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
        command: `${nodeBinary} scripts/qa-webserver.mjs ${devPort} ${devHostname}`,
        url: baseURL,
        // Browser QA needs its own production bundle and Worker bindings.
        // Reusing an unrelated preview can silently omit OWNER_EMAIL, skip
        // private-owner coverage, or test stale client assets.
        reuseExistingServer: false,
        // A cold Vinext production build can take several minutes on a fresh
        // CI runner before the preview server becomes ready.
        timeout: 300_000,
        env: {
          OWNER_EMAIL: process.env.OWNER_EMAIL ?? "owner@example.com",
        },
      }
    : undefined,
});
