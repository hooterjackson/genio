import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const workflowUrl = new URL("../.github/workflows/release-candidate.yml", import.meta.url);
const dockerfileUrl = new URL("../Dockerfile", import.meta.url);
const buildInfoUrl = new URL("../server/build-info.ts", import.meta.url);

type ReleaseCandidateJob =
  | "authorize"
  | "validate_offline"
  | "validate_browser"
  | "validate_production_database"
  | "validate_system"
  | "publish";

function job(workflow: string, name: ReleaseCandidateJob): string {
  const order = [
    "authorize",
    "validate_offline",
    "validate_browser",
    "validate_production_database",
    "validate_system",
    "publish",
  ] as const;
  const start = workflow.indexOf(`  ${name}:\n`);
  const next = order[order.indexOf(name) + 1];
  const end = next ? workflow.indexOf(`  ${next}:\n`, start + 1) : workflow.length;
  expect(start, `${name} job must exist`).toBeGreaterThan(0);
  expect(end, `${name} job must have a valid boundary`).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe("release-candidate workflow trust boundary", () => {
  test("loads only from the default branch and accepts merged, green RC commits", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    expect(workflow).toContain("repository_dispatch:");
    expect(workflow).toContain("types: [genio-release-candidate]");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/push:\s*\n\s+tags:/u);
    expect(workflow).toContain(
      "CANDIDATE_TAG: ${{ github.event.client_payload.candidate_tag }}",
    );
    expect(workflow).toContain(
      'test "$CANDIDATE_SHA" = "$(git rev-parse "origin/$DEFAULT_BRANCH")"',
    );
    expect(workflow).toContain('test "$CANDIDATE_SHA" = "$GITHUB_SHA"');
    expect(workflow).toContain("listPullRequestsAssociatedWithCommit");
    expect(workflow).toContain('trustedWorkflowPath = ".github/workflows/ci.yml"');
    expect(workflow).toContain("github.rest.actions.getWorkflow");
    expect(workflow).toContain("github.rest.actions.listWorkflowRuns");
    expect(workflow).toContain('event: "push"');
    expect(workflow).toContain(
      "run.head_branch === context.payload.repository.default_branch",
    );
    expect(workflow).toContain(
      "run.head_sha === process.env.CANDIDATE_SHA",
    );
    expect(workflow).toContain(
      "run.head_repository?.full_name === repository",
    );
    expect(workflow).toContain("github.rest.checks.listForSuite");
    expect(workflow).toContain('run.app?.slug !== "github-actions"');
    expect(workflow).toContain(
      "run.check_suite?.id !== trustedRun.check_suite_id",
    );
    expect(workflow).toContain("candidate required checks are not green");
    expect(workflow).toContain('"production-database-compatibility"');
    expect(workflow).toContain("ref: ${{ steps.candidate.outputs.sha }}");
    expect(workflow).toContain(
      'node scripts/check-release.mjs --require-exact-tag "$CANDIDATE_TAG"',
    );
    expect(workflow.indexOf("Verify annotated RC identity")).toBeLessThan(
      workflow.indexOf("pnpm install --frozen-lockfile"),
    );
    expect(workflow).toContain(
      "name: rc-playwright-${{ matrix.project }}-${{ env.CANDIDATE_TAG }}",
    );
    expect(workflow).toContain(
      "name: rc-system-failure-${{ env.CANDIDATE_TAG }}",
    );
    expect(workflow).toMatch(
      /name: Upload browser failure artifacts\s*\n\s+if: failure\(\)/u,
    );
    expect(workflow).toMatch(
      /name: Upload stitched-system failure artifacts\s*\n\s+if: failure\(\)/u,
    );
  });

  test("isolates exact-SHA offline, browser, production-database, and system validation from publishing authority", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const authorization = job(workflow, "authorize");
    const offline = job(workflow, "validate_offline");
    const browser = job(workflow, "validate_browser");
    const productionDatabase = job(workflow, "validate_production_database");
    const system = job(workflow, "validate_system");
    const publishing = job(workflow, "publish");

    expect(workflow).toContain("permissions: {}");
    expect(authorization).toMatch(
      /permissions:\s*\n\s+actions: read\s*\n\s+attestations: read\s*\n\s+checks: read\s*\n\s+contents: read\s*\n\s+packages: read\s*\n\s+pull-requests: read/u,
    );
    for (const validation of [offline, browser, productionDatabase, system]) {
      expect(validation).toContain("needs: [authorize]");
      expect(validation).toMatch(/permissions:\s*\n\s+contents: read/u);
      expect(validation).toContain(
        "ref: ${{ needs.authorize.outputs.source_revision }}",
      );
      expect(validation).toContain(
        'node scripts/check-release.mjs --require-exact-tag "$CANDIDATE_TAG"',
      );
      expect(validation.indexOf("Verify annotated RC identity")).toBeLessThan(
        validation.indexOf("pnpm install --frozen-lockfile"),
      );
      expect(validation).not.toMatch(
        /^\s+(?:packages|id-token|attestations):\s+write\s*$/mu,
      );
    }
    expect(offline).toContain("pnpm test:coverage");
    expect(offline).toContain("pnpm test:database");
    expect(browser).toContain(
      "matrix:\n        project: [mobile-320, mobile-390, mobile-430, desktop]",
    );
    expect(browser).toContain(
      "pnpm exec playwright install --with-deps chromium-headless-shell webkit",
    );
    expect(browser).toContain("pnpm test:e2e --project=${{ matrix.project }}");
    expect(productionDatabase).toContain(
      "image: ghcr.io/railwayapp-templates/postgres-ssl:18@sha256:764fabc5fceb7166414c425a57bed8722a08cfb7fff508efb21a86eb31e172a6",
    );
    expect(productionDatabase).toContain("pnpm test:database:preflight");
    expect(productionDatabase).toContain("pnpm db:migrate");
    expect(productionDatabase).toContain("pnpm test:database");
    expect(productionDatabase).not.toContain("pnpm test:coverage");
    expect(system).toContain(
      "pnpm exec playwright install --with-deps chromium-headless-shell",
    );
    expect(system).toContain("pnpm test:e2e:system");
    expect(publishing).toContain(
      "needs: [authorize, validate_offline, validate_browser, validate_production_database, validate_system]",
    );
    expect(publishing).toContain(
      "needs.validate_offline.result == 'success' && needs.validate_browser.result == 'success' && needs.validate_production_database.result == 'success' && needs.validate_system.result == 'success'",
    );
    expect(publishing).toMatch(
      /permissions:\s*\n\s+attestations: write\s*\n\s+contents: read\s*\n\s+id-token: write\s*\n\s+packages: write/u,
    );
    expect(publishing).not.toContain("playwright");
    expect(publishing).not.toContain("pnpm test:e2e");
    expect(publishing).toContain("platforms: linux/amd64");
    expect(publishing).toContain("Require image-build disk headroom");
    expect(publishing.indexOf("Require image-build disk headroom")).toBeLessThan(
      publishing.indexOf("docker/setup-buildx-action@"),
    );
    for (const section of [
      authorization,
      offline,
      browser,
      productionDatabase,
      system,
      publishing,
    ]) {
      expect(section).toContain("runs-on: ubuntu-latest");
      expect(section).toContain("actions/checkout@");
    }
  });

  test("guards disk headroom after pruning only known package-manager caches", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const offline = job(workflow, "validate_offline");
    const browser = job(workflow, "validate_browser");
    const productionDatabase = job(workflow, "validate_production_database");
    const system = job(workflow, "validate_system");

    for (const validation of [offline, browser, productionDatabase, system]) {
      expect(validation).toContain("pnpm store prune");
      expect(validation).toContain("sudo apt-get clean");
      expect(validation).toContain('df --output=avail -k "$GITHUB_WORKSPACE"');
      expect(validation).toContain("At least 8 GiB of free disk is required");
      expect(validation).not.toMatch(/\brm\s+-rf\b/u);
      expect(validation).not.toContain("docker system prune");
    }
    expect(offline.indexOf("Require build disk headroom")).toBeLessThan(
      offline.indexOf("pnpm build"),
    );
    expect(offline.indexOf("Require coverage disk headroom")).toBeLessThan(
      offline.indexOf("pnpm test:coverage"),
    );
    expect(browser.indexOf("Require browser disk headroom")).toBeLessThan(
      browser.indexOf("pnpm test:e2e --project="),
    );
    expect(
      productionDatabase.indexOf("Require production-database disk headroom"),
    ).toBeLessThan(productionDatabase.indexOf("pnpm db:migrate"));
    expect(system.indexOf("Require stitched-system disk headroom")).toBeLessThan(
      system.indexOf("pnpm test:e2e:system"),
    );
  });

  test("pins current authorities but derives the semantic baseline only from the exact immutable stable predecessor", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const authorization = job(workflow, "authorize");
    const offline = job(workflow, "validate_offline");
    const publishing = job(workflow, "publish");

    expect(authorization).toContain(
      "release_verification_key_sha256: ${{ steps.release_authority.outputs.sha256 }}",
    );
    expect(authorization).toContain(
      "public_rollout_intent_canary_authority_policy_sha256: ${{ steps.release_authority.outputs.public_rollout_intent_canary_authority_policy_sha256 }}",
    );
    expect(authorization).toContain(
      "semantic_baseline_metadata_sha256: ${{ steps.stable_predecessor.outputs.metadata_sha256 }}",
    );
    expect(authorization).toContain(
      "semantic_baseline_stable_tag: ${{ steps.stable_predecessor.outputs.stable_tag }}",
    );
    expect(authorization).toContain(
      "semantic_baseline_release_key_sha256: ${{ steps.stable_predecessor.outputs.release_key_sha256 }}",
    );
    expect(authorization).toContain(
      "semantic_baseline_stable_authorizer_key_sha256: ${{ steps.stable_predecessor.outputs.stable_authorizer_key_sha256 }}",
    );
    expect(authorization).toContain(
      "semantic_baseline_handoff_sha256: ${{ steps.semantic_baseline_handoff.outputs.sha256 }}",
    );
    expect(authorization).toContain(
      "RELEASE_VERIFICATION_KEY_SHA256: ${{ vars.RELEASE_VERIFICATION_KEY_SHA256 }}",
    );
    expect(authorization).toContain(
      "RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256: ${{ vars.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256 }}",
    );
    expect(authorization).toContain(
      '[[ ! "$RELEASE_VERIFICATION_KEY_SHA256" =~ ^[0-9a-f]{64}$ ]]',
    );
    for (const variable of [
      "RELEASE_SEMANTIC_BASELINE_METADATA_SHA256",
      "RELEASE_SEMANTIC_BASELINE_STABLE_TAG",
      "RELEASE_SEMANTIC_BASELINE_RELEASE_KEY_SHA256",
      "RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_ID",
      "RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_SHA256",
    ]) {
      expect(authorization).not.toContain(`\${{ vars.${variable} }}`);
    }
    expect(authorization.indexOf("Pin the release verification authority"))
      .toBeLessThan(authorization.indexOf("Resolve merged candidate"));
    expect(authorization).toContain(
      "Resolve the exact immutable stable predecessor and signed lineage",
    );
    expect(authorization).toContain(
      '"GET /repos/{owner}/{repo}/immutable-releases"',
    );
    expect(authorization).toContain("github.rest.repos.listReleases");
    expect(authorization).toContain("github.rest.git.listMatchingRefs");
    expect(authorization).toContain(
      "candidate version must be greater than every existing stable tag and release",
    );
    expect(authorization).toContain(
      "lowerStableVersions.sort(",
    );
    expect(authorization).toContain("selected.immutable !== true");
    expect(authorization).toContain(
      '"protected-semantic-baseline.json"',
    );
    expect(authorization).toContain('"finalization-evidence.json"');
    expect(authorization).toContain('"stable-authorization.json"');
    expect(authorization).toContain('"stable-image-attestation.json"');
    expect(authorization).toContain('"stable-release-consumer.json"');
    expect(authorization).toContain(
      '"genio-semantic-ranking-protected-baseline/v2"',
    );
    expect(authorization).toContain(
      '"genio-signed-release-evidence/v3"',
    );
    expect(authorization).toContain(
      '"genio-signed-stable-release-authorization/v2"',
    );
    expect(authorization).toContain(
      '"genio-stable-release-consumer-manifest/v2"',
    );
    expect(authorization).toContain(
      "payloadHash !== stableSha256(payload)",
    );
    expect(authorization).toContain(
      "authorizationPayload.protectedBaselineMetadataHash",
    );
    expect(authorization).toContain(
      "consumer.protectedBaselineMetadataHash !== metadataSha256",
    );
    expect(authorization).toContain(
      "releaseKeySha256 === stableAuthorizerKeySha256",
    );
    expect(authorization).toContain(
      'const handoffDirectory = "semantic-baseline-handoff"',
    );
    expect(authorization).toContain(
      "await writeFile(join(handoffDirectory, name), bytes",
    );
    expect(authorization).toContain(
      "HISTORICAL_RELEASE_PUBLIC_KEY_B64URL: ${{ secrets.RELEASE_SEMANTIC_BASELINE_RELEASE_PUBLIC_KEY_B64URL }}",
    );
    expect(authorization).toContain(
      "HISTORICAL_STABLE_AUTHORIZER_PUBLIC_KEY_B64URL: ${{ secrets.RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_PUBLIC_KEY_B64URL }}",
    );
    expect(authorization).toContain(
      "scripts/semantic-baseline-handoff.ts create",
    );
    expect(authorization).toContain(
      "--asset-sha256-json-b64url \"$PREDECESSOR_ASSET_SHA256_JSON_B64URL\"",
    );
    expect(authorization).toContain(
      "name: semantic-baseline-handoff-${{ steps.identity.outputs.candidate_tag }}",
    );
    expect(authorization).not.toContain(
      "${{ vars.RELEASE_SEMANTIC_BASELINE_RELEASE_PUBLIC_KEY_B64URL }}",
    );
    expect(authorization).not.toContain(
      "${{ vars.RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_PUBLIC_KEY_B64URL }}",
    );
    expect(authorization).toContain("github.rest.git.getTag");
    expect(authorization).toContain(
      "github.rest.repos.compareCommitsWithBasehead",
    );
    expect(authorization).toContain(
      "Reverify the predecessor image's keyless provenance",
    );
    expect(authorization).toContain(
      '--source-digest "$BASELINE_SIGNER_SOURCE_DIGEST"',
    );
    expect(authorization).toContain(
      '--signer-workflow "$GITHUB_REPOSITORY/$BASELINE_SIGNER_WORKFLOW"',
    );
    expect(authorization).toContain(
      "fresh GitHub verification does not match the bootstrap image attestation canonical hash",
    );
    expect(authorization).toContain(
      "Reverify the predecessor through the shared strict dispatcher",
    );
    expect(authorization).toContain(
      'import { verifyHistoricalStablePredecessor } from "./scripts/historical-stable-predecessor.ts"',
    );
    expect(authorization).toContain(
      "name: semantic-baseline-github-verification-${{ steps.identity.outputs.candidate_tag }}",
    );
    expect(authorization).toContain(
      "semantic-baseline-handoff/predecessor-image-attestation-verification.json",
    );
    expect(authorization).toContain(
      "--predecessor-mode \"$PREDECESSOR_MODE\"",
    );
    expect(authorization).toContain(
      "--predecessor-controller-source-revision \"$PREDECESSOR_CONTROLLER_SOURCE_REVISION\"",
    );
    expect(authorization).toContain(
      "controllerSourceRevision ?? imageSignerSourceDigest",
    );
    expect(offline).toContain(
      "Recheck the exact immutable predecessor before publication",
    );
    expect(offline).toContain(
      "EXPECTED_RELEASE_IDENTITY_SHA256: ${{ needs.authorize.outputs.semantic_baseline_release_identity_sha256 }}",
    );
    expect(offline).toContain("github.rest.repos.getReleaseByTag");
    expect(offline).toContain("github.rest.repos.listReleases");
    expect(offline).toContain("github.rest.git.listMatchingRefs");
    expect(offline).toContain(
      "candidate version is no longer greater than every stable tag and release",
    );
    expect(offline).toContain(
      "observed !== expectedAssetSha256[name]",
    );
    expect(offline).toContain(
      "releaseIdentitySha256",
    );
    expect(offline.indexOf("Recheck the exact immutable predecessor"))
      .toBeLessThan(offline.indexOf("pnpm install --frozen-lockfile"));
    expect(publishing).toContain(
      "Reconfirm the predecessor is still greatest before image publication",
    );
    expect(publishing).toContain("github.rest.repos.listReleases");
    expect(publishing).toContain("github.rest.git.listMatchingRefs");
    expect(publishing).toContain(
      "candidate version is no longer greater than every stable tag and release",
    );
    expect(publishing).toContain(
      "predecessor?.id !== expectedReleaseId",
    );
    expect(publishing.indexOf("Reconfirm the predecessor is still greatest"))
      .toBeLessThan(publishing.indexOf("pnpm install --frozen-lockfile"));
    expect(publishing).toContain(
      "RELEASE_VERIFICATION_KEY_SHA256: ${{ needs.authorize.outputs.release_verification_key_sha256 }}",
    );
    expect(publishing).toContain(
      "RELEASE_SEMANTIC_BASELINE_METADATA_SHA256: ${{ needs.authorize.outputs.semantic_baseline_metadata_sha256 }}",
    );
    expect(publishing).toContain(
      "RELEASE_SEMANTIC_BASELINE_HANDOFF_SHA256: ${{ needs.authorize.outputs.semantic_baseline_handoff_sha256 }}",
    );
    expect(publishing).toContain(
      "RELEASE_SEMANTIC_BASELINE_PREDECESSOR_MODE: ${{ needs.authorize.outputs.semantic_baseline_predecessor_mode }}",
    );
    expect(publishing).toContain(
      "RELEASE_SEMANTIC_BASELINE_CONTROLLER_SOURCE_REVISION: ${{ needs.authorize.outputs.semantic_baseline_controller_source_revision }}",
    );
    expect(publishing).toContain(
      "RELEASE_SEMANTIC_BASELINE_GITHUB_ATTESTATION_VERIFICATION_BYTES_SHA256: ${{ needs.authorize.outputs.semantic_baseline_github_attestation_verification_bytes_sha256 }}",
    );
    expect(publishing).toContain(
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    );
    expect(publishing).toContain(
      "scripts/semantic-baseline-handoff.ts verify",
    );
    expect(publishing).toContain(
      "--expected-manifest-sha256 \"$RELEASE_SEMANTIC_BASELINE_HANDOFF_SHA256\"",
    );
    expect(publishing).toContain(
      "--predecessor-mode \"$RELEASE_SEMANTIC_BASELINE_PREDECESSOR_MODE\"",
    );
    expect(publishing).toContain(
      "--predecessor-controller-source-revision \"$RELEASE_SEMANTIC_BASELINE_CONTROLLER_SOURCE_REVISION\"",
    );
    expect(publishing).toContain(
      "semanticBaselineHandoffSha256:process.env.RELEASE_SEMANTIC_BASELINE_HANDOFF_SHA256",
    );
    expect(publishing).toContain("semantic-baseline-handoff/");
    expect(publishing).toContain(
      "semanticBaselineMetadataSha256:process.env.RELEASE_SEMANTIC_BASELINE_METADATA_SHA256",
    );
    expect(publishing).toContain(
      'schemaVersion:"genio-release-image/v2"',
    );
    expect(publishing).toContain(
      "semanticBaselinePredecessorMode:process.env.RELEASE_SEMANTIC_BASELINE_PREDECESSOR_MODE",
    );
    expect(publishing).toContain(
      "semanticBaselineControllerSourceRevision:process.env.RELEASE_SEMANTIC_BASELINE_CONTROLLER_SOURCE_REVISION",
    );
    expect(publishing).toContain(
      "semanticBaselineGithubAttestationVerificationBytesSha256:process.env.RELEASE_SEMANTIC_BASELINE_GITHUB_ATTESTATION_VERIFICATION_BYTES_SHA256",
    );
    expect(publishing).toContain(
      "GENIO_RELEASE_VERIFICATION_KEY_SHA256=${{ needs.authorize.outputs.release_verification_key_sha256 }}",
    );
    expect(publishing).toContain(
      "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256=${{ needs.authorize.outputs.public_rollout_intent_canary_authority_policy_sha256 }}",
    );
    expect(publishing).toContain(
      "publicRolloutIntentCanaryAuthorityPolicySha256:process.env.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256",
    );
    expect(publishing).not.toContain(
      "GENIO_RELEASE_VERIFICATION_KEY_SHA256=${{ vars.RELEASE_VERIFICATION_KEY_SHA256 }}",
    );
  });

  test("admits the one-time predecessor only through an exact bootstrap schema pair", async () => {
    const authorization = job(
      await readFile(workflowUrl, "utf8"),
      "authorize",
    );
    for (const schema of [
      "genio-signed-release-evidence/v3",
      "genio-release-evidence/v3",
      "genio-signed-stable-release-authorization/v2",
      "genio-stable-release-authorization/v2",
      "genio-signed-stable-predecessor-bootstrap-evidence/v1",
      "genio-stable-predecessor-bootstrap-evidence/v1",
      "genio-signed-stable-predecessor-bootstrap-authorization/v1",
      "genio-stable-predecessor-bootstrap-authorization/v1",
    ]) {
      expect(authorization).toContain(schema);
    }
    expect(authorization).toContain(
      "if (normalSchemaPair === bootstrapSchemaPair)",
    );
    expect(authorization).toContain(
      "evidence and authorization must use one exact supported schema pair",
    );
    expect(authorization).toContain(
      'const BOOTSTRAP_SUCCESSOR_RC = /^v2\\.4\\.0-rc\\.[1-9]\\d*$/u',
    );
    expect(authorization).toContain(
      'const BOOTSTRAP_STABLE_TAG = "v2.3.4"',
    );
    expect(authorization).toContain(
      '"7dc877cfc1537a9936974f9699a4b8ba9740b5f5"',
    );
    expect(authorization).toContain(
      '"0fb63ccc88b6f5ea675b3b43506fc112fa3fae58"',
    );
    expect(authorization).toContain(
      '"91076c2f06de9d562532981c3a602f1c6366f057"',
    );
    expect(authorization).toContain(
      'const BOOTSTRAP_CONTROLLER_WORKFLOW =\n              ".github/workflows/bootstrap-stable-predecessor.yml"',
    );
    expect(authorization).toContain(
      'const BOOTSTRAP_IMAGE_WORKFLOW =\n              ".github/workflows/bootstrap-stable-predecessor-image.yml"',
    );
    expect(authorization).toContain(
      'successorPolicy.version !== "2.4.0"',
    );
    expect(authorization).toContain(
      "sourceTreeObjectSha256",
    );
    expect(authorization).toContain(
      "wrapperFixtureEvidenceHash",
    );
    expect(authorization).toContain(
      "reconstruction_wrapper_only_not_historical_production_equivalence",
    );
    expect(authorization).toContain(
      "wrapper_fixture_evidence_does_not_prove_historical_production_output_equivalence",
    );
    expect(authorization).toContain(
      "authorization.payload.producerKeySha256",
    );
    expect(authorization).toContain(
      "authorization.payload.sitesKeySha256",
    );
    expect(authorization).toContain(
      "successorReleaseExists || successorTagExists",
    );
    expect(authorization).toContain(
      'ref: "tags/v2.4.0"',
    );
    expect(authorization).toContain(
      'annotatedTag.data.message !== "Release v2.3.4\\n"',
    );
    expect(authorization).toContain(
      "sourceCommit.data.tree.sha !== BOOTSTRAP_SOURCE_TREE",
    );
    expect(authorization).toContain(
      "controllerAncestry.data.merge_base_commit?.sha",
    );
    expect(authorization).toContain(
      "imageAttestation.workflowSourceRevision",
    );
    expect(authorization).toContain(
      "imageAttestation.githubVerificationHash",
    );
    expect(authorization).toContain(
      "predecessor schema mode and GitHub verification binding differ",
    );
  });

  test("the bootstrap builds evidence but cannot deploy Railway or Sites", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    expect(workflow).toContain(
      "docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6",
    );
    expect(workflow).toContain(
      "actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a # v3",
    );
    expect(workflow).toContain(
      "actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6 # v4",
    );
    expect(workflow).toContain("gh attestation verify release-offline-suite.json");
    expect(workflow).toContain("--deny-self-hosted-runners");
    expect(workflow).toContain("--source-digest \"$TRUSTED_WORKFLOW_SHA\"");
    expect(workflow).not.toContain("RELEASE_GATE_PRODUCER_PRIVATE_KEY_PEM");
    expect(workflow).not.toContain("release-offline-suite.attestation.json");
    expect(workflow).not.toMatch(/\brailway\s+config\s+(?:apply|stage)\b/iu);
    expect(workflow).not.toMatch(/\b(?:deploy|publish)[^\n]*(?:Railway|Sites)\b/iu);
    expect(workflow).not.toContain("openai/sites");
  });

  test("serializes stable mutations and fences the predecessor after build but before push and attestation", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const publishing = job(workflow, "publish");
    expect(workflow).toContain(
      "concurrency:\n  group: stable-release-mutation\n  cancel-in-progress: false",
    );
    const build = publishing.indexOf(
      "Build the candidate image without registry mutation",
    );
    const fence = publishing.indexOf(
      "Recheck stable monotonicity after build and immediately before image push",
    );
    const push = publishing.indexOf(
      "Push the already-built candidate only after the final fence",
    );
    const attestation = publishing.indexOf("Attest image provenance");
    expect(build).toBeGreaterThan(0);
    expect(fence).toBeGreaterThan(build);
    expect(push).toBeGreaterThan(fence);
    expect(attestation).toBeGreaterThan(push);
    expect(publishing.slice(build, fence)).toContain("load: true");
    expect(publishing.slice(build, fence)).toContain("provenance: false");
    expect(publishing.slice(build, fence)).not.toContain("push: true");
    expect(publishing).toContain(
      "subject-digest: ${{ steps.push.outputs.digest }}",
    );
    expect(publishing).toContain(
      "candidate version is no longer greater than every stable tag and release",
    );
    expect(workflow).toContain(
      '"originalRailwayProvenanceArtifactHash"',
    );
    expect(workflow).toContain(
      "authorization.payload.originalRailwayProvenanceKeySha256",
    );
  });

  test("embeds the immutable source identity inside the promoted image", async () => {
    const [workflow, dockerfile, buildInfo] = await Promise.all([
      readFile(workflowUrl, "utf8"),
      readFile(dockerfileUrl, "utf8"),
      readFile(buildInfoUrl, "utf8"),
    ]);
    expect(workflow).toContain(
      "GENIO_BUILD_REVISION=${{ needs.authorize.outputs.source_revision }}",
    );
    expect(workflow).toContain(
      "GENIO_BUILD_VERSION=${{ needs.authorize.outputs.version }}",
    );
    expect(workflow).toContain("platforms: linux/amd64");
    expect(dockerfile).toContain('schemaVersion:"genio-embedded-build/v1"');
    expect(dockerfile).toContain(
      "publicRolloutIntentCanaryAuthorityPolicySha256",
    );
    expect(dockerfile).toContain("org.opencontainers.image.revision");
    expect(buildInfo).toContain("../.genio-build.json");
    expect(buildInfo.indexOf("const embedded = embeddedBuildInformation()"))
      .toBeLessThan(buildInfo.indexOf("env.SOURCE_COMMIT_SHA"));
  });
});
