import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const workflowUrl = new URL(
  "../.github/workflows/v254-pre-exposure-clean-nonowner.yml",
  import.meta.url,
);

function index(workflow: string, value: string): number {
  const found = workflow.indexOf(value);
  expect(found, `missing workflow fragment: ${value}`).toBeGreaterThanOrEqual(0);
  return found;
}

describe("v2.5.4 pre-exposure clean non-owner workflow", () => {
  test("binds the exact candidate to successful promotion, Sites, and paused route receipts", async () => {
    const workflow = await readFile(workflowUrl, "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("backend_promotion_run_id:");
    expect(workflow).toContain("sites_handoff_run_id:");
    expect(workflow).toContain("route_authority_run_id:");
    expect(workflow).toContain("ref: ${{ inputs.source_revision }}");
    expect(workflow).toContain(
      'test "$GITHUB_WORKFLOW_SHA" = "$SOURCE_REVISION"',
    );
    expect(workflow).toContain(
      'test "$(git rev-parse HEAD)" = "$SOURCE_REVISION"',
    );
    expect(workflow).toContain(
      'test "$(git rev-parse "$TAG_OBJECT^{}")" = "$SOURCE_REVISION"',
    );
    expect(workflow).toContain(
      'test "$(jq -r \'.path\' <<<"$BACKEND")" = ".github/workflows/native-schema20-release.yml"',
    );
    expect(workflow).toContain(
      'test "$(jq -r \'.path\' <<<"$SITES")" = ".github/workflows/v254-sites-connector-handoff.yml"',
    );
    expect(workflow).toContain(
      'test "$(jq -r \'.path\' <<<"$ROUTE")" = ".github/workflows/v254-pre-exposure-route-pause.yml"',
    );
    expect(workflow).toContain(
      'test "$ROUTE_ARTIFACT" = "v254-pre-exposure-route-pause-public_canary-$SOURCE_REVISION"',
    );
    expect(workflow).toContain(
      "name: native-schema20-promotion-${{ inputs.source_revision }}",
    );
    expect(workflow).toContain(
      "name: ${{ inputs.sites_handoff_artifact }}",
    );
    expect(workflow).toContain(
      "name: ${{ inputs.route_authority_artifact }}",
    );
    expect(workflow).toContain(
      '.schemaVersion == "genio-native-schema20-promotion/v1"',
    );
    expect(workflow).toContain(
      '.schemaVersion == "genio-v254-sites-connector-handoff/v1"',
    );
    expect(workflow).toContain(
      '.schemaVersion == "genio-v254-editorial-route-authority/v1"',
    );
    expect(workflow).toContain('.phase == "public_canary"');
    expect(workflow).toContain(
      ".semanticExecutionConfigurationHash == $semantic",
    );
    expect(workflow).toContain(
      ".database.hardSwitchDisabled == false",
    );
    expect(workflow).toContain(
      ".database.globalPublicPause == true",
    );
    expect(workflow).toContain(
      ".database.intentPublicPause == true",
    );
    expect(index(workflow, 'BACKEND_COMPLETED_AT="$(jq -er'))
      .toBeLessThan(index(workflow, 'SITES_VERIFIED_AT="$(jq -er'));
    expect(index(workflow, 'SITES_VERIFIED_AT="$(jq -er'))
      .toBeLessThan(index(workflow, 'ROUTE_COMPLETED_AT="$(jq -er'));
  });

  test("runs the two real signed-canary UI probes with manifest and Apple writes fenced", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const producer = index(
      workflow,
      "scripts/final-custom-domain-browser-producer.ts",
    );
    const proofAssertion = index(
      workflow,
      "Assert exact signed-canary, fresh-run, and Apple-write fences",
    );
    const upload = index(
      workflow,
      "name: v254-pre-exposure-clean-nonowner-${{ inputs.source_revision }}",
    );

    expect(workflow).toContain("RELEASE_CANARY_HMAC_SECRET");
    expect(workflow).toContain("RELEASE_SECRET_VERSIONS_BASE64");
    expect(workflow).toContain(
      "RELEASE_GATE_PRODUCER_PRIVATE_KEY_BASE64",
    );
    expect(workflow).toContain("RELEASE_GATE_PRODUCER_KEY_SHA256");
    expect(workflow).toContain("scripts/release-runtime-snapshot.ts");
    expect(workflow).toContain("--scope full");
    expect(workflow).toContain(
      ".runtime.semanticExecutionConfigurationHash == $semantic",
    );
    expect(workflow).toContain(".configuration.apiHash == $api");
    expect(workflow).toContain(
      ".configuration.interactiveWorkerHash == $interactive",
    );
    expect(workflow).toContain(
      ".configuration.deepWorkerHash == $deep",
    );
    expect(workflow).toContain("--pre-exposure-clean-nonowner");
    expect(workflow).toContain("Infuential irish music");
    expect(workflow).toContain("Influential Irish music");
    expect(workflow).toContain(
      '.sources.browser.schemaVersion == "genio-final-custom-domain-browser/v7"',
    );
    expect(workflow).toContain(
      '.sources.browser.assignmentMode == "pre_exposure_release_canary"',
    );
    expect(workflow).toContain(
      '.assignmentAuthority == "signed_release_canary"',
    );
    expect(workflow).toContain(".publicPercentageBypass == true");
    expect(workflow).toContain(".organicAssignment == false");
    expect(workflow).toContain(
      '(.successorContractHash | test("^[0-9a-f]{64}$"))',
    );
    expect(workflow).toContain(
      '(.queryPlanHash | test("^[0-9a-f]{64}$"))',
    );
    expect(workflow).toContain(
      '(.executionRouteReceiptHash | test("^[0-9a-f]{64}$"))',
    );
    expect(workflow).toContain(
      '(.workerConsumptionReceiptHash | test("^[0-9a-f]{64}$"))',
    );
    expect(workflow).toContain(".runReused == false");
    expect(workflow).toContain(".manifestOnly == true");
    expect(workflow).toContain('.appleWriteAccess == "forbidden"');
    expect(workflow).toContain(".manifestRows == 0");
    expect(workflow).toContain(".matchingJobs == 0");
    expect(workflow).toContain(".publicationJobs == 0");
    expect(workflow).toContain(".orphanPlaylistRows == 0");
    expect(producer).toBeLessThan(proofAssertion);
    expect(proofAssertion).toBeLessThan(upload);

    expect(workflow).not.toContain(
      "--expected-public-rollout-evidence-hash",
    );
    expect(workflow).not.toContain("--expected-public-rollout-stage");
    expect(workflow).not.toContain(
      "--expected-direct-exposure-authority-hash",
    );
    expect(workflow).not.toContain("RELEASE_OWNER_BROWSER_COOKIE");
    expect(workflow).not.toContain("APPLE_QA_VERIFIER_DEVELOPER_TOKEN");
    expect(workflow).not.toContain("scripts/hosted-publication-smoke.ts");
    expect(workflow).not.toContain("RAILWAY_TOKEN");
    expect(workflow).not.toMatch(/\brailway\s+(?:up|redeploy|variable)\b/u);
  });
});
