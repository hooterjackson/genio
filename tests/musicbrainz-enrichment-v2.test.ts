import { describe, expect, test, vi } from "vitest";
import type {
  CatalogMatchResult,
  CatalogSong,
  TrackCandidateInput,
} from "../shared/types.ts";
import type {
  AppleCatalogCacheEntry,
  AppleCatalogCacheResourceKind,
  AppleCatalogCacheWrite,
} from "../server/apple-catalog-cache.ts";
import {
  enrichMusicBrainzIdentity,
  musicBrainzEnrichmentFingerprint,
  shouldEnrichMusicBrainzIdentity,
  type MusicBrainzEnrichmentRepository,
} from "../server/musicbrainz-enrichment-v2.ts";

const recordingId = "11111111-1111-4111-8111-111111111111";
const releaseGroupId = "22222222-2222-4222-8222-222222222222";

const song: CatalogSong = {
  id: "apple-1",
  name: "Can You Feel It",
  artistName: "Mr. Fingers",
  albumName: "Introduction",
  durationInMillis: 360_000,
};

type Candidate = Pick<TrackCandidateInput,
  "artist" | "title" | "album" | "durationMs" | "isrc" | "musicbrainzId" | "versionLabel"> & {
    id: string;
  };

function candidate(id = "candidate-1", title = song.name): Candidate {
  return {
    id,
    artist: song.artistName,
    title,
    album: song.albumName,
    durationMs: song.durationInMillis ?? null,
    isrc: null,
    musicbrainzId: null,
    versionLabel: null,
  };
}

function accepted(override: Partial<CatalogMatchResult> = {}): CatalogMatchResult {
  return {
    candidateId: "candidate-1",
    status: "accepted",
    basis: "exact metadata",
    score: 1,
    song,
    alternatives: [],
    ...override,
  };
}

function cacheKey(storefront: string, kind: AppleCatalogCacheResourceKind, fingerprint: string): string {
  return `${storefront}:${kind}:${fingerprint}`;
}

class MemoryRepository implements MusicBrainzEnrichmentRepository {
  readonly entries = new Map<string, AppleCatalogCacheEntry>();
  readonly writes: AppleCatalogCacheWrite[] = [];
  readonly updates: Array<{ runId: string; candidateId: string; recordingId: string }> = [];
  uncachedRequests = 0;

  async getAppleCatalogCacheEntry(storefront: string, kind: AppleCatalogCacheResourceKind, fingerprint: string) {
    return this.entries.get(cacheKey(storefront, kind, fingerprint)) ?? null;
  }

  async putAppleCatalogCacheEntry(entry: AppleCatalogCacheWrite) {
    this.writes.push(entry);
    this.entries.set(cacheKey(entry.storefront, entry.resourceKind, entry.requestFingerprint), { ...entry });
  }

  async deleteAppleCatalogCacheEntry(storefront: string, kind: AppleCatalogCacheResourceKind, fingerprint: string) {
    this.entries.delete(cacheKey(storefront, kind, fingerprint));
  }

  async reserveMusicBrainzEnrichmentRequest(_runId: string, maximum: number) {
    if (this.uncachedRequests >= maximum) return null;
    this.uncachedRequests += 1;
    return this.uncachedRequests;
  }

  async updateCandidateMusicBrainzIdentity(runId: string, candidateId: string, id: string) {
    this.updates.push({ runId, candidateId, recordingId: id });
  }
}

function musicBrainzPayload() {
  return {
    recordings: [{
      id: recordingId,
      title: song.name,
      length: song.durationInMillis,
      "artist-credit": [{ artist: { name: song.artistName } }],
      releases: [{
        title: song.albumName,
        "release-group": { id: releaseGroupId },
      }],
    }],
  };
}

const noThrottle = async () => undefined;
const noSleep = async () => undefined;

describe("Pipeline V2 MusicBrainz identity enrichment", () => {
  test("stays off the hot path for a stable ISRC and enriches only ambiguous/version-family rows", () => {
    const stableSong = { ...song, isrc: "USAAA2000001" };
    expect(shouldEnrichMusicBrainzIdentity(candidate(), accepted({ song: stableSong }))).toBe(false);
    expect(shouldEnrichMusicBrainzIdentity(
      candidate(),
      accepted({ song: stableSong, alternatives: [{ ...stableSong, id: "apple-2" }] }),
    )).toBe(true);
    expect(shouldEnrichMusicBrainzIdentity(
      { ...candidate(), versionLabel: "Live" },
      accepted({ song: stableSong }),
    )).toBe(true);
    expect(shouldEnrichMusicBrainzIdentity(
      { ...candidate(), musicbrainzId: recordingId },
      accepted(),
    )).toBe(false);
  });

  test("serves a warm compact cache hit with zero uncached requests", async () => {
    const repository = new MemoryRepository();
    const row = candidate();
    const fingerprint = musicBrainzEnrichmentFingerprint(row, song);
    repository.entries.set(cacheKey("zz", "musicbrainz_identity", fingerprint), {
      storefront: "zz",
      resourceKind: "musicbrainz_identity",
      requestFingerprint: fingerprint,
      payload: {
        version: "musicbrainz_identity_v1",
        status: "resolved",
        recordingId,
        releaseGroupId,
      },
      fetchedAt: "2026-07-19T12:00:00.000Z",
      expiresAt: "2026-07-26T12:00:00.000Z",
    });
    const fetchImpl = vi.fn(async () => { throw new Error("cache hit must not fetch"); });

    await expect(enrichMusicBrainzIdentity(repository, "run-1", row, accepted(), undefined, {
      fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      throttle: noThrottle,
    })).resolves.toEqual({ recordingId, releaseGroupId, source: "cache" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repository.uncachedRequests).toBe(0);
    expect(repository.updates).toEqual([{ runId: "run-1", candidateId: row.id, recordingId }]);
  });

  test("enforces five uncached HTTP requests across a durable run counter", async () => {
    const repository = new MemoryRepository();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ recordings: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    for (let index = 0; index < 6; index += 1) {
      const row = candidate(`candidate-${index}`, `Track ${index}`);
      const match = accepted({ candidateId: row.id, song: { ...song, name: row.title } });
      await enrichMusicBrainzIdentity(repository, "same-run", row, match, undefined, {
        fetchImpl: fetchImpl as typeof fetch,
        throttle: noThrottle,
        sleep: noSleep,
      });
    }

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(repository.uncachedRequests).toBe(5);
    // A resumed worker shares the repository-backed counter and cannot make a
    // sixth provider request.
    await enrichMusicBrainzIdentity(
      repository,
      "same-run",
      candidate("candidate-resumed", "Track resumed"),
      accepted({ song: { ...song, name: "Track resumed" } }),
      undefined,
      { fetchImpl: fetchImpl as typeof fetch, throttle: noThrottle },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  test("honors Retry-After, uses the fixed public host and persists IDs only", async () => {
    const repository = new MemoryRepository();
    const sleeps: number[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(musicBrainzPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    await expect(enrichMusicBrainzIdentity(repository, "run-rate", candidate(), accepted(), undefined, {
      fetchImpl: fetchImpl as typeof fetch,
      throttle: noThrottle,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      now: () => new Date("2026-07-19T12:00:00.000Z"),
    })).resolves.toEqual({ recordingId, releaseGroupId, source: "musicbrainz" });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(repository.uncachedRequests).toBe(2);
    expect(sleeps).toEqual([1_000]);
    const [requestUrl, requestInit] = fetchImpl.mock.calls[0]!;
    expect(new URL(String(requestUrl)).hostname).toBe("musicbrainz.org");
    expect(requestInit.headers["User-Agent"]).toContain("9enio/");
    expect(repository.writes[0]?.payload).toEqual({
      version: "musicbrainz_identity_v1",
      status: "resolved",
      recordingId,
      releaseGroupId,
    });
    expect(repository.updates).toEqual([{ runId: "run-rate", candidateId: "candidate-1", recordingId }]);
  });

  test("fails open when MusicBrainz is unavailable and does not cache the outage", async () => {
    const repository = new MemoryRepository();
    const fetchImpl = vi.fn(async () => { throw new TypeError("network unavailable"); });

    await expect(enrichMusicBrainzIdentity(repository, "run-outage", candidate(), accepted(), undefined, {
      fetchImpl: fetchImpl as typeof fetch,
      throttle: noThrottle,
    })).resolves.toBeNull();
    expect(repository.uncachedRequests).toBe(1);
    expect(repository.writes).toHaveLength(0);
    expect(repository.updates).toHaveLength(0);
  });
});
