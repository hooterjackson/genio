import { beforeEach, expect, test, vi } from "vitest";
import type { CatalogMatchResult, CatalogSong, PlaylistBrief, TrackCandidateInput } from "../shared/types.ts";

vi.mock("../server/apple.ts", () => ({
  lookupAppleCatalogByIsrc: vi.fn(),
  searchAppleCatalog: vi.fn(),
}));

import { lookupAppleCatalogByIsrc, searchAppleCatalog } from "../server/apple.ts";
import { matchResearchRun, type MatchingRepository } from "../server/matching-service.ts";

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
    evidence: [{ sourceUrl: "https://example.com/source", state, supportScope: "track", relationship: "performed on", note: "credit" }],
  };
}

class MemoryMatchingRepository implements MatchingRepository {
  readonly matches: CatalogMatchResult[] = [];
  readonly checkpoints: unknown[] = [];
  readonly updates: Array<Record<string, unknown>> = [];

  constructor(readonly candidates: Candidate[]) {}

  async getRun() { return { brief }; }
  async updateRun(_runId: string, patch: Record<string, unknown>) { this.updates.push(patch); }
  async listCandidates() { return this.candidates; }
  async listMatches() { return []; }
  async saveMatch(_runId: string, match: CatalogMatchResult) { this.matches.push(match); }
  async getResearchCheckpoint() { return null; }
  async saveResearchCheckpoint(_runId: string, _phase: string, checkpoint: unknown) { this.checkpoints.push(checkpoint); }
}

beforeEach(() => {
  vi.mocked(lookupAppleCatalogByIsrc).mockReset().mockResolvedValue([song]);
  vi.mocked(searchAppleCatalog).mockReset().mockResolvedValue([song]);
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
    relationship: "performed on",
    note: "Conflicting positive credit",
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
