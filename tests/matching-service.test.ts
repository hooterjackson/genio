import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CatalogMatchResult, CatalogSong, PlaylistBrief, TrackCandidateInput } from "../shared/types.ts";

vi.mock("../server/apple.ts", async () => {
  const actual = await vi.importActual<typeof import("../server/apple.ts")>("../server/apple.ts");
  return {
    ...actual,
    lookupAppleCatalogByIsrc: vi.fn(),
    searchAppleCatalog: vi.fn(),
  };
});

import {
  AppleApiError,
  AppleAuthorizationRequiredError,
  lookupAppleCatalogByIsrc,
  searchAppleCatalog,
} from "../server/apple.ts";
import { matchResearchRun, type MatchingRepository } from "../server/matching-service.ts";
import { createFastRouteCheckpoint, researchExecutionPolicy } from "../server/research-policy.ts";

const brief: PlaylistBrief = {
  title: "Matching policy test",
  description: "A deterministic test scope.",
  mode: "exhaustive",
  subjectEntities: ["Test Artist"],
  relationship: "performed on",
  include: ["released recordings"],
  exclude: [],
  versionPolicy: "documented recording versions",
  evidencePolicy: "verified or corroborated",
  orderingPolicy: "chronological",
  targetSize: null,
  ambiguities: [],
};

const curatedBrief: PlaylistBrief = {
  ...brief,
  mode: "curated",
  evidencePolicy: "cited editorial sources",
  orderingPolicy: "influence rank",
  targetSize: { min: 50, max: 100 },
};

function routeCheckpoint(confirmedAt = new Date()) {
  const policy = researchExecutionPolicy(curatedBrief, {});
  if (policy.kind !== "fast_curated") throw new Error("Fixture policy must be fast");
  return createFastRouteCheckpoint(policy, confirmedAt);
}

function fastRepository(candidates: Candidate[], confirmedAt = new Date()): MemoryMatchingRepository {
  return new MemoryMatchingRepository(candidates, curatedBrief, new Map([
    ["fast:route:fast_curated_v1", routeCheckpoint(confirmedAt)],
  ]));
}

const song: CatalogSong = {
  id: "apple-1",
  name: "Test Song",
  artistName: "Test Artist",
  albumName: "Test Album",
  releaseDate: "2020-01-01",
  durationInMillis: 240_000,
  isrc: "USAAA2000001",
};

type Candidate = TrackCandidateInput & {
  id: string;
  duplicateClusterKey?: string | null;
};

function candidate(id: string, state: "verified" | "corroborated" | "editorial" | "inferred" | "disputed", duplicateClusterKey: string | null = null): Candidate {
  const citationSupport = state === "inferred" ? null : {
    responseId: `resp-${id}`,
    outputItemId: `msg-${id}`,
    contentIndex: 0,
    startIndex: 0,
    endIndex: 40,
    excerpt: "Test Artist performed on Test Song.",
  };
  return {
    id,
    artist: "Test Artist",
    title: "Test Song",
    album: "Test Album",
    releaseYear: 2020,
    durationMs: 240_000,
    isrc: "USAAA2000001",
    musicbrainzId: null,
    versionLabel: null,
    duplicateClusterKey,
    evidence: [{
      sourceUrl: "https://example.com/source",
      state,
      supportScope: "track",
      subjectEntity: brief.subjectEntities[0]!,
      subjectRelationship: brief.relationship,
      relationship: "performed on",
      note: "credit",
      sourceClass: "web",
      citationSupport,
    }],
  };
}

class MemoryMatchingRepository implements MatchingRepository {
  readonly matches: CatalogMatchResult[] = [];
  readonly checkpoints: unknown[] = [];
  readonly updates: Array<Record<string, unknown>> = [];

  readonly bulkTimeoutWrites: Array<{ candidateIds: string[]; basis: string }> = [];

  constructor(
    readonly candidates: Candidate[],
    readonly runBrief: PlaylistBrief = brief,
    readonly checkpointsByPhase: Map<string, unknown> = new Map(),
    readonly runCreatedAt?: string,
  ) {}

  async getRun() { return { brief: this.runBrief, createdAt: this.runCreatedAt }; }
  async updateRun(_runId: string, patch: Record<string, unknown>) { this.updates.push(patch); }
  async listCandidates() { return this.candidates; }
  async listMatches() { return this.matches; }
  async saveMatch(_runId: string, match: CatalogMatchResult) { this.matches.push(match); }
  async saveTimeoutMatches(_runId: string, candidateIds: string[], basis: string) {
    this.bulkTimeoutWrites.push({ candidateIds, basis });
    for (const candidateId of candidateIds) {
      this.matches.push({ candidateId, status: "review", basis, score: 0, song: null, alternatives: [] });
    }
  }
  async getResearchCheckpoint(_runId: string, phase: string) { return this.checkpointsByPhase.get(phase) ?? null; }
  async saveResearchCheckpoint(_runId: string, _phase: string, checkpoint: unknown) { this.checkpoints.push(checkpoint); }
}

beforeEach(() => {
  vi.mocked(lookupAppleCatalogByIsrc).mockReset().mockResolvedValue([song]);
  vi.mocked(searchAppleCatalog).mockReset().mockResolvedValue([song]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("inferred evidence keeps ranked Apple choices but is forced to visitor review", async () => {
  const repository = new MemoryMatchingRepository([candidate("inferred", "inferred")]);
  await matchResearchRun(repository, "run", "us");
  expect(repository.matches[0]).toMatchObject({
    candidateId: "inferred",
    status: "review",
    song: { id: "apple-1" },
  });
  expect(repository.matches[0]?.basis).toContain("Inferred evidence");
});

test("disputed evidence surfaces source disagreement for visitor review", async () => {
  const disputed = candidate("disputed", "disputed");
  disputed.evidence.push({
    sourceUrl: "https://example.net/support",
    state: "verified",
    supportScope: "track",
    subjectEntity: brief.subjectEntities[0]!,
    subjectRelationship: brief.relationship,
    relationship: "performed on",
    note: "Conflicting positive credit",
    sourceClass: "web",
    citationSupport: {
      responseId: "resp-positive",
      outputItemId: "msg-positive",
      contentIndex: 0,
      startIndex: 0,
      endIndex: 40,
      excerpt: "Test Artist performed on Test Song.",
    },
  });
  const repository = new MemoryMatchingRepository([disputed]);
  await matchResearchRun(repository, "run", "us");
  expect(repository.matches[0]).toMatchObject({ candidateId: "disputed", status: "review" });
  expect(repository.matches[0]?.basis).toContain("Sources disagree");
});

test("every surviving member of a metadata duplicate cluster requires review", async () => {
  const repository = new MemoryMatchingRepository([
    candidate("cluster-a", "verified", "meta:test-artist|test-song"),
    candidate("cluster-b", "verified", "meta:test-artist|test-song"),
  ]);
  await matchResearchRun(repository, "run", "us");
  expect(repository.matches.map((match) => match.status)).toEqual(["review", "review"]);
  expect(repository.matches.every((match) => match.basis.includes("Possible duplicate cluster"))).toBe(true);
});

test("a later exact match to an accepted Apple catalog ID is recorded as duplicate", async () => {
  const repository = new MemoryMatchingRepository([
    candidate("first", "verified"),
    candidate("second", "corroborated"),
  ]);
  await matchResearchRun(repository, "run", "us");
  expect(repository.matches.map((match) => match.status)).toEqual(["accepted", "duplicate"]);
  expect(repository.matches[1]?.basis).toContain("already accepted");
});

test("catalog reads use bounded concurrency while match decisions stay ordered", async () => {
  vi.stubEnv("APPLE_MATCHING_CONCURRENCY", "4");
  let active = 0;
  let maximumActive = 0;
  vi.mocked(lookupAppleCatalogByIsrc).mockImplementation(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return [song];
  });
  const candidates = Array.from({ length: 100 }, (_, index) => candidate(`candidate-${index}`, "verified"));
  const repository = new MemoryMatchingRepository(candidates);

  await matchResearchRun(repository, "run", "us");

  expect(maximumActive).toBe(4);
  expect(repository.matches.map((match) => match.candidateId)).toEqual(candidates.map((item) => item.id));
  expect((repository.checkpoints.at(-1) as any).complete).toBe(true);
  expect((repository.checkpoints.at(-1) as any)).toMatchObject({
    startedAt: expect.any(String),
    completedAt: expect.any(String),
  });
});

test("fast matching converts a transient Apple failure into an explicit review outcome", async () => {
  vi.mocked(lookupAppleCatalogByIsrc)
    .mockRejectedValueOnce(new AppleApiError("Apple overloaded", 503, true))
    .mockResolvedValueOnce([song]);
  const repository = fastRepository([
    candidate("timed-out", "verified"),
    candidate("completed", "verified"),
  ]);

  // The durable route, not a possibly stale queue marker, selects fast mode.
  await matchResearchRun(repository, "run", "us");

  expect(repository.matches[0]).toMatchObject({
    candidateId: "timed-out",
    status: "review",
    basis: expect.stringContaining("temporarily unavailable"),
  });
  expect(repository.matches[1]).toMatchObject({ candidateId: "completed", status: "accepted" });
});

test("fast matching records a genuine elapsed deadline as a review outcome without calling Apple", async () => {
  const repository = fastRepository(
    [candidate("deadline", "verified"), candidate("deadline-two", "verified")],
    new Date(Date.now() - 120_001),
  );

  await matchResearchRun(repository, "run", "us", undefined, { fast: true });

  expect(lookupAppleCatalogByIsrc).not.toHaveBeenCalled();
  expect(searchAppleCatalog).not.toHaveBeenCalled();
  expect(repository.bulkTimeoutWrites).toEqual([{
    candidateIds: ["deadline", "deadline-two"],
    basis: expect.stringContaining("absolute fast-run window"),
  }]);
  expect(repository.matches).toHaveLength(2);
  expect((repository.checkpoints.at(-1) as any)).toMatchObject({ complete: true, nextIndex: 2, timedOutCandidateCount: 2 });
});

test("deadline bulk accounting preserves a crash-window match and records every unmatched candidate", async () => {
  const repository = fastRepository(
    [candidate("already-matched", "verified"), candidate("remaining-a", "verified"), candidate("remaining-b", "verified")],
    new Date(Date.now() - 120_001),
  );
  repository.matches.push({
    candidateId: "already-matched",
    status: "accepted",
    basis: "Saved before checkpoint advancement",
    score: 1,
    song,
    alternatives: [],
  });

  await matchResearchRun(repository, "run", "us");

  expect(repository.bulkTimeoutWrites[0]?.candidateIds).toEqual(["remaining-a", "remaining-b"]);
  expect(repository.matches.map((match) => match.candidateId)).toEqual([
    "already-matched",
    "remaining-a",
    "remaining-b",
  ]);
  expect((repository.checkpoints.at(-1) as any)).toMatchObject({ complete: true, nextIndex: 3 });
});

test("fast matching backfills a legacy route from run creation without resetting the clock", async () => {
  const confirmedAt = new Date(Date.now() - 120_001);
  const repository = new MemoryMatchingRepository(
    [candidate("legacy-deadline", "verified")],
    curatedBrief,
    new Map(),
    confirmedAt.toISOString(),
  );

  await matchResearchRun(repository, "run", "us", undefined, { fast: true });

  expect(lookupAppleCatalogByIsrc).not.toHaveBeenCalled();
  expect(repository.bulkTimeoutWrites[0]?.candidateIds).toEqual(["legacy-deadline"]);
  expect(repository.checkpoints[0]).toMatchObject({
    confirmedAt: confirmedAt.toISOString(),
    deadlineAt: new Date(confirmedAt.getTime() + 120_000).toISOString(),
  });
});

test.each([401, 403] as const)("fast matching propagates Apple catalog authentication failure %s", async (status) => {
  const error = new AppleApiError("Developer credentials rejected", status, false);
  vi.mocked(lookupAppleCatalogByIsrc).mockRejectedValueOnce(error);
  const repository = fastRepository([candidate(`auth-${status}`, "verified")]);

  await expect(matchResearchRun(repository, "run", "us", undefined, { fast: true })).rejects.toBe(error);
  expect(repository.matches).toHaveLength(0);
});

test("fast matching propagates the authorization-required sentinel for durable handling", async () => {
  const error = new AppleAuthorizationRequiredError(403);
  vi.mocked(lookupAppleCatalogByIsrc).mockRejectedValueOnce(error);
  const repository = fastRepository([candidate("owner-auth", "verified")]);

  await expect(matchResearchRun(repository, "run", "us", undefined, { fast: true })).rejects.toBe(error);
  expect(repository.matches).toHaveLength(0);
});

test.each([
  new AppleApiError("Invalid catalog request", 400, false),
  new Error("catalog response mapper crashed"),
])("fast matching fails rather than relabeling non-transient errors: $message", async (error) => {
  vi.mocked(lookupAppleCatalogByIsrc).mockRejectedValueOnce(error);
  const repository = fastRepository([candidate("non-transient", "verified")]);

  await expect(matchResearchRun(repository, "run", "us", undefined, { fast: true })).rejects.toBe(error);
  expect(repository.matches).toHaveLength(0);
});
