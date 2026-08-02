import { readFile, readdir } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const packageUrl = new URL("../package.json", import.meta.url);
const testsUrl = new URL("./", import.meta.url);
const ciWorkflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
const releaseWorkflowUrl = new URL(
  "../.github/workflows/release-candidate.yml",
  import.meta.url,
);
const migrationJournalUrl = new URL(
  "../postgres-migrations/meta/_journal.json",
  import.meta.url,
);
const productionPostgresImage =
  "ghcr.io/railwayapp-templates/postgres-ssl:18@sha256:764fabc5fceb7166414c425a57bed8722a08cfb7fff508efb21a86eb31e172a6";

describe("CI unit and PostgreSQL test partition", () => {
  test("journals the schema-20-compatible Guidance V5.1 checkpoint migration", async () => {
    const journal = JSON.parse(
      await readFile(migrationJournalUrl, "utf8"),
    ) as {
      entries?: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries?.at(-1)).toEqual(expect.objectContaining({
      idx: 24,
      tag: "0024_guidance_v5_execution_decision",
    }));
  });

  test("fetches the annotated release history in every job that runs Git-bound suites", async () => {
    const workflow = await readFile(ciWorkflowUrl, "utf8");
    for (const [jobName, nextJobName] of [
      ["unit-and-database", "production-database-compatibility"],
      ["production-database-compatibility", "browser"],
    ] as const) {
      const start = workflow.indexOf(`  ${jobName}:\n`);
      const end = workflow.indexOf(`\n  ${nextJobName}:\n`, start + 1);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      expect(workflow.slice(start, end)).toMatch(
        /actions\/checkout@[0-9a-f]{40}\s+# v4\s*\n\s+with:\s*\n\s+fetch-depth: 0/u,
      );
    }
  });

  test("keeps every database integration file out of parallel coverage and in the serial DB gate", async () => {
    const packageJson = JSON.parse(await readFile(packageUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const integrationFiles = (await readdir(testsUrl))
      .filter((name) => name.endsWith(".integration.test.ts"))
      .sort();

    expect(integrationFiles.length).toBeGreaterThan(0);
    expect(integrationFiles).toContain(
      "canonical-executor-release-identity.integration.test.ts",
    );
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
    expect(section).toContain(
      "PGDATA: /var/lib/postgresql/data/pgdata",
    );
    expect(section).toContain("pnpm test:database:preflight");
    expect(section).toContain("pnpm db:migrate");
    expect(section).toContain("pnpm test:database");
    expect(section).not.toContain("pnpm test:coverage");
  });

  test("makes the stitched API-worker-database-browser suite part of the exact-SHA aggregate", async () => {
    const workflow = await readFile(ciWorkflowUrl, "utf8");
    const stitchedStart = workflow.indexOf("  stitched-system:\n");
    const aggregateStart = workflow.indexOf("  aggregate-exact-sha:\n");
    expect(stitchedStart).toBeGreaterThan(-1);
    expect(aggregateStart).toBeGreaterThan(stitchedStart);
    const stitched = workflow.slice(stitchedStart, aggregateStart);
    const aggregate = workflow.slice(aggregateStart);
    expect(stitched).toContain("DATABASE_URL: postgresql://needle:needle@127.0.0.1:5432/needle");
    expect(stitched).toContain("pnpm test:e2e:system");
    expect(stitched).toContain("pnpm exec playwright install --with-deps chromium-headless-shell");
    expect(aggregate).toMatch(/needs:[\s\S]*- stitched-system/u);
  });
});
