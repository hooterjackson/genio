import { describe, expect, test, vi } from "vitest";
import type { SelectionConstraint, SelectionPlan } from "../shared/types.ts";
import { createQueryPlanV3 } from "../server/query-plan-v3.ts";
import {
  executeRetrievalV3,
  publicTrackScopeAttestationV3,
  type CandidateQualificationV3,
  type RawTrackCandidateV3,
  type RetrievalAdaptersV3,
} from "../server/pipeline-v3-retrieval.ts";
import { selectionPlanFromQueryPlanV3 } from "../server/pipeline-v3-worker-execution.ts";
import { createRunSpecV3, resolveRunSpecV3 } from "../server/selection-plan-v3.ts";

const GRAPH_SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";

function typedPlan(
  constraints: SelectionConstraint[],
  patch: Partial<Pick<SelectionPlan,
    "scopeKind" | "diversityGoals" | "orderingPolicy" | "softGoalRelaxationOrder">> = {},
): NonNullable<Parameters<typeof createRunSpecV3>[0]["typedSelectionPlan"]> {
  return {
    intents: ["genre_scene"],
    scopeKind: patch.scopeKind ?? "broad_curated",
    constraints,
    diversityGoals: patch.diversityGoals ?? {
      minimumDistinctArtists: 5,
      minimumDistinctAlbums: 5,
      minimumDistinctEras: 2,
      minimumDistinctScenes: 2,
      minimumDistinctGeographies: null,
      maximumTracksPerArtist: 2,
      maximumTracksPerAlbum: 2,
    },
    orderingPolicy: patch.orderingPolicy ?? {
      mode: "editorial",
      goals: ["interleave artists"],
      avoidAdjacentSameArtist: true,
      avoidAdjacentSameAlbum: true,
    },
    softGoalRelaxationOrder: patch.softGoalRelaxationOrder
      ?? ["album_concentration", "artist_concentration"],
    versionPolicy: {
      preferred: ["canonical"],
      allowed: ["canonical", "clean", "explicit"],
      excludeCompilations: false,
      excludeKaraokeAndTributes: true,
    },
    contentPolicy: {
      explicitContent: "allow",
      instrumental: "allow",
      languages: [],
    },
  };
}

function candidate(index: number, artist: string, album: string): RawTrackCandidateV3 {
  return {
    id: `candidate-${index}`,
    title: `Track ${index}`,
    artist,
    album,
    sourceObservationIds: [`source-${index}`],
  };
}

function qualification(value: RawTrackCandidateV3, sourceRank: number): CandidateQualificationV3 {
  const bindingId = `binding-${value.id}`;
  const sourceUrl = `https://evidence.example.test/tracks/${encodeURIComponent(value.id)}`;
  return {
    candidateId: value.id,
    scope: { passed: true, failedMembershipPredicateIds: [], fit: 1 },
    hardConstraints: { passed: true, failedConstraintIds: [] },
    evidence: {
      passed: true,
      bindingIds: [bindingId],
      strength: 0.95,
      independentProvenanceRoots: 2,
      bindings: [{
        id: bindingId,
        url: sourceUrl,
        provenanceRoot: "evidence.example.test",
        strength: 0.95,
        sourceRank,
        kind: "track_specific_source",
        governance: {
          policyVersion: "evidence-source-governance-v3",
          useScope: "run_local",
          approvalState: "approved",
          accessMethod: "hosted_web_search",
          licenseState: "citation_only",
          licenseVersion: "test-citation-v1",
          termsVersion: "test-terms-v1",
          attribution: "Test exact track source",
          cachePolicy: "excerpt_only",
          retentionPolicy: "ninety_days",
          freshnessPolicy: "revalidate_30d",
          sourceHash: "b".repeat(64),
          sourceRevision: "b".repeat(64),
        },
        eligibilityAttestation: publicTrackScopeAttestationV3(sourceUrl),
      }],
    },
    version: { compatible: true, confidence: 1 },
    catalog: {
      storefrontPlayable: true,
      appleSongId: `apple-${value.id}`,
      recordingFamilyKey: `family-${value.id}`,
      confidence: 1,
    },
    rankingSignals: { relevance: 1 },
    sourceRank,
  };
}

function oneBatchAdapter(values: readonly RawTrackCandidateV3[]): RetrievalAdaptersV3 {
  let emitted = false;
  return {
    discover: vi.fn(async () => {
      if (emitted) return { candidates: [], nextCursor: null, exhausted: true };
      emitted = true;
      return { candidates: values, nextCursor: null, exhausted: true };
    }),
    qualify: vi.fn(async (
      { candidates }: Parameters<RetrievalAdaptersV3["qualify"]>[0],
    ) => candidates.map((value) => qualification(
      value,
      values.findIndex(({ id }) => id === value.id),
    ))),
  };
}

describe("Pipeline V3 immutable selection policy", () => {
  test("does not mistake the generic word playlist for a fixed release container", () => {
    expect(createRunSpecV3({
      prompt: "Make me a diverse jazz playlist",
      requestedTrackCount: 25,
    }).scopeKind).toBe("broad_curated");
  });

  test("persists and rehydrates typed hard constraints, soft preferences, and diversity policy", () => {
    const hardMaximum: SelectionConstraint = {
      id: "artist-cap",
      axis: "artist",
      operator: "maximum",
      values: ["2"],
      kind: "hard",
      geographyRelationship: null,
      relaxationRank: null,
    };
    const softEra: SelectionConstraint = {
      id: "prefer-nineties",
      axis: "era",
      operator: "prefer",
      values: ["1990s"],
      kind: "soft",
      geographyRelationship: null,
      relaxationRank: 4,
    };
    const plan = resolveRunSpecV3(createRunSpecV3({
      prompt: "25 Berlin techno tracks",
      requestedTrackCount: 25,
      typedSelectionPlan: typedPlan([hardMaximum, softEra]),
    }), []);
    const query = createQueryPlanV3(plan, GRAPH_SNAPSHOT_ID);

    expect(query.hardConstraints).toContainEqual(hardMaximum);
    expect(query.softPreferences).toEqual([softEra]);
    expect(query.scopeKind).toBe("broad_curated");
    expect(query.diversityGoals?.maximumTracksPerArtist).toBe(2);
    expect(query.orderingPolicy?.avoidAdjacentSameArtist).toBe(true);

    const rehydrated = selectionPlanFromQueryPlanV3(query, { prompt: plan.prompt });
    expect(rehydrated.hardConstraints).toContainEqual(hardMaximum);
    expect(rehydrated.softPreferences).toEqual([softEra]);
    expect(rehydrated.diversityGoals).toEqual(plan.diversityGoals);
    expect(rehydrated.orderingPolicy).toEqual(plan.orderingPolicy);
    expect(rehydrated.softGoalRelaxationOrder).toEqual(plan.softGoalRelaxationOrder);
  });

  test("rehydrates similarity seed values from immutable query plans with a legacy-safe default", () => {
    const plan = resolveRunSpecV3(createRunSpecV3({
      prompt: "25 songs like Radiohead but do not include Radiohead",
      requestedTrackCount: 25,
    }), []);
    const query = createQueryPlanV3(plan, GRAPH_SNAPSHOT_ID);
    const rehydrated = selectionPlanFromQueryPlanV3(query, { prompt: plan.prompt });
    expect(rehydrated.rankingObjectives).toContainEqual(expect.objectContaining({
      dimension: "similarity",
      values: ["radiohead"],
    }));

    const legacy = {
      ...query,
      rankingObjectives: query.rankingObjectives.map((objective) => {
        const legacyObjective = { ...objective };
        delete legacyObjective.values;
        return legacyObjective;
      }),
    };
    const legacyRehydrated = selectionPlanFromQueryPlanV3(legacy, { prompt: plan.prompt });
    expect(legacyRehydrated.rankingObjectives).toContainEqual(expect.objectContaining({
      dimension: "similarity",
      values: [],
    }));
  });

  test("enforces hard per-artist and per-album maxima before target selection and never relaxes them", async () => {
    const hardArtistMaximum: SelectionConstraint = {
      id: "artist-cap",
      axis: "artist",
      operator: "maximum",
      values: ["2"],
      kind: "hard",
      geographyRelationship: null,
      relaxationRank: null,
    };
    const hardAlbumMaximum: SelectionConstraint = {
      id: "album-cap",
      axis: "album",
      operator: "maximum",
      values: ["1"],
      kind: "hard",
      geographyRelationship: null,
      relaxationRank: null,
    };
    const plan = resolveRunSpecV3(createRunSpecV3({
      prompt: "10 disco tracks",
      requestedTrackCount: 10,
      typedSelectionPlan: typedPlan([hardArtistMaximum, hardAlbumMaximum]),
    }), []);
    const values = [
      ...Array.from({ length: 6 }, (_, index) => candidate(index, "Artist A", `Album ${Math.floor(index / 2)}`)),
      ...Array.from({ length: 6 }, (_, index) => candidate(index + 6, "Artist B", `Album ${Math.floor(index / 2)}`)),
    ];
    const result = await executeRetrievalV3({
      runId: "hard-aggregate-cap",
      plan,
      adapters: oneBatchAdapter(values),
    });

    expect(result.outcome.status).toBe("partial_ready");
    expect(result.selected).toHaveLength(4);
    const counts = new Map<string, number>();
    for (const track of result.selected) counts.set(track.artist, (counts.get(track.artist) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBe(2);
    expect(result.deficit.discardedByReason.hard_constraint_failed).toBe(8);
    expect(result.deficit.discardedByReason.hard_artist_maximum_exceeded).toBe(6);
    expect(result.deficit.discardedByReason.hard_album_maximum_exceeded).toBe(4);
  });

  test("maps custom critical answers to their subject-specific membership axis", () => {
    const french = resolveRunSpecV3(
      createRunSpecV3({ prompt: "French jazz", requestedTrackCount: 25 }),
      [{ key: "french_jazz_scope", optionId: "custom", customValue: "Paris scene" }],
    );
    const house = resolveRunSpecV3(
      createRunSpecV3({ prompt: "House classics", requestedTrackCount: 25 }),
      [{ key: "house_semantics", optionId: "custom", customValue: "Chicago house" }],
    );
    expect(french.membershipPredicates).toContainEqual(expect.objectContaining({ axis: "scene", values: ["Paris scene"] }));
    expect(house.membershipPredicates).toContainEqual(expect.objectContaining({ axis: "genre", values: ["Chicago house"] }));
  });

  test("applies artist and album diversity only to broad curated scope", async () => {
    const values = [
      ...Array.from({ length: 6 }, (_, index) => candidate(index, "Artist A", "Album A")),
      candidate(6, "Artist B", "Album B"),
      candidate(7, "Artist C", "Album C"),
      candidate(8, "Artist D", "Album D"),
      candidate(9, "Artist E", "Album E"),
      candidate(10, "Artist F", "Album F"),
      candidate(11, "Artist G", "Album G"),
      candidate(12, "Artist H", "Album H"),
      candidate(13, "Artist I", "Album I"),
      candidate(14, "Artist J", "Album J"),
      candidate(15, "Artist K", "Album K"),
    ];
    const broad = resolveRunSpecV3(createRunSpecV3({
      prompt: "6 disco tracks",
      requestedTrackCount: 6,
      typedSelectionPlan: typedPlan([]),
    }), []);
    const fixed = {
      ...broad,
      scopeKind: "fixed_release_container" as const,
      diversityGoals: {
        minimumDistinctArtists: null,
        minimumDistinctAlbums: null,
        minimumDistinctEras: null,
        minimumDistinctScenes: null,
        minimumDistinctGeographies: null,
        maximumTracksPerArtist: null,
        maximumTracksPerAlbum: null,
      },
      orderingPolicy: {
        mode: "source_order" as const,
        goals: [],
        avoidAdjacentSameArtist: false,
        avoidAdjacentSameAlbum: false,
      },
    };

    const broadResult = await executeRetrievalV3({
      runId: "broad-diversity",
      plan: broad,
      adapters: oneBatchAdapter(values),
    });
    const fixedResult = await executeRetrievalV3({
      runId: "fixed-no-diversity",
      plan: fixed,
      adapters: oneBatchAdapter(values),
    });

    expect(new Set(broadResult.selected.map(({ artist }) => artist)).size).toBeGreaterThanOrEqual(5);
    expect(fixedResult.selected.map(({ artist }) => artist)).toEqual(Array(6).fill("Artist A"));
  });
});
