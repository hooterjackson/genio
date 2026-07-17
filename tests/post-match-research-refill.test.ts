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

  test("never silently accepts a smaller playlist after the two-refill ceiling", () => {
    expect(FAST_POST_MATCH_REFILL_LIMIT).toBe(2);
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

  test("persists each refill's candidate goal and immutable research/matching deadline split", () => {
    const confirmedAt = new Date("2026-07-17T12:00:00.000Z");
    const checkpoint = createFastPostMatchRefillRouteCheckpoint(
      1,
      21,
      "US",
      confirmedAt,
      { OPENAI_FAST_MODEL: "fast-refill-snapshot" },
    );

    expect(checkpoint).toMatchObject({
      status: "queued",
      profile: "fast_post_match_refill_v1",
      generation: 1,
      additionalCandidateGoal: 21,
      storefront: "us",
      model: "fast-refill-snapshot",
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
    return this.matches;
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
  ) {
    this.automaticCandidateRefills.push({
      runId,
      storefront,
      additionalCandidateGoal,
      currentRefillGeneration,
    });
    return this.candidateRefillState;
  }

  async queueAutomaticPublication() {}
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

  test("generation two terminalizes an unresolved exact-count shortfall without queuing a third refill", async () => {
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
      "fast:post-match-refill:2:route",
      createFastPostMatchRefillRouteCheckpoint(2, 1, "us"),
    );

    await matchResearchRun(repository, "rio-terminal-shortfall", "us", undefined, {
      refillGeneration: 2,
    });

    expect(repository.automaticCandidateRefills).toEqual([]);
    expect(repository.updates.at(-1)).toMatchObject({
      status: "failed",
      phase: "catalog_matching_shortfall",
      error: expect.stringContaining("49 strict unique catalog matches for the required 50"),
    });
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
      additionalCandidateGoal: 2,
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
