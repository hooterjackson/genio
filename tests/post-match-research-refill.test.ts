import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  CatalogMatchResult,
  CatalogSong,
  EvidenceClaimInput,
  PlaylistBrief,
  TrackCandidateInput,
} from "../shared/types.ts";

vi.mock("../server/apple.ts", async () => {
  const actual = await vi.importActual<typeof import("../server/apple.ts")>("../server/apple.ts");
  return {
    ...actual,
    lookupAppleCatalogByIsrc: vi.fn(),
    searchAppleCatalog: vi.fn(),
  };
});

import { AppleApiError, lookupAppleCatalogByIsrc, searchAppleCatalog } from "../server/apple.ts";
import { matchResearchRun, type MatchingRepository } from "../server/matching-service.ts";
import {
  catalogMatchingCandidateGoal,
  createFastPostMatchRefillRouteCheckpoint,
  FAST_POST_MATCH_REFILL_LIMIT,
  FAST_POST_MATCH_REFILL_RESEARCH_MS,
  fastArtistDiversityRefillPlan,
  fastPostMatchRefillPlan,
  parseFastPostMatchRefillRouteCheckpoint,
} from "../server/research-policy.ts";

const exactBrief = (title: string, count: number): PlaylistBrief => ({
  title,
  description: `${count} source-backed recordings`,
  mode: "curated",
  subjectEntities: [title],
  relationship: "is editorially relevant to",
  include: [],
  exclude: [],
  versionPolicy: "one canonical studio recording",
  evidencePolicy: "cited editorial sources",
  orderingPolicy: "editorial",
  targetSize: { min: count, max: count },
  ambiguities: [],
});

describe("post-match research-refill policy", () => {
  test.each([
    {
      label: "50 Rio de Janeiro songs",
      requestedMinimum: 50,
      initialCandidateCount: 88,
      strictMatchCount: 42,
      expectedShortfall: 8,
      expectedAdditionalCandidateGoal: 21,
    },
    {
      label: "25 Wandelweiser-adjacent recordings for late-night listening",
      requestedMinimum: 25,
      initialCandidateCount: 44,
      strictMatchCount: 11,
      expectedShortfall: 14,
      expectedAdditionalCandidateGoal: 70,
    },
  ])(
    "$label turns a strict Apple shortfall into a bounded evidence-research refill",
    ({
      requestedMinimum,
      initialCandidateCount,
      strictMatchCount,
      expectedShortfall,
      expectedAdditionalCandidateGoal,
    }) => {
      expect(catalogMatchingCandidateGoal(requestedMinimum)).toBe(initialCandidateCount);
      expect(fastPostMatchRefillPlan({
        requestedMinimum,
        selectableCount: strictMatchCount,
        attemptedCandidateCount: initialCandidateCount,
        refillAttempts: 0,
      })).toEqual({
        state: "refill",
        requestedMinimum,
        selectableCount: strictMatchCount,
        shortfall: expectedShortfall,
        additionalCandidateGoal: expectedAdditionalCandidateGoal,
      });
    },
  );

  test("never silently accepts a smaller playlist after the three-refill ceiling", () => {
    expect(FAST_POST_MATCH_REFILL_LIMIT).toBe(3);
    expect(fastPostMatchRefillPlan({
      requestedMinimum: 50,
      selectableCount: 49,
      attemptedCandidateCount: 115,
      refillAttempts: FAST_POST_MATCH_REFILL_LIMIT,
    })).toEqual({
      state: "shortfall",
      requestedMinimum: 50,
      selectableCount: 49,
      shortfall: 1,
      additionalCandidateGoal: 0,
    });
  });

  test("plans a bounded distinct-artist refill after track count is already satisfied", () => {
    expect(fastArtistDiversityRefillPlan({
      requestedTrackCount: 25,
      desiredArtistCount: 10,
      representedArtistCount: 4,
      refillAttempts: 0,
    })).toEqual({
      state: "refill",
      requestedTrackCount: 25,
      desiredArtistCount: 10,
      representedArtistCount: 4,
      artistShortfall: 6,
      additionalCandidateGoal: 19,
    });
    expect(fastArtistDiversityRefillPlan({
      requestedTrackCount: 25,
      desiredArtistCount: 10,
      representedArtistCount: 4,
      refillAttempts: FAST_POST_MATCH_REFILL_LIMIT,
    })).toMatchObject({ state: "shortfall", artistShortfall: 6, additionalCandidateGoal: 0 });
  });

  test("fails closed instead of returning NaN for malformed diversity inputs", () => {
    expect(fastArtistDiversityRefillPlan({
      requestedTrackCount: Number.NaN,
      desiredArtistCount: Number.NaN,
      representedArtistCount: Number.NaN,
      refillAttempts: Number.NaN,
    })).toEqual({
      state: "satisfied",
      requestedTrackCount: 1,
      desiredArtistCount: 0,
      representedArtistCount: 0,
      artistShortfall: 0,
      additionalCandidateGoal: 0,
    });
  });

  test("persists each refill's candidate goal and immutable research/matching deadline split", () => {
    const confirmedAt = new Date("2026-07-17T12:00:00.000Z");
    const checkpoint = createFastPostMatchRefillRouteCheckpoint(
      1,
      21,
      "US",
      confirmedAt,
      { OPENAI_FAST_MODEL: "fast-refill-snapshot" },
      {
        eligibleCount: 25,
        selectionRank: 44,
        diversityTarget: 10,
        representedArtists: ["Django Reinhardt", "Michel Petrucciani"],
      },
    );

    expect(checkpoint).toMatchObject({
      status: "queued",
      profile: "fast_post_match_refill_v1",
      generation: 1,
      additionalCandidateGoal: 21,
      storefront: "us",
      model: "fast-refill-snapshot",
      baselineEligibleCount: 25,
      baselineSelectionRank: 44,
      diversityTarget: 10,
      representedArtists: ["Django Reinhardt", "Michel Petrucciani"],
      confirmedAt: confirmedAt.toISOString(),
      researchDeadlineAt: new Date(confirmedAt.getTime() + FAST_POST_MATCH_REFILL_RESEARCH_MS).toISOString(),
      deadlineAt: new Date(
        confirmedAt.getTime() + FAST_POST_MATCH_REFILL_RESEARCH_MS + checkpoint.matchingReserveMs,
      ).toISOString(),
    });
    expect(parseFastPostMatchRefillRouteCheckpoint(checkpoint, 1)).toEqual(checkpoint);
    expect(parseFastPostMatchRefillRouteCheckpoint({
      ...checkpoint,
      deadlineAt: new Date(Date.parse(checkpoint.deadlineAt) + 1).toISOString(),
    }, 1)).toBeNull();
  });
});

type Candidate = TrackCandidateInput & {
  id: string;
  evidence: EvidenceClaimInput[];
  duplicateClusterKey?: string | null;
};

function candidate(id: string): Candidate {
  const ordinal = Number(id.replace(/\D/gu, "")) || 1;
  const title = `Rio Track ${ordinal}`;
  return {
    id,
    artist: `Rio Artist ${ordinal}`,
    title,
    album: `Rio Album ${ordinal}`,
    releaseYear: 2000 + ordinal,
    durationMs: 180_000 + ordinal,
    isrc: `BRA1A26${String(ordinal).padStart(5, "0")}`,
    musicbrainzId: null,
    versionLabel: null,
    duplicateClusterKey: null,
    evidence: [{
      sourceUrl: `https://music-history.example/rio/${ordinal}`,
      state: "editorial",
      supportScope: "track",
      subjectEntity: "Rio de Janeiro songs",
      subjectRelationship: "is editorially relevant to",
      relationship: "documents Rio de Janeiro in song",
      note: `${title} is documented in a Rio music-history source.`,
      sourceClass: "web",
      citationSupport: {
        responseId: `response-${ordinal}`,
        outputItemId: `message-${ordinal}`,
        contentIndex: 0,
        startIndex: 0,
        endIndex: 80,
        excerpt: `${title} is documented in a Rio music-history source.`,
      },
    }],
  };
}

function catalogSongFor(item: Candidate): CatalogSong {
  return {
    id: `apple-${item.id}`,
    name: item.title,
    artistName: item.artist,
    albumName: item.album!,
    releaseDate: `${item.releaseYear}-01-01`,
    durationInMillis: item.durationMs!,
    isrc: item.isrc!,
  };
}

class RefillMatchingRepository implements MatchingRepository {
  readonly checkpoints = new Map<string, unknown>();
  readonly updates: Array<Record<string, unknown>> = [];
  readonly matches: CatalogMatchResult[];
  readonly automaticCandidateRefills: Array<{
    runId: string;
    storefront: string;
    additionalCandidateGoal: number;
    currentRefillGeneration: number;
  }> = [];
  readonly automaticCatalogRecoveries: Array<{
    currentRecoveryGeneration: number;
    currentRefillGeneration: number;
  }> = [];
  readonly automaticPublications: string[] = [];
  readonly automaticDiversityContexts: Array<{
    desiredArtistCount: number;
    representedArtists: string[];
  }> = [];
  automaticRecoveryState: "queued" | "in_flight" | "not_needed" | "exhausted" = "not_needed";

  constructor(
    readonly candidates: Candidate[],
    existingMatches: CatalogMatchResult[],
    readonly runBrief: PlaylistBrief = exactBrief("Rio de Janeiro songs", 3),
    readonly autoPublish = false,
    readonly candidateRefillState: "queued" | "in_flight" | "not_needed" | "exhausted" = "not_needed",
  ) {
    this.matches = [...existingMatches];
  }

  async getRun() {
    return {
      brief: this.runBrief,
      status: "matching",
      autoPublish: this.autoPublish,
    };
  }

  async updateRun(_runId: string, patch: Record<string, unknown>) {
    this.updates.push(patch);
  }

  async listCandidates() {
    return this.candidates;
  }

  async listMatches() {
    const candidateArtists = new Map(this.candidates.map((item) => [item.id, item.artist]));
    return this.matches.map((match) => ({
      ...match,
      artist: candidateArtists.get(match.candidateId),
    }));
  }

  async saveMatch(_runId: string, match: CatalogMatchResult) {
    const index = this.matches.findIndex((existing) => existing.candidateId === match.candidateId);
    if (index >= 0) this.matches[index] = match;
    else this.matches.push(match);
  }

  async saveTimeoutMatches(_runId: string, candidateIds: string[], basis: string) {
    for (const candidateId of candidateIds) {
      await this.saveMatch(_runId, {
        candidateId,
        status: "review",
        basis,
        score: 0,
        song: null,
        alternatives: [],
      });
    }
  }

  async getResearchCheckpoint(_runId: string, phase: string) {
    return this.checkpoints.get(phase) ?? null;
  }

  async saveResearchCheckpoint(_runId: string, phase: string, checkpoint: unknown) {
    this.checkpoints.set(phase, checkpoint);
  }

  async queueAutomaticCatalogRecovery(
    _runId: string,
    _storefront: string,
    currentRecoveryGeneration: number,
    currentRefillGeneration = 0,
  ) {
    this.automaticCatalogRecoveries.push({ currentRecoveryGeneration, currentRefillGeneration });
    return this.automaticRecoveryState;
  }

  async queueAutomaticCandidateRefill(
    runId: string,
    storefront: string,
    additionalCandidateGoal: number,
    currentRefillGeneration: number,
    diversity?: { desiredArtistCount: number; representedArtists: string[] },
  ) {
    this.automaticCandidateRefills.push({
      runId,
      storefront,
      additionalCandidateGoal,
      currentRefillGeneration,
    });
    if (diversity) this.automaticDiversityContexts.push(structuredClone(diversity));
    return this.candidateRefillState;
  }

  async queueAutomaticPublication(runId: string) {
    this.automaticPublications.push(runId);
  }
}

describe("matching after a research refill", () => {
  beforeEach(() => {
    vi.mocked(lookupAppleCatalogByIsrc).mockReset().mockImplementation(async (_storefront, isrc) => {
      const item = [candidate("candidate-2"), candidate("candidate-3")]
        .find((entry) => entry.isrc === isrc);
      return item ? [catalogSongFor(item)] : [];
    });
    vi.mocked(searchAppleCatalog).mockReset().mockResolvedValue([]);
  });

  test("a 50-track sparse research pool reaches the exact target through safe Apple credit variants", async () => {
    const sparseCandidates = Array.from({ length: 50 }, (_, index): Candidate => {
      const ordinal = index + 1;
      const family = index < 18 ? "exact" : index < 34 ? "featured" : "collaborator";
      const base = candidate(`candidate-${ordinal}`);
      return {
        ...base,
        artist: `${family === "collaborator" ? "Producer" : "Artist"} ${ordinal}`,
        title: `${family} Track ${ordinal}`,
        album: null,
        releaseYear: null,
        durationMs: null,
        isrc: null,
        versionLabel: null,
      };
    });
    const repository = new RefillMatchingRepository(
      sparseCandidates,
      [],
      exactBrief("Rio de Janeiro songs", 50),
      true,
    );
    vi.mocked(lookupAppleCatalogByIsrc).mockResolvedValue([]);
    vi.mocked(searchAppleCatalog).mockImplementation(async (_storefront, query) => {
      const match = query.match(/(?:exact|featured|collaborator) Track (\d+)/iu);
      if (!match) return [];
      const ordinal = Number(match[1]);
      const source = sparseCandidates[ordinal - 1]!;
      if (ordinal <= 18) {
        return [{
          id: `apple-${ordinal}`,
          name: source.title,
          artistName: source.artist,
          albumName: `Exact Album ${ordinal}`,
          durationInMillis: 180_000 + ordinal,
          isrc: `USAAA26${String(ordinal).padStart(5, "0")}`,
        }];
      }
      if (ordinal <= 34) {
        return [
          {
            id: `apple-${ordinal}`,
            name: `${source.title} (feat. Guest ${ordinal})`,
            artistName: source.artist,
            albumName: `Featured Album ${ordinal}`,
            durationInMillis: 190_000 + ordinal,
            isrc: `USBBB26${String(ordinal).padStart(5, "0")}`,
          },
          {
            id: `apple-${ordinal}-compilation`,
            name: `${source.title} (feat. Guest ${ordinal})`,
            artistName: source.artist,
            albumName: `Featured Collection ${ordinal}`,
            durationInMillis: 190_000 + ordinal,
            isrc: `USBBB26${String(ordinal).padStart(5, "0")}`,
          },
        ];
      }
      return [
        {
          id: `apple-${ordinal}`,
          name: source.title,
          artistName: `${source.artist} & Vocalist ${ordinal}`,
          albumName: `Collaboration Album ${ordinal}`,
          durationInMillis: 200_000 + ordinal,
          isrc: `USCCC26${String(ordinal).padStart(5, "0")}`,
        },
        {
          id: `apple-${ordinal}-reissue`,
          name: source.title,
          artistName: `${source.artist} & Vocalist ${ordinal}`,
          albumName: `Collaboration Collection ${ordinal}`,
          durationInMillis: 200_000 + ordinal,
          isrc: `USCCC26${String(ordinal).padStart(5, "0")}`,
        },
      ];
    });

    await matchResearchRun(repository, "run", "us");

    expect(repository.matches).toHaveLength(50);
    expect(repository.matches.every((match) => match.status === "accepted" && match.song?.id)).toBe(true);
    expect(new Set(repository.matches.map((match) => match.song!.id))).toHaveLength(50);
    expect(repository.automaticCandidateRefills).toEqual([]);
    expect(repository.automaticPublications).toEqual(["run"]);
  });

  test("a subsequent matching pass preserves prior matches and calls Apple only for newly researched candidates", async () => {
    const prior = candidate("candidate-1");
    const newCandidates = [candidate("candidate-2"), candidate("candidate-3")];
    const repository = new RefillMatchingRepository(
      [prior, ...newCandidates],
      [{
        candidateId: prior.id,
        status: "accepted",
        basis: "strict identifier match from the initial pass",
        score: 1,
        song: catalogSongFor(prior),
        alternatives: [],
      }],
    );
    repository.checkpoints.set(
      "fast:post-match-refill:1:route",
      createFastPostMatchRefillRouteCheckpoint(1, 2, "us"),
    );

    await matchResearchRun(repository, "rio-run", "us", undefined, { refillGeneration: 1 });

    expect(lookupAppleCatalogByIsrc).toHaveBeenCalledTimes(2);
    expect(lookupAppleCatalogByIsrc).toHaveBeenNthCalledWith(1, "us", newCandidates[0]!.isrc, expect.any(AbortSignal));
    expect(lookupAppleCatalogByIsrc).toHaveBeenNthCalledWith(2, "us", newCandidates[1]!.isrc, expect.any(AbortSignal));
    expect(repository.matches).toEqual([
      expect.objectContaining({ candidateId: prior.id, status: "accepted" }),
      expect.objectContaining({ candidateId: newCandidates[0]!.id, status: "accepted" }),
      expect.objectContaining({ candidateId: newCandidates[1]!.id, status: "accepted" }),
    ]);
    expect(repository.updates.at(-1)).toMatchObject({
      status: "visitor_review",
      phase: "exception_review",
      error: null,
    });
  });

  test("an exact curated auto-publish shortfall queues the bounded Rio evidence refill before terminal failure", async () => {
    const candidates = Array.from({ length: 88 }, (_, index) => candidate(`candidate-${index + 1}`));
    const matches: CatalogMatchResult[] = candidates.map((item, index) => index < 42
      ? {
          candidateId: item.id,
          status: "accepted",
          basis: "strict Apple match",
          score: 1,
          song: catalogSongFor(item),
          alternatives: [],
        }
      : {
          candidateId: item.id,
          status: "review",
          basis: "No strict Apple version match",
          score: 0,
          song: null,
          alternatives: [],
        });
    const repository = new RefillMatchingRepository(
      candidates,
      matches,
      exactBrief("Rio de Janeiro songs", 50),
      true,
      "queued",
    );

    await matchResearchRun(repository, "rio-50", "us", undefined, {
      refillGeneration: 0,
    });

    expect(repository.automaticCandidateRefills).toEqual([{
      runId: "rio-50",
      storefront: "us",
      additionalCandidateGoal: 21,
      currentRefillGeneration: 0,
    }]);
    expect(repository.updates).not.toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  test("production French-jazz replay refills a four-artist pool even after all 25 tracks matched", async () => {
    const representedArtists = [
      "Django Reinhardt",
      "Michel Petrucciani",
      "Stéphane Grappelli",
      "Martial Solal",
    ];
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      ...candidate(`candidate-${index + 1}`),
      artist: representedArtists[Math.min(3, Math.floor(index / 7))]!,
    }));
    const matches: CatalogMatchResult[] = candidates.map((item) => ({
      candidateId: item.id,
      status: "accepted",
      basis: "strict Apple match",
      score: 1,
      song: catalogSongFor(item),
      alternatives: [],
    }));
    const repository = new RefillMatchingRepository(
      candidates,
      matches,
      exactBrief("French Jazz Flow", 25),
      true,
      "queued",
    );

    await matchResearchRun(repository, "french-jazz-production-replay", "us", undefined, {
      refillGeneration: 0,
    });

    expect(repository.automaticCandidateRefills).toEqual([{
      runId: "french-jazz-production-replay",
      storefront: "us",
      additionalCandidateGoal: 19,
      currentRefillGeneration: 0,
    }]);
    expect(repository.automaticDiversityContexts).toEqual([{
      desiredArtistCount: 10,
      representedArtists,
    }]);
    expect(repository.checkpoints.get("catalog_matching_outcome")).toMatchObject({
      safePrimaryCount: 25,
      shortfall: 0,
      desiredArtistCount: 10,
      representedArtistCount: 4,
      artistShortfall: 6,
      status: "shortfall",
    });
    expect(repository.automaticPublications).toEqual([]);
  });

  test("counts source candidate artists rather than Apple collaboration-credit variants", async () => {
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      ...candidate(`candidate-${index + 1}`),
      artist: "Django Reinhardt",
    }));
    const matches: CatalogMatchResult[] = candidates.map((item, index) => ({
      candidateId: item.id,
      status: "accepted",
      basis: "strict Apple match",
      score: 1,
      song: {
        ...catalogSongFor(item),
        artistName: `Django Reinhardt & Collaborator ${index + 1}`,
      },
      alternatives: [],
    }));
    const repository = new RefillMatchingRepository(
      candidates,
      matches,
      exactBrief("French Jazz Flow", 25),
      true,
      "queued",
    );

    await matchResearchRun(repository, "collaboration-credit-replay", "us", undefined, {
      refillGeneration: 0,
    });

    expect(repository.checkpoints.get("catalog_matching_outcome")).toMatchObject({
      representedArtistCount: 1,
      desiredArtistCount: 10,
      artistShortfall: 9,
    });
    expect(repository.automaticDiversityContexts[0]?.representedArtists)
      .toEqual(["Django Reinhardt"]);
  });

  test("publishes fail-open after bounded diversity recovery while preserving the visible shortfall", async () => {
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      ...candidate(`candidate-${index + 1}`),
      artist: index < 13 ? "Django Reinhardt" : "Michel Petrucciani",
    }));
    const matches: CatalogMatchResult[] = candidates.map((item) => ({
      candidateId: item.id,
      status: "accepted",
      basis: "strict Apple match",
      score: 1,
      song: catalogSongFor(item),
      alternatives: [],
    }));
    const repository = new RefillMatchingRepository(
      candidates,
      matches,
      exactBrief("French Jazz Flow", 25),
      true,
      "exhausted",
    );
    repository.checkpoints.set(
      `fast:post-match-refill:${FAST_POST_MATCH_REFILL_LIMIT}:route`,
      createFastPostMatchRefillRouteCheckpoint(FAST_POST_MATCH_REFILL_LIMIT, 1, "us"),
    );

    await matchResearchRun(repository, "exhausted-diversity-replay", "us", undefined, {
      refillGeneration: FAST_POST_MATCH_REFILL_LIMIT,
    });

    expect(repository.automaticCandidateRefills).toEqual([]);
    expect(repository.automaticPublications).toEqual(["exhausted-diversity-replay"]);
    expect(repository.checkpoints.get("catalog_matching_outcome")).toMatchObject({
      safePrimaryCount: 25,
      shortfall: 0,
      representedArtistCount: 2,
      desiredArtistCount: 10,
      artistShortfall: 8,
      status: "shortfall",
    });
  });

  test("generation three publishes an unresolved shortfall as partial without queuing a fourth refill", async () => {
    const candidates = Array.from({ length: 50 }, (_, index) => candidate(`candidate-${index + 1}`));
    const matches: CatalogMatchResult[] = candidates.map((item, index) => index < 49
      ? {
          candidateId: item.id,
          status: "accepted",
          basis: "strict Apple match",
          score: 1,
          song: catalogSongFor(item),
          alternatives: [],
        }
      : {
          candidateId: item.id,
          status: "unavailable",
          basis: "No compatible Apple recording",
          score: 0,
          song: null,
          alternatives: [],
        });
    const repository = new RefillMatchingRepository(
      candidates,
      matches,
      exactBrief("Rio de Janeiro songs", 50),
      true,
      "queued",
    );
    repository.checkpoints.set(
      "fast:post-match-refill:3:route",
      createFastPostMatchRefillRouteCheckpoint(3, 1, "us"),
    );

    await matchResearchRun(repository, "rio-terminal-shortfall", "us", undefined, {
      refillGeneration: 3,
    });

    expect(repository.automaticCandidateRefills).toEqual([]);
    expect(repository.updates.at(-1)).toMatchObject({
      status: "visitor_review",
      phase: "exception_review",
      error: null,
    });
    expect(repository.automaticPublications).toEqual(["rio-terminal-shortfall"]);
  });

  test("refill generation survives exhausted catalog recovery and queues generation two instead of stranding matching", async () => {
    const candidates = Array.from({ length: 3 }, (_, index) => candidate(`candidate-${index + 1}`));
    const repository = new RefillMatchingRepository(
      candidates,
      candidates.map((item, index): CatalogMatchResult => index < 2
        ? {
            candidateId: item.id,
            status: "accepted",
            basis: "strict Apple match",
            score: 1,
            song: catalogSongFor(item),
            alternatives: [],
          }
        : {
            candidateId: item.id,
            status: "unavailable",
            basis: "No compatible Apple recording",
            score: 0,
            song: null,
            alternatives: [],
          }),
      exactBrief("Rio de Janeiro songs", 3),
      true,
      "queued",
    );
    repository.automaticRecoveryState = "exhausted";
    repository.checkpoints.set(
      "fast:post-match-refill:1:route",
      createFastPostMatchRefillRouteCheckpoint(1, 1, "us"),
    );

    await matchResearchRun(repository, "rio-refill-recovery", "us", undefined, {
      retryIncomplete: true,
      recoveryGeneration: 3,
      refillGeneration: 1,
    });

    expect(repository.automaticCatalogRecoveries).toEqual([{
      currentRecoveryGeneration: 3,
      currentRefillGeneration: 1,
    }]);
    expect(repository.automaticCandidateRefills).toEqual([{
      runId: "rio-refill-recovery",
      storefront: "us",
      additionalCandidateGoal: 3,
      currentRefillGeneration: 1,
    }]);
    expect(repository.updates).not.toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  test("one permanently rejected Apple lookup becomes a candidate outcome and does not abort other matches", async () => {
    const rejected = candidate("candidate-2");
    const matched = candidate("candidate-3");
    vi.mocked(lookupAppleCatalogByIsrc).mockImplementation(async (_storefront, isrc) => {
      if (isrc === rejected.isrc) throw new AppleApiError("Malformed candidate query", 400, false);
      return isrc === matched.isrc ? [catalogSongFor(matched)] : [];
    });
    const repository = new RefillMatchingRepository(
      [rejected, matched],
      [],
      exactBrief("Rio de Janeiro songs", 1),
    );

    await matchResearchRun(repository, "per-candidate-failure", "us");

    expect(repository.matches).toEqual([
      expect.objectContaining({
        candidateId: rejected.id,
        status: "unavailable",
        song: null,
      }),
      expect.objectContaining({
        candidateId: matched.id,
        status: "accepted",
        song: expect.objectContaining({ id: `apple-${matched.id}` }),
      }),
    ]);
    expect(repository.updates.at(-1)).toMatchObject({
      status: "visitor_review",
      phase: "exception_review",
    });
  });
});
