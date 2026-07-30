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
import {
  applyPlaylistContractPatchV1,
  assertPlaylistContractIntegrityV1,
  type PlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";
import {
  createQueryPlanV3,
  isQueryPlanV3,
  queryPlanV3Hash,
} from "../server/query-plan-v3.ts";
import {
  selectionPlanFromQueryPlanV3,
} from "../server/pipeline-v3-worker-execution.ts";
import {
  selectWithCanonicalQuotaV3,
  type QualifiedTrackV3,
} from "../server/pipeline-v3-retrieval.ts";
import { createSelectionPlanV2 } from "../server/selection-plan-v2.ts";
import {
  PlaylistOptimizationBudgetExceededErrorV1,
  withPlaylistOptimizationBudgetV1,
} from "../server/playlist-optimizer-v1.ts";

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

function fixedAlbumBrief(): PlaylistBrief {
  return {
    title: "Kind of Blue",
    description: "Every track from the album Kind of Blue.",
    mode: "curated",
    subjectEntities: ["Kind of Blue", "Miles Davis"],
    relationship: "tracks from the album Kind of Blue by Miles Davis",
    include: [],
    exclude: [],
    versionPolicy: "Prefer canonical studio recordings.",
    evidencePolicy: "Require track-scope evidence.",
    orderingPolicy: "Keep the source order.",
    targetSize: { min: 25, max: 25 },
    ambiguities: [],
  };
}

function fixedTrackListBrief(): PlaylistBrief {
  return {
    title: "Pop Essentials 3",
    description: "Three named original studio recordings in a fixed order.",
    mode: "curated",
    subjectEntities: [],
    relationship: "Exact inclusion of three named original studio recordings in the listed order.",
    include: [
      "Michael Jackson — Billie Jean",
      "Madonna — La Isla Bonita",
      "Earth, Wind & Fire — September",
    ],
    exclude: [
      "remixes",
      "live versions",
      "radio edits",
      "covers",
      "re-recordings",
      "duplicates",
    ],
    versionPolicy: "Use the original studio recording only for each listed song; no alternate versions.",
    evidencePolicy: "Verify exact artist, title, and original studio recording identity.",
    orderingPolicy: "Preserve the user-specified order exactly.",
    targetSize: { min: 3, max: 3 },
    ambiguities: [],
  };
}

function radioheadBrief(): PlaylistBrief {
  return {
    title: "Beyond Radiohead",
    description: "Recordings by other artists with a Radiohead-like sound.",
    mode: "curated",
    subjectEntities: ["Radiohead"],
    relationship: "stylistically similar to Radiohead",
    include: ["Recordings by other artists that are stylistically similar to Radiohead"],
    exclude: ["Reference artist is a style seed; exclude recordings by: Radiohead"],
    versionPolicy: "Prefer canonical studio recordings.",
    evidencePolicy: "Require track-scope evidence.",
    orderingPolicy: "Use an editorial sequence.",
    targetSize: { min: 25, max: 25 },
    ambiguities: [],
  };
}

function darkAmbientSleepBrief(): PlaylistBrief {
  return {
    title: "Dark Ambient for Sleep",
    description: "A dark ambient playlist whose atmosphere remains suitable for sleep.",
    mode: "curated",
    subjectEntities: ["dark ambient"],
    relationship: "is dark ambient music suitable for sleep",
    include: ["Dark ambient recordings.", "Suitable for sleep."],
    exclude: [],
    versionPolicy: "Prefer canonical studio recordings.",
    evidencePolicy: "Require track-scope evidence.",
    orderingPolicy: "Use a calm, smooth editorial sequence.",
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
  test("binds an explicit fixed track list into canonical membership and source-order execution", () => {
    const prompt = "Build exactly Billie Jean, La Isla Bonita, and September in the listed order.";
    const fixedBrief = fixedTrackListBrief();
    const basePlan = createSelectionPlanV2({
      prompt,
      brief: fixedBrief,
      storefront: "us",
    });
    expect(basePlan.scopeKind).toBe("fixed_track_list");
    const shadow = compilePlaylistContractShadowV1({
      contractId: "contract:fixed-track-list-runtime",
      prompt,
      brief: fixedBrief,
      selectionPlan: basePlan,
    });
    const projection = projectPlaylistContractExecutionV1({
      contract: shadow.contract,
      basePlan,
    });

    expect(shadow.contract.executionDirectives?.fixedTrackList).toEqual({
      tracks: basePlan.fixedTrackList,
      membershipClauseId: "bridge:membership:fixed-track-list",
    });
    expect(projection.selectionPlanV3).toMatchObject({
      engines: ["fixed_container"],
      scopeKind: "fixed_track_list",
      orderingPolicy: { mode: "source_order" },
    });
    expect(projection.plan).toMatchObject({
      scopeKind: "fixed_track_list",
      fixedTrackList: basePlan.fixedTrackList,
    });
    expect(projection.selectionPlanV3.membershipPredicates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "bridge:membership:fixed-track-list",
          axis: "track",
          operator: "require",
        }),
      ]),
    );

    const query = createQueryPlanV3(
      projection.selectionPlanV3,
      "00000000-0000-4000-8000-000000000001",
      {
        schemaVersion: 6,
        briefContractVersion: 3,
        playlistContractRevisionId: shadow.contract.revisionId,
        playlistContractSemanticHash: shadow.contract.semanticHash,
        playlistContractCompilerVersion: shadow.contract.versions.compiler,
      },
    );
    expect(isQueryPlanV3(query)).toBe(true);
    expect(selectionPlanFromQueryPlanV3(query, {})).toMatchObject({
      engines: ["fixed_container"],
      scopeKind: "fixed_track_list",
      executionDirectives: {
        fixedTrackList: {
          tracks: basePlan.fixedTrackList,
        },
      },
    });
  });

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
    expect(projection.playlistQualityPolicy?.criteria).toHaveLength(6);
    expect(projection.playlistQualityPolicy?.criteria.map((criterion) => (
      criterion.toLocaleLowerCase("en-US")
        .replace(/\s+(?:atmosphere|feel|feeling|mood|vibe)$/u, "")
    ))).toHaveLength(new Set(projection.playlistQualityPolicy?.criteria.map((criterion) => (
      criterion.toLocaleLowerCase("en-US")
        .replace(/\s+(?:atmosphere|feel|feeling|mood|vibe)$/u, "")
    ))).size);
    expect(projection.selectionPlanV3.diversityGoals).toEqual({
      minimumDistinctArtists: null,
      minimumDistinctAlbums: null,
      minimumDistinctEras: null,
      minimumDistinctScenes: null,
      minimumDistinctGeographies: null,
      maximumTracksPerArtist: null,
      maximumTracksPerAlbum: null,
    });
    expect(projection).toMatchObject({
      backend: "corpus_first_v3",
      backendCapabilityVersion: "playlist_contract_backend_capability_v6",
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

  test("carries the exact Kind of Blue container identity through contract 3, schema 5, and worker rehydration", () => {
    const prompt = "Every track from the album Kind of Blue, exactly 25 tracks.";
    const albumBrief = fixedAlbumBrief();
    const basePlan = createSelectionPlanV2({
      prompt,
      brief: albumBrief,
      storefront: "us",
    });
    expect(basePlan.fixedContainerIdentity).toEqual({
      kind: "album",
      name: "Kind of Blue",
      artistName: null,
    });
    const shadow = compilePlaylistContractShadowV1({
      contractId: "contract:kind-of-blue-runtime",
      prompt,
      brief: albumBrief,
      selectionPlan: basePlan,
    });
    const projection = projectPlaylistContractExecutionV1({
      contract: shadow.contract,
      basePlan,
    });
    expect(shadow.contract.executionDirectives?.fixedContainer).toEqual({
      kind: "album",
      name: "Kind of Blue",
      artistName: null,
      membershipClauseId: "bridge:membership:fixed-container",
    });
    expect(projection.selectionPlanV3.engines).toEqual(["fixed_container"]);
    expect(projection.selectionPlanV3.orderingPolicy.mode).toBe("source_order");
    expect(projection.selectionPlanV3.membershipPredicates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "bridge:membership:fixed-container",
        axis: "album",
        operator: "require",
        values: ["Kind of Blue"],
      }),
    ]));

    const query = createQueryPlanV3(
      projection.selectionPlanV3,
      "00000000-0000-4000-8000-000000000001",
      {
        schemaVersion: 5,
        briefContractVersion: 3,
        playlistContractRevisionId: shadow.contract.revisionId,
        playlistContractSemanticHash: shadow.contract.semanticHash,
        playlistContractCompilerVersion: shadow.contract.versions.compiler,
      },
    );
    expect(isQueryPlanV3(query)).toBe(true);
    const rehydrated = selectionPlanFromQueryPlanV3(query, {
      prompt: "all tracks from album A Hostile Mutable Prompt",
    });
    expect(rehydrated.executionDirectives).toEqual(shadow.contract.executionDirectives);
    expect(rehydrated.engines).toEqual(["fixed_container"]);
    expect(rehydrated.prompt).not.toContain("Hostile Mutable Prompt");

    const tampered = {
      ...shadow.contract,
      executionDirectives: {
        fixedContainer: {
          ...shadow.contract.executionDirectives!.fixedContainer!,
          name: "A Different Album",
        },
        similarity: null,
      },
    } as PlaylistContractRevisionV1;
    expect(() => assertPlaylistContractIntegrityV1(tampered))
      .toThrow(/fixed_container_directive_clause_mismatch/u);
  });

  test("preserves dark ambient genre, dark mood, and sleep suitability through contract 3 and schema 4", () => {
    const prompt = "50 dark ambient tracks for sleep";
    const ambientBrief = darkAmbientSleepBrief();
    const basePlan = createSelectionPlanV2({
      prompt,
      brief: ambientBrief,
      storefront: "us",
    });
    expect(basePlan.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        axis: "genre",
        kind: "hard",
        operator: "require",
        values: ["ambient"],
      }),
      expect.objectContaining({
        axis: "mood",
        kind: "hard",
        operator: "require",
        values: ["dark"],
      }),
      expect.objectContaining({
        axis: "activity",
        kind: "hard",
        operator: "require",
        values: ["sleep"],
      }),
    ]));

    const shadow = compilePlaylistContractShadowV1({
      contractId: "contract:dark-ambient-sleep-runtime",
      prompt,
      brief: ambientBrief,
      selectionPlan: basePlan,
    });
    const genreClause = shadow.contract.clauses.find((clause) => (
      clause.axis === "genre"
      && clause.hardness === "hard"
      && clause.values.includes("ambient")
    ));
    const darkSuitability = shadow.contract.clauses.find((clause) => (
      clause.axis === "central_suitability"
      && clause.values.includes("dark")
    ));
    const sleepSuitability = shadow.contract.clauses.find((clause) => (
      clause.axis === "central_suitability"
      && clause.values.includes("sleep")
    ));
    expect(genreClause).toBeDefined();
    expect(darkSuitability).toBeDefined();
    expect(sleepSuitability).toBeDefined();
    expect(shadow.contract.qualityPolicy.centralSuitabilityClauseIds).toEqual(
      expect.arrayContaining([darkSuitability!.id, sleepSuitability!.id]),
    );

    const projection = projectPlaylistContractExecutionV1({
      contract: shadow.contract,
      basePlan,
    });
    expect(projection.selectionPlanV3.engines).toEqual(expect.arrayContaining([
      "curated_genre_scene",
      "mood_activity_theme",
    ]));
    expect(projection.selectionPlanV3.membershipPredicates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: genreClause!.id,
        axis: "genre",
        operator: "require",
        values: ["ambient"],
      }),
    ]));
    expect(projection.playlistQualityPolicy).toMatchObject({
      clauseIds: expect.arrayContaining([darkSuitability!.id, sleepSuitability!.id]),
      criteria: expect.arrayContaining(["dark", "sleep"]),
      minimumPassRatio: 0.8,
      maximumUnknownRatio: 0.2,
      zeroKnownFailures: true,
    });

    const query = createQueryPlanV3(
      projection.selectionPlanV3,
      "00000000-0000-4000-8000-000000000001",
      {
        schemaVersion: 4,
        briefContractVersion: 3,
        playlistContractRevisionId: shadow.contract.revisionId,
        playlistContractSemanticHash: shadow.contract.semanticHash,
        playlistContractCompilerVersion: shadow.contract.versions.compiler,
      },
    );
    expect(isQueryPlanV3(query)).toBe(true);
    const rehydrated = selectionPlanFromQueryPlanV3(query, {
      prompt: "50 upbeat dance-pop tracks for a workout",
    });
    expect(rehydrated.engines).toEqual(expect.arrayContaining([
      "curated_genre_scene",
      "mood_activity_theme",
    ]));
    expect(rehydrated.membershipPredicates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: genreClause!.id,
        axis: "genre",
        values: ["ambient"],
      }),
    ]));
    expect(rehydrated.playlistQualityPolicy).toMatchObject({
      criteria: expect.arrayContaining(["dark", "sleep"]),
    });
    expect(rehydrated.prompt).not.toContain("upbeat dance-pop");
  });

  test("carries Radiohead only as a typed similarity seed with an exact artist exclusion", () => {
    const prompt = "Songs like Radiohead, but do not include Radiohead";
    const similarityBrief = radioheadBrief();
    const basePlan = createSelectionPlanV2({
      prompt,
      brief: similarityBrief,
      storefront: "us",
    });
    const shadow = compilePlaylistContractShadowV1({
      contractId: "contract:radiohead-runtime",
      prompt,
      brief: similarityBrief,
      selectionPlan: basePlan,
    });
    const projection = projectPlaylistContractExecutionV1({
      contract: shadow.contract,
      basePlan,
    });
    expect(shadow.contract.executionDirectives?.similarity).toEqual({
      seedArtists: ["Radiohead"],
      excludedArtists: ["Radiohead"],
      rankingClauseId: "bridge:ranking:similarity-seed",
      exactArtistExclusionClauseIds: ["bridge:exclusion:similarity-seed-artist"],
    });
    expect(shadow.contract.clauses).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        axis: "relationship",
        operator: "exclude",
        values: [expect.stringContaining("Reference artist is a style seed")],
      }),
    ]));
    expect(projection.selectionPlanV3.engines).toEqual(["similarity"]);
    expect(projection.selectionPlanV3.rankingObjectives).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "bridge:ranking:similarity-seed",
        dimension: "similarity",
        values: ["Radiohead"],
      }),
    ]));
    expect(projection.selectionPlanV3.membershipPredicates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "bridge:exclusion:similarity-seed-artist",
        axis: "artist",
        operator: "exclude",
        values: ["Radiohead"],
      }),
    ]));
    expect(() => projectPlaylistContractExecutionV1({
      contract: shadow.contract,
      basePlan,
      backendCapability: {
        ...CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY,
        backend: "missing-typed-similarity",
        executionFeatures: [],
      },
    })).toThrow(/execution_feature:(?:exact_artist_exclusion_v1|similarity_seed_v1)/u);

    const query = createQueryPlanV3(
      projection.selectionPlanV3,
      "00000000-0000-4000-8000-000000000001",
      {
        schemaVersion: 5,
        briefContractVersion: 3,
        playlistContractRevisionId: shadow.contract.revisionId,
        playlistContractSemanticHash: shadow.contract.semanticHash,
        playlistContractCompilerVersion: shadow.contract.versions.compiler,
      },
    );
    expect(isQueryPlanV3(query)).toBe(true);
    expect(isQueryPlanV3({
      ...query,
      executionDirectives: {
        fixedContainer: null,
        similarity: {
          ...query.executionDirectives!.similarity!,
          seedArtists: ["Muse"],
        },
      },
    })).toBe(false);
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

  test("solves intersecting canonical quotas without oscillating or losing rank order", () => {
    const ranked = [
      { ...track(0, "None"), catalogGenreNames: ["None"] },
      { ...track(1, "A"), catalogGenreNames: ["A"] },
      { ...track(2, "B"), catalogGenreNames: ["B"] },
      { ...track(3, "A"), catalogGenreNames: ["A", "B"] },
    ];
    const rules = [
      {
        id: "quota:a",
        clauseId: "membership:a",
        axis: "genre" as const,
        values: ["A"],
        minimumCount: 1,
        maximumCount: null,
        minimumRatio: null,
        maximumRatio: null,
        evidenceGrade: "authoritative_structured_metadata" as const,
      },
      {
        id: "quota:b",
        clauseId: "membership:b",
        axis: "genre" as const,
        values: ["B"],
        minimumCount: 1,
        maximumCount: null,
        minimumRatio: null,
        maximumRatio: null,
        evidenceGrade: "authoritative_structured_metadata" as const,
      },
    ];

    const first = selectWithCanonicalQuotaV3({ ranked, target: 2, rules });
    const second = selectWithCanonicalQuotaV3({ ranked, target: 2, rules });

    // [none, A+B] is the lexicographically earliest feasible ranked subset.
    expect(first.map(({ candidateId }) => candidateId)).toEqual([
      "candidate-0",
      "candidate-3",
    ]);
    expect(second).toEqual(first);
  });

  test("uses the bounded verified fallback for large canonical quota pools", () => {
    const ranked = Array.from({ length: 513 }, (_, index) => (
      track(index, index === 511 ? "A" : index === 512 ? "B" : "None")
    ));
    const selected = selectWithCanonicalQuotaV3({
      ranked,
      target: 2,
      rules: [
        {
          id: "quota:large:a",
          clauseId: "membership:a",
          axis: "genre",
          values: ["A"],
          minimumCount: 1,
          maximumCount: null,
          minimumRatio: null,
          maximumRatio: null,
          evidenceGrade: "authoritative_structured_metadata",
        },
        {
          id: "quota:large:b",
          clauseId: "membership:b",
          axis: "genre",
          values: ["B"],
          minimumCount: 1,
          maximumCount: null,
          minimumRatio: null,
          maximumRatio: null,
          evidenceGrade: "authoritative_structured_metadata",
        },
      ],
    });

    expect(selected.map(({ candidateId }) => candidateId)).toEqual([
      "candidate-511",
      "candidate-512",
    ]);
  });

  test("shares the worker optimizer budget and enlarges the canonical quota retry pass", () => {
    const ranked = Array.from({ length: 24 }, (_, index) => (
      track(index, index === 22 ? "A" : index === 23 ? "B" : "None")
    ));
    const rules = [
      {
        id: "quota:budget:a",
        clauseId: "membership:a",
        axis: "genre" as const,
        values: ["A"],
        minimumCount: 1,
        maximumCount: null,
        minimumRatio: null,
        maximumRatio: null,
        evidenceGrade: "authoritative_structured_metadata" as const,
      },
      {
        id: "quota:budget:b",
        clauseId: "membership:b",
        axis: "genre" as const,
        values: ["B"],
        minimumCount: 1,
        maximumCount: null,
        minimumRatio: null,
        maximumRatio: null,
        evidenceGrade: "authoritative_structured_metadata" as const,
      },
    ];

    expect(() => withPlaylistOptimizationBudgetV1({
      maximumExactNodes: 5,
      maximumExactWorkUnits: 1,
    }, () => selectWithCanonicalQuotaV3({
      ranked,
      target: 2,
      rules,
    }))).toThrow(PlaylistOptimizationBudgetExceededErrorV1);

    const selected = withPlaylistOptimizationBudgetV1({
      maximumExactNodes: 2_000,
      maximumExactWorkUnits: 2_000,
    }, () => selectWithCanonicalQuotaV3({
      ranked,
      target: 2,
      rules,
    }));
    expect(selected.map(({ candidateId }) => candidateId)).toEqual([
      "candidate-22",
      "candidate-23",
    ]);
  });

  test("preserves an unfamiliar canonical concept as a schema-5 worker discovery lead only", () => {
    const prompt = "Make exactly 25 velvet pulse tracks for a late-night set.";
    const unknownBrief: PlaylistBrief = {
      title: "Velvet pulse",
      description: prompt,
      mode: "curated",
      subjectEntities: ["velvet pulse"],
      relationship: "fits the requested unfamiliar music concept",
      include: ["velvet pulse"],
      exclude: [],
      versionPolicy: "Prefer canonical studio recordings.",
      evidencePolicy: "Require track-scope evidence.",
      orderingPolicy: "Use an editorial sequence.",
      targetSize: { min: 25, max: 25 },
      ambiguities: [],
    };
    const basePlan = createSelectionPlanV2({
      prompt,
      brief: unknownBrief,
      storefront: "us",
    });
    const shadow = compilePlaylistContractShadowV1({
      contractId: "contract:velvet-pulse-execution",
      prompt,
      brief: unknownBrief,
      selectionPlan: {
        ...basePlan,
        constraints: [
          {
            id: "genre_velvet_pulse",
            axis: "genre",
            operator: "require",
            values: ["velvet pulse"],
            kind: "hard",
            geographyRelationship: null,
            relaxationRank: null,
          },
          {
            id: "genre_velvet_pulse_duplicate",
            axis: "genre",
            operator: "require",
            values: ["velvet pulse"],
            kind: "hard",
            geographyRelationship: null,
            relaxationRank: null,
          },
          {
            id: "genre_perreo_discovery_only",
            axis: "genre",
            operator: "require",
            values: ["perreo"],
            kind: "hard",
            geographyRelationship: null,
            relaxationRank: null,
          },
        ],
      },
    });
    const projection = projectPlaylistContractExecutionV1({
      contract: shadow.contract,
      basePlan,
    });
    const hints = projection.selectionPlanV3.conceptDiscoveryHints;
    const hint = hints.find(({ normalizedText }) => normalizedText === "velvet pulse");
    expect(hints).toHaveLength(2);
    expect(hints).toContainEqual(expect.objectContaining({
      originalText: "perreo",
      normalizedText: "perreo",
      status: "discovery_only",
      unresolvedTermId: null,
      untrusted: true,
    }));
    expect(hint).toEqual({
      clauseId: expect.stringContaining("genre_velvet_pulse"),
      axis: "genre",
      originalText: "velvet pulse",
      normalizedText: "velvet pulse",
      status: "unresolved",
      ontologyVersion: "playlist_music_ontology_v2",
      unresolvedTermId: expect.stringMatching(/^unresolved:[a-f0-9]{16}$/u),
      provenance: "immutable_playlist_contract_concept_v1",
      untrusted: true,
      usage: "discovery_lead_only_not_membership_evidence_or_ranking",
    });
    expect(projection.selectionPlanV3.membershipPredicates)
      .not.toContainEqual(expect.objectContaining({ id: hint!.clauseId }));
    expect(projection.selectionPlanV3.semanticClauses)
      .not.toContainEqual(expect.objectContaining({ id: hint!.clauseId }));
    expect(projection.selectionPlanV3.rankingObjectives)
      .not.toContainEqual(expect.objectContaining({ id: hint!.clauseId }));
    expect(projection.canonicalContractPolicy.clauses)
      .not.toContainEqual(expect.objectContaining({ id: hint!.clauseId }));

    const query = createQueryPlanV3(
      projection.selectionPlanV3,
      "00000000-0000-4000-8000-000000000025",
      {
        schemaVersion: 5,
        briefContractVersion: 3,
        playlistContractRevisionId: shadow.contract.revisionId,
        playlistContractSemanticHash: shadow.contract.semanticHash,
        playlistContractCompilerVersion: shadow.contract.versions.compiler,
      },
    );
    expect(query.conceptDiscoveryHints).toEqual(hints);
    expect(queryPlanV3Hash({
      ...query,
      conceptDiscoveryHints: undefined,
    })).not.toBe(queryPlanV3Hash(query));
    expect(isQueryPlanV3({
      ...query,
      conceptDiscoveryHints: undefined,
    })).toBe(true);
    expect(query.membershipPredicates)
      .not.toContainEqual(expect.objectContaining({ id: hint!.clauseId }));
    expect(isQueryPlanV3(query)).toBe(true);

    const workerPlan = selectionPlanFromQueryPlanV3(query, {
      prompt: "tampered raw prompt that must not reach canonical execution",
    });
    expect(workerPlan.conceptDiscoveryHints).toEqual(hints);
    expect(workerPlan.prompt).not.toContain("tampered raw prompt");
    expect(workerPlan.prompt).not.toContain(prompt);

    expect(isQueryPlanV3({
      ...query,
      conceptDiscoveryHints: [{ ...hint!, ontologyVersion: "future_ontology" }],
    })).toBe(false);
    expect(isQueryPlanV3({
      ...query,
      conceptDiscoveryHints: [{ ...hint!, normalizedText: "changed" }],
    })).toBe(false);
    expect(isQueryPlanV3({
      ...query,
      conceptDiscoveryHints: [{ ...hint!, status: "resolved" }],
    })).toBe(false);
    expect(isQueryPlanV3({
      ...query,
      conceptDiscoveryHints: [{ ...hint!, untrusted: false }],
    })).toBe(false);
    expect(isQueryPlanV3({
      ...query,
      conceptDiscoveryHints: [hint!, { ...hint! }],
    })).toBe(false);
    expect(isQueryPlanV3({
      ...query,
      conceptDiscoveryHints: [{
        ...hint!,
        clauseId: query.canonicalContractPolicy!.clauses[0]!.id,
      }],
    })).toBe(false);
  });

});
