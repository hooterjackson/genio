import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Vitest otherwise mirrors the host CPU count. A dozen instrumented Node
    // workers under V8 coverage have triggered EINTR startup failures and a
    // hung suite on developer Macs. Four retains useful file parallelism while
    // keeping both local and CI runs inside a predictable process envelope.
    maxWorkers: 4,
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    testTimeout: 15_000,
    coverage: {
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      include: ["server/**/*.ts", "lib/**/*.ts", "shared/**/*.ts"],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
    },
  },
});
