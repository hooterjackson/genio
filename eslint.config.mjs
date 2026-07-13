import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    files: ["server/**/*.ts", "worker/**/*.ts", "tests/**/*.ts"],
    rules: {
      // Provider responses and SQL row projections are validated at their
      // boundaries, but intentionally remain dynamic while being normalized.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;
