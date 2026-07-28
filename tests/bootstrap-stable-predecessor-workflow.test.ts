import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const workflowUrl = new URL(
  "../.github/workflows/bootstrap-stable-predecessor.yml",
  import.meta.url,
);

async function workflowSections(): Promise<{
  workflow: string;
  recovery: string;
  publish: string;
}> {
  const workflow = await readFile(workflowUrl, "utf8");
  const recoveryIndex = workflow.indexOf("  verify_recovered_provenance:");
  const publishIndex = workflow.indexOf("  publish:");
  expect(recoveryIndex).toBeGreaterThan(0);
  expect(publishIndex).toBeGreaterThan(recoveryIndex);
  return {
    workflow,
    recovery: workflow.slice(recoveryIndex, publishIndex),
    publish: workflow.slice(publishIndex),
  };
}

describe("one-time v2.3.4 stable predecessor bootstrap workflow", () => {
  test("can only be loaded by a bounded repository dispatch on the real default branch", async () => {
    const { workflow } = await workflowSections();
    expect(workflow).toContain("repository_dispatch:");
    expect(workflow).toContain(
      "types: [genio-stable-predecessor-bootstrap-v2-3-4]",
    );
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+push:\s*$/mu);
    expect(workflow).toContain(
      "BOOTSTRAP_REPOSITORY: hooterjackson/genio",
    );
    expect(workflow).toContain(
      'test "$GITHUB_REF" = "refs/heads/$DEFAULT_BRANCH"',
    );
    expect(workflow).toContain(
      'test "$GITHUB_SHA" = "$(git rev-parse "origin/$DEFAULT_BRANCH")"',
    );
    expect(workflow).toContain(
      'test "$GITHUB_WORKFLOW_SHA" = "$GITHUB_SHA"',
    );
    expect(workflow).toContain(
      'test "$GITHUB_WORKFLOW_REF" = "$GITHUB_REPOSITORY/$BOOTSTRAP_WORKFLOW@refs/heads/$DEFAULT_BRANCH"',
    );
    expect(workflow).toContain(
      'context.repo.owner.toLowerCase() !== "hooterjackson"',
    );
    expect(workflow).toContain("context.payload.repository?.fork !== false");
    expect(workflow).toContain(
      'fail("forked, non-default, or replayed controller")',
    );
  });

  test("hard-codes the exact existing annotated tag object, commit, and tree", async () => {
    const { workflow } = await workflowSections();
    expect(workflow).toContain("STABLE_TAG: v2.3.4");
    expect(workflow).toContain(
      "ORIGINAL_TAG_OBJECT: 0fb63ccc88b6f5ea675b3b43506fc112fa3fae58",
    );
    expect(workflow).toContain(
      "ORIGINAL_SOURCE_REVISION: 7dc877cfc1537a9936974f9699a4b8ba9740b5f5",
    );
    expect(workflow).toContain(
      "ORIGINAL_SOURCE_TREE: 91076c2f06de9d562532981c3a602f1c6366f057",
    );
    expect(workflow).toContain(
      'test "$(git cat-file -t "$ORIGINAL_TAG_OBJECT")" = "tag"',
    );
    expect(workflow).toContain(
      'test "$(git rev-parse "$ORIGINAL_TAG_OBJECT^{}")" = "$ORIGINAL_SOURCE_REVISION"',
    );
    expect(workflow).toContain(
      'test "$(git rev-parse "$ORIGINAL_SOURCE_REVISION^{tree}")" = "$ORIGINAL_SOURCE_TREE"',
    );
    expect(workflow).toContain("github.rest.git.getRef");
    expect(workflow).toContain("github.rest.git.getTag");
    expect(workflow).toContain("github.rest.git.getCommit");
    expect(workflow).toContain(
      'tag.data.message !== "Release v2.3.4\\n"',
    );
  });

  test("contains no command or API path capable of creating, moving, or deleting a tag or ref", async () => {
    const { workflow } = await workflowSections();
    expect(workflow).not.toMatch(/^\s+git\s+tag(?:\s|$)/mu);
    expect(workflow).not.toMatch(/^\s+git\s+push(?:\s|$)/mu);
    expect(workflow).not.toMatch(/^\s+git\s+update-ref(?:\s|$)/mu);
    expect(workflow).not.toContain("github.rest.git.createRef");
    expect(workflow).not.toContain("github.rest.git.updateRef");
    expect(workflow).not.toContain("github.rest.git.deleteRef");
    expect(workflow).not.toMatch(
      /gh api [^\n]*(?:\/git\/refs|\/git\/tags)[^\n]*(?:POST|PATCH|DELETE)/u,
    );
    expect(workflow).not.toMatch(/gh release delete(?:\s|")/u);
    expect(workflow).not.toContain("persist-credentials: true");
    expect(workflow).toContain("--verify-tag");
  });

  test("accepts only six bounded inputs and no operator-selected successor identity", async () => {
    const { workflow } = await workflowSections();
    const payloadKeys = [
      "finalization_evidence_b64url",
      "image_digest",
      "original_railway_provenance_attestation_b64url",
      "protected_baseline_metadata_b64url",
      "recovered_production_provenance_b64url",
      "stable_authorization_b64url",
    ];
    for (const key of payloadKeys) expect(workflow).toContain(`"${key}"`);
    expect(workflow).toContain(
      "JSON.stringify(payloadKeys) !== JSON.stringify(expectedPayloadKeys)",
    );
    expect(workflow).toContain("payloadKeys.length > 10");
    expect(workflow).toContain('>= 64 * 1024');
    expect(workflow).toContain("value.length > 24_000");
    expect(workflow).toContain("bytes.length > 18_000");
    expect(workflow).not.toMatch(
      /client_payload\.(?:candidate|successor|source_revision|stable_tag|rc_tag)/u,
    );
    expect(workflow).not.toMatch(
      /"(?:candidate_tag|successor_tag|source_revision|stable_tag|rc_tag)"/u,
    );
  });

  test("keeps read-only provenance recovery separate from Release publication authority", async () => {
    const { recovery, publish } = await workflowSections();
    expect(recovery).toMatch(
      /permissions:\s*\n\s+contents: read/u,
    );
    expect(recovery).not.toMatch(/^\s+contents:\s+write\s*$/mu);
    expect(recovery).not.toContain("packages: write");
    expect(recovery).not.toContain("attestations: write");
    expect(recovery).not.toContain("id-token: write");
    expect(recovery).not.toContain("docker/build-push-action@");
    expect(recovery).not.toContain("docker/login-action@");
    expect(recovery).not.toContain("actions/attest@");
    expect(recovery).toContain(
      "Verify independently signed original Railway provenance",
    );
    expect(recovery).toContain(
      "verifyStablePredecessorOriginalRailwayProvenanceV1",
    );
    expect(recovery).toContain(
      "RELEASE_ORIGINAL_RAILWAY_PROVENANCE_PUBLIC_KEY_B64URL",
    );
    expect(recovery).not.toContain(
      "recovered original Railway image provenance has not yet been independently verified",
    );

    expect(publish).toMatch(
      /permissions:\s*\n\s+attestations: read\s*\n\s+contents: write\s*\n\s+packages: read/u,
    );
    expect(publish).not.toContain("id-token: write");
    expect(publish).not.toContain("docker/build-push-action@");
    expect(publish).toContain(
      'gh attestation verify "oci://$IMAGE_REFERENCE"',
    );
    expect(publish).toContain(
      '--signer-workflow "$GITHUB_REPOSITORY/$BOOTSTRAP_IMAGE_WORKFLOW"',
    );
    expect(publish).toContain('--source-digest "$GITHUB_SHA"');
    expect(publish).toContain("--deny-self-hosted-runners");
    expect(publish).toContain("--no-public-good");
    expect(publish).toContain(
      "--github-attestation-verification wrapper-attestation-verification.json",
    );
    expect(publish).toContain(
      "--recovered-production-provenance recovered-production-provenance.json",
    );
  });

  test("requires protected authority, reviewed green controller, exact rules, and immutable Releases before writes", async () => {
    const { recovery, publish } = await workflowSections();
    for (const section of [recovery, publish]) {
      expect(section).toContain(
        "STABLE_PREDECESSOR_BOOTSTRAP_CONTROL_PLANE_TOKEN",
      );
      expect(section).toContain("STABLE_PREDECESSOR_BOOTSTRAP_ACTOR");
      expect(section).toContain(
        "github.rest.repos.getCollaboratorPermissionLevel",
      );
      expect(section).toContain('permission.data.permission !== "admin"');
      expect(section).toContain("github.rest.repos.getBranchProtection");
      expect(section).toContain('"production-database-compatibility"');
      expect(section).toContain("github.rest.checks.listForRef");
      expect(section).toContain('conclusion !== "success"');
      expect(section).toContain(
        "GET /repos/{owner}/{repo}/environments/{environment_name}",
      );
      expect(section).toContain('"stable-predecessor-bootstrap"');
      expect(section).toContain(
        "deployment_branch_policy?.protected_branches",
      );
      expect(section).toContain('rule.type === "required_reviewers"');
      expect(section).toContain("prevent_self_review");
      expect(section).toContain(
        "GET /repos/{owner}/{repo}/immutable-releases",
      );
      expect(section).toContain(
        "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}",
      );
      expect(section).toContain('ruleset.data.target !== "tag"');
      expect(section).toContain('ruleset.data.enforcement !== "active"');
      expect(section).toContain('JSON.stringify(["refs/tags/v*"])');
      expect(section).toContain(
        'JSON.stringify(["refs/tags/v*-rc.*"])',
      );
      expect(section).toContain(
        'JSON.stringify(["creation", "deletion", "update"])',
      );
      expect(section).toContain(
        'bypassActors[0]?.actor_type !== "Integration"',
      );
      expect(section).toContain(
        "Number(bypassActors[0]?.actor_id) !== githubActionsAppId",
      );
    }
    expect(recovery).toContain(
      "github.rest.repos.listPullRequestsAssociatedWithCommit",
    );
    expect(recovery).toContain("github.rest.pulls.listReviews");
    expect(recovery).toContain(
      'actor !== context.actor && state === "APPROVED"',
    );

    const publishProtection = publish.indexOf(
      "Reauthorize the exact GitHub controls before Release writes",
    );
    const releaseWrite = publish.indexOf('gh release create "$STABLE_TAG"');
    expect(publishProtection).toBeGreaterThan(0);
    expect(releaseWrite).toBeGreaterThan(publishProtection);
  });

  test("closes the bootstrap boundary after v2.3.4 stops being greatest or v2.4.0 is published", async () => {
    const { workflow } = await workflowSections();
    expect(workflow).toContain("github.rest.git.listMatchingRefs");
    expect(workflow).toContain(
      'stableRefs[0]?.ref?.ref !== "refs/tags/v2.3.4"',
    );
    expect(workflow).toContain(
      'stableVersions[0]?.ref !== "refs/tags/v2.3.4"',
    );
    expect(workflow).toContain("const hasSuccessorOrLaterStable");
    expect(workflow).toContain("const predecessor = [2n, 3n, 4n]");
    expect(workflow).toContain(
      'fail("one-time v2.3.4 bootstrap reachability closed")',
    );
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$ORIGINAL_SOURCE_REVISION" "$GITHUB_SHA"',
    );
    expect(workflow).toContain("COMPATIBILITY_RC_TAG: v2.3.4-rc.1");
    expect(workflow).not.toContain("v2.5.0-rc.");
  });

  test("pins distinct verification keys and invokes the explicit bootstrap verifier", async () => {
    const { publish } = await workflowSections();
    expect(publish).toContain("RELEASE_VERIFICATION_KEY_SHA256");
    expect(publish).toContain("RELEASE_VERIFICATION_KEY_ID");
    expect(publish).toContain("RELEASE_STABLE_AUTHORIZER_KEY_ID");
    expect(publish).toContain("RELEASE_STABLE_AUTHORIZER_KEY_SHA256");
    expect(publish).toContain("RELEASE_GATE_PRODUCER_KEY_ID");
    expect(publish).toContain("RELEASE_GATE_PRODUCER_KEY_SHA256");
    expect(publish).toContain(
      "RELEASE_ORIGINAL_RAILWAY_PROVENANCE_KEY_SHA256",
    );
    expect(publish).toContain("RELEASE_SITES_CONTROL_PLANE_KEY_ID");
    expect(publish).toContain(
      "RELEASE_SITES_CONTROL_PLANE_KEY_SHA256",
    );
    expect(publish).toContain(
      "RELEASE_SITES_CONTROL_PLANE_VERIFICATION_KEY_B64URL",
    );
    expect(publish).toContain("new Set([...hashes");
    expect(publish).toContain(
      'git cat-file tag "$ORIGINAL_TAG_OBJECT"',
    );
    expect(publish).toContain(
      'git cat-file commit "$ORIGINAL_SOURCE_REVISION"',
    );
    expect(publish).toContain(
      'git cat-file tree "$ORIGINAL_SOURCE_TREE"',
    );
    expect(publish).toContain(
      'git show "$GITHUB_SHA:$BOOTSTRAP_WORKFLOW"',
    );
    for (const option of [
      "--controller-workflow-bytes",
      "--tag-object-bytes",
      "--source-commit-bytes",
      "--source-tree-object-bytes",
    ]) {
      expect(publish.match(new RegExp(option, "gu"))).toHaveLength(2);
    }
    expect(publish).toContain(
      "scripts/stable-predecessor-bootstrap.ts produce",
    );
    expect(publish).toContain(
      "scripts/stable-predecessor-bootstrap.ts verify",
    );
    expect(publish).toContain(
      "--confirm-v2-3-4-stable-predecessor-bootstrap",
    );
    expect(publish).toContain(
      "--recovered-production-provenance recovered-production-provenance.json",
    );
    expect(publish).toContain(
      "--original-railway-provenance original-railway-provenance.json",
    );
    expect(publish).toContain(
      "--sites-control-plane-trust-policy sites-control-plane-trust-policy.json",
    );
    expect(publish).toContain(
      "--expected-repository \"$GITHUB_REPOSITORY\"",
    );
    expect(publish).toContain(
      "--expected-default-branch \"$DEFAULT_BRANCH\"",
    );
  });

  test("shares the stable mutation lock and rechecks monotonicity immediately before publication", async () => {
    const { workflow, publish } = await workflowSections();
    expect(workflow).toContain(
      "concurrency:\n  group: stable-release-mutation\n  cancel-in-progress: false",
    );
    const verify = publish.indexOf(
      "Produce and verify the exact five bootstrap assets",
    );
    const fence = publish.indexOf(
      "Fence bootstrap monotonicity immediately before Release mutation",
    );
    const mutation = publish.indexOf(
      "Create or reconcile only the immutable v2.3.4 GitHub Release",
    );
    expect(verify).toBeGreaterThan(0);
    expect(fence).toBeGreaterThan(verify);
    expect(mutation).toBeGreaterThan(fence);
    expect(publish.slice(fence, mutation)).toContain(
      "v2.3.4 is no longer the greatest stable identity",
    );
  });

  test("reconciles exactly five assets and never repairs a published mismatch", async () => {
    const { publish } = await workflowSections();
    const expectedAssets = [
      "finalization-evidence.json",
      "protected-semantic-baseline.json",
      "stable-authorization.json",
      "stable-image-attestation.json",
      "stable-release-consumer.json",
    ];
    for (const asset of expectedAssets) expect(publish).toContain(asset);
    expect(publish).toContain("scripts/stable-release-assets.ts");
    expect(publish).toContain(
      'gh release delete-asset "$STABLE_TAG" "$ASSET" --yes',
    );
    expect(publish).toContain(
      'if(current.id!==before.id||current.id!==plan.releaseId',
    );
    expect(publish).toContain("||!current.draft");
    expect(publish).toContain(
      "v2.3.4 five-asset reconciliation did not converge exactly",
    );
    expect(publish).toContain(
      'gh release edit "$STABLE_TAG" --draft=false',
    );
    expect(publish).toContain("release.immutable!==true");
    expect(publish).not.toContain("gh release delete ");
    expect(publish).not.toContain("gh release delete\n");

    const reconcile = publish.indexOf(
      "scripts/stable-release-assets.ts",
    );
    const upload = publish.indexOf('gh release upload "$STABLE_TAG"');
    const compare = publish.indexOf(
      "cmp finalization-evidence.json exact-release-assets/finalization-evidence.json",
    );
    const publishRelease = publish.indexOf(
      'gh release edit "$STABLE_TAG" --draft=false',
    );
    const immutable = publish.lastIndexOf("release.immutable!==true");
    expect(reconcile).toBeGreaterThan(0);
    expect(upload).toBeGreaterThan(reconcile);
    expect(compare).toBeGreaterThan(upload);
    expect(publishRelease).toBeGreaterThan(compare);
    expect(immutable).toBeGreaterThan(publishRelease);
  });

  test("binds the reconstructed Release body without rewriting the historical tag annotation", async () => {
    const { publish } = await workflowSections();
    const requiredLines = [
      "gênio wrapper-backed stable predecessor v2.3.4",
      "Compatibility-RC: v2.3.4-rc.1",
      "Original-Tag-Object:",
      "Original-Source-Revision:",
      "Original-Source-Tree:",
      "Wrapper-Image-Digest:",
      "Railway-Observation-Kind:",
      "Wrapper-Limitation:",
      "Bootstrap-Evidence-SHA256:",
      "Protected-Semantic-Baseline-SHA256:",
      "Bootstrap-Authorization-SHA256:",
      "Bootstrap-Controller-Revision:",
      "Bootstrap-Workflow:",
      "Tag-Ruleset-ID:",
      "Tag-Bypass-Integration-ID:",
    ];
    for (const line of requiredLines) expect(publish).toContain(line);
    expect(publish).toContain(
      "stable-predecessor-release-notes.txt",
    );
    expect(publish).not.toContain(
      "existing stable tag annotation is not the exact verified release annotation",
    );
  });
});
