import { afterEach, describe, expect, test, vi } from "vitest";
import { createAdapterRegistry } from "../server/adapters.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("structured source adapters", () => {
  test("Discogs discovery persists release references and normalizes track credits as inferred-only evidence", async () => {
    vi.stubEnv("DISCOGS_TOKEN", "test-token");
    const responses = [
      {
        pagination: { page: 1, pages: 2, items: 2 },
        results: [
          { type: "release", id: 101, title: "Artist - First" },
          { type: "master", id: 202, title: "Artist - Second" },
        ],
      },
      {
        title: "First",
        tracklist: [{
          type_: "track",
          position: "A1",
          title: "Track One",
          duration: "3:40",
          extraartists: [{ name: "Session Player", role: "Percussion" }],
        }],
      },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapterRegistry().get("discogs")!;
    const discovery = await adapter.discover("release", "Session Player", null);
    expect(discovery).toMatchObject({ complete: false, nextCursor: "2", advertisedTotal: 2 });
    expect(discovery.containers).toEqual([
      expect.objectContaining({ providerId: "discogs:release:101", containerType: "release" }),
      expect.objectContaining({ providerId: "discogs:master:202", containerType: "release" }),
    ]);
    expect(discovery.evidence.every((claim) => !claim.eligibleForAutomaticVerification)).toBe(true);

    const detail = await adapter.enumerate({
      ...discovery.containers[0]!,
      id: "container-1",
      status: "discovered",
      cursor: null,
      recoveredTotal: 0,
    }, null);
    expect(detail).toMatchObject({ complete: true, advertisedTotal: 1, nextCursor: null });
    expect(detail.evidence).toEqual([expect.objectContaining({
      evidenceKind: "track_credit",
      supportScope: "track",
      subject: "Session Player",
      relationship: "Percussion",
      trackTitle: "Track One",
      eligibleForAutomaticVerification: false,
    })]);
    const discoveryUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(discoveryUrl.origin + discoveryUrl.pathname).toBe("https://api.discogs.com/database/search");
    expect(discoveryUrl.searchParams.get("credit")).toBe("Session Player");
    expect(discoveryUrl.searchParams.get("type")).toBe("release");
    expect(discoveryUrl.searchParams.get("release_title")).toBeNull();
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://api.discogs.com/releases/101");
  });

  test("Discogs paginates a release larger than the model tool-output item cap without losing tracks", async () => {
    vi.stubEnv("DISCOGS_TOKEN", "test-token");
    const tracklist = Array.from({ length: 61 }, (_, index) => ({
      type_: "track",
      position: String(index + 1),
      title: `Track ${index + 1}`,
      duration: "3:00",
      extraartists: [],
    }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ title: "Large Release", tracklist }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createAdapterRegistry().get("discogs")!;
    const container = {
      id: "container-large",
      containerType: "release" as const,
      providerId: "discogs:release:101",
      title: "Large Release",
      advertisedTotal: 61,
      metadata: { adapterId: "discogs", externalType: "release", externalId: 101 },
      status: "discovered" as const,
      cursor: null,
      recoveredTotal: 0,
    };

    const first = await adapter.enumerate(container, null);
    const second = await adapter.enumerate(container, first.nextCursor);
    const third = await adapter.enumerate(container, second.nextCursor);

    expect(first).toMatchObject({ complete: false, nextCursor: "25", advertisedTotal: 61 });
    expect(second).toMatchObject({ complete: false, nextCursor: "50", advertisedTotal: 61 });
    expect(third).toMatchObject({ complete: true, nextCursor: null, advertisedTotal: 61 });
    expect([first, second, third].flatMap((page) => page.items).map((item: any) => item.title))
      .toEqual(tracklist.map((track) => track.title));
    expect([first, second, third].every((page) => page.items.length <= 50)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("MusicBrainz enumerates every track while explicitly withholding relationship verification", async () => {
    vi.useFakeTimers();
    vi.stubEnv("MUSICBRAINZ_CONTACT", "operator@example.com");
    const releaseId = "00000000-0000-4000-8000-000000000001";
    const responses = [
      {
        count: 1,
        releases: [{ id: releaseId, title: "Release", media: [{ "track-count": 2 }] }],
      },
      {
        id: releaseId,
        title: "Release",
        media: [{ tracks: [
          { number: "1", recording: { id: "00000000-0000-4000-8000-000000000002", title: "One", length: 180_000 } },
          { number: "2", recording: { id: "00000000-0000-4000-8000-000000000003", title: "Two", length: 200_000 } },
        ] }],
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const adapter = createAdapterRegistry().get("musicbrainz")!;

    const discoveryPromise = adapter.discover("release", "Artist", null);
    await vi.advanceTimersByTimeAsync(1_100);
    const discovery = await discoveryPromise;
    expect(discovery.containers).toEqual([expect.objectContaining({
      providerId: `musicbrainz:release:${releaseId}`,
      advertisedTotal: 2,
    })]);

    const enumerationPromise = adapter.enumerate({
      ...discovery.containers[0]!,
      id: "container-1",
      status: "discovered",
      cursor: null,
      recoveredTotal: 0,
    }, null);
    await vi.advanceTimersByTimeAsync(1_100);
    const enumeration = await enumerationPromise;
    expect(enumeration.items).toHaveLength(2);
    expect(enumeration).toMatchObject({ complete: true, advertisedTotal: 2 });
    expect(enumeration.evidence).toHaveLength(2);
    expect(enumeration.evidence.every((claim) =>
      claim.evidenceKind === "metadata" && claim.supportScope === "track" && !claim.eligibleForAutomaticVerification,
    )).toBe(true);
  });
});
