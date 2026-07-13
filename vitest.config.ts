import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    testTimeout: 15_000,
    coverage: {
      reporter: ["text", "json-summary"],
      include: ["server/**/*.ts", "lib/**/*.ts", "shared/**/*.ts"],
    },
  },
});
