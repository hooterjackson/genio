import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import {
  PIPELINE_V2_SHADOW_INPUT_SCHEMA,
  evaluatePipelineV2ManifestShadow,
  parsePipelineV2ShadowInput,
  type PipelineV2ShadowInput,
  type ShadowCandidatePool,
  type ShadowManifestCandidate,
} from "../server/pipeline-v2-shadow.ts";
import { sha256Hex } from "../server/security.ts";

function candidate(
  rank: number,
  prefix: string,
  overrides: Partial<ShadowManifestCandidate> = {},
): ShadowManifestCandidate {
  return {
    rank,
    candidateId: `${prefix}-candidate-${rank}`,
    appleSongId: `${prefix}-apple-${rank}`,
    recordingFamilyKey: `${prefix}-family-${rank}`,
    artist: `Artist ${rank}`,
    title: `Track ${rank}`,
    scopeBindingIds: [`${prefix}-binding-${rank}`],
    includeInManifest: true,
    evidenceEligible: true,
    hardConstraintsSatisfied: true,
    versionCompatible: true,
    storefrontPlayable: true,
    ...overrides,
  };
}

function pool(
  pipelineVersion: ShadowCandidatePool["pipelineVersion"],
  candidates: ShadowManifestCandidate[],
): ShadowCandidatePool {
  return {
    pipelineVersion,
    policyVersion: pipelineVersion === "legacy_v1" ? "legacy_v1" : "relevance_first_2026_07",
    modelSnapshot: pipelineVersion === "legacy_v1" ? "gpt-5.4-mini-2026-06-01" : "gpt-5.6-luna-2026-07-15",
    sourceRunId: `${pipelineVersion}-run-1`,
    candidates,
  };
}

function input(overrides: Partial<PipelineV2ShadowInput> = {}): PipelineV2ShadowInput {
  const sharedLegacy = candidate(1, "legacy", {
    appleSongId: "apple-shared",
    recordingFamilyKey: "family-shared",
  });
  const sharedV2 = candidate(1, "v2", {
    appleSongId: "apple-shared",
    recordingFamilyKey: "family-shared",
  });
  return {
    schemaVersion: PIPELINE_V2_SHADOW_INPUT_SCHEMA,
    comparisonId: "owner-canary-american-drill-25",
    generatedAt: "2026-07-19T20:00:00.000Z",
    promptHash: sha256Hex("25 foundational American drill tracks"),
    storefront: "us",
    targetTrackCount: 2,
    primary: pool("legacy_v1", [sharedLegacy, candidate(2, "legacy")]),
    shadow: pool("catalog_first_v2", [sharedV2, candidate(2, "v2")]),
    ...overrides,
  };
}

describe("Pipeline V2 manifest-only shadow comparison", () => {
  test("generates immutable V1/V2 manifests and a review-only comparison", () => {
    const report = evaluatePipelineV2ManifestShadow(input());
    expect(report).toMatchObject({
      executionMode: "manifest_only",
      publicationCapability: "absent",
      releaseDisposition: "independent_review_required",
      targetTrackCount: 2,
      primary: { pipelineVersion: "legacy_v1", trackCount: 2, exactCountSatisfied: true },
      shadow: { pipelineVersion: "catalog_first_v2", trackCount: 2, exactCountSatisfied: true },
      comparison: {
        primaryTrackCount: 2,
        shadowTrackCount: 2,
        trackCountDelta: 0,
        sharedAppleSongCount: 1,
        sharedRecordingFamilyCount: 1,
        shadowEvidenceCoverage: 1,
      },
    });
    expect(report.primary.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.shadow.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.reportHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.comparison.addedAppleSongIds).toEqual(["v2-apple-2"]);
    expect(report.comparison.removedAppleSongIds).toEqual(["legacy-apple-2"]);
  });

  test("has no network, repository, authorization, or Apple publication dependency", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be called"));
    const source = readFileSync(new URL("../server/pipeline-v2-shadow.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["']\.\/apple(?:\.ts)?["']/u);
    expect(source).not.toMatch(/from ["']\.\/publisher(?:\.ts)?["']/u);
    expect(source).not.toMatch(/from ["']\.\/repository(?:\.ts)?["']/u);
    expect(source).not.toMatch(/from ["']\.\/openai(?:\.ts)?["']/u);
    expect(source).not.toContain("publishManifest(");
    expect(source).not.toContain("createPlaylist(");

    expect(() => evaluatePipelineV2ManifestShadow(input())).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test("rejects injected write capabilities before any comparison runs", () => {
    let writeAttempts = 0;
    const hostile = {
      ...input(),
      publishManifest: () => { writeAttempts += 1; },
    };
    expect(() => parsePipelineV2ShadowInput(hostile)).toThrow(/invalid keys.*publishManifest/iu);
    expect(writeAttempts).toBe(0);

    const nestedHostile = {
      ...input(),
      shadow: {
        ...input().shadow,
        appleUserToken: "secret",
      },
    };
    expect(() => parsePipelineV2ShadowInput(nestedHostile)).toThrow(/invalid keys.*appleUserToken/iu);
  });

  test("fails closed when V2 selects a track without every eligibility layer", () => {
    const base = input();
    for (const unsafePatch of [
      { evidenceEligible: false },
      { hardConstraintsSatisfied: false },
      { versionCompatible: false },
      { storefrontPlayable: false },
      { scopeBindingIds: [] },
    ] satisfies Array<Partial<ShadowManifestCandidate>>) {
      const unsafe = input({
        shadow: pool("catalog_first_v2", [
          { ...base.shadow.candidates[0]!, ...unsafePatch },
        ]),
      });
      expect(() => evaluatePipelineV2ManifestShadow(unsafe)).toThrow(/selected an ineligible candidate/iu);
    }
  });

  test("fails closed on duplicate playable identities, families, and oversized manifests", () => {
    const duplicateIdentity = input({
      shadow: pool("catalog_first_v2", [
        candidate(1, "v2", { appleSongId: "duplicate" }),
        candidate(2, "v2", { appleSongId: "duplicate" }),
      ]),
    });
    expect(() => evaluatePipelineV2ManifestShadow(duplicateIdentity)).toThrow(/duplicate Apple song IDs/iu);

    const duplicateFamily = input({
      shadow: pool("catalog_first_v2", [
        candidate(1, "v2", { recordingFamilyKey: "duplicate" }),
        candidate(2, "v2", { recordingFamilyKey: "duplicate" }),
      ]),
    });
    expect(() => evaluatePipelineV2ManifestShadow(duplicateFamily)).toThrow(/duplicate recording families/iu);

    const oversized = input({
      targetTrackCount: 1,
      shadow: pool("catalog_first_v2", [candidate(1, "v2"), candidate(2, "v2")]),
    });
    expect(() => evaluatePipelineV2ManifestShadow(oversized)).toThrow(/exceeds the immutable requested target/iu);
  });

  test("permits an honest empty or partial shadow manifest without treating it as a release pass", () => {
    const partial = evaluatePipelineV2ManifestShadow(input({
      targetTrackCount: 3,
      shadow: pool("catalog_first_v2", [
        candidate(1, "v2"),
        candidate(2, "v2", { includeInManifest: false, evidenceEligible: false }),
      ]),
    }));
    expect(partial.shadow).toMatchObject({ trackCount: 1, exactCountSatisfied: false });
    expect(partial.releaseDisposition).toBe("independent_review_required");

    const empty = evaluatePipelineV2ManifestShadow(input({
      primary: pool("legacy_v1", []),
      shadow: pool("catalog_first_v2", []),
    }));
    expect(empty.primary.trackCount).toBe(0);
    expect(empty.shadow.trackCount).toBe(0);
    expect(empty.comparison.shadowEvidenceCoverage).toBe(1);
  });

  test("is deterministic for the same immutable input", () => {
    const value = input();
    const first = evaluatePipelineV2ManifestShadow(value);
    const second = evaluatePipelineV2ManifestShadow(structuredClone(value));
    expect(second).toEqual(first);
  });
});
