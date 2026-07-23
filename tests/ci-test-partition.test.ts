import { readFile, readdir } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const packageUrl = new URL("../package.json", import.meta.url);
const testsUrl = new URL("./", import.meta.url);
const ciWorkflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
const releaseWorkflowUrl = new URL(
  "../.github/workflows/release-candidate.yml",
  import.meta.url,
);

describe("CI unit and PostgreSQL test partition", () => {
  test("keeps every database integration file out of parallel coverage and in the serial DB gate", async () => {
    const packageJson = JSON.parse(await readFile(packageUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const integrationFiles = (await readdir(testsUrl))
      .filter((name) => name.endsWith(".integration.test.ts"))
      .sort();

    expect(integrationFiles).toHaveLength(14);
    expect(packageJson.scripts?.["test:coverage"]).toContain(
      "--exclude 'tests/*.integration.test.ts'",
    );
    expect(packageJson.scripts?.["test:database"]).toContain(
      "--no-file-parallelism tests/*.integration.test.ts",
    );
  });

  test.each([
    ["pull-request", ciWorkflowUrl],
    ["release-candidate", releaseWorkflowUrl],
  ])("%s workflow runs coverage and the explicit DB gate separately", async (_name, url) => {
    const workflow = await readFile(url, "utf8");
    const coverageIndex = workflow.indexOf("pnpm test:coverage");
    const databaseIndex = workflow.indexOf("pnpm test:database", coverageIndex + 1);
    expect(coverageIndex).toBeGreaterThan(-1);
    expect(databaseIndex).toBeGreaterThan(coverageIndex);
  });
});
