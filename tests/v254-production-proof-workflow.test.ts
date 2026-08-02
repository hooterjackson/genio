import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const workflows = {
  sites: new URL(
    "../.github/workflows/v254-sites-connector-handoff.yml",
    import.meta.url,
  ),
  ownerApple: new URL(
    "../.github/workflows/v254-owner-apple-gate.yml",
    import.meta.url,
  ),
  productionProof: new URL(
    "../.github/workflows/v254-production-proof.yml",
    import.meta.url,
  ),
  finalizer: new URL(
    "../.github/workflows/native-schema20-release-finalize.yml",
    import.meta.url,
  ),
};

const sourceRevisionCheckout =
  "ref: ${{ inputs.source_revision }}";
const exactWorkflowRevisionCheck =
  'test "$GITHUB_WORKFLOW_SHA" = "$SOURCE_REVISION"';
const exactCheckoutRevisionCheck =
  'test "$(git rev-parse HEAD)" = "$SOURCE_REVISION"';

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("v2.5.4 production proof workflow graph", () => {
  test("imports connector-produced Sites evidence without building or deploying Sites", async () => {
    const workflow = await readFile(workflows.sites, "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("source_revision:");
    expect(workflow).toContain("candidate_tag:");
    expect(workflow).toContain("image_digest:");
    expect(workflow).toContain("sites_control_plane_evidence_base64:");
    expect(workflow).toContain("sites_control_plane_attestation_base64:");
    expect(workflow).toContain("sites_control_plane_public_key_base64:");
    expect(workflow).toContain(sourceRevisionCheckout);
    expect(workflow).toContain(exactWorkflowRevisionCheck);
    expect(workflow).toContain(exactCheckoutRevisionCheck);
    expect(workflow).toContain(
      "RELEASE_SITES_CONTROL_PLANE_TRUSTED_KEY_ID",
    );
    expect(workflow).toContain(
      "RELEASE_SITES_CONTROL_PLANE_TRUSTED_KEY_SHA256",
    );
    expect(workflow).toContain(
      "scripts/v254-sites-connector-handoff.ts",
    );
    expect(workflow).toContain(
      "name: v254-sites-connector-handoff-${{ inputs.source_revision }}",
    );
    expect(workflow).toContain("v254-sites-connector-handoff.json");

    // GitHub Actions may import and verify a receipt produced by the Sites
    // connector, but it is not a Sites control plane and must never recreate,
    // rebuild, push, save, or deploy the frontend.
    expect(workflow).not.toMatch(/\brailway\s+up\b/u);
    expect(workflow).not.toMatch(/\bgit\s+push\b/u);
    expect(workflow).not.toMatch(/\b(?:pnpm|npm)\s+(?:run\s+)?build\b/u);
    expect(workflow).not.toMatch(/\bcreate_site\b/u);
    expect(workflow).not.toMatch(/\bsave_version\b/u);
    expect(workflow).not.toMatch(/\bdeploy_version\b/u);
    expect(workflow).not.toMatch(/\bsites\s+deploy\b/u);
    expect(workflow).not.toMatch(/\bwrangler\b/u);
  });

  test("keeps both Apple-writing controls in one protected owner workflow", async () => {
    const workflow = await readFile(workflows.ownerApple, "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain(sourceRevisionCheckout);
    expect(workflow).toContain(exactWorkflowRevisionCheck);
    expect(workflow).toContain(exactCheckoutRevisionCheck);
    expect(workflow).toContain("route_authority_run_id:");
    expect(workflow).toContain("sites_handoff_run_id:");
    expect(workflow).toContain("sites_handoff_artifact:");
    expect(workflow).toContain(
      ".github/workflows/v254-sites-connector-handoff.yml",
    );
    expect(workflow).toContain(
      'test "$SITES_ARTIFACT" = "v254-sites-connector-handoff-$SOURCE_REVISION"',
    );
    expect(workflow).toContain(
      "name: ${{ inputs.sites_handoff_artifact }}",
    );
    expect(workflow).toContain("v254-sites-connector-handoff.json");
    expect(workflow).toContain("scripts/v254-sites-connector-handoff.ts");
    expect(workflow).toContain(
      '.schemaVersion == "genio-native-schema20-promotion/v1"',
    );
    expect(workflow).toContain(
      '.schemaVersion == "genio-v254-editorial-route-authority/v1"',
    );
    expect(workflow).toContain('.phase == "owner_gate"');
    expect(workflow).toContain(
      ".semanticExecutionConfigurationHash == $semantic",
    );
    expect(workflow).toContain("--scope full");
    expect(workflow).toContain("full-runtime-snapshot.json");
    expect(workflow).toContain(
      ".sitesObservation.candidateMatched == true",
    );
    expect(workflow.indexOf("scripts/v254-sites-connector-handoff.ts"))
      .toBeLessThan(workflow.indexOf("scripts/hosted-publication-smoke.ts"));
    expect(workflow.indexOf("full-runtime-snapshot.json"))
      .toBeLessThan(workflow.indexOf("scripts/hosted-publication-smoke.ts"));
    expect(workflow).toContain(
      ".github/workflows/v254-pre-exposure-route-pause.yml",
    );
    expect(workflow).toContain(
      'test "$ROUTE_ARTIFACT" = "v254-pre-exposure-route-pause-owner_gate-$SOURCE_REVISION"',
    );
    expect(workflow).toContain("scripts/hosted-publication-smoke.ts");
    expect(occurrences(
      workflow,
      "scripts/hosted-publication-smoke.ts",
    )).toBe(2);
    expect(workflow).toContain(
      "--fixture-id fixed-three-track-control-v1",
    );
    expect(workflow).toContain(
      "production-fixed-three-track.gate.json",
    );
    expect(workflow).toContain(
      "production-fixed-three-track.attestation.json",
    );
    expect(workflow.indexOf(
      "--fixture-id fixed-three-track-control-v1",
    )).toBeLessThan(workflow.indexOf(
      "--fixture-id irish-influence-recovery-25-v1",
    ));
    expect(workflow).toContain('RELEASE_IRISH_RECOVERY_ACCESS_ID: ""');
    expect(workflow).toContain('RELEASE_IRISH_RECOVERY_COOKIE: ""');
    expect(workflow).toContain('RELEASE_OWNER_BROWSER_COOKIE: ""');
    expect(workflow).toContain('RELEASE_PRODUCTION_DATABASE_URL: ""');
    expect(workflow).toContain("unset RELEASE_IRISH_RECOVERY_ACCESS_ID");
    expect(workflow).toContain("unset RELEASE_IRISH_RECOVERY_COOKIE");
    expect(workflow).toContain("unset RELEASE_OWNER_BROWSER_COOKIE");
    expect(workflow).toContain("unset RELEASE_PRODUCTION_DATABASE_URL");
    expect(workflow).toContain(
      "RELEASE_BROWSER_ARTIFACT_DIR: ${{ runner.temp }}/owner-browser/fixed-three",
    );
    expect(workflow).toContain(
      "RELEASE_BROWSER_ARTIFACT_DIR: ${{ runner.temp }}/owner-browser/irish",
    );
    expect(workflow).toContain("production-affected-regression.gate.json");
    expect(workflow).toContain(
      "production-affected-regression.attestation.json",
    );
    expect(workflow).toContain(
      "name: v254-owner-apple-gate-${{ inputs.source_revision }}",
    );
    expect(workflow).not.toContain(
      "scripts/final-custom-domain-browser-producer.ts",
    );
    expect(workflow).not.toContain("--manifest-only");
    expect(workflow).toContain("APPLE_QA_VERIFIER_DEVELOPER_TOKEN");
  });

  test("produces full convergence and a direct-exposure public browser proof only after binding the signed transition", async () => {
    const workflow = await readFile(workflows.productionProof, "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("sites_handoff_run_id:");
    expect(workflow).toContain("sites_handoff_artifact:");
    expect(workflow).toContain("direct_exposure_run_id:");
    expect(workflow).toContain("direct_exposure_artifact:");
    expect(workflow).toContain(sourceRevisionCheckout);
    expect(workflow).toContain(exactWorkflowRevisionCheck);
    expect(workflow).toContain(exactCheckoutRevisionCheck);
    expect(workflow).toContain(
      ".github/workflows/v254-sites-connector-handoff.yml",
    );
    expect(workflow).toContain(
      ".github/workflows/v254-editorial-direct-exposure.yml",
    );
    expect(workflow).toContain(
      'test "$SITES_ARTIFACT" = "v254-sites-connector-handoff-$SOURCE_REVISION"',
    );
    expect(workflow).toContain(
      "name: ${{ inputs.sites_handoff_artifact }}",
    );
    expect(workflow).toContain("v254-sites-connector-handoff.json");
    expect(workflow).toContain(
      '.schemaVersion == "genio-v254-sites-connector-handoff/v1"',
    );
    expect(workflow).toContain(
      'test "$DIRECT_ARTIFACT" = "v254-editorial-direct-exposure-$SOURCE_REVISION"',
    );
    expect(workflow).toContain(
      "scripts/apply-v254-direct-exposure.ts plan",
    );
    expect(workflow).toContain(
      '.schemaVersion == "genio-v254-direct-exposure-runtime/v1"',
    );
    expect(workflow).toContain(
      '.schemaVersion == "genio-v254-direct-exposure-apply-receipt/v1"',
    );
    expect(workflow).toContain('.operation == "activate"');
    expect(workflow).toContain('.state == "active"');
    expect(workflow).toContain("scripts/release-runtime-snapshot.ts");
    expect(workflow).toContain("--scope full");
    expect(workflow).toContain("scripts/release-convergence-producer.ts");
    expect(workflow).toContain(
      "scripts/final-custom-domain-browser-producer.ts",
    );
    expect(workflow).toContain("--direct-exposure");
    expect(workflow).toContain(
      '--expected-direct-exposure-authority-hash "$DIRECT_AUTHORITY_HASH"',
    );
    expect(workflow).toContain(
      '.sources.browser.schemaVersion == "genio-final-custom-domain-browser/v8"',
    );
    expect(workflow).toContain(
      '.sources.browser.exposureClass == "fully_exposed_unproven"',
    );
    expect(workflow).toContain(
      ".sources.browser.organicReliabilityProven == false",
    );
    expect(workflow).toContain("release-convergence.gate.json");
    expect(workflow).toContain("release-convergence.attestation.json");
    expect(workflow).toContain("final-custom-domain-browser.gate.json");
    expect(workflow).toContain(
      "final-custom-domain-browser.attestation.json",
    );
    expect(workflow).toContain(
      "name: v254-production-proof-${{ inputs.source_revision }}",
    );
    expect(occurrences(workflow, "uses: actions/upload-artifact@")).toBe(1);
    expect(workflow).not.toContain("scripts/hosted-publication-smoke.ts");
    expect(workflow).not.toContain("RELEASE_OWNER_BROWSER_COOKIE");
    expect(workflow).not.toContain("APPLE_QA_VERIFIER_DEVELOPER_TOKEN");
  });

  test("finalization accepts only the exact producer paths and exact-SHA artifact names", async () => {
    const workflow = await readFile(workflows.finalizer, "utf8");

    expect(workflow).toContain(
      'test "$(jq -r \'.path\' <<<"$DIRECT")" = ".github/workflows/v254-editorial-direct-exposure.yml"',
    );
    expect(workflow).toContain(
      'test "$(jq -r \'.path\' <<<"$PROOF")" = ".github/workflows/v254-production-proof.yml"',
    );
    expect(workflow).toContain(
      'test "$(jq -r \'.path\' <<<"$APPLE")" = ".github/workflows/v254-owner-apple-gate.yml"',
    );
    expect(workflow).toContain(
      'test "$DIRECT_ARTIFACT" = "v254-editorial-direct-exposure-$SOURCE_REVISION"',
    );
    expect(workflow).toContain(
      'test "$PROOF_ARTIFACT" = "v254-production-proof-$SOURCE_REVISION"',
    );
    expect(workflow).toContain(
      'test "$APPLE_ARTIFACT" = "v254-owner-apple-gate-$SOURCE_REVISION"',
    );
    expect(workflow).toContain("name: ${{ inputs.direct_exposure_artifact }}");
    expect(workflow).toContain("name: ${{ inputs.production_proof_artifact }}");
    expect(workflow).toContain(
      "name: ${{ inputs.apple_gate_artifact }}",
    );
    expect(workflow).toContain(
      '--fixed-three-artifact "$RUNNER_TEMP/apple/production-fixed-three-track.gate.json"',
    );
    expect(workflow).toContain(
      '--fixed-three-attestation "$RUNNER_TEMP/apple/production-fixed-three-track.attestation.json"',
    );
    expect(workflow).toContain(
      '--direct-exposure-authority "$RUNNER_TEMP/direct/v254-direct-exposure-authority.json"',
    );
    expect(workflow).toContain(
      '--direct-exposure-database-activate-receipt "$RUNNER_TEMP/direct/direct-exposure-database-activate.json"',
    );
    expect(workflow).toContain(
      '--final-browser-artifact "$RUNNER_TEMP/proof/final-custom-domain-browser.gate.json"',
    );
  });
});
