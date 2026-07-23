import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  compileGuidanceSelectionV3,
  guidanceContractPatchV1,
  SMOOTH_REGGAETON_HEAT_PROMPT,
  smoothReggaetonHeatGuidanceDecisionV3,
} from "../server/adaptive-guidance-v3.ts";
import {
  projectPlaylistContractExecutionV1,
} from "../server/playlist-contract-execution-bridge-v1.ts";
import {
  CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY,
} from "../server/playlist-contract-backend-capability-v1.ts";
import {
  compilePlaylistContractShadowV1,
} from "../server/playlist-contract-shadow-bridge-v1.ts";
import { applyPlaylistContractPatchV1 } from "../server/playlist-contract-v1.ts";
import {
  selectWithCanonicalQuotaV3,
  type QualifiedTrackV3,
} from "../server/pipeline-v3-retrieval.ts";
import { createSelectionPlanV2 } from "../server/selection-plan-v2.ts";

function brief(): PlaylistBrief {
  return {
    title: "Smooth Reggaeton Heat",
    description: "A 50-track smooth reggaeton playlist centered on polished, sensual, danceable reggaeton and adjacent Latin urban tracks with a flirtatious, crowd-pleasing vibe.",
    mode: "curated",
    subjectEntities: ["reggaeton", "Latin urban"],
    relationship: "centered on reggaeton and adjacent Latin urban music",
    include: ["reggaeton", "adjacent Latin urban"],
    exclude: [],
    versionPolicy: "Prefer canonical studio recordings.",
    evidencePolicy: "Require track-scope evidence.",
    orderingPolicy: "Use a smooth editorial flow.",
    targetSize: { min: 50, max: 50 },
    ambiguities: [],
  };
}

function track(index: number, genre: string): QualifiedTrackV3 {
  return {
    candidateId: `candidate-${index}`,
    title: `Track ${index}`,
    artist: `Artist ${index}`,
    album: `Album ${index}`,
    appleSongId: `apple-${index}`,
    recordingFamilyKey: `family-${index}`,
    catalogGenreNames: [genre],
    sourceObservationIds: [`source-${index}`],
    evidenceBindingIds: [`binding-${index}`],
    evidenceStrength: 1,
    scopeFit: 1,
    independentProvenanceRoots: 1,
    versionConfidence: 1,
    catalogConfidence: 1,
    rankingSignals: { relevance: 1 - index / 100 },
    sourceRank: index,
  };
}

describe("canonical contract execution bridge", () => {
  test("projects the recommended answer into executable V3 membership and a 70% quota", () => {
    const basePlan = createSelectionPlanV2({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: brief(),
      storefront: "us",
    });
    const shadow = compilePlaylistContractShadowV1({
      contractId: "brief:execution-regression",
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: brief(),
      selectionPlan: basePlan,
    });
    const decision = smoothReggaetonHeatGuidanceDecisionV3({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      baseContractRevisionId: shadow.contract.revisionId,
      baseContractSemanticHash: shadow.contract.semanticHash,
      preservedTrackPredicate: shadow.preservedTrackPredicate,
      ambiguousScopeClauseIds: shadow.ambiguousScopeClauseIds,
    })!;
    const selected = compileGuidanceSelectionV3(decision, {
      optionIds: ["reggaeton_dembow_latin_urban"],
    });
    const patch = guidanceContractPatchV1({
      decision,
      questionSetHash: "a".repeat(64),
      accepted: {
        answerHash: selected.answerHash,
        executableOperations: selected.operations,
      },
    })!;
    const contract = applyPlaylistContractPatchV1(shadow.contract, patch);
    const projection = projectPlaylistContractExecutionV1({ contract, basePlan });

    expect(projection.plan.constraints.filter(({ id }) => (
      id.startsWith("guidance:membership:")
    ))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "guidance:membership:core-reggaeton", values: ["reggaeton"] }),
      expect.objectContaining({ id: "guidance:membership:dembow", values: ["dembow"] }),
      expect.objectContaining({ id: "guidance:membership:latin-urban", values: ["Latin urban"] }),
    ]));
    expect(projection.canonicalContractPolicy.trackPredicate).toMatchObject({
      op: "all",
      children: expect.arrayContaining([
        expect.objectContaining({ op: "any" }),
      ]),
    });
    expect(projection.playlistQuotaRules).toEqual([
      expect.objectContaining({
        id: "quota:genre:core-reggaeton-share",
        values: ["reggaeton"],
        minimumRatio: 0.7,
      }),
    ]);
    expect(projection.playlistQualityPolicy).toMatchObject({
      policyVersion: "canonical_central_quality_v1",
      criteria: expect.arrayContaining([
        "smooth",
        "polished",
        "sensual",
        "danceable",
        "flirtatious",
        "crowd-pleasing",
      ]),
      minimumPassRatio: 0.8,
      maximumUnknownRatio: 0.2,
      zeroKnownFailures: true,
      signalSemantics: "ranking_only_not_factual_evidence",
    });
    expect(projection).toMatchObject({
      backend: "corpus_first_v3",
      backendCapabilityVersion: "playlist_contract_backend_capability_v2",
    });
    expect(projection.backendCapabilityHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("execution refuses an otherwise routable backend that cannot enforce the quota", () => {
    const basePlan = createSelectionPlanV2({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: brief(),
      storefront: "us",
    });
    const shadow = compilePlaylistContractShadowV1({
      contractId: "brief:execution-capability",
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: brief(),
      selectionPlan: basePlan,
    });
    const decision = smoothReggaetonHeatGuidanceDecisionV3({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      baseContractRevisionId: shadow.contract.revisionId,
      baseContractSemanticHash: shadow.contract.semanticHash,
      preservedTrackPredicate: shadow.preservedTrackPredicate,
      ambiguousScopeClauseIds: shadow.ambiguousScopeClauseIds,
    })!;
    const selected = compileGuidanceSelectionV3(decision, {
      optionIds: ["reggaeton_dembow_latin_urban"],
    });
    const patch = guidanceContractPatchV1({
      decision,
      questionSetHash: "b".repeat(64),
      accepted: {
        answerHash: selected.answerHash,
        executableOperations: selected.operations,
      },
    })!;
    const contract = applyPlaylistContractPatchV1(shadow.contract, patch);

    expect(() => projectPlaylistContractExecutionV1({
      contract,
      basePlan,
      backendCapability: {
        ...CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY,
        backend: "catalog_first_v2",
        supportsQuotas: false,
      },
    })).toThrow(/playlist_contract_backend_unsupported:.*feature:quotas/u);
  });

  test("projects canonical OR without flattening it into an all-of gate", () => {
    const basePlan = createSelectionPlanV2({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: brief(),
      storefront: "us",
    });
    const shadow = compilePlaylistContractShadowV1({
      contractId: "brief:execution-or",
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: brief(),
      selectionPlan: basePlan,
    });
    const contract = applyPlaylistContractPatchV1(shadow.contract, {
      baseRevisionId: shadow.contract.revisionId,
      baseSemanticHash: shadow.contract.semanticHash,
      answerLineage: {
        questionSetHash: "c".repeat(64),
        questionId: "capability:or",
        answerHash: "d".repeat(64),
      },
      operations: [{
        op: "replace_track_predicate",
        predicate: {
          op: "any",
          children: [
            shadow.contract.trackPredicate,
            shadow.contract.trackPredicate,
          ],
        },
      }],
    });
    const projection = projectPlaylistContractExecutionV1({
      contract,
      basePlan,
    });
    expect(projection.canonicalContractPolicy.trackPredicate.op).toBe("any");
    expect(projection.selectionPlanV3.canonicalContractPolicy?.projectionHash).toBe(
      projection.canonicalContractPolicy.projectionHash,
    );
  });

  test("legacy plan drift cannot change contract3 runtime execution", () => {
    const basePlan = createSelectionPlanV2({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: brief(),
      storefront: "us",
    });
    const shadow = compilePlaylistContractShadowV1({
      contractId: "brief:runtime-authority",
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: brief(),
      selectionPlan: basePlan,
    });
    const changedLegacyPlan = {
      ...basePlan,
      constraints: [{
        id: "legacy:hostile-drift",
        axis: "artist" as const,
        operator: "require" as const,
        values: ["A legacy-only artist"],
        kind: "hard" as const,
        geographyRelationship: null,
        relaxationRank: null,
      }],
      contentPolicy: {
        ...basePlan.contentPolicy,
        explicitContent: "clean_only" as const,
      },
      orderingPolicy: {
        ...basePlan.orderingPolicy,
        mode: "contrast" as const,
        goals: ["legacy-only ordering"],
      },
    };
    const original = projectPlaylistContractExecutionV1({
      contract: shadow.contract,
      basePlan,
    });
    const drifted = projectPlaylistContractExecutionV1({
      contract: shadow.contract,
      basePlan: changedLegacyPlan,
    });
    expect(drifted.selectionPlanV3).toEqual(original.selectionPlanV3);
    expect(drifted.canonicalContractPolicy).toEqual(original.canonicalContractPolicy);
    expect(drifted.projectionHash).toBe(original.projectionHash);
    expect(drifted.selectionPlanV3.membershipPredicates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ values: ["A legacy-only artist"] }),
    ]));
  });

  test("returns the largest ratio-compliant partial instead of filler", () => {
    const ranked = [
      ...Array.from({ length: 20 }, (_, index) => track(index, "Reggaeton")),
      ...Array.from({ length: 40 }, (_, index) => track(index + 20, "Latin Urban")),
    ];
    const selected = selectWithCanonicalQuotaV3({
      ranked,
      target: 50,
      rules: [{
        id: "quota:core",
        clauseId: "membership:core",
        axis: "genre",
        values: ["reggaeton"],
        minimumCount: null,
        maximumCount: null,
        minimumRatio: 0.7,
        maximumRatio: 1,
        evidenceGrade: "authoritative_structured_metadata",
      }],
    });
    expect(selected).toHaveLength(28);
    expect(selected.filter((item) => item.catalogGenreNames?.[0] === "Reggaeton")).toHaveLength(20);
  });
});
