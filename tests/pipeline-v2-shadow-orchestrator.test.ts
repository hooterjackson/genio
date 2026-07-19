import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import {
  PIPELINE_SHADOW_RUN_ARTIFACT_SCHEMA,
  PIPELINE_V2_SHADOW_ORCHESTRATION_SCHEMA,
  orchestratePipelineV2ManifestShadow,
  type PipelineShadowRunArtifact,
  type PipelineV2ShadowOrchestrationRequest,
} from "../server/pipeline-v2-shadow-orchestrator.ts";
import type { ShadowCandidatePool } from "../server/pipeline-v2-shadow.ts";
import { sha256Hex } from "../server/security.ts";

function pool(pipelineVersion: ShadowCandidatePool["pipelineVersion"]): ShadowCandidatePool {
  const prefix = pipelineVersion === "legacy_v1" ? "v1" : "v2";
  return {
    pipelineVersion,
    policyVersion: pipelineVersion === "legacy_v1" ? "legacy_v1" : "relevance_first_2026_07",
    modelSnapshot: `${prefix}-snapshot`,
    sourceRunId: `${prefix}-run`,
    candidates: [{
      rank: 1,
      candidateId: `${prefix}-candidate`,
      appleSongId: "shared-apple-song",
      recordingFamilyKey: "shared-family",
      artist: "Artist",
      title: "Track",
      scopeBindingIds: [`${prefix}-binding`],
      includeInManifest: true,
      evidenceEligible: true,
      hardConstraintsSatisfied: true,
      versionCompatible: true,
      storefrontPlayable: true,
    }],
  };
}

function artifact(
  pipelineVersion: ShadowCandidatePool["pipelineVersion"],
  overrides: Partial<PipelineShadowRunArtifact> = {},
): PipelineShadowRunArtifact {
  const prefix = pipelineVersion === "legacy_v1" ? "v1" : "v2";
  return {
    schemaVersion: PIPELINE_SHADOW_RUN_ARTIFACT_SCHEMA,
    artifactId: `${prefix}-artifact`,
    exportedAt: pipelineVersion === "legacy_v1"
      ? "2026-07-19T20:00:00.000Z"
      : "2026-07-19T20:00:01.000Z",
    sourceInput: {
      promptHash: sha256Hex("same prompt"),
      selectionPlanHash: sha256Hex("same selection plan"),
      storefront: "us",
      targetTrackCount: 1,
    },
    candidatePool: pool(pipelineVersion),
    ...overrides,
  };
}

function request(): PipelineV2ShadowOrchestrationRequest {
  return {
    schemaVersion: PIPELINE_V2_SHADOW_ORCHESTRATION_SCHEMA,
    comparisonId: "paired-artifact-canary",
    primaryArtifact: artifact("legacy_v1"),
    shadowArtifact: artifact("catalog_first_v2"),
  };
}

describe("Pipeline V2 persisted-artifact shadow orchestration", () => {
  test("proves same input and compares both pipelines through immutable manifests", () => {
    const report = orchestratePipelineV2ManifestShadow(request());
    expect(report).toMatchObject({
      executionMode: "persisted_artifact_manifest_only",
      publicationCapability: "absent",
      primaryArtifactId: "v1-artifact",
      shadowArtifactId: "v2-artifact",
      manifestComparison: {
        executionMode: "manifest_only",
        publicationCapability: "absent",
        releaseDisposition: "independent_review_required",
        primary: { trackCount: 1 },
        shadow: { trackCount: 1 },
      },
    });
    expect(report.orchestrationHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test.each(["promptHash", "selectionPlanHash", "storefront", "targetTrackCount"] as const)(
    "fails closed when persisted artifacts disagree on %s",
    (field) => {
      const value = request();
      const replacement = field === "storefront" ? "gb"
        : field === "targetTrackCount" ? 2
          : sha256Hex(`different ${field}`);
      value.shadowArtifact.sourceInput = {
        ...value.shadowArtifact.sourceInput,
        [field]: replacement,
      };
      expect(() => orchestratePipelineV2ManifestShadow(value)).toThrow(new RegExp(`same ${field}`, "iu"));
    },
  );

  test("rejects injected publication capability and secrets before any write can run", () => {
    let writeAttempts = 0;
    expect(() => orchestratePipelineV2ManifestShadow({
      ...request(),
      publishManifest: () => { writeAttempts += 1; },
    })).toThrow(/invalid keys.*publishManifest/iu);
    const nested = request() as unknown as Record<string, unknown>;
    nested.shadowArtifact = {
      ...(nested.shadowArtifact as object),
      appleUserToken: "secret",
    };
    expect(() => orchestratePipelineV2ManifestShadow(nested)).toThrow(/invalid keys.*appleUserToken/iu);
    expect(writeAttempts).toBe(0);
  });

  test("has no network, repository, authorization, model, or publication dependency", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must remain absent"));
    const source = readFileSync(new URL("../server/pipeline-v2-shadow-orchestrator.ts", import.meta.url), "utf8");
    for (const forbidden of ["./apple", "./publisher", "./repository", "./openai"]) {
      expect(source).not.toContain(`from \"${forbidden}`);
    }
    expect(source).not.toContain("publishManifest(");
    expect(source).not.toContain("createPlaylist(");
    expect(() => orchestratePipelineV2ManifestShadow(request())).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test("is deterministic for identical persisted artifacts", () => {
    const value = request();
    expect(orchestratePipelineV2ManifestShadow(structuredClone(value)))
      .toEqual(orchestratePipelineV2ManifestShadow(value));
  });
});
