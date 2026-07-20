import { describe, expect, test, vi } from "vitest";
import type { CatalogSong } from "../shared/types.ts";
import {
  createPipelineV3LiveAdapters,
  type HostedWebCandidateV3,
} from "../server/pipeline-v3-live-adapters.ts";
import {
  executeRetrievalV3,
  retrievalStrategiesForEnginesV3,
  type DiscoveryRequestV3,
  type EvidenceSourceGovernanceV3,
  type QualificationRequestV3,
  type RawTrackCandidateV3,
} from "../server/pipeline-v3-retrieval.ts";
import {
  createRunSpecV3,
  resolveRunSpecV3,
  type SelectionPlanV3,
} from "../server/selection-plan-v3.ts";

function plan(prompt: string, requestedTrackCount: number): SelectionPlanV3 {
  return resolveRunSpecV3(createRunSpecV3({
    prompt,
    requestedTrackCount,
    storefront: "US",
  }), []);
}

function song(index: number, artist = `Artist ${index % 20}`, title = `Track ${index}`): CatalogSong {
  return {
    id: String(10_000 + index),
    name: title,
    artistName: artist,
    albumName: `Album ${index % 30}`,
    durationInMillis: 180_000 + index,
    isrc: `USAAA${String(index).padStart(7, "0")}`,
    url: `https://music.apple.com/us/song/${10_000 + index}`,
  };
}

function emptySearch(overrides: Record<string, unknown> = {}) {
  return { songs: [], artists: [], albums: [], playlists: [], ...overrides } as any;
}

function discoveryRequest(selection: SelectionPlanV3, kind: "editorial_tracks" | "graph_traversal"): DiscoveryRequestV3 {
  const engine = kind === "graph_traversal" ? "factual_relationship" : "curated_genre_scene";
  const strategy = retrievalStrategiesForEnginesV3([engine]).find((value) => value.kind === kind)!;
  return {
    runId: "run-1",
    executionMode: "active",
    appleWriteAccess: "forbidden",
    plan: selection,
    engine,
    strategy,
    strategyRound: 1,
    cursor: null,
    requestedRawCandidateCount: 50,
    alreadyDiscoveredCandidateIds: [],
    alreadyDiscoveredTracks: [],
    qualifiedRecordingFamilyKeys: [],
    qualifiedTrackSeeds: [],
  };
}

describe("Pipeline V3 live read-only adapters", () => {
  test("uses the run-frozen model route instead of the adapter startup route", async () => {
    const validUrl = "https://www.loc.gov/item/disco-history";
    const createResponse = vi.fn().mockResolvedValue({
      output_text: JSON.stringify({ candidates: [] }),
      output: [{ type: "web_search_call", action: { sources: [{ url: validUrl }] } }],
    });
    const startupRoute = {
      version: "pipeline_v3_model_route_v2" as const,
      tier: "baseline" as const,
      providerModelId: "gpt-5.6-terra",
      baselineProviderModelId: "gpt-5.6-terra",
      escalationProviderModelId: "gpt-5.6-luna",
      resolutionMode: "provider_managed_alias" as const,
      modelCatalogValidatedAt: "2026-07-20T14:30:00.000Z",
      reason: "baseline" as const,
      interpretationConfidence: "medium" as const,
      structuredRepairFailures: 0,
      escalationCount: 0 as const,
    };
    const frozenRoute = {
      ...startupRoute,
      providerModelId: "gpt-5.6-luna",
      baselineProviderModelId: "gpt-5.6-luna",
      escalationProviderModelId: "gpt-5.6-terra",
    };
    const adapters = createPipelineV3LiveAdapters({
      createResponse: createResponse as any,
      modelRoute: startupRoute,
    });
    const request = {
      ...discoveryRequest(plan("25 disco songs", 25), "editorial_tracks"),
      modelRoute: frozenRoute,
    };

    await adapters.discover(request);

    expect(createResponse).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-luna" }),
      expect.any(Object),
    );
  });

  test("repairs malformed structured output once with the frozen escalation provider ID", async () => {
    const validUrl = "https://www.loc.gov/item/disco-history";
    const createResponse = vi.fn()
      .mockResolvedValueOnce({ output_text: "{not-json", output: [] })
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          candidates: [{
            artist: "Chic",
            title: "Good Times",
            album: null,
            sources: [{ url: validUrl, authority: "institutional" }],
          }],
        }),
        output: [{ type: "web_search_call", action: { sources: [{ url: validUrl }] } }],
      });
    const adapters = createPipelineV3LiveAdapters({
      createResponse: createResponse as any,
      modelRoute: {
        version: "pipeline_v3_model_route_v2",
        tier: "baseline",
        providerModelId: "gpt-5.6-luna",
        baselineProviderModelId: "gpt-5.6-luna",
        escalationProviderModelId: "gpt-5.6-terra",
        resolutionMode: "provider_managed_alias",
        modelCatalogValidatedAt: "2026-07-20T14:30:00.000Z",
        reason: "baseline",
        interpretationConfidence: "medium",
        structuredRepairFailures: 0,
        escalationCount: 0,
      },
    });

    const batch = await adapters.discover(discoveryRequest(plan("25 disco songs", 25), "editorial_tracks"));

    expect(batch.candidates).toHaveLength(1);
    expect(createResponse).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls.map(([input]) => input.model)).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-terra",
    ]);
    expect(createResponse.mock.calls[1]![1]).toMatchObject({
      operation: "pipeline_v3.live_retrieval.structured_repair",
    });
  });

  test("does not cascade beyond one structured repair or retry provider outages", async () => {
    const route = {
      version: "pipeline_v3_model_route_v2",
      tier: "baseline",
      providerModelId: "gpt-5.6-luna",
      baselineProviderModelId: "gpt-5.6-luna",
      escalationProviderModelId: "gpt-5.6-terra",
      resolutionMode: "provider_managed_alias",
      modelCatalogValidatedAt: "2026-07-20T14:30:00.000Z",
      reason: "baseline",
      interpretationConfidence: "medium",
      structuredRepairFailures: 0,
      escalationCount: 0,
    } as const;
    const malformed = vi.fn(async () => ({ output_text: "{not-json", output: [] }));
    const malformedAdapters = createPipelineV3LiveAdapters({ createResponse: malformed as any, modelRoute: route });
    await expect(malformedAdapters.discover(
      discoveryRequest(plan("25 disco songs", 25), "editorial_tracks"),
    )).rejects.toThrow("malformed structured output");
    expect(malformed).toHaveBeenCalledTimes(2);

    const outage = vi.fn(async () => { throw new Error("provider_http_503"); });
    const outageAdapters = createPipelineV3LiveAdapters({ createResponse: outage as any, modelRoute: route });
    await expect(outageAdapters.discover(
      discoveryRequest(plan("25 disco songs", 25), "editorial_tracks"),
    )).rejects.toThrow("provider_http_503");
    expect(outage).toHaveBeenCalledTimes(1);
  });

  test("keeps valid structured hosted candidates when an invalid sibling invents its source URL", async () => {
    const selection = plan("25 disco songs", 25);
    const validUrl = "https://www.loc.gov/item/disco-history";
    const createResponse = vi.fn(async () => ({
      output_text: JSON.stringify({
        candidates: [
          {
            artist: "Chic",
            title: "Good Times",
            album: null,
            sources: [{ url: validUrl, authority: "institutional" }],
          },
          {
            artist: "Invented Artist",
            title: "Invented Track",
            album: null,
            sources: [{ url: "https://invented.invalid/not-returned", authority: "primary" }],
          },
        ],
      }),
      output: [{ type: "web_search_call", action: { sources: [{ url: validUrl }] } }],
    }));
    const adapters = createPipelineV3LiveAdapters({ createResponse: createResponse as any });
    const batch = await adapters.discover(discoveryRequest(selection, "editorial_tracks"));

    expect(batch.candidates).toHaveLength(1);
    expect(batch.candidates[0]).toMatchObject({ artist: "Chic", title: "Good Times" });
    expect(batch.exhausted).toBe(false);
    expect(batch.nextCursor).toEqual(expect.any(String));
  });

  test("uses scout sources only as re-retrieved discovery leads", async () => {
    const seedUrl = "https://example.org/disco-history";
    const selection = resolveRunSpecV3(createRunSpecV3({
      prompt: "25 disco songs",
      requestedTrackCount: 25,
      storefront: "US",
      guidanceSourceHints: [{
        url: seedUrl,
        title: "Disco history",
        excerpt: "A provider-returned scout source.",
      }],
    }), []);
    const candidatePayload = JSON.stringify({
      candidates: [{
        artist: "Chic",
        title: "Good Times",
        album: null,
        sources: [{ url: seedUrl, authority: "editorial" }],
      }],
    });
    const withoutCurrentRetrieval = vi.fn(async () => ({
      output_text: candidatePayload,
      output: [],
    }));
    const ungrounded = createPipelineV3LiveAdapters({ createResponse: withoutCurrentRetrieval as any });
    await expect(ungrounded.discover(discoveryRequest(selection, "editorial_tracks")))
      .rejects.toThrow("not bound to provider-returned sources");
    const requestBody = JSON.parse((withoutCurrentRetrieval.mock.calls[0] as any)[0].input);
    expect(requestBody.scoutSourceHints).toEqual([{
      url: seedUrl,
      title: "Disco history",
      excerpt: "A provider-returned scout source.",
    }]);

    const withCurrentRetrieval = vi.fn(async () => ({
      output_text: candidatePayload,
      output: [{ type: "web_search_call", action: { sources: [{ url: seedUrl }] } }],
    }));
    const grounded = createPipelineV3LiveAdapters({ createResponse: withCurrentRetrieval as any });
    const groundedBatch = await grounded.discover(discoveryRequest(selection, "editorial_tracks"));
    expect(groundedBatch.candidates).toHaveLength(1);
    expect(groundedBatch.candidates[0]).toMatchObject({ artist: "Chic", title: "Good Times" });
  });

  test.each([
    "disco songs",
    "Brazilian disco songs",
    "house music songs",
    "jazz by French artists",
  ])("does not silently return zero for a catalog-rich cited prompt: %s", async (prompt) => {
    const selection = plan(prompt, 25);
    expect(selection.confirmed).toBe(true);
    const supported = Array.from({ length: 40 }, (_, index): HostedWebCandidateV3 => ({
      artist: `Artist ${index}`,
      title: `Track ${index}`,
      album: `Album ${index}`,
      sourceUrl: `https://example.com/${encodeURIComponent(prompt)}/${index}`,
      provenanceRoot: "example.com",
      evidenceStrength: 0.9,
      sourceRank: index + 1,
    }));
    const catalog = supported.map((candidate, index) => song(index, candidate.artist, candidate.title));
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: vi.fn(async () => emptySearch()) as any,
      discoverHostedWeb: vi.fn(async () => supported),
      searchAppleSongs: vi.fn(async (_storefront: string, query: string) => catalog
        .filter((candidate) => query.includes(candidate.artistName) && query.includes(candidate.name))) as any,
      lookupAppleByIsrc: vi.fn(async () => []) as any,
    });

    const result = await executeRetrievalV3({ runId: `rich-${prompt}`, plan: selection, adapters });

    expect(result.outcome).toMatchObject({ status: "exact_ready", selectedTrackCount: 25 });
    expect(result.reserve.length).toBeGreaterThan(0);
  });

  test("fills a 150-track request plus its reserve from trusted paginated Apple editorial containers", async () => {
    const tracks = Array.from({ length: 180 }, (_, index) => song(index));
    const searchAppleResources = vi.fn(async () => emptySearch({
      playlists: [{
        id: "pl.disco",
        name: "Disco Essentials",
        curatorName: "Apple Music",
        description: "Defining disco songs from the genre's foundational eras.",
        url: "https://music.apple.com/us/playlist/disco-essentials/pl.disco",
      }],
    }));
    const getPlaylistTracks = vi.fn(async (_storefront: string, _id: string, next: string | null) => (
      next
        ? { items: tracks.slice(100), next: null }
        : { items: tracks.slice(0, 100), next: "/v1/catalog/us/playlists/pl.disco/tracks?offset=100" }
    ));
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: searchAppleResources as any,
      getPlaylistTracks: getPlaylistTracks as any,
      searchAppleSongs: vi.fn(async () => []) as any,
      lookupAppleByIsrc: vi.fn(async () => []) as any,
      discoverHostedWeb: vi.fn(async () => []),
    });

    const result = await executeRetrievalV3({
      runId: "large-disco",
      plan: plan("150 disco songs", 150),
      adapters,
    });

    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      requestedTrackCount: 150,
      selectedTrackCount: 150,
      reserveTrackCount: 30,
    });
    expect(result.selected).toHaveLength(150);
    expect(result.reserve).toHaveLength(30);
    expect(getPlaylistTracks).toHaveBeenCalledTimes(2);
  });

  test("resolves hosted-web track evidence to Apple while keeping Apple catalog identity separate from relevance", async () => {
    const selection = plan("25 influential disco songs", 25);
    const supported: HostedWebCandidateV3 = {
      artist: "Chic",
      title: "Good Times",
      album: null,
      sourceUrl: "https://www.loc.gov/item/disco-history",
      provenanceRoot: "loc.gov",
      evidenceStrength: 0.9,
      sourceRank: 1,
      rankingSignals: { influence: 0.9 },
    };
    const appleSong = song(1, "Chic", "Good Times");
    const adapters = createPipelineV3LiveAdapters({
      discoverHostedWeb: vi.fn(async () => [supported]),
      searchAppleSongs: vi.fn(async () => [appleSong]) as any,
      lookupAppleByIsrc: vi.fn(async () => []) as any,
    });
    const request = discoveryRequest(selection, "editorial_tracks");
    const batch = await adapters.discover(request);
    const qualifications = await adapters.qualify({
      runId: request.runId,
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: request.engine,
      strategy: request.strategy,
      candidates: batch.candidates,
    });

    expect(batch.candidates).toHaveLength(1);
    expect(qualifications[0]).toMatchObject({
      scope: { passed: true },
      evidence: { passed: true, independentProvenanceRoots: 1 },
      catalog: { storefrontPlayable: true, appleSongId: appleSong.id },
    });
  });

  test("retains independent medium-strength web bindings so corroboration can satisfy the evidence floor", async () => {
    const selection = plan("25 disco songs", 25);
    const appleSong = song(11, "First Choice", "Let No Man Put Asunder");
    const supported: HostedWebCandidateV3 = {
      artist: appleSong.artistName,
      title: appleSong.name,
      album: null,
      sourceUrl: "https://example.com/disco-history",
      provenanceRoot: "example.com",
      evidenceStrength: 0.7,
      sourceRank: 1,
      evidence: [
        {
          sourceUrl: "https://example.com/disco-history",
          provenanceRoot: "example.com",
          evidenceStrength: 0.7,
          sourceRank: 1,
        },
        {
          sourceUrl: "https://archive.org/details/disco-oral-history",
          provenanceRoot: "archive.org",
          evidenceStrength: 0.7,
          sourceRank: 2,
        },
      ],
    };
    const adapters = createPipelineV3LiveAdapters({
      discoverHostedWeb: vi.fn(async () => [supported]),
      searchAppleSongs: vi.fn(async () => [appleSong]) as any,
      lookupAppleByIsrc: vi.fn(async () => []) as any,
    });
    const discovery = discoveryRequest(selection, "editorial_tracks");
    const batch = await adapters.discover(discovery);
    const [qualification] = await adapters.qualify({
      runId: discovery.runId,
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: discovery.engine,
      strategy: discovery.strategy,
      candidates: batch.candidates,
    });

    expect(qualification!.evidence).toMatchObject({
      passed: true,
      independentProvenanceRoots: 2,
    });
    expect(qualification!.evidence.bindingIds).toHaveLength(2);
  });

  test("never substitutes model/web discovery for a governed factual graph", async () => {
    const factualBase = plan("Paulinho da Costa performance credits", 25);
    const factual: SelectionPlanV3 = {
      ...factualBase,
      intents: ["factual_relationship"],
      engines: ["factual_relationship"],
      confirmed: true,
    };
    const discoverHostedWeb = vi.fn(async () => [{
      artist: "Invented",
      title: "Invented",
      album: null,
      sourceUrl: "https://example.com/source",
      provenanceRoot: "example.com",
      evidenceStrength: 1,
      sourceRank: 1,
    }]);
    const adapters = createPipelineV3LiveAdapters({ discoverHostedWeb });
    const batch = await adapters.discover(discoveryRequest(factual, "graph_traversal"));

    expect(batch).toEqual({ candidates: [], nextCursor: null, exhausted: true, costUnits: 0 });
    expect(discoverHostedWeb).not.toHaveBeenCalled();
  });

  test("propagates governed graph cursors and binds only predicates proven by the frozen assertion", async () => {
    const base = plan("Paulinho da Costa performance credits", 25);
    const factual: SelectionPlanV3 = {
      ...base,
      intents: ["factual_relationship"],
      engines: ["factual_relationship"],
      membershipPredicates: [
        {
          id: "subject-paulinho",
          axis: "artist",
          operator: "require",
          values: ["Paulinho da Costa"],
          source: "user",
          reason: "Exact credited performer.",
        },
        {
          id: "relationship-performed",
          axis: "factual_relationship",
          operator: "require",
          values: ["subject_performed"],
          source: "user",
          reason: "Exact performance credit.",
        },
      ],
      confirmed: true,
    };
    const discoverHostedWeb = vi.fn(async () => []);
    const appleSong = song(100, "Michael Jackson", "Human Nature");
    const discoverGovernedGraph = vi.fn(async () => ({
      candidates: [{
        title: appleSong.name,
        artist: appleSong.artistName,
        album: appleSong.albumName,
        appleSong,
        observationIds: ["observation-1"],
        assertionIds: ["assertion-1"],
        provenanceRoots: ["credits.example"],
        sourceUrls: ["https://credits.example/human-nature"],
        evidenceStrength: 0.98,
        sourceRank: 0,
        evidenceBindings: [{
          id: "graph:assertion-1:observation-1",
          assertionId: "assertion-1",
          observationId: "observation-1",
          provenanceRoot: "credits.example",
          sourceUrl: "https://credits.example/human-nature",
          evidenceStrength: 0.98,
          sourceRank: 0,
          predicateIds: ["subject-paulinho", "relationship-performed"],
          governance: {
            policyVersion: "evidence-source-governance-v3",
            useScope: "durable_corpus",
            approvalState: "approved",
            accessMethod: "manual_entry",
            licenseState: "permission_recorded",
            licenseVersion: "test-permission-v1",
            termsVersion: "test-terms-v1",
            attribution: "Official recording credits",
            cachePolicy: "excerpt_only",
            retentionPolicy: "durable_public_corpus",
            freshnessPolicy: "immutable_revision",
            sourceHash: "a".repeat(64),
            sourceRevision: "a".repeat(64),
          } satisfies EvidenceSourceGovernanceV3,
        }],
      }],
      nextCursor: "next-frozen-page",
      exhausted: false,
      graphSnapshotId: "00000000-0000-4000-8000-000000000014",
    }));
    const adapters = createPipelineV3LiveAdapters({ discoverHostedWeb, discoverGovernedGraph });
    const request = discoveryRequest(factual, "graph_traversal");
    const batch = await adapters.discover(request);
    const [qualification] = await adapters.qualify({
      runId: request.runId,
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: factual,
      engine: request.engine,
      strategy: request.strategy,
      candidates: batch.candidates,
    });

    expect(batch).toMatchObject({ nextCursor: "next-frozen-page", exhausted: false, costUnits: 0 });
    expect(qualification).toMatchObject({
      scope: { passed: true },
      evidence: { passed: true, bindingIds: ["graph:assertion-1:observation-1"] },
      catalog: { appleSongId: appleSong.id, storefrontPlayable: true },
    });
    expect(discoverHostedWeb).not.toHaveBeenCalled();
  });

  test("preserves valid sibling catalog resolutions when one candidate lookup fails", async () => {
    const selection = plan("25 disco songs", 25);
    const web: HostedWebCandidateV3[] = [
      {
        artist: "Broken Artist",
        title: "Broken Track",
        album: null,
        sourceUrl: "https://example.com/disco-one",
        provenanceRoot: "example.com",
        evidenceStrength: 0.9,
        sourceRank: 1,
      },
      {
        artist: "Chic",
        title: "Good Times",
        album: null,
        sourceUrl: "https://www.loc.gov/item/disco-two",
        provenanceRoot: "loc.gov",
        evidenceStrength: 0.9,
        sourceRank: 2,
      },
    ];
    const good = song(2, "Chic", "Good Times");
    const adapters = createPipelineV3LiveAdapters({
      discoverHostedWeb: vi.fn(async () => web),
      searchAppleSongs: vi.fn(async (_storefront: string, query: string) => {
        if (query.includes("Broken")) throw new Error("one lookup failed");
        return [good];
      }) as any,
      lookupAppleByIsrc: vi.fn(async () => []) as any,
    });
    const discovery = discoveryRequest(selection, "editorial_tracks");
    const batch = await adapters.discover(discovery);
    const request: QualificationRequestV3 = {
      runId: discovery.runId,
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: discovery.engine,
      strategy: discovery.strategy,
      candidates: batch.candidates,
    };
    const qualified = await adapters.qualify(request);

    expect(qualified).toHaveLength(2);
    expect(qualified[0]!.catalog.storefrontPlayable).toBe(false);
    expect(qualified[1]!.catalog).toMatchObject({ storefrontPlayable: true, appleSongId: good.id });
  });

  test("catalog identity without an attached scope binding can never qualify", async () => {
    const selection = plan("25 disco songs", 25);
    const appleSong = song(3, "Chic", "Le Freak");
    const strategy = retrievalStrategiesForEnginesV3(["curated_genre_scene"])
      .find((value) => value.kind === "editorial_tracks")!;
    const candidate: RawTrackCandidateV3 = {
      id: "unbound",
      artist: appleSong.artistName,
      title: appleSong.name,
      album: appleSong.albumName,
      sourceObservationIds: [],
      metadata: {
        schema: "genio-v3-live-candidate/v1",
        song: appleSong,
        bindings: [],
      },
    };
    const adapters = createPipelineV3LiveAdapters();
    const [qualification] = await adapters.qualify({
      runId: "unbound-run",
      executionMode: "shadow",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: "curated_genre_scene",
      strategy,
      candidates: [candidate],
    });

    expect(qualification!.catalog.storefrontPlayable).toBe(true);
    expect(qualification!.evidence).toMatchObject({ passed: false, bindingIds: [] });
    expect(qualification!.scope.passed).toBe(false);
  });

  test("qualified genre expansion enumerates Apple releases but requires exact hosted evidence and never traverses similar artists", async () => {
    const selection = plan("25 disco songs", 25);
    const strategy = retrievalStrategiesForEnginesV3(["curated_genre_scene"])
      .find((value) => value.kind === "qualified_expansion")!;
    const expanded = song(301, "Chic", "Everybody Dance");
    const getSimilarArtists = vi.fn(async () => ({ items: [], next: null }));
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: vi.fn(async () => emptySearch({
        artists: [{ id: "123", name: "Chic", genreNames: ["Disco"] }],
      })) as any,
      getArtistTopSongs: vi.fn(async () => ({ items: [expanded], next: null })) as any,
      getArtistAlbums: vi.fn(async () => ({ items: [], next: null })) as any,
      getAlbumTracks: vi.fn(async () => ({ items: [], next: null })) as any,
      getSimilarArtists: getSimilarArtists as any,
      verifyAppleExpansion: vi.fn(async () => [{
        artist: expanded.artistName,
        title: expanded.name,
        album: expanded.albumName,
        sourceUrl: "https://www.loc.gov/item/disco-expansion",
        provenanceRoot: "loc.gov",
        evidenceStrength: 0.9,
        sourceRank: 1,
      }]),
    });
    const batch = await adapters.discover({
      ...discoveryRequest(selection, "editorial_tracks"),
      strategy,
      requestedRawCandidateCount: 25,
      qualifiedRecordingFamilyKeys: ["isrc:USAAA0000001"],
      qualifiedTrackSeeds: [{
        artist: "Chic",
        title: "Good Times",
        appleSongId: "10001",
        recordingFamilyKey: "isrc:USAAA0000001",
      }],
    });
    const [qualification] = await adapters.qualify({
      runId: "expansion",
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: "curated_genre_scene",
      strategy,
      candidates: batch.candidates,
    });

    expect(batch.candidates).toHaveLength(1);
    expect(qualification).toMatchObject({
      evidence: { passed: true },
      catalog: { storefrontPlayable: true, appleSongId: expanded.id },
    });
    expect(getSimilarArtists).not.toHaveBeenCalled();
  });
});
