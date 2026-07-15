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
import {
  catalogLookupTimeoutMs,
  catalogRecoveryDeadlineMs,
  matchResearchRun,
  type MatchingRepository,
} from "../server/matching-service.ts";
import { RETRYABLE_CATALOG_MATCH_BASES } from "../server/catalog-match-recovery.ts";
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
    ["fast:route:fast_curated_v3", routeCheckpoint(confirmedAt)],
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
  async saveMatch(_runId: string, match: CatalogMatchResult) {
    const existing = this.matches.findIndex((item) => item.candidateId === match.candidateId);
    if (existing >= 0) this.matches[existing] = match;
    else this.matches.push(match);
  }
  async saveTimeoutMatches(_runId: string, candidateIds: string[], basis: string) {
    this.bulkTimeoutWrites.push({ candidateIds, basis });
    for (const candidateId of candidateIds) {
      this.matches.push({ candidateId, status: "review", basis, score: 0, song: null, alternatives: [] });
    }
  }
  async getResearchCheckpoint(_runId: string, phase: string) { return this.checkpointsByPhase.get(phase) ?? null; }
  async saveResearchCheckpoint(_runId: string, _phase: string, checkpoint: unknown) { this.checkpoints.push(checkpoint); }
}

function lastMatchingCheckpoint(repository: MemoryMatchingRepository): Record<string, unknown> | undefined {
  return [...repository.checkpoints].reverse().find((checkpoint): checkpoint is Record<string, unknown> => (
    typeof checkpoint === "object" && checkpoint !== null && "complete" in checkpoint
  ));
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
  expect(lastMatchingCheckpoint(repository)?.complete).toBe(true);
  expect(lastMatchingCheckpoint(repository)).toMatchObject({
    startedAt: expect.any(String),
    completedAt: expect.any(String),
  });
});

test("fast matching preserves 100 distinct candidates as 100 accepted Apple tracks", async () => {
  const candidates = Array.from({ length: 100 }, (_, index) => {
    const ordinal = index + 1;
    const title = `Influential Track ${String(ordinal).padStart(3, "0")}`;
    const isrc = `USAAA26${String(ordinal).padStart(5, "0")}`;
    const item = candidate(`candidate-${ordinal}`, "editorial");
    item.title = title;
    item.isrc = isrc;
    item.evidence[0]!.citationSupport!.excerpt = `Test Artist performed on ${title}.`;
    return item;
  });
  const songsByIsrc = new Map(candidates.map((item, index): [string, CatalogSong] => [
    item.isrc!,
    {
      ...song,
      id: `apple-${index + 1}`,
      name: item.title,
      isrc: item.isrc!,
    },
  ]));
  vi.mocked(lookupAppleCatalogByIsrc).mockImplementation(async (_storefront, isrc) => {
    const match = songsByIsrc.get(isrc);
    return match ? [match] : [];
  });
  const exactCuratedBrief = { ...curatedBrief, targetSize: { min: 100, max: 100 } };
  const repository = new MemoryMatchingRepository(candidates, exactCuratedBrief, new Map([
    ["fast:route:fast_curated_v3", routeCheckpoint()],
  ]));

  await matchResearchRun(repository, "run", "us", undefined, { fast: true });

  expect(repository.matches).toHaveLength(100);
  expect(repository.matches.every((match) => match.status === "accepted")).toBe(true);
  expect(repository.matches.map((match) => match.song?.id)).toEqual(
    Array.from({ length: 100 }, (_, index) => `apple-${index + 1}`),
  );
  expect(new Set(repository.matches.map((match) => match.song?.id)).size).toBe(100);
  expect(repository.updates.at(-1)).toMatchObject({ status: "visitor_review", phase: "exception_review" });
});

test("matching records an explicit shortfall instead of presenting a partial requested count as complete", async () => {
  const exactTargetBrief = { ...curatedBrief, targetSize: { min: 4, max: 4 } };
  const repository = new MemoryMatchingRepository([], exactTargetBrief, new Map([
    ["fast:route:fast_curated_v3", routeCheckpoint()],
  ]));
  repository.matches.push(
    { candidateId: "accepted", status: "accepted", basis: "exact", score: 100, song: { ...song, id: "apple-a" }, alternatives: [] },
    { candidateId: "selectable-review", status: "review", basis: "version review", score: 70, song: { ...song, id: "apple-b" }, alternatives: [] },
    { candidateId: "wrong-artist", status: "review", basis: "title only", score: 40, song: null, alternatives: [{ ...song, id: "apple-wrong" }] },
  );

  await matchResearchRun(repository, "run", "us", undefined, { fast: true });

  expect(repository.updates.at(-1)).toMatchObject({
    status: "visitor_review",
    phase: "catalog_matching_shortfall",
    error: expect.stringContaining("2 safe catalog matches for the required 4; 2 remain unresolved"),
  });
  expect(repository.checkpoints).toContainEqual(expect.objectContaining({
    storefront: "us",
    targetMinimum: 4,
    safePrimaryCount: 2,
    shortfall: 2,
    status: "shortfall",
  }));
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

test("fast matching records a genuine elapsed deadline for later recovery without calling Apple", async () => {
  const repository = fastRepository(
    [candidate("deadline", "verified"), candidate("deadline-two", "verified")],
    new Date(Date.now() - 120_001),
  );

  await matchResearchRun(repository, "run", "us", undefined, { fast: true });

  expect(lookupAppleCatalogByIsrc).not.toHaveBeenCalled();
  expect(searchAppleCatalog).not.toHaveBeenCalled();
  expect(repository.bulkTimeoutWrites).toEqual([{
    candidateIds: ["deadline", "deadline-two"],
    basis: RETRYABLE_CATALOG_MATCH_BASES[0],
  }]);
  expect(repository.matches).toHaveLength(2);
  expect(lastMatchingCheckpoint(repository)).toMatchObject({
    complete: true,
    nextIndex: 2,
    timedOutCandidateCount: 2,
  });
});

test("deadline bulk accounting preserves a crash-window match and records only unmatched candidates", async () => {
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
  expect(lookupAppleCatalogByIsrc).not.toHaveBeenCalled();
  expect(repository.matches.map((match) => match.candidateId)).toEqual([
    "already-matched",
    "remaining-a",
    "remaining-b",
  ]);
  expect(lastMatchingCheckpoint(repository)).toMatchObject({ complete: true, nextIndex: 3 });
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
  expect(repository.matches[0]).toMatchObject({ candidateId: "legacy-deadline", status: "review" });
  expect(repository.checkpoints[0]).toMatchObject({
    confirmedAt: confirmedAt.toISOString(),
    deadlineAt: new Date(confirmedAt.getTime() + 120_000).toISOString(),
  });
});

test("catalog recovery retries only prior timeout rows and preserves completed matches", async () => {
  const repository = fastRepository([
    candidate("completed", "verified"),
    candidate("retry", "verified"),
    candidate("manual-review", "inferred"),
  ]);
  repository.matches.push(
    { candidateId: "completed", status: "accepted", basis: "Exact match", score: 1, song: { ...song, id: "apple-complete" }, alternatives: [] },
    { candidateId: "retry", status: "review", basis: RETRYABLE_CATALOG_MATCH_BASES[0], score: 0, song: null, alternatives: [] },
    { candidateId: "manual-review", status: "review", basis: "Inferred evidence requires visitor approval", score: 1, song, alternatives: [] },
  );
  vi.mocked(lookupAppleCatalogByIsrc).mockResolvedValueOnce([{ ...song, id: "apple-retry" }]);

  await matchResearchRun(repository, "run", "us", undefined, { retryIncomplete: true });

  expect(lookupAppleCatalogByIsrc).toHaveBeenCalledTimes(1);
  expect(repository.matches).toEqual([
    expect.objectContaining({ candidateId: "completed", status: "accepted", song: expect.objectContaining({ id: "apple-complete" }) }),
    expect.objectContaining({ candidateId: "retry", status: "accepted", song: expect.objectContaining({ id: "apple-retry" }) }),
    expect.objectContaining({ candidateId: "manual-review", status: "review" }),
  ]);
  expect(repository.updates[0]).toMatchObject({
    status: "matching",
    phase: "catalog_matching_recovery",
  });
  expect(lastMatchingCheckpoint(repository)).toMatchObject({ complete: true, nextIndex: 1 });
});

test("catalog recovery stops at its configured deadline and leaves remaining rows retryable", async () => {
  vi.stubEnv("APPLE_CATALOG_RECOVERY_TIMEOUT_MS", "90000");
  const repository = fastRepository([
    candidate("retry-a", "verified"),
    candidate("retry-b", "verified"),
  ]);
  repository.matches.push(
    { candidateId: "retry-a", status: "review", basis: RETRYABLE_CATALOG_MATCH_BASES[0], score: 0, song: null, alternatives: [] },
    { candidateId: "retry-b", status: "review", basis: RETRYABLE_CATALOG_MATCH_BASES[0], score: 0, song: null, alternatives: [] },
  );
  const base = Date.now();
  const clock = vi.spyOn(Date, "now")
    .mockReturnValueOnce(base)
    .mockReturnValue(base + 90_001);

  try {
    await matchResearchRun(repository, "run", "us", undefined, { retryIncomplete: true });
  } finally {
    clock.mockRestore();
  }

  expect(lookupAppleCatalogByIsrc).not.toHaveBeenCalled();
  expect(repository.bulkTimeoutWrites).toEqual([]);
  expect(repository.matches).toEqual([
    expect.objectContaining({ candidateId: "retry-a", status: "review", basis: RETRYABLE_CATALOG_MATCH_BASES[0] }),
    expect.objectContaining({ candidateId: "retry-b", status: "review", basis: RETRYABLE_CATALOG_MATCH_BASES[0] }),
  ]);
  expect(lastMatchingCheckpoint(repository)).toMatchObject({
    complete: true,
    nextIndex: 2,
    timedOutCandidateCount: 2,
  });
  expect(repository.updates.at(-1)).toMatchObject({ status: "visitor_review", phase: "catalog_matching_shortfall" });
});

test("catalog recovery gets a complete medium-playlist window and caps unsafe overrides", () => {
  vi.stubEnv("APPLE_CATALOG_RECOVERY_TIMEOUT_MS", "45000");
  expect(catalogRecoveryDeadlineMs()).toBe(90_000);
  vi.stubEnv("APPLE_CATALOG_RECOVERY_TIMEOUT_MS", "90000");
  expect(catalogRecoveryDeadlineMs()).toBe(90_000);
  vi.stubEnv("APPLE_CATALOG_RECOVERY_TIMEOUT_MS", "999999");
  expect(catalogRecoveryDeadlineMs()).toBe(180_000);
});

test("catalog recovery permits one bounded provider retry without relaxing the fast lookup window", () => {
  vi.stubEnv("FAST_MATCH_LOOKUP_TIMEOUT_MS", "7000");
  expect(catalogLookupTimeoutMs(false)).toBe(7_000);
  expect(catalogLookupTimeoutMs(true)).toBe(20_000);
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
