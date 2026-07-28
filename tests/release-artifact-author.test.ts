import {
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  loadStableReleaseFinalizationSourceBundleV2,
  parseReleaseArtifactAuthorArgs,
  validateFinalizationSourceAuthoringManifestV1,
} from "../scripts/release-artifact-author.ts";
import {
  STABLE_RELEASE_FINALIZATION_SOURCE_BUNDLE_SCHEMA_V2,
} from "../scripts/authorize-stable-release.ts";

const directories: string[] = [];
const gates = [
  "production_fixed_three_track",
  "production_affected_regression",
  "backend_release_convergence",
  "release_convergence",
  "final_custom_domain_browser",
] as const;

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "genio-finalization-source-author-"),
  );
  directories.push(directory);
  const file = async (name: string): Promise<string> => {
    const path = `${name}.json`;
    await writeFile(
      join(directory, path),
      `${JSON.stringify({ artifact: name })}\n`,
    );
    return path;
  };
  const receipts = {
    apple: await file("apple-receipt"),
    provider: await file("provider-receipt"),
    qaBudget: await file("qa-budget-receipt"),
  };
  const receiptKeys = {
    apple: await file("apple-receipt-key"),
    provider: await file("provider-receipt-key"),
    qaBudget: await file("qa-budget-receipt-key"),
  };
  const receiptPolicies = {
    apple: await file("apple-receipt-policy"),
    provider: await file("provider-receipt-policy"),
    qaBudget: await file("qa-budget-receipt-policy"),
  };
  const gateArtifactFiles = Object.fromEntries(
    await Promise.all(gates.map(async (gate) => [
      gate,
      await file(`gate-${gate}`),
    ])),
  );
  const gateProducerAttestationFiles = Object.fromEntries(
    await Promise.all(gates.map(async (gate) => [
      gate,
      await file(`gate-${gate}-attestation`),
    ])),
  );
  return {
    directory,
    manifest: {
      schemaVersion:
        "genio-stable-release-finalization-source-authoring-manifest/v1",
      promotionEvidenceFile: await file("promotion-evidence"),
      publicRolloutEvidenceFile: await file("public-rollout-evidence"),
      stagingControlPlaneEvidenceFile:
        await file("staging-control-plane-evidence"),
      stagingControlPlaneVerificationKeyFile:
        await file("staging-control-plane-key"),
      stagingControlPlaneTrustPolicyFile:
        await file("staging-control-plane-policy"),
      controlPlaneReceiptFiles: receipts,
      controlPlaneReceiptVerificationKeyFiles: receiptKeys,
      controlPlaneReceiptTrustPolicyFiles: receiptPolicies,
      gateArtifactFiles,
      gateProducerAttestationFiles,
    },
  };
}

describe("release artifact author", () => {
  test("loads the exact finalization source inventory from relative files", async () => {
    const value = await fixture();
    const bundle = await loadStableReleaseFinalizationSourceBundleV2(
      value.manifest,
      value.directory,
    );
    expect(bundle).toMatchObject({
      schemaVersion: STABLE_RELEASE_FINALIZATION_SOURCE_BUNDLE_SCHEMA_V2,
      promotionEvidence: { artifact: "promotion-evidence" },
      publicRolloutEvidence: { artifact: "public-rollout-evidence" },
      stagingControlPlaneEvidence: {
        artifact: "staging-control-plane-evidence",
      },
      controlPlaneReceipts: {
        apple: { artifact: "apple-receipt" },
        provider: { artifact: "provider-receipt" },
        qaBudget: { artifact: "qa-budget-receipt" },
      },
      gateArtifacts: {
        final_custom_domain_browser: {
          artifact: "gate-final_custom_domain_browser",
        },
      },
      gateProducerAttestations: {
        release_convergence: {
          artifact: "gate-release_convergence-attestation",
        },
      },
    });
  });

  test("rejects missing, extra, or misspelled source slots", async () => {
    const value = await fixture();
    const extra = structuredClone(value.manifest) as Record<string, unknown>;
    extra.unapproved = "extra.json";
    expect(() =>
      validateFinalizationSourceAuthoringManifestV1(extra)
    ).toThrow(/missing or unapproved/u);

    const missingGate = structuredClone(value.manifest);
    delete (
      missingGate.gateArtifactFiles as Record<string, string>
    ).release_convergence;
    expect(() =>
      validateFinalizationSourceAuthoringManifestV1(missingGate)
    ).toThrow(/missing or unapproved/u);
  });

  test("rejects manifest traversal, absolute paths, and symlinked directories", async () => {
    const value = await fixture();
    const traversal = structuredClone(value.manifest);
    traversal.promotionEvidenceFile = "../promotion-evidence.json";
    await expect(loadStableReleaseFinalizationSourceBundleV2(
      traversal,
      value.directory,
    )).rejects.toThrow(/normalized relative path without traversal/u);

    const absolute = structuredClone(value.manifest);
    absolute.promotionEvidenceFile = join(
      value.directory,
      "promotion-evidence.json",
    );
    await expect(loadStableReleaseFinalizationSourceBundleV2(
      absolute,
      value.directory,
    )).rejects.toThrow(/normalized relative path without traversal/u);

    const outside = await mkdtemp(
      join(tmpdir(), "genio-finalization-source-outside-"),
    );
    directories.push(outside);
    await writeFile(
      join(outside, "promotion-evidence.json"),
      '{"artifact":"outside"}\n',
    );
    await symlink(outside, join(value.directory, "linked"));
    const symlinked = structuredClone(value.manifest);
    symlinked.promotionEvidenceFile = "linked/promotion-evidence.json";
    await expect(loadStableReleaseFinalizationSourceBundleV2(
      symlinked,
      value.directory,
    )).rejects.toThrow(/without symlinks/u);
  });

  test("parses only the two create-only commands", () => {
    expect(parseReleaseArtifactAuthorArgs([
      "protected-baseline",
      "--finalization-evidence",
      "final.json",
      "--release-verification-key",
      "release.pub.pem",
      "--expected-rc-tag",
      "v2.4.0-rc.5",
      "--expected-version",
      "2.4.0",
      "--expected-revision",
      "a".repeat(40),
      "--expected-image-digest",
      `sha256:${"b".repeat(64)}`,
      "--output",
      "baseline.json",
    ])).toMatchObject({ command: "protected-baseline" });

    expect(() =>
      parseReleaseArtifactAuthorArgs(["dispatch"])
    ).toThrow(/Usage/u);
  });
});
