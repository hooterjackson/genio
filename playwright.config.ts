import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:4173";
const devPort = new URL(baseURL).port || "3000";
const startsLocalServer = ["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname);
const nodeBinary = process.execPath;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    reducedMotion: "reduce",
  },
  projects: [
    { name: "mobile-320", use: { ...devices["iPhone SE"], viewport: { width: 320, height: 720 } } },
    { name: "mobile-390", use: { ...devices["iPhone 14"], viewport: { width: 390, height: 844 } } },
    { name: "mobile-430", use: { ...devices["iPhone 14 Pro Max"], viewport: { width: 430, height: 932 } } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
  ],
  webServer: startsLocalServer
    ? {
        command: `${nodeBinary} node_modules/vinext/dist/cli.js dev --port ${devPort}`,
        url: baseURL,
        // Browser QA needs its own Worker bindings. Reusing an unrelated local
        // preview can silently omit OWNER_EMAIL and skip private-owner coverage.
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          OWNER_EMAIL: process.env.OWNER_EMAIL ?? "owner@example.com",
        },
      }
    : undefined,
});
