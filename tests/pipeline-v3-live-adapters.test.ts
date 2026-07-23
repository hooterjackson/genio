import { describe, expect, test, vi } from "vitest";
import type { CatalogSong } from "../shared/types.ts";
import {
  createPipelineV3LiveAdapters,
  type HostedWebCandidateV3,
} from "../server/pipeline-v3-live-adapters.ts";
import {
  executeRetrievalV3,
  RetrievalDependencyErrorV3,
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

  test("emits a provider-compatible strict schema and deduplicates predicate IDs locally", async () => {
    const selection = plan("25 disco songs", 25);
    const predicateId = selection.membershipPredicates.find((value) => value.axis === "genre")!.id;
    const sourceUrl = "https://www.loc.gov/item/disco-history";
    const citationText = "Chic — Good Times is a disco recording documented by the archive. [source]";
    const markerStart = citationText.indexOf("[source]");
    const createResponse = vi.fn(async (input: unknown, context: unknown) => {
      void input;
      void context;
      return {
      output_text: JSON.stringify({
        candidates: [{
          artist: "Chic",
          title: "Good Times",
          album: null,
          sources: [{ url: sourceUrl, predicateIds: [predicateId, predicateId] }],
        }],
      }),
      output: [
        { type: "web_search_call", action: { sources: [{ url: sourceUrl }] } },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: citationText,
            annotations: [{
              type: "url_citation",
              url: sourceUrl,
              start_index: markerStart,
              end_index: markerStart + "[source]".length,
            }],
          }],
        },
      ],
      };
    });
    const adapters = createPipelineV3LiveAdapters({ createResponse: createResponse as any });

    const batch = await adapters.discover(discoveryRequest(selection, "editorial_tracks"));

    const requestBody = (createResponse.mock.calls as unknown as Array<[any]>)[0]![0];
    expect(JSON.stringify(requestBody.text.format.schema)).not.toContain('"uniqueItems"');
    expect((batch.candidates[0] as any).metadata.bindings[0].predicateIds).toEqual([predicateId]);
  });

  test("keeps central suitability on a dedicated ranking-only signal", async () => {
    const base = plan("10 smooth polished disco songs", 10);
    const selection: SelectionPlanV3 = {
      ...base,
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["quality:smooth", "quality:polished"],
        criteria: ["smooth", "polished"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    };
    const predicateId = selection.membershipPredicates.find(({ axis }) => axis === "genre")!.id;
    const sourceUrl = "https://www.loc.gov/item/disco-history";
    const citationText = "Chic — Good Times is a disco recording. [source]";
    const markerStart = citationText.indexOf("[source]");
    const createResponse = vi.fn(async () => ({
      output_text: JSON.stringify({
        candidates: [{
          artist: "Chic",
          title: "Good Times",
          album: null,
          centralQualityScore: 0.92,
          sources: [{ url: sourceUrl, predicateIds: [predicateId] }],
        }],
      }),
      output: [
        { type: "web_search_call", action: { sources: [{ url: sourceUrl }] } },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: citationText,
            annotations: [{
              type: "url_citation",
              url: sourceUrl,
              start_index: markerStart,
              end_index: markerStart + "[source]".length,
            }],
          }],
        },
      ],
    }));
    const adapters = createPipelineV3LiveAdapters({ createResponse: createResponse as any });

    const batch = await adapters.discover(discoveryRequest(selection, "editorial_tracks"));
    const requestBody = (createResponse.mock.calls as unknown as Array<[any]>)[0]![0];
    expect(requestBody.text.format.schema.properties.candidates.items.properties)
      .toHaveProperty("centralQualityScore");
    expect(JSON.parse(requestBody.input).centralQualityPolicy.criteria)
      .toEqual(["smooth", "polished"]);
    expect((batch.candidates[0] as any).metadata.rankingSignals).toMatchObject({
      relevance: 0.85,
      central_quality: 0.92,
    });
  });

  test("verifies recording-version and content policy at the catalog layer instead of demanding citation predicates", async () => {
    const base = plan("25 disco songs", 25);
    const genrePredicate = base.membershipPredicates.find((value) => value.axis === "genre")!;
    const selection: SelectionPlanV3 = {
      ...base,
      membershipPredicates: [
        ...base.membershipPredicates,
        {
          id: "version-policy",
          axis: "recording_version",
          operator: "require",
          values: ["canonical studio recording; no live, remix, or tribute versions"],
          source: "user",
          reason: "Catalog recording policy.",
        },
        {
          id: "content-policy",
          axis: "content",
          operator: "require",
          values: ["clean or explicit canonical issue"],
          source: "user",
          reason: "Catalog content policy.",
        },
      ],
    };
    const sourceUrl = "https://www.loc.gov/item/disco-history";
    const citationText = "Chic — Good Times is a disco recording documented by the archive. [source]";
    const markerStart = citationText.indexOf("[source]");
    const createResponse = vi.fn(async (input: unknown, context: unknown) => {
      void input;
      void context;
      return {
      output_text: JSON.stringify({
        candidates: [{
          artist: "Chic",
          title: "Good Times",
          album: null,
          sources: [{ url: sourceUrl, predicateIds: [genrePredicate.id] }],
        }],
      }),
      output: [
        { type: "web_search_call", action: { sources: [{ url: sourceUrl }] } },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: citationText,
            annotations: [{
              type: "url_citation",
              url: sourceUrl,
              start_index: markerStart,
              end_index: markerStart + "[source]".length,
            }],
          }],
        },
      ],
      };
    });
    const appleSong = { ...song(6, "Chic", "Good Times"), contentRating: "clean" as const };
    const adapters = createPipelineV3LiveAdapters({
      createResponse: createResponse as any,
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

    const requestSchema = JSON.stringify((createResponse.mock.calls[0]![0] as any).text.format.schema);
    expect(requestSchema).toContain(genrePredicate.id);
    expect(requestSchema).not.toContain("version-policy");
    expect(requestSchema).not.toContain("content-policy");
    expect(qualification).toMatchObject({
      scope: { passed: true, failedMembershipPredicateIds: [] },
      evidence: { passed: true },
      version: { compatible: true },
    });
  });

  test.each([
    { policy: "clean", rating: "clean", compatible: true },
    { policy: "clean", rating: "explicit", compatible: false },
    { policy: "explicit", rating: "explicit", compatible: true },
    { policy: "explicit", rating: "clean", compatible: false },
    { policy: "clean", rating: undefined, compatible: false },
  ] as const)(
    "enforces $policy-only membership against Apple content rating $rating",
    async ({ policy, rating, compatible }) => {
      const base = plan("25 disco songs", 25);
      const genrePredicate = base.membershipPredicates.find((value) => value.axis === "genre")!;
      const selection: SelectionPlanV3 = {
        ...base,
        membershipPredicates: [
          ...base.membershipPredicates,
          {
            id: `${policy}-content-policy`,
            axis: "content",
            operator: "require",
            values: [policy],
            source: "user",
            reason: `Require the Apple-catalog ${policy} recording.`,
          },
        ],
      };
      const sourceUrl = "https://www.loc.gov/item/disco-history";
      const appleSong: CatalogSong = {
        ...song(7, "Chic", "Le Freak"),
        ...(rating ? { contentRating: rating } : {}),
      };
      const adapters = createPipelineV3LiveAdapters({
        discoverHostedWeb: vi.fn(async () => [{
          artist: "Chic",
          title: "Le Freak",
          album: null,
          sourceUrl,
          provenanceRoot: "loc.gov",
          evidenceStrength: 0.9,
          sourceRank: 1,
          predicateIds: [genrePredicate.id],
          providerAttestedExactTrackScope: true,
        }]),
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

      expect(qualification.version.compatible).toBe(compatible);
    },
  );

  test("carries a typed clean-only policy as catalog policy rather than evidence membership", () => {
    const spec = createRunSpecV3({
      prompt: "25 disco songs, clean versions only",
      requestedTrackCount: 25,
      storefront: "US",
      typedSelectionPlan: {
        intents: ["genre_scene"],
        scopeKind: "broad_curated",
        constraints: [],
        diversityGoals: {
          minimumDistinctArtists: 5,
          minimumDistinctAlbums: 5,
          minimumDistinctEras: 2,
          minimumDistinctScenes: 2,
          minimumDistinctGeographies: null,
          maximumTracksPerArtist: 4,
          maximumTracksPerAlbum: 3,
        },
        orderingPolicy: {
          mode: "editorial",
          goals: [],
          avoidAdjacentSameArtist: true,
          avoidAdjacentSameAlbum: true,
        },
        softGoalRelaxationOrder: [],
        versionPolicy: {
          preferred: ["canonical", "clean"],
          allowed: ["canonical", "clean"],
          excludeCompilations: false,
          excludeKaraokeAndTributes: true,
        },
        contentPolicy: {
          explicitContent: "clean_only",
          instrumental: "allow",
          languages: [],
        },
      },
    });

    expect(spec.membershipPredicates.some(({ axis }) => axis === "content")).toBe(false);
    expect(spec.recordingPolicy).toMatchObject({
      allowedVersions: ["clean"],
      preferCanonicalStudio: false,
    });
    expect(spec.catalogPolicies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "catalog_policy",
        axis: "recording_version",
        explicitUserAuthored: true,
      }),
    ]));
  });

  test("enforces an explicit schema-2 live-only policy against the resolved Apple version", async () => {
    const selection = plan("25 disco songs, only live versions", 25);
    const strategy = retrievalStrategiesForEnginesV3(["curated_genre_scene"])
      .find((value) => value.kind === "trusted_containers")!;
    const request: DiscoveryRequestV3 = {
      runId: "live-only-catalog-policy",
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: "curated_genre_scene",
      strategy,
      strategyRound: 1,
      cursor: null,
      requestedRawCandidateCount: 25,
      alreadyDiscoveredCandidateIds: [],
      alreadyDiscoveredTracks: [],
      qualifiedRecordingFamilyKeys: [],
      qualifiedTrackSeeds: [],
    };
    const studio = song(701, "Chic", "Good Times");
    const live = {
      ...song(702, "Chic", "Good Times (Live)"),
      versionLabel: "Live",
    };
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: vi.fn(async () => emptySearch({
        playlists: [{
          id: "pl.live-disco",
          name: "Disco Essentials",
          curatorName: "Apple Music",
          description: "Defining disco music from the genre's foundational scenes.",
          url: "https://music.apple.com/us/playlist/disco-essentials/pl.live-disco",
        }],
      })) as any,
      getPlaylistTracks: vi.fn(async () => ({ items: [studio, live], next: null })) as any,
    });

    const batch = await adapters.discover(request);
    const qualifications = await adapters.qualify({ ...request, candidates: batch.candidates });

    expect(selection.membershipPredicates.some(({ axis }) => axis === "recording_version")).toBe(false);
    expect(selection.recordingPolicy.allowedVersions).toEqual(["live"]);
    expect(qualifications.map(({ version }) => version.compatible)).toEqual([false, true]);
  });

  test.each([
    { rating: "clean" as const, compatible: true },
    { rating: "explicit" as const, compatible: false },
    { rating: undefined, compatible: false },
  ])("enforces a compiled schema-2 clean-only policy for Apple rating $rating", async ({ rating, compatible }) => {
    const selection = plan("25 disco songs, clean versions only", 25);
    const genre = selection.membershipPredicates.find(({ axis }) => axis === "genre")!;
    const appleSong: CatalogSong = {
      ...song(710, "Chic", "Le Freak"),
      ...(rating ? { contentRating: rating } : {}),
    };
    const adapters = createPipelineV3LiveAdapters({
      discoverHostedWeb: vi.fn(async () => [{
        artist: "Chic",
        title: "Le Freak",
        album: null,
        sourceUrl: "https://www.loc.gov/item/disco-history",
        provenanceRoot: "loc.gov",
        evidenceStrength: 0.9,
        sourceRank: 1,
        predicateIds: [genre.id],
        providerAttestedExactTrackScope: true,
      }]),
      searchAppleSongs: vi.fn(async () => [appleSong]) as any,
      lookupAppleByIsrc: vi.fn(async () => []) as any,
    });
    const discovery = discoveryRequest(selection, "editorial_tracks");
    const batch = await adapters.discover(discovery);
    const [qualification] = await adapters.qualify({ ...discovery, candidates: batch.candidates });

    expect(qualification.version.compatible).toBe(compatible);
    expect(qualification.catalog).toMatchObject({
      lookupAttempted: true,
      appleProviderRequestCount: 2,
    });
  });

  test("distinguishes catalog-resolution attempts from actual Apple provider reads", async () => {
    const selection = plan("25 disco songs", 25);
    const strategy = retrievalStrategiesForEnginesV3(["curated_genre_scene"])
      .find((value) => value.kind === "trusted_containers")!;
    const request: DiscoveryRequestV3 = {
      runId: "metered-apple-provider-reads",
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: "curated_genre_scene",
      strategy,
      strategyRound: 1,
      cursor: null,
      requestedRawCandidateCount: 25,
      alreadyDiscoveredCandidateIds: [],
      alreadyDiscoveredTracks: [],
      qualifiedRecordingFamilyKeys: [],
      qualifiedTrackSeeds: [],
    };
    const appleSong = song(720, "Chic", "Good Times");
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: vi.fn(async () => emptySearch({
        playlists: [{
          id: "pl.disco-metered",
          name: "Disco Essentials",
          curatorName: "Apple Music",
          description: "Defining disco music from the genre's foundational scenes.",
          url: "https://music.apple.com/us/playlist/disco-essentials/pl.disco-metered",
        }],
      })) as any,
      getPlaylistTracks: vi.fn(async () => ({ items: [appleSong], next: null })) as any,
      searchAppleSongs: vi.fn(async () => { throw new Error("must not be called"); }) as any,
      lookupAppleByIsrc: vi.fn(async () => { throw new Error("must not be called"); }) as any,
    });
    const batch = await adapters.discover(request);
    const [qualification] = await adapters.qualify({ ...request, candidates: batch.candidates });

    expect(qualification.catalog).toMatchObject({
      lookupAttempted: true,
      appleProviderRequestCount: 0,
      appleSongId: appleSong.id,
    });
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
    const outageError = await outageAdapters.discover(
      discoveryRequest(plan("25 disco songs", 25), "editorial_tracks"),
    ).catch((error: unknown) => error);
    expect(outageError).toBeInstanceOf(RetrievalDependencyErrorV3);
    expect(outageError).toMatchObject({
      message: "provider_http_503",
      dependencyIds: ["hosted_web"],
    });
    expect(outage).toHaveBeenCalledTimes(1);
  });

  test("keeps a provider-returned URL as a discovery lead but does not mint exact-track evidence without a citation span", async () => {
    const selection = plan("25 disco songs", 25);
    const predicateId = selection.membershipPredicates.find((value) => value.axis === "genre")!.id;
    const sourceUrl = "https://example.com/disco-list";
    const payload = {
      candidates: [{
        artist: "Chic",
        title: "Good Times",
        album: null,
        sources: [{ url: sourceUrl, predicateIds: [predicateId], authority: "primary" }],
      }],
    };
    const createResponse = vi.fn(async () => ({
      output_text: JSON.stringify(payload),
      output: [{ type: "web_search_call", action: { sources: [{ url: sourceUrl }] } }],
    }));
    const appleSong = song(3, "Chic", "Good Times");
    const adapters = createPipelineV3LiveAdapters({
      createResponse: createResponse as any,
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

    expect(batch.candidates).toHaveLength(1);
    expect(qualification).toMatchObject({
      scope: { passed: false, failedMembershipPredicateIds: [predicateId] },
      evidence: { passed: false, bindingIds: [] },
      catalog: { storefrontPlayable: true, appleSongId: appleSong.id },
    });
  });

  test("derives hosted authority server-side and ignores a model claim that an unknown host is primary", async () => {
    const selection = plan("25 disco songs", 25);
    const predicateId = selection.membershipPredicates.find((value) => value.axis === "genre")!.id;
    const sourceUrl = "https://unknown-editorial.example/disco-list";
    const citationText = "Chic — Good Times is a disco recording. [source]";
    const markerStart = citationText.indexOf("[source]");
    const createResponse = vi.fn(async () => ({
      output_text: JSON.stringify({
        candidates: [{
          artist: "Chic",
          title: "Good Times",
          album: null,
          sources: [{ url: sourceUrl, predicateIds: [predicateId], authority: "primary" }],
        }],
      }),
      output: [
        { type: "web_search_call", action: { sources: [{ url: sourceUrl }] } },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: citationText,
            annotations: [{
              type: "url_citation",
              url: sourceUrl,
              start_index: markerStart,
              end_index: markerStart + "[source]".length,
            }],
          }],
        },
      ],
    }));
    const appleSong = song(4, "Chic", "Good Times");
    const adapters = createPipelineV3LiveAdapters({
      createResponse: createResponse as any,
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

    expect(qualification).toMatchObject({
      scope: { passed: false, failedMembershipPredicateIds: [predicateId] },
      evidence: { passed: false, strength: 0.72 },
    });
    expect(qualification!.evidence.bindings?.[0]?.strength).toBe(0.72);
  });

  test("promotes an institutional hosted source only when the provider citation span names the exact track and predicate", async () => {
    const selection = plan("25 disco songs", 25);
    const predicateId = selection.membershipPredicates.find((value) => value.axis === "genre")!.id;
    const sourceUrl = "https://www.loc.gov/item/disco-history";
    const citationText = "Chic — Good Times is a disco recording documented by the archive. [source]";
    const markerStart = citationText.indexOf("[source]");
    const createResponse = vi.fn(async () => ({
      output_text: JSON.stringify({
        candidates: [{
          artist: "Chic",
          title: "Good Times",
          album: null,
          sources: [{ url: sourceUrl, predicateIds: [predicateId] }],
        }],
      }),
      output: [
        { type: "web_search_call", action: { sources: [{ url: sourceUrl }] } },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: citationText,
            annotations: [{
              type: "url_citation",
              url: sourceUrl,
              start_index: markerStart,
              end_index: markerStart + "[source]".length,
            }],
          }],
        },
      ],
    }));
    const appleSong = song(5, "Chic", "Good Times");
    const adapters = createPipelineV3LiveAdapters({
      createResponse: createResponse as any,
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

    expect(qualification).toMatchObject({
      scope: { passed: true, failedMembershipPredicateIds: [] },
      evidence: { passed: true, strength: 0.9, bindingIds: [expect.any(String)] },
      catalog: { storefrontPlayable: true, appleSongId: appleSong.id },
    });
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
    expect((withoutCurrentRetrieval.mock.calls[0] as any)[0]).toMatchObject({
      tool_choice: "required",
      max_tool_calls: 3,
    });
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
      predicateIds: selection.membershipPredicates
        .filter((predicate) => predicate.operator !== "exclude")
        .map((predicate) => predicate.id),
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

  test("fills baile funk requests from an equivalent Apple editorial alias while TikTok is a ranking preference", async () => {
    const tracks = Array.from({ length: 85 }, (_, index) => song(index, `Funk Artist ${index}`, `Funk Track ${index}`));
    const searchAppleResources = vi.fn(async (_storefront: string, query: string) => emptySearch({
      playlists: query.toLowerCase().includes("baile funk") ? [{
        id: "pl.baile-funk",
        name: "Baile Funk Hits",
        curatorName: "Apple Music",
        description: "The essential Brazilian funk records moving Rio and the world.",
        url: "https://music.apple.com/us/playlist/baile-funk-hits/pl.baile-funk",
      }] : [],
    }));
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: searchAppleResources as any,
      getPlaylistTracks: vi.fn(async () => ({ items: tracks, next: null })) as any,
      searchAppleSongs: vi.fn(async () => []) as any,
      lookupAppleByIsrc: vi.fn(async () => []) as any,
      discoverHostedWeb: vi.fn(async () => []),
    });

    const result = await executeRetrievalV3({
      runId: "baile-funk-alias",
      plan: plan("69 baile funk TikTok breakouts", 69),
      adapters,
    });

    expect(result.outcome).toMatchObject({ status: "exact_ready", selectedTrackCount: 69 });
    expect(result.reserve).toHaveLength(14);
    expect(searchAppleResources.mock.calls.map((call) => String(call[1]).toLowerCase()))
      .toContain("baile funk");
  });

  test("requires phrase boundaries and an Apple-authored curator before treating a playlist as a scoped editorial container", async () => {
    const selection = plan("25 house music songs", 25);
    const strategy = retrievalStrategiesForEnginesV3(["curated_genre_scene"])
      .find((value) => value.kind === "trusted_containers")!;
    const request: DiscoveryRequestV3 = {
      runId: "editorial-boundary-test",
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: "curated_genre_scene",
      strategy,
      strategyRound: 1,
      cursor: null,
      requestedRawCandidateCount: 25,
      alreadyDiscoveredCandidateIds: [],
      alreadyDiscoveredTracks: [],
      qualifiedRecordingFamilyKeys: [],
      qualifiedTrackSeeds: [],
    };
    const getPlaylistTracks = vi.fn(async () => ({ items: [song(80)], next: null }));
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: vi.fn(async () => emptySearch({
        playlists: [
          {
            id: "pl.warehouse",
            name: "Warehouse Anthems",
            curatorName: "Apple Music",
            description: "Electronic club classics.",
            url: "https://music.apple.com/us/playlist/warehouse-anthems/pl.warehouse",
          },
          {
            id: "pl.third-party",
            name: "House Essentials",
            curatorName: "Apple Records Fans",
            description: "House music essentials.",
            url: "https://music.apple.com/us/playlist/house-essentials/pl.third-party",
          },
          {
            id: "pl.not-apple",
            name: "House Essentials",
            curatorName: "Not Apple Music",
            description: "House music essentials.",
            url: "https://music.apple.com/us/playlist/house-essentials/pl.not-apple",
          },
        ],
      })) as any,
      getPlaylistTracks: getPlaylistTracks as any,
    });

    const batch = await adapters.discover(request);

    expect(batch.candidates).toEqual([]);
    expect(getPlaylistTracks).not.toHaveBeenCalled();
  });

  test("accepts a wholly scoped Apple Music editorial container", async () => {
    const selection = plan("25 house music songs", 25);
    const strategy = retrievalStrategiesForEnginesV3(["curated_genre_scene"])
      .find((value) => value.kind === "trusted_containers")!;
    const request: DiscoveryRequestV3 = {
      runId: "editorial-owned-test",
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: "curated_genre_scene",
      strategy,
      strategyRound: 1,
      cursor: null,
      requestedRawCandidateCount: 25,
      alreadyDiscoveredCandidateIds: [],
      alreadyDiscoveredTracks: [],
      qualifiedRecordingFamilyKeys: [],
      qualifiedTrackSeeds: [],
    };
    const appleSong = song(82, "House Artist", "House Track");
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: vi.fn(async () => emptySearch({
        playlists: [{
          id: "pl.house",
          name: "House Essentials",
          curatorName: "Apple Music",
          description: "Defining house music from the genre's foundational scenes.",
          url: "https://music.apple.com/us/playlist/house-essentials/pl.house",
        }],
      })) as any,
      getPlaylistTracks: vi.fn(async () => ({ items: [appleSong], next: null })) as any,
    });

    const batch = await adapters.discover(request);
    const [qualification] = await adapters.qualify({
      runId: request.runId,
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: request.engine,
      strategy,
      candidates: batch.candidates,
    });

    expect(batch.candidates).toHaveLength(1);
    expect(qualification).toMatchObject({
      scope: { passed: true, failedMembershipPredicateIds: [] },
      evidence: { passed: true },
      catalog: { storefrontPlayable: true, appleSongId: appleSong.id },
    });
  });

  test("searches the semantic music scope before structural era terms", async () => {
    const base = plan("Essential disco tracks from 1973 through 1983 with broad artist diversity", 25);
    const selection: SelectionPlanV3 = {
      ...base,
      membershipPredicates: [
        { id: "genre-disco", axis: "genre", operator: "require", values: ["disco"], source: "user", reason: "Genre." },
        { id: "era-membership", axis: "era", operator: "require", values: ["1973", "1983"], source: "user", reason: "Era." },
      ],
      hardConstraints: [{
        id: "era-between",
        axis: "era",
        operator: "between",
        values: ["1973", "1983"],
        kind: "hard",
        relaxationRank: null,
      }],
      confirmed: true,
    };
    const strategy = retrievalStrategiesForEnginesV3(["curated_genre_scene"])
      .find((value) => value.kind === "trusted_containers")!;
    const request: DiscoveryRequestV3 = {
      runId: "semantic-query-order-test",
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: "curated_genre_scene",
      strategy,
      strategyRound: 1,
      cursor: null,
      requestedRawCandidateCount: 1,
      alreadyDiscoveredCandidateIds: [],
      alreadyDiscoveredTracks: [],
      qualifiedRecordingFamilyKeys: [],
      qualifiedTrackSeeds: [],
    };
    const classic = {
      ...song(820, "Chic", "Good Times"),
      releaseDate: "1979-07-30",
    };
    const current = {
      ...song(821, "Current Artist", "Current Disco Track"),
      releaseDate: "2026-01-01",
    };
    const queries: string[] = [];
    const searchAppleResources = vi.fn(async (_storefront: string, query: string) => {
      queries.push(query);
      const focused = query.trim().toLowerCase() === "disco";
      return emptySearch({
        playlists: [{
          id: focused ? "pl.disco-classic" : "pl.disco-current",
          name: focused ? "Disco Essentials" : "Current Disco",
          curatorName: "Apple Music",
          description: focused
            ? "Defining disco music from the genre's foundational scenes."
            : "Current tracks influenced by disco.",
          url: `https://music.apple.com/us/playlist/${focused ? "disco-essentials" : "current-disco"}/${focused ? "pl.disco-classic" : "pl.disco-current"}`,
        }],
      });
    });
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: searchAppleResources as any,
      getPlaylistTracks: vi.fn(async (_storefront: string, playlistId: string) => ({
        items: playlistId === "pl.disco-classic" ? [classic] : [current],
        next: null,
      })) as any,
    });

    const batch = await adapters.discover(request);
    const [qualification] = await adapters.qualify({
      runId: request.runId,
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: request.engine,
      strategy,
      candidates: batch.candidates,
    });

    expect(queries[0]).toBe("disco");
    expect(queries[2]).toBe("disco 1973 1983");
    expect(batch.candidates[0]).toMatchObject({ artist: "Chic", title: "Good Times" });
    expect(qualification).toMatchObject({
      hardConstraints: { passed: true, failedConstraintIds: [] },
      catalog: { releaseYear: 1979, compatibleReleaseYears: [1979] },
    });
  });

  test("uses an exact-ISRC compatible catalog issue to prove recording era for a later compilation", async () => {
    const base = plan("25 disco songs from 1973 through 1983", 25);
    const selection: SelectionPlanV3 = {
      ...base,
      membershipPredicates: [
        { id: "genre-disco", axis: "genre", operator: "require", values: ["disco"], source: "user", reason: "Genre." },
        { id: "era-membership", axis: "era", operator: "require", values: ["1973", "1983"], source: "user", reason: "Era." },
      ],
      hardConstraints: [{
        id: "era-between",
        axis: "era",
        operator: "between",
        values: ["1973", "1983"],
        kind: "hard",
        relaxationRank: null,
      }],
      confirmed: true,
    };
    const strategy = retrievalStrategiesForEnginesV3(["curated_genre_scene"])
      .find((value) => value.kind === "trusted_containers")!;
    const request: DiscoveryRequestV3 = {
      runId: "editorial-compatible-era-test",
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: "curated_genre_scene",
      strategy,
      strategyRound: 1,
      cursor: null,
      requestedRawCandidateCount: 25,
      alreadyDiscoveredCandidateIds: [],
      alreadyDiscoveredTracks: [],
      qualifiedRecordingFamilyKeys: [],
      qualifiedTrackSeeds: [],
    };
    const compilationIssue = {
      ...song(83, "Disco Artist", "Disco Classic"),
      albumName: "Disco Gold: 2004 Edition",
      releaseDate: "2004-01-01",
    };
    const originalIssue: CatalogSong = {
      ...compilationIssue,
      id: "1978001",
      albumName: "Disco Classic",
      releaseDate: "1978-06-01",
    };
    const lookupAppleByIsrc = vi.fn(async () => [compilationIssue, originalIssue]);
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: vi.fn(async () => emptySearch({
        playlists: [{
          id: "pl.disco-era",
          name: "Disco Essentials",
          curatorName: "Apple Music",
          description: "Defining disco music from the genre's foundational scenes.",
          url: "https://music.apple.com/us/playlist/disco-essentials/pl.disco-era",
        }],
      })) as any,
      getPlaylistTracks: vi.fn(async () => ({ items: [compilationIssue], next: null })) as any,
      lookupAppleByIsrc: lookupAppleByIsrc as any,
    });

    const batch = await adapters.discover(request);
    const [qualification] = await adapters.qualify({
      runId: request.runId,
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: request.engine,
      strategy,
      candidates: batch.candidates,
    });

    expect(lookupAppleByIsrc).toHaveBeenCalledWith("us", compilationIssue.isrc);
    expect(qualification).toMatchObject({
      scope: { passed: true },
      evidence: { passed: true },
      hardConstraints: { passed: true, failedConstraintIds: [] },
      catalog: {
        appleSongId: compilationIssue.id,
        releaseYear: 2004,
        compatibleReleaseYears: [1978, 2004],
      },
    });
  });

  test("falls back to exact artist-title search when ISRC lookup cannot recover the original-era issue", async () => {
    const base = plan("25 disco songs from 1973 through 1983", 25);
    const selection: SelectionPlanV3 = {
      ...base,
      membershipPredicates: [
        { id: "genre-disco", axis: "genre", operator: "require", values: ["disco"], source: "user", reason: "Genre." },
        { id: "era-membership", axis: "era", operator: "require", values: ["1973", "1983"], source: "user", reason: "Era." },
      ],
      hardConstraints: [{ id: "era-between", axis: "era", operator: "between", values: ["1973", "1983"], kind: "hard", relaxationRank: null }],
      confirmed: true,
    };
    const strategy = retrievalStrategiesForEnginesV3(["curated_genre_scene"])
      .find((value) => value.kind === "trusted_containers")!;
    const request: DiscoveryRequestV3 = {
      runId: "editorial-title-fallback-era-test",
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: "curated_genre_scene",
      strategy,
      strategyRound: 1,
      cursor: null,
      requestedRawCandidateCount: 25,
      alreadyDiscoveredCandidateIds: [],
      alreadyDiscoveredTracks: [],
      qualifiedRecordingFamilyKeys: [],
      qualifiedTrackSeeds: [],
    };
    const compilationIssue: CatalogSong = {
      ...song(85, "Disco Artist", "Disco Classic"),
      isrc: "USAAA0000085",
      albumName: "Disco Gold: 2004 Edition",
      releaseDate: "2004-01-01",
      durationInMillis: 215_000,
    };
    const originalIssue: CatalogSong = {
      ...compilationIssue,
      id: "1978003",
      albumName: "Disco Classic",
      releaseDate: "1978-06-01",
      durationInMillis: 216_500,
    };
    const lookupAppleByIsrc = vi.fn(async () => [compilationIssue]);
    const searchAppleSongs = vi.fn(async () => [originalIssue]);
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: vi.fn(async () => emptySearch({
        playlists: [{
          id: "pl.disco-cross-isrc",
          name: "Disco Essentials",
          curatorName: "Apple Music",
          description: "Defining disco music from the genre's foundational scenes.",
          url: "https://music.apple.com/us/playlist/disco-essentials/pl.disco-cross-isrc",
        }],
      })) as any,
      getPlaylistTracks: vi.fn(async () => ({ items: [compilationIssue], next: null })) as any,
      lookupAppleByIsrc: lookupAppleByIsrc as any,
      searchAppleSongs: searchAppleSongs as any,
    });

    const batch = await adapters.discover(request);
    const [qualification] = await adapters.qualify({
      runId: request.runId,
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: request.engine,
      strategy,
      candidates: batch.candidates,
    });

    expect(lookupAppleByIsrc).toHaveBeenCalledWith("us", compilationIssue.isrc);
    expect(searchAppleSongs).toHaveBeenCalledWith("us", "Disco Artist Disco Classic");
    expect(qualification).toMatchObject({
      hardConstraints: { passed: true, failedConstraintIds: [] },
      catalog: {
        appleSongId: compilationIssue.id,
        releaseYear: 2004,
        compatibleReleaseYears: [1978, 2004],
      },
    });
  });

  test("does not borrow an era from a metadata match with a conflicting ISRC", async () => {
    const base = plan("25 disco songs from 1973 through 1983", 25);
    const selection: SelectionPlanV3 = {
      ...base,
      membershipPredicates: [
        { id: "genre-disco", axis: "genre", operator: "require", values: ["disco"], source: "user", reason: "Genre." },
        { id: "era-membership", axis: "era", operator: "require", values: ["1973", "1983"], source: "user", reason: "Era." },
      ],
      hardConstraints: [{ id: "era-between", axis: "era", operator: "between", values: ["1973", "1983"], kind: "hard", relaxationRank: null }],
      confirmed: true,
    };
    const strategy = retrievalStrategiesForEnginesV3(["curated_genre_scene"])
      .find((value) => value.kind === "trusted_containers")!;
    const request = {
      ...discoveryRequest(selection, "editorial_tracks"),
      runId: "editorial-cross-isrc-conflict-test",
      strategy,
    };
    const compilationIssue: CatalogSong = {
      ...song(86, "Disco Artist", "Disco Classic"),
      isrc: "USAAA0000086",
      releaseDate: "2004-01-01",
      durationInMillis: 215_000,
    };
    const differentRecording: CatalogSong = {
      ...compilationIssue,
      id: "1978004",
      isrc: "USBBB0000086",
      releaseDate: "1978-01-01",
      durationInMillis: 215_000,
    };
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: vi.fn(async () => emptySearch({
        playlists: [{
          id: "pl.disco-duration-conflict",
          name: "Disco Essentials",
          curatorName: "Apple Music",
          description: "Defining disco music from the genre's foundational scenes.",
          url: "https://music.apple.com/us/playlist/disco-essentials/pl.disco-duration-conflict",
        }],
      })) as any,
      getPlaylistTracks: vi.fn(async () => ({ items: [compilationIssue], next: null })) as any,
      lookupAppleByIsrc: vi.fn(async () => [compilationIssue]) as any,
      searchAppleSongs: vi.fn(async () => [differentRecording]) as any,
    });

    const batch = await adapters.discover(request);
    const [qualification] = await adapters.qualify({
      runId: request.runId,
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: request.engine,
      strategy,
      candidates: batch.candidates,
    });

    expect(qualification).toMatchObject({
      hardConstraints: { passed: false, failedConstraintIds: ["catalog:era:1973_1983"] },
      catalog: { releaseYear: 2004, compatibleReleaseYears: [2004] },
    });
  });

  test("does not borrow an era year from a conflicting remix even when Apple reuses the ISRC", async () => {
    const base = plan("25 disco songs from 1973 through 1983", 25);
    const selection: SelectionPlanV3 = {
      ...base,
      membershipPredicates: [
        { id: "genre-disco", axis: "genre", operator: "require", values: ["disco"], source: "user", reason: "Genre." },
        { id: "era-membership", axis: "era", operator: "require", values: ["1973", "1983"], source: "user", reason: "Era." },
      ],
      hardConstraints: [{ id: "era-between", axis: "era", operator: "between", values: ["1973", "1983"], kind: "hard", relaxationRank: null }],
      confirmed: true,
    };
    const strategy = retrievalStrategiesForEnginesV3(["curated_genre_scene"])
      .find((value) => value.kind === "trusted_containers")!;
    const request: DiscoveryRequestV3 = {
      runId: "editorial-conflicting-era-test",
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: "curated_genre_scene",
      strategy,
      strategyRound: 1,
      cursor: null,
      requestedRawCandidateCount: 25,
      alreadyDiscoveredCandidateIds: [],
      alreadyDiscoveredTracks: [],
      qualifiedRecordingFamilyKeys: [],
      qualifiedTrackSeeds: [],
    };
    const compilationIssue = {
      ...song(84, "Disco Artist", "Disco Classic"),
      releaseDate: "2004-01-01",
    };
    const remixIssue: CatalogSong = {
      ...compilationIssue,
      id: "1978002",
      name: "Disco Classic (Remix)",
      releaseDate: "1978-01-01",
    };
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: vi.fn(async () => emptySearch({
        playlists: [{
          id: "pl.disco-conflict",
          name: "Disco Essentials",
          curatorName: "Apple Music",
          description: "Defining disco music from the genre's foundational scenes.",
          url: "https://music.apple.com/us/playlist/disco-essentials/pl.disco-conflict",
        }],
      })) as any,
      getPlaylistTracks: vi.fn(async () => ({ items: [compilationIssue], next: null })) as any,
      lookupAppleByIsrc: vi.fn(async () => [remixIssue]) as any,
      searchAppleSongs: vi.fn(async () => [remixIssue]) as any,
    });

    const batch = await adapters.discover(request);
    const [qualification] = await adapters.qualify({
      runId: request.runId,
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: request.engine,
      strategy,
      candidates: batch.candidates,
    });

    expect(qualification).toMatchObject({
      hardConstraints: { passed: false, failedConstraintIds: ["catalog:era:1973_1983"] },
      catalog: { releaseYear: 2004, compatibleReleaseYears: [2004] },
    });
  });

  test("enumerates the exact normalized fixed-container identity instead of the first Apple search result", async () => {
    const selection = plan("all tracks from album Correct Album by Correct Artist", 25);
    const strategy = retrievalStrategiesForEnginesV3(["fixed_container"])
      .find((value) => value.kind === "container_enumeration")!;
    const request: DiscoveryRequestV3 = {
      runId: "fixed-exact-test",
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: "fixed_container",
      strategy,
      strategyRound: 1,
      cursor: null,
      requestedRawCandidateCount: 25,
      alreadyDiscoveredCandidateIds: [],
      alreadyDiscoveredTracks: [],
      qualifiedRecordingFamilyKeys: [],
      qualifiedTrackSeeds: [],
    };
    const exactSong = song(83, "Correct Artist", "Exact Track");
    const getAlbumTracks = vi.fn(async (_storefront: string, albumId: string) => ({
      items: albumId === "album-correct" ? [exactSong] : [song(84, "Wrong Artist", "Wrong Track")],
      next: null,
    }));
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: vi.fn(async () => emptySearch({
        albums: [
          {
            id: "album-wrong",
            name: "Wrong Album",
            artistName: "Wrong Artist",
            genreNames: ["Pop"],
            url: "https://music.apple.com/us/album/wrong-album/1",
          },
          {
            id: "album-correct",
            name: "Correct Album",
            artistName: "Correct Artist",
            genreNames: ["Electronic"],
            url: "https://music.apple.com/us/album/correct-album/2",
          },
        ],
      })) as any,
      getAlbumTracks: getAlbumTracks as any,
    });

    const batch = await adapters.discover(request);

    expect(batch.candidates).toHaveLength(1);
    expect(batch.candidates[0]).toMatchObject({ artist: "Correct Artist", title: "Exact Track" });
    expect(getAlbumTracks).toHaveBeenCalledWith(
      "us",
      "album-correct",
      null,
      undefined,
    );
  });

  test("fails closed when no Apple fixed container exactly matches the requested identity", async () => {
    const selection = plan("all tracks from playlist Exact Playlist", 25);
    const strategy = retrievalStrategiesForEnginesV3(["fixed_container"])
      .find((value) => value.kind === "container_enumeration")!;
    const getPlaylistTracks = vi.fn(async () => ({ items: [song(85)], next: null }));
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: vi.fn(async () => emptySearch({
        playlists: [{
          id: "playlist-near",
          name: "Exact Playlist Deluxe",
          curatorName: "Apple Music",
          description: "Near match only.",
        }],
      })) as any,
      getPlaylistTracks: getPlaylistTracks as any,
    });
    const batch = await adapters.discover({
      runId: "fixed-no-match-test",
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: "fixed_container",
      strategy,
      strategyRound: 1,
      cursor: null,
      requestedRawCandidateCount: 25,
      alreadyDiscoveredCandidateIds: [],
      alreadyDiscoveredTracks: [],
      qualifiedRecordingFamilyKeys: [],
      qualifiedTrackSeeds: [],
    });

    expect(batch).toMatchObject({ candidates: [], exhausted: true });
    expect(getPlaylistTracks).not.toHaveBeenCalled();
  });

  test("does not let an Apple artist-catalogue identity binding prove an unrelated genre predicate", async () => {
    const base = plan("Example Artist jazz catalogue", 25);
    const selection: SelectionPlanV3 = {
      ...base,
      intents: ["artist_catalogue"],
      engines: ["artist_catalogue"],
      membershipPredicates: [
        { id: "artist-example", axis: "artist", operator: "require", values: ["Example Artist"], source: "user", reason: "Artist." },
        { id: "genre-jazz", axis: "genre", operator: "require", values: ["jazz"], source: "user", reason: "Genre." },
      ],
      confirmed: true,
    };
    const appleSong = song(81, "Example Artist", "Unclassified Track");
    const strategy = retrievalStrategiesForEnginesV3(["artist_catalogue"])
      .find((value) => value.kind === "artist_identity")!;
    const adapters = createPipelineV3LiveAdapters({
      searchAppleResources: vi.fn(async () => emptySearch({
        artists: [{
          id: "artist-1",
          name: "Example Artist",
          genreNames: ["Pop"],
          url: "https://music.apple.com/us/artist/example-artist/1",
        }],
      })) as any,
      getArtistTopSongs: vi.fn(async () => ({ items: [appleSong], next: null })) as any,
      getArtistAlbums: vi.fn(async () => ({ items: [], next: null })) as any,
      getAlbumTracks: vi.fn(async () => ({ items: [], next: null })) as any,
    });
    const request: DiscoveryRequestV3 = {
      runId: "artist-axis-test",
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: "artist_catalogue",
      strategy,
      strategyRound: 1,
      cursor: null,
      requestedRawCandidateCount: 25,
      alreadyDiscoveredCandidateIds: [],
      alreadyDiscoveredTracks: [],
      qualifiedRecordingFamilyKeys: [],
      qualifiedTrackSeeds: [],
    };
    const batch = await adapters.discover(request);
    const [qualification] = await adapters.qualify({
      runId: request.runId,
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: request.engine,
      strategy,
      candidates: batch.candidates,
    });

    expect(qualification).toMatchObject({
      scope: { passed: false, failedMembershipPredicateIds: ["genre-jazz"] },
      catalog: { storefrontPlayable: true },
    });
    expect(qualification!.evidence.bindings?.[0]?.predicateIds).toEqual(["artist-example"]);
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

  test("does not let a jazz-only source prove French or women while catalog enforces the 1960s", async () => {
    const base = plan("French women in 1960s jazz", 25);
    const selection: SelectionPlanV3 = {
      ...base,
      membershipPredicates: [
        {
          id: "genre-jazz",
          axis: "genre",
          operator: "require",
          values: ["jazz"],
          source: "user",
          reason: "Requested genre.",
        },
        {
          id: "geography-france",
          axis: "geography",
          operator: "require",
          values: ["France"],
          source: "user",
          reason: "Requested geography.",
        },
        {
          id: "artist-women",
          axis: "artist",
          operator: "require",
          values: ["women artists"],
          source: "user",
          reason: "Requested artist scope.",
        },
        {
          id: "era-1960s",
          axis: "era",
          operator: "require",
          values: ["1960s"],
          source: "user",
          reason: "Requested era.",
        },
      ],
      confirmed: true,
    };
    const appleSong = song(91, "Example Quartet", "Example Jazz Track");
    appleSong.releaseDate = "1967-01-01";
    const supported: HostedWebCandidateV3 = {
      artist: appleSong.artistName,
      title: appleSong.name,
      album: appleSong.albumName,
      sourceUrl: "https://www.loc.gov/item/jazz-history",
      provenanceRoot: "loc.gov",
      evidenceStrength: 0.9,
      sourceRank: 1,
      predicateIds: ["genre-jazz"],
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

    expect(qualification).toMatchObject({
      scope: {
        passed: false,
        failedMembershipPredicateIds: ["geography-france", "artist-women"],
      },
      hardConstraints: { passed: true, failedConstraintIds: [] },
      evidence: { passed: false, bindingIds: [expect.any(String)] },
      catalog: { storefrontPlayable: true, appleSongId: appleSong.id, releaseYear: 1967 },
    });
    expect(qualification!.evidence.bindings?.[0]?.predicateIds).toEqual(["genre-jazz"]);
  });

  test("requires the union of explicit source bindings to cover every positive predicate", async () => {
    const base = plan("French jazz from the 1960s", 25);
    const selection: SelectionPlanV3 = {
      ...base,
      membershipPredicates: [
        { id: "genre-jazz", axis: "genre", operator: "require", values: ["jazz"], source: "user", reason: "Genre." },
        { id: "geography-france", axis: "geography", operator: "require", values: ["France"], source: "user", reason: "Geography." },
        { id: "era-1960s", axis: "era", operator: "require", values: ["1960s"], source: "user", reason: "Era." },
      ],
      confirmed: true,
    };
    const appleSong = song(92, "Example Trio", "Paris 1967");
    appleSong.releaseDate = "1967-01-01";
    const supported: HostedWebCandidateV3 = {
      artist: appleSong.artistName,
      title: appleSong.name,
      album: appleSong.albumName,
      sourceUrl: "https://example.org/jazz-recording",
      provenanceRoot: "example.org",
      evidenceStrength: 0.9,
      sourceRank: 1,
      evidence: [
        {
          sourceUrl: "https://example.org/jazz-recording",
          provenanceRoot: "example.org",
          evidenceStrength: 0.9,
          sourceRank: 1,
          predicateIds: ["genre-jazz"],
        },
        {
          sourceUrl: "https://archive.org/details/paris-jazz-1967",
          provenanceRoot: "archive.org",
          evidenceStrength: 0.9,
          sourceRank: 2,
          predicateIds: ["geography-france", "era-1960s"],
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

    expect(qualification).toMatchObject({
      scope: { passed: true, failedMembershipPredicateIds: [] },
      evidence: { passed: true, independentProvenanceRoots: 2 },
      hardConstraints: { passed: true, failedConstraintIds: [] },
      catalog: { releaseYear: 1967 },
    });
    expect(qualification!.evidence.bindings?.map((binding) => binding.predicateIds)).toEqual([
      ["genre-jazz"],
      ["geography-france"],
    ]);
  });

  test("qualifies disco evidence while enforcing inclusive 1973–1983 dates from Apple metadata", async () => {
    const base = plan("disco from 1973 through 1983", 4);
    const selection: SelectionPlanV3 = {
      ...base,
      membershipPredicates: [
        { id: "genre-disco", axis: "genre", operator: "require", values: ["disco"], source: "user", reason: "Genre." },
        { id: "era-membership", axis: "era", operator: "require", values: ["1973", "1983"], source: "user", reason: "Era." },
      ],
      hardConstraints: [{
        id: "era-between",
        axis: "era",
        operator: "between",
        values: ["1973", "1983"],
        kind: "hard",
        relaxationRank: null,
      }],
      confirmed: true,
    };
    const songs = [1972, 1973, 1983, 1984].map((year, index) => ({
      ...song(200 + index, `Disco Artist ${index}`, `Disco Track ${year}`),
      releaseDate: `${year}-01-01`,
    }));
    const hosted = songs.map((value, index): HostedWebCandidateV3 => ({
      artist: value.artistName,
      title: value.name,
      album: value.albumName,
      sourceUrl: `https://example.org/disco/${index}`,
      provenanceRoot: "example.org",
      evidenceStrength: 0.9,
      sourceRank: index + 1,
      predicateIds: ["genre-disco"],
    }));
    const adapters = createPipelineV3LiveAdapters({
      discoverHostedWeb: vi.fn(async () => hosted),
      searchAppleSongs: vi.fn(async () => songs) as any,
      lookupAppleByIsrc: vi.fn(async () => []) as any,
    });
    const discovery = discoveryRequest(selection, "editorial_tracks");
    const batch = await adapters.discover(discovery);
    const qualifications = await adapters.qualify({
      runId: discovery.runId,
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: discovery.engine,
      strategy: discovery.strategy,
      candidates: batch.candidates,
    });

    expect(qualifications.map(({ scope, evidence, hardConstraints, catalog }) => ({
      scope: scope.passed,
      evidence: evidence.passed,
      hard: hardConstraints.passed,
      year: catalog.releaseYear,
    }))).toEqual([
      { scope: true, evidence: true, hard: false, year: 1972 },
      { scope: true, evidence: true, hard: true, year: 1973 },
      { scope: true, evidence: true, hard: true, year: 1983 },
      { scope: true, evidence: true, hard: false, year: 1984 },
    ]);
  });

  test.each([
    {
      label: "one strong axis plus a weak second axis",
      evidence: [
        { sourceUrl: "https://strong.example/genre", provenanceRoot: "strong.example", evidenceStrength: 0.9, sourceRank: 1, predicateIds: ["genre-disco"] },
        { sourceUrl: "https://weak.example/france", provenanceRoot: "weak.example", evidenceStrength: 0.4, sourceRank: 2, predicateIds: ["geography-france"] },
      ],
      passed: false,
      failed: ["geography-france"],
    },
    {
      label: "two roots corroborating only the first axis plus a weak second axis",
      evidence: [
        { sourceUrl: "https://first.example/genre", provenanceRoot: "first.example", evidenceStrength: 0.72, sourceRank: 1, predicateIds: ["genre-disco"] },
        { sourceUrl: "https://second.example/genre", provenanceRoot: "second.example", evidenceStrength: 0.72, sourceRank: 2, predicateIds: ["genre-disco"] },
        { sourceUrl: "https://weak.example/france", provenanceRoot: "weak.example", evidenceStrength: 0.4, sourceRank: 3, predicateIds: ["geography-france"] },
      ],
      passed: false,
      failed: ["geography-france"],
    },
    {
      label: "one strong exact binding for both axes",
      evidence: [
        { sourceUrl: "https://strong.example/track", provenanceRoot: "strong.example", evidenceStrength: 0.9, sourceRank: 1, predicateIds: ["genre-disco", "geography-france"] },
      ],
      passed: true,
      failed: [],
    },
    {
      label: "a strong first axis and two independent medium roots for the second axis",
      evidence: [
        { sourceUrl: "https://strong.example/genre", provenanceRoot: "strong.example", evidenceStrength: 0.9, sourceRank: 1, predicateIds: ["genre-disco"] },
        { sourceUrl: "https://france-one.example/track", provenanceRoot: "france-one.example", evidenceStrength: 0.72, sourceRank: 2, predicateIds: ["geography-france"] },
        { sourceUrl: "https://france-two.example/track", provenanceRoot: "france-two.example", evidenceStrength: 0.72, sourceRank: 3, predicateIds: ["geography-france"] },
      ],
      passed: true,
      failed: [],
    },
    {
      label: "mirrored medium bindings sharing one provenance root",
      evidence: [
        { sourceUrl: "https://strong.example/genre", provenanceRoot: "strong.example", evidenceStrength: 0.9, sourceRank: 1, predicateIds: ["genre-disco"] },
        { sourceUrl: "https://mirror.example/one", provenanceRoot: "mirror.example", evidenceStrength: 0.72, sourceRank: 2, predicateIds: ["geography-france"] },
        { sourceUrl: "https://mirror.example/two", provenanceRoot: "www.mirror.example", evidenceStrength: 0.72, sourceRank: 3, predicateIds: ["geography-france"] },
      ],
      passed: false,
      failed: ["geography-france"],
    },
  ])("evaluates the evidence floor independently per predicate: $label", async ({ evidence, passed, failed }) => {
    const base = plan("French disco songs", 25);
    const selection: SelectionPlanV3 = {
      ...base,
      membershipPredicates: [
        { id: "genre-disco", axis: "genre", operator: "require", values: ["disco"], source: "user", reason: "Genre." },
        { id: "geography-france", axis: "geography", operator: "require", values: ["France"], source: "user", reason: "Geography." },
      ],
      confirmed: true,
    };
    const appleSong = song(93, "Example French Artist", "Example Disco Track");
    const adapters = createPipelineV3LiveAdapters({
      discoverHostedWeb: vi.fn(async () => [{
        artist: appleSong.artistName,
        title: appleSong.name,
        album: appleSong.albumName,
        sourceUrl: evidence[0]!.sourceUrl,
        provenanceRoot: evidence[0]!.provenanceRoot,
        evidenceStrength: evidence[0]!.evidenceStrength,
        sourceRank: 1,
        evidence,
      }]),
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

    expect(qualification).toMatchObject({
      scope: { passed, failedMembershipPredicateIds: failed },
      evidence: { passed },
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

  test("does not let one promoted graph assertion satisfy unrelated composite axes", async () => {
    const base = plan("French jazz from the 1960s", 25);
    const selection: SelectionPlanV3 = {
      ...base,
      intents: ["factual_relationship"],
      engines: ["factual_relationship"],
      membershipPredicates: [
        { id: "genre-jazz", axis: "genre", operator: "require", values: ["jazz"], source: "user", reason: "Genre." },
        { id: "geography-france", axis: "geography", operator: "require", values: ["France"], source: "user", reason: "Geography." },
        { id: "era-1960s", axis: "era", operator: "require", values: ["1960s"], source: "user", reason: "Era." },
      ],
      confirmed: true,
    };
    const appleSong = song(101, "Example Ensemble", "Example Recording");
    appleSong.releaseDate = "1967-01-01";
    const discoverGovernedGraph = vi.fn(async () => ({
      candidates: [{
        title: appleSong.name,
        artist: appleSong.artistName,
        album: appleSong.albumName,
        appleSong,
        observationIds: ["observation-jazz"],
        assertionIds: ["assertion-jazz"],
        graphSnapshotId: "00000000-0000-4000-8000-000000000014",
        provenanceRoots: ["credits.example"],
        sourceUrls: ["https://credits.example/jazz-recording"],
        evidenceStrength: 0.98,
        sourceRank: 0,
        evidenceBindings: [{
          id: "graph:assertion-jazz:observation-jazz",
          assertionId: "assertion-jazz",
          observationId: "observation-jazz",
          provenanceRoot: "credits.example",
          sourceUrl: "https://credits.example/jazz-recording",
          evidenceStrength: 0.98,
          sourceRank: 0,
          predicateIds: ["genre-jazz"],
          governance: {
            policyVersion: "evidence-source-governance-v3",
            useScope: "durable_corpus",
            approvalState: "approved",
            accessMethod: "manual_entry",
            licenseState: "permission_recorded",
            licenseVersion: "test-permission-v1",
            termsVersion: "test-terms-v1",
            attribution: "Reviewed jazz source",
            cachePolicy: "excerpt_only",
            retentionPolicy: "durable_public_corpus",
            freshnessPolicy: "immutable_revision",
            sourceHash: "b".repeat(64),
            sourceRevision: "b".repeat(64),
          } satisfies EvidenceSourceGovernanceV3,
        }],
      }],
      nextCursor: null,
      exhausted: true,
      graphSnapshotId: "00000000-0000-4000-8000-000000000014",
    }));
    const adapters = createPipelineV3LiveAdapters({ discoverGovernedGraph });
    const request = discoveryRequest(selection, "graph_traversal");
    const batch = await adapters.discover(request);
    const [qualification] = await adapters.qualify({
      runId: request.runId,
      executionMode: "active",
      appleWriteAccess: "forbidden",
      plan: selection,
      engine: request.engine,
      strategy: request.strategy,
      candidates: batch.candidates,
    });

    expect(qualification).toMatchObject({
      scope: {
        passed: false,
        failedMembershipPredicateIds: ["geography-france"],
      },
      evidence: { passed: false },
      hardConstraints: { passed: true, failedConstraintIds: [] },
      catalog: { releaseYear: 1967 },
    });
    expect(qualification!.evidence.bindings?.[0]?.predicateIds).toEqual(["genre-jazz"]);
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
