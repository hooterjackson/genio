import { readFile, readdir } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const packageUrl = new URL("../package.json", import.meta.url);
const testsUrl = new URL("./", import.meta.url);
const ciWorkflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
const releaseWorkflowUrl = new URL(
  "../.github/workflows/release-candidate.yml",
  import.meta.url,
);
const productionPostgresImage =
  "ghcr.io/railwayapp-templates/postgres-ssl:18@sha256:764fabc5fceb7166414c425a57bed8722a08cfb7fff508efb21a86eb31e172a6";

describe("CI unit and PostgreSQL test partition", () => {
  test("keeps every database integration file out of parallel coverage and in the serial DB gate", async () => {
    const packageJson = JSON.parse(await readFile(packageUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const integrationFiles = (await readdir(testsUrl))
      .filter((name) => name.endsWith(".integration.test.ts"))
      .sort();

    expect(integrationFiles).toHaveLength(16);
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

  test.each([
    [
      "pull-request",
      ciWorkflowUrl,
      "production-database-compatibility",
      "browser",
    ],
    [
      "release-candidate",
      releaseWorkflowUrl,
      "validate_production_database",
      "validate_system",
    ],
  ])("%s workflow reruns every serialized integration test on the exact production Postgres 18 image", async (
    _name,
    url,
    jobName,
    nextJobName,
  ) => {
    const workflow = await readFile(url, "utf8");
    const start = workflow.indexOf(`  ${jobName}:\n`);
    expect(start).toBeGreaterThan(-1);
    const nextJob = workflow.indexOf(`\n  ${nextJobName}:\n`, start + 1);
    expect(nextJob).toBeGreaterThan(start);
    const section = workflow.slice(
      start,
      nextJob,
    );
    expect(section).toContain(`image: ${productionPostgresImage}`);
    expect(section).toContain("pnpm test:database:preflight");
    expect(section).toContain("pnpm db:migrate");
    expect(section).toContain("pnpm test:database");
    expect(section).not.toContain("pnpm test:coverage");
  });
});
