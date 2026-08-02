import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const workflowUrl = new URL(
  "../.github/workflows/v254-editorial-direct-exposure.yml",
  import.meta.url,
);

describe("v2.5.4 direct editorial exposure workflow", () => {
  test("binds the exact candidate and replaces staged rollout with one signed 0 to 100 transition", async () => {
    const source = await readFile(workflowUrl, "utf8");
    expect(source).toContain("source_revision:");
    expect(source).toContain("candidate_tag:");
    expect(source).toContain("image_digest:");
    expect(source).toContain('test "$GITHUB_WORKFLOW_SHA" = "$SOURCE_REVISION"');
    expect(source).toContain('test "$(git rev-parse HEAD)" = "$SOURCE_REVISION"');
    expect(source).toContain(
      'test "$(jq -r \'.path\' <<<"$ROUTE")" = ".github/workflows/v254-pre-exposure-route-pause.yml"',
    );
    expect(source).toContain(
      'test "$ROUTE_ARTIFACT" = "v254-pre-exposure-route-pause-public_canary-$SOURCE_REVISION"',
    );
    expect(source).toContain("signed editorial_influence 0 to 100");
    expect(source).toContain("release:v254:direct-exposure:authorize");
    expect(source).toContain("v254-direct-exposure-authority.json");
    expect(source).toContain("v254-direct-exposure-rollback-warrant.json");
    expect(source).toContain("fully_exposed_unproven");
    expect(source).toContain("organicReliabilityProven == false");
    expect(source).not.toContain("editorial_influence:1->10");
    expect(source).not.toContain("editorial_influence:10->50");
    expect(source).not.toContain("editorial_influence:50->100");
    expect(source).not.toContain(
      ".github/workflows/v254-editorial-route-control.yml",
    );
    expect(source).not.toContain(
      "v254-editorial-route-public_canary-$SOURCE_REVISION",
    );
  });

  test("orders prepare, durable arm, workers-first runtime, and database activation", async () => {
    const source = await readFile(workflowUrl, "utf8");
    const prepare = source.indexOf(
      "Independently derive one shared post-exposure semantic hash",
    );
    const authorize = source.indexOf(
      "Mint and verify the single-use 0 to 100 authority",
    );
    const plan = source.indexOf(
      "Verify the exact database plan before mutation",
    );
    const arm = source.indexOf(
      "Arm the durable authority while route and publication stay paused",
    );
    const runtime = source.indexOf(
      "Redeploy the existing workers first and API last from the same image",
    );
    const activate = source.indexOf("Activate the database authority last");

    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(authorize).toBeGreaterThan(prepare);
    expect(plan).toBeGreaterThan(authorize);
    expect(arm).toBeGreaterThan(plan);
    expect(runtime).toBeGreaterThan(arm);
    expect(activate).toBeGreaterThan(runtime);
    expect(source).toContain("direct-exposure-runtime-plan.json");
    expect(source).toContain("direct-exposure-database-arm.json");
    expect(source).toContain("direct-exposure-runtime-apply.json");
    expect(source).toContain("direct-exposure-database-activate.json");
    expect(source).toContain('.workerProtocol.actual == "playlist-pipeline-v12"');
  });

  test("rolls back database authority before runtime and never rebuilds or creates infrastructure", async () => {
    const source = await readFile(workflowUrl, "utf8");
    const rollback = source.indexOf(
      "Roll back database first, then exact image and configuration",
    );
    const databaseRollback = source.indexOf(
      "scripts/apply-v254-direct-exposure.ts",
      rollback,
    );
    const runtimeRollback = source.indexOf(
      "release:v254:direct-exposure:runtime -- rollback",
      rollback,
    );
    expect(rollback).toBeGreaterThanOrEqual(0);
    expect(databaseRollback).toBeGreaterThan(rollback);
    expect(runtimeRollback).toBeGreaterThan(databaseRollback);
    expect(source).not.toMatch(/\brailway\s+up\b/u);
    expect(source).not.toContain("--from-source");
    expect(source).not.toMatch(/service\s+create/u);
    expect(source).not.toMatch(/\b(?:pnpm|npm)\s+(?:run\s+)?build\b/u);
    expect(source).not.toMatch(/\bcreate_site\b/u);
    expect(source).not.toMatch(/\bdeploy_version\b/u);
    expect(source).not.toMatch(/\bwrangler\b/u);
  });
});
