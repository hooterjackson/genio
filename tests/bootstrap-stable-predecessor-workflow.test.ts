import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const workflowUrl = new URL(
  "../.github/workflows/bootstrap-stable-predecessor.yml",
  import.meta.url,
);

async function workflowSections(): Promise<{
  workflow: string;
  recovery: string;
  verifier: string;
  finalAuthorization: string;
  publish: string;
}> {
  const workflow = await readFile(workflowUrl, "utf8");
  const recoveryIndex = workflow.indexOf("  verify_recovered_observation:");
  const verifierIndex = workflow.indexOf("  verify_and_seal:");
  const finalIndex = workflow.indexOf("  final_reauthorize:");
  const publishIndex = workflow.indexOf("  publish:");
  expect(recoveryIndex).toBeGreaterThan(0);
  expect(verifierIndex).toBeGreaterThan(recoveryIndex);
  expect(finalIndex).toBeGreaterThan(verifierIndex);
  expect(publishIndex).toBeGreaterThan(finalIndex);
  return {
    workflow,
    recovery: workflow.slice(recoveryIndex, verifierIndex),
    verifier: workflow.slice(verifierIndex, finalIndex),
    finalAuthorization: workflow.slice(finalIndex, publishIndex),
    publish: workflow.slice(publishIndex),
  };
}

describe("one-time v2.3.4 stable predecessor bootstrap workflow", () => {
  test("is a bounded default-branch repository dispatch with fixed historical identity", async () => {
    const { workflow } = await workflowSections();
    expect(workflow).toContain("repository_dispatch:");
    expect(workflow).toContain(
      "types: [genio-stable-predecessor-bootstrap-v2-3-4]",
    );
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+push:\s*$/mu);
    expect(workflow).toContain("BOOTSTRAP_REPOSITORY: hooterjackson/genio");
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
      'test "$GITHUB_WORKFLOW_SHA" = "$GITHUB_SHA"',
    );
    expect(workflow).toContain(
      'test "$GITHUB_SHA" = "$(git rev-parse "origin/$DEFAULT_BRANCH")"',
    );
  });

  test("cannot create, move, or delete the historical tag", async () => {
    const { workflow } = await workflowSections();
    expect(workflow).not.toMatch(/^\s+git\s+tag(?:\s|$)/mu);
    expect(workflow).not.toMatch(/^\s+git\s+push(?:\s|$)/mu);
    expect(workflow).not.toMatch(/^\s+git\s+update-ref(?:\s|$)/mu);
    expect(workflow).not.toContain("github.rest.git.createRef");
    expect(workflow).not.toContain("github.rest.git.updateRef");
    expect(workflow).not.toContain("github.rest.git.deleteRef");
    expect(workflow).not.toMatch(/gh release delete(?:\s|")/u);
    expect(workflow).toContain("--verify-tag");
    expect(workflow).toContain('tag.data.message !== "Release v2.3.4\\n"');
  });

  test("accepts only five bounded inputs and no selected successor", async () => {
    const { workflow } = await workflowSections();
    for (const key of [
      "finalization_evidence_b64url",
      "image_digest",
      "protected_baseline_metadata_b64url",
      "recovered_railway_observation_b64url",
      "stable_authorization_b64url",
    ]) {
      expect(workflow).toContain(`"${key}"`);
    }
    expect(workflow).toContain(
      "JSON.stringify(payloadKeys) !== JSON.stringify(expectedPayloadKeys)",
    );
    expect(workflow).toContain("payloadKeys.length > 10");
    expect(workflow).toContain("value.length > 24_000");
    expect(workflow).toContain("bytes.length > 18_000");
    expect(workflow).not.toMatch(
      /client_payload\.(?:candidate|successor|source_revision|stable_tag|rc_tag)/u,
    );
  });

  test("separates audit authority and writer authority across environments", async () => {
    const {
      workflow,
      recovery,
      verifier,
      finalAuthorization,
      publish,
    } = await workflowSections();
    for (const auditSection of [recovery, verifier, finalAuthorization]) {
      expect(auditSection).toContain("environment: release-control-audit");
      expect(auditSection).toContain(
        "app-id: ${{ vars.RELEASE_CONTROL_AUDITOR_APP_ID }}",
      );
      expect(auditSection).toContain(
        "private-key: ${{ secrets.RELEASE_CONTROL_AUDITOR_APP_PRIVATE_KEY }}",
      );
      expect(auditSection).toContain("permission-administration: write");
      expect(auditSection).toContain("permission-actions: read");
      expect(auditSection).toContain("permission-checks: read");
      expect(auditSection).toContain("permission-contents: read");
      expect(auditSection).toContain("permission-pull-requests: read");
      expect(auditSection).not.toContain(
        "secrets.STABLE_RELEASE_WRITER_APP_PRIVATE_KEY",
      );
      expect(auditSection).not.toContain("permission-contents: write");
    }
    expect(publish).toContain("environment: stable-predecessor-bootstrap");
    expect(publish).toContain(
      "private-key: ${{ secrets.STABLE_RELEASE_WRITER_APP_PRIVATE_KEY }}",
    );
    expect(publish).toContain("permission-contents: write");
    expect(publish).not.toContain("RELEASE_CONTROL_AUDITOR_APP_PRIVATE_KEY");
    expect(publish).not.toContain("permission-administration:");
    expect(publish).not.toContain("permission-actions:");
    expect(publish).not.toContain("permission-checks:");
    expect(publish).not.toContain("permission-pull-requests:");
    expect(workflow).not.toContain("persist-credentials: true");
    expect(workflow).not.toContain(
      "STABLE_PREDECESSOR_BOOTSTRAP_CONTROL_PLANE_TOKEN",
    );
    expect(workflow).not.toContain("|| github.token");
  });

  test("preserves reduced historical claims and the four independent authorities", async () => {
    const { recovery, verifier } = await workflowSections();
    expect(recovery).toContain(
      "Validate the authenticated Railway observation and reduced claim",
    );
    expect(recovery).toContain(
      "validateStablePredecessorRecoveredRailwayObservationV1",
    );
    expect(recovery).toContain("registryReferenceRecovered!==false");
    expect(recovery).toContain("manifestBytesRecovered!==false");
    expect(recovery).toContain("supplyChainAttestationRecovered!==false");
    expect(verifier).toContain(
      "scripts/stable-predecessor-bootstrap.ts produce",
    );
    expect(verifier).toContain(
      "scripts/stable-predecessor-bootstrap.ts verify",
    );
    expect(verifier).toContain(
      "--confirm-v2-3-4-stable-predecessor-bootstrap",
    );
    for (const authority of [
      "RELEASE_VERIFICATION_KEY_SHA256",
      "RELEASE_STABLE_AUTHORIZER_KEY_SHA256",
      "RELEASE_GATE_PRODUCER_KEY_SHA256",
      "RELEASE_SITES_CONTROL_PLANE_KEY_SHA256",
    ]) {
      expect(verifier).toContain(authority);
    }
    expect(verifier).toContain("new Set([...hashes");
    expect(verifier).not.toContain("--original-railway-provenance");
    expect(verifier).not.toContain("RELEASE_ORIGINAL_RAILWAY_PROVENANCE");
  });

  test("reauthorizes the controller, protections, environments, and ruleset after sealing", async () => {
    const { workflow, finalAuthorization } = await workflowSections();
    expect(workflow).toContain(
      "concurrency:\n  group: stable-release-mutation\n  cancel-in-progress: false",
    );
    expect(finalAuthorization).toContain(
      "stable-predecessor-mutation-manifest.json",
    );
    expect(finalAuthorization).toContain(
      "github.rest.repos.getBranchProtection",
    );
    expect(finalAuthorization).toContain(
      "github.rest.repos.listPullRequestsAssociatedWithCommit",
    );
    expect(finalAuthorization).not.toContain("github.rest.pulls.listReviews");
    expect(finalAuthorization).toContain(
      "reviewerRule.reviewers.length !== 1",
    );
    expect(finalAuthorization).toContain(
      "!== context.repo.owner.toLowerCase()",
    );
    expect(finalAuthorization).toContain(
      "environment.data.prevent_self_review === true",
    );
    expect(finalAuthorization).not.toContain(
      'actor !== context.actor && state === "APPROVED"',
    );
    expect(finalAuthorization).toContain('"release-control-audit"');
    expect(finalAuthorization).toContain('"stable-predecessor-bootstrap"');
    expect(finalAuthorization).toContain(
      "GET /repos/{owner}/{repo}/immutable-releases",
    );
    expect(finalAuthorization).toContain(
      "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}",
    );
    expect(finalAuthorization).toContain(
      "Number(bypassActors[0]?.actor_id) !== stableWriterAppId",
    );
    expect(finalAuthorization).toContain("]).size !== 3");
    expect(finalAuthorization).toContain(
      'stableRefs[0]?.ref?.ref !== "refs/tags/v2.3.4"',
    );
    expect(finalAuthorization).toContain(
      'fail("one-time v2.3.4 bootstrap reachability closed")',
    );
    expect(finalAuthorization).toContain(
      "stable-predecessor-control-authorization.json",
    );
  });

  test("mints the writer only after a fresh sealed receipt and runs no repository code with it", async () => {
    const { verifier, finalAuthorization, publish } =
      await workflowSections();
    const verifierScript = verifier.indexOf(
      "Produce and verify the exact five bootstrap assets",
    );
    const manifest = verifier.indexOf(
      "Seal the bounded bootstrap mutation manifest",
    );
    const receipt = finalAuthorization.indexOf(
      "Seal the final bootstrap control authorization",
    );
    const immediate = publish.indexOf(
      "Reject a stale controller or historical tag before writer minting",
    );
    const writer = publish.indexOf(
      "Mint the repository-scoped stable writer only for mutation",
    );
    const mutation = publish.indexOf(
      "Create or reconcile only the exact v2.3.4 Release",
    );
    const postverify = publish.indexOf(
      "Verify the exact published immutable v2.3.4 Release read-only",
    );
    expect(verifierScript).toBeGreaterThan(0);
    expect(manifest).toBeGreaterThan(verifierScript);
    expect(receipt).toBeGreaterThan(0);
    expect(immediate).toBeGreaterThan(0);
    expect(writer).toBeGreaterThan(immediate);
    expect(mutation).toBeGreaterThan(writer);
    expect(postverify).toBeGreaterThan(mutation);
    expect(publish).toContain("now - authorizedAt > 5 * 60 * 1000");
    expect(publish).toContain(
      "bootstrap controller or annotated tag changed",
    );
    const writerMutation = publish.slice(mutation, postverify);
    expect(writerMutation).not.toContain("node");
    expect(writerMutation).not.toContain("scripts/");
    expect(writerMutation).not.toContain("gh api");
    expect(publish.slice(writer)).not.toContain(
      "RELEASE_CONTROL_AUDITOR_APP_PRIVATE_KEY",
    );
  });

  test("reconciles exactly five assets without weakening historical truth", async () => {
    const { workflow, publish } = await workflowSections();
    for (const asset of [
      "finalization-evidence.json",
      "protected-semantic-baseline.json",
      "stable-authorization.json",
      "stable-image-attestation.json",
      "stable-release-consumer.json",
    ]) {
      expect(workflow).toContain(asset);
    }
    expect(workflow).toContain("immutable v2.3.4 Release assets differ");
    expect(publish).toContain(
      'gh release delete-asset "$STABLE_TAG" "$ASSET" --yes',
    );
    expect(publish).toContain('gh release edit "$STABLE_TAG" --draft=false');
    expect(publish).toContain("release.immutable !== true");
    for (const line of [
      "gênio wrapper-backed stable predecessor v2.3.4",
      "Compatibility-RC: v2.3.4-rc.1",
      "Railway-Observation-Kind:",
      "Wrapper-Limitation:",
      "Historical-Artifact-Equivalence:",
      "Historical-Artifact-Identity:",
      "Tag-Ruleset-ID:",
      "Tag-Bypass-Integration-ID:",
    ]) {
      expect(workflow).toContain(line);
    }
  });
});
