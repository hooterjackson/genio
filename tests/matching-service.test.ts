import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  AlternateCatalogIdentity,
  CandidateStageEvent,
  CatalogDiscoveredCandidateInput,
  CatalogDiscoveredCandidateResult,
  CatalogMatchResult,
  CatalogSong,
  PipelineDeficitLedgerEntry,
  PipelineOutcome,
  PlaylistBrief,
  SelectionPlan,
  TrackScopeBinding,
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

import {
  AppleApiError,
  AppleAuthorizationRequiredError,
  lookupAppleCatalogByIsrc,
  searchAppleCatalog,
} from "../server/apple.ts";
import {
  catalogDeficitQueries,
  catalogLookupTimeoutMs,
  catalogRecoveryDeadlineMs,
  matchResearchRun,
  musicScopePhraseMatches,
  type MatchingRepository,
} from "../server/matching-service.ts";
import { RETRYABLE_CATALOG_MATCH_BASES } from "../server/catalog-match-recovery.ts";
import {
  CATALOG_DISCOVERY_PROGRESS_VERSION,
  type CatalogDiscoveryProvider,
} from "../server/catalog-discovery-v2.ts";
import { createFastRouteCheckpoint, researchExecutionPolicy } from "../server/research-policy.ts";
import { catalogRecordingVersionClass } from "../server/pipeline-v2-policy.ts";
import { createSelectionPlanV2 } from "../server/selection-plan-v2.ts";
import {
  PIPELINE_V2_SHADOW_INPUT_SCHEMA,
  evaluatePipelineV2ManifestShadow,
  type ShadowManifestCandidate,
} from "../server/pipeline-v2-shadow.ts";
import { sha256Hex } from "../server/security.ts";

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
  subjectEntities: ["Test scene"],
  relationship: "represents the Test scene",
  include: ["documented Test scene recordings"],
  evidencePolicy: "cited editorial sources",
  orderingPolicy: "influence rank",
  targetSize: { min: 50, max: 100 },
};

function sceneBrief(target: number): PlaylistBrief {
  return {
    title: "Test scene essentials",
    description: "A cited editorial survey of the Test scene.",
    mode: "curated",
    subjectEntities: ["Test scene"],
    relationship: "represents the Test scene",
    include: ["documented Test scene recordings"],
    exclude: [],
    versionPolicy: "studio recordings",
    evidencePolicy: "cited editorial sources",
    orderingPolicy: "editorial rank",
    targetSize: { min: target, max: target },
    ambiguities: [],
  };
}

function routeCheckpoint(confirmedAt = new Date()) {
  const policy = researchExecutionPolicy(curatedBrief, {});
  if (policy.kind !== "fast_curated") throw new Error("Fixture policy must be fast");
  return createFastRouteCheckpoint(policy, confirmedAt);
}

function emptyCatalogDiscoveryProvider(): CatalogDiscoveryProvider {
  return {
    async search() { return { songs: [], artists: [], albums: [], playlists: [] }; },
    async playlistTracks() { return { items: [], next: null }; },
    async albumTracks() { return { items: [], next: null }; },
    async artistTopSongs() { return { items: [], next: null }; },
    async artistAlbums() { return { items: [], next: null }; },
    async similarArtists() { return { items: [], next: null }; },
  };
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
  const sceneExcerpt = "Test Song represents the documented Test scene.";
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
    }, {
      sourceUrl: "https://example.com/scene-source",
      state,
      supportScope: "track",
      subjectEntity: curatedBrief.subjectEntities[0]!,
      subjectRelationship: curatedBrief.relationship,
      relationship: curatedBrief.relationship,
      note: "curated scene evidence",
      sourceClass: "web",
      citationSupport: state === "inferred" ? null : {
        responseId: `scene-resp-${id}`,
        outputItemId: `scene-msg-${id}`,
        contentIndex: 0,
        startIndex: 0,
        endIndex: sceneExcerpt.length,
        excerpt: sceneExcerpt,
      },
    }],
  };
}

class MemoryMatchingRepository implements MatchingRepository {
  readonly matches: CatalogMatchResult[] = [];
  readonly checkpoints: unknown[] = [];
  readonly checkpointWrites: Array<{ phase: string; checkpoint: unknown }> = [];
  readonly updates: Array<Record<string, unknown>> = [];

  readonly bulkTimeoutWrites: Array<{ candidateIds: string[]; basis: string }> = [];
  readonly automaticRecoveries: Array<{
    runId: string;
    storefront: string;
    currentGeneration: number;
    currentRefillGeneration: number;
  }> = [];
  readonly automaticRefills: Array<{ runId: string; storefront: string; additionalCandidateGoal: number; currentGeneration: number }> = [];
  readonly automaticPublications: string[] = [];
  readonly pipelineOutcomes: PipelineOutcome[] = [];
  automaticRecoveryState: "queued" | "in_flight" | "not_needed" | "exhausted" = "not_needed";
  automaticRefillState: "queued" | "in_flight" | "not_needed" | "exhausted" = "not_needed";

  constructor(
    readonly candidates: Candidate[],
    readonly runBrief: PlaylistBrief = brief,
    readonly checkpointsByPhase: Map<string, unknown> = new Map(),
    readonly runCreatedAt?: string,
    readonly autoPublish = false,
    readonly runStatus = "matching",
  ) {}

  async getRun() {
    return {
      brief: this.runBrief,
      status: this.runStatus,
      autoPublish: this.autoPublish,
      createdAt: this.runCreatedAt,
    };
  }
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
  async saveResearchCheckpoint(_runId: string, phase: string, checkpoint: unknown) {
    this.checkpoints.push(checkpoint);
    this.checkpointWrites.push({ phase, checkpoint });
    this.checkpointsByPhase.set(phase, checkpoint);
  }
  async queueAutomaticCatalogRecovery(
    runId: string,
    storefront: string,
    currentGeneration: number,
    currentRefillGeneration = 0,
  ) {
    this.automaticRecoveries.push({ runId, storefront, currentGeneration, currentRefillGeneration });
    return this.automaticRecoveryState;
  }
  async queueAutomaticCandidateRefill(runId: string, storefront: string, additionalCandidateGoal: number, currentGeneration: number) {
    this.automaticRefills.push({ runId, storefront, additionalCandidateGoal, currentGeneration });
    return this.automaticRefillState;
  }
  async queueAutomaticPublication(runId: string) { this.automaticPublications.push(runId); }
  async savePipelineOutcome(_runId: string, outcome: PipelineOutcome) { this.pipelineOutcomes.push(outcome); }
}

class V2MemoryMatchingRepository extends MemoryMatchingRepository {
  readonly families: Array<Parameters<NonNullable<MatchingRepository["upsertRecordingFamily"]>>[1]> = [];
  readonly familyAttachments: Array<{ familyId: string; candidateId: string; relationship: string | undefined }> = [];
  readonly catalogIdentities: AlternateCatalogIdentity[] = [];
  readonly stageEvents: CandidateStageEvent[] = [];
  readonly deficits: PipelineDeficitLedgerEntry[] = [];
  readonly persistedDiscoveries: CatalogDiscoveredCandidateInput[] = [];
  selectionPlan: SelectionPlan | null = null;

  override async getRun() {
    return {
      ...(await super.getRun()),
      pipelineVersion: "catalog_first_v2" as const,
      policyVersion: this.selectionPlan?.policyVersion ?? "relevance_first_2026_07",
      selectionPlan: this.selectionPlan,
    };
  }

  async upsertRecordingFamily(
    _runId: string,
    input: Parameters<NonNullable<MatchingRepository["upsertRecordingFamily"]>>[1],
  ) {
    this.families.push(input);
    return "00000000-0000-4000-a000-000000000001";
  }

  async attachCandidateToRecordingFamily(
    _runId: string,
    familyId: string,
    candidateId: string,
    relationship?: string,
  ) {
    this.familyAttachments.push({ familyId, candidateId, relationship });
  }

  async upsertAlternateCatalogIdentity(_runId: string, input: AlternateCatalogIdentity) {
    this.catalogIdentities.push(input);
    return input.id;
  }

  async appendCandidateStageEvents(
    _runId: string,
    events: readonly CandidateStageEvent[],
    _versions: Pick<SelectionPlan, "pipelineVersion" | "policyVersion">,
  ) {
    void _versions;
    this.stageEvents.push(...events);
  }

  async savePipelineDeficitLedger(
    _runId: string,
    entries: readonly PipelineDeficitLedgerEntry[],
    _options: Pick<SelectionPlan, "pipelineVersion" | "policyVersion"> & { mode: "append" | "replace" },
  ) {
    void _options;
    this.deficits.splice(0, this.deficits.length, ...entries);
  }

  async persistCatalogDiscoveredCandidates(
    _runId: string,
    inputs: readonly CatalogDiscoveredCandidateInput[],
    _versions: Pick<SelectionPlan, "pipelineVersion" | "policyVersion">,
  ): Promise<CatalogDiscoveredCandidateResult[]> {
    void _versions;
    return inputs.map((input) => {
      this.persistedDiscoveries.push(input);
      const existing = this.candidates.find((item) => item.isrc && item.isrc === input.song.isrc);
      const candidateId = existing?.id ?? `catalog-${input.song.id}`;
      const scopeBindings: TrackScopeBinding[] = input.bindings.map((binding) => ({
        ...binding,
        sourceRecordId: `source-${input.container.providerId}`,
        researchContainerId: `container-${input.container.providerId}`,
        citationAttestationId: null,
        provenancePath: [
          { kind: "provenance_root", id: input.source.provenanceRoot },
          { kind: "source_record", id: `source-${input.container.providerId}` },
          { kind: "research_container", id: `container-${input.container.providerId}` },
        ],
      }));
      if (!existing) {
        this.candidates.push({
          id: candidateId,
          artist: input.song.artistName,
          title: input.song.name,
          album: input.song.albumName || null,
          releaseYear: input.song.releaseDate ? Number.parseInt(input.song.releaseDate.slice(0, 4), 10) : null,
          durationMs: input.song.durationInMillis ?? null,
          isrc: input.song.isrc ?? null,
          musicbrainzId: null,
          versionLabel: input.song.versionLabel ?? null,
          candidateStage: "scope_qualified",
          scopeBindings,
          evidence: [],
        });
      }
      return { candidateId, appleSongId: input.song.id, inserted: !existing, scopeBindings };
    });
  }
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
  vi.useRealTimers();
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

test("Pipeline V2 applies MusicBrainz identity before recording-family canonicalization", async () => {
  const row = candidate("musicbrainz-family", "verified");
  row.isrc = null;
  row.musicbrainzId = null;
  const catalogSong = { ...song, isrc: undefined };
  vi.mocked(searchAppleCatalog).mockResolvedValue([catalogSong]);
  const repository = new V2MemoryMatchingRepository([row]);
  const musicBrainzEnricher = vi.fn(async () => ({
    recordingId: "11111111-1111-4111-8111-111111111111",
    releaseGroupId: "22222222-2222-4222-8222-222222222222",
    source: "musicbrainz" as const,
  }));

  await matchResearchRun(repository, "run-musicbrainz-family", "us", undefined, {
    musicBrainzEnricher,
  });

  expect(musicBrainzEnricher).toHaveBeenCalledOnce();
  expect(repository.families).toHaveLength(1);
  expect(repository.families[0]).toMatchObject({
    familyKey: "mbid:11111111-1111-4111-8111-111111111111",
    metadata: {
      musicbrainzRecordingId: "11111111-1111-4111-8111-111111111111",
      musicbrainzReleaseGroupId: "22222222-2222-4222-8222-222222222222",
    },
  });
  expect(repository.catalogIdentities[0]).toMatchObject({
    provider: "apple",
    musicbrainzId: "11111111-1111-4111-8111-111111111111",
  });
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

test("V2 matching persists recording identity, compatible alternates, stages, and deficits", async () => {
  const compatible: CatalogSong = {
    ...song,
    id: "apple-compatible",
    albumName: "Test Album (Deluxe)",
  };
  const incompatibleIsrc: CatalogSong = {
    ...song,
    id: "apple-other-recording",
    isrc: "USAAA2000999",
  };
  const incompatibleLive: CatalogSong = {
    ...song,
    id: "apple-live",
    name: "Test Song (Live)",
    isrc: "USAAA2000888",
    versionLabel: "Live",
  };
  vi.mocked(lookupAppleCatalogByIsrc).mockResolvedValueOnce([
    song,
    compatible,
    incompatibleIsrc,
    incompatibleLive,
  ]);
  const exactBrief = { ...curatedBrief, targetSize: { min: 2, max: 2 } };
  const repository = new V2MemoryMatchingRepository(
    [candidate("v2-candidate", "editorial")],
    exactBrief,
    new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );

  await matchResearchRun(repository, "run-v2", "us", undefined, { fast: true });

  expect(repository.families).toEqual([expect.objectContaining({
    familyKey: "isrc:USAAA2000001",
    canonicalArtist: "Test Artist",
    canonicalTitle: "Test Song",
    pipelineVersion: "catalog_first_v2",
    policyVersion: "relevance_first_2026_07",
  })]);
  expect(repository.familyAttachments).toEqual([expect.objectContaining({
    candidateId: "v2-candidate",
    relationship: "primary_match",
  })]);
  expect(repository.catalogIdentities.map((identity) => identity.catalogId)).toEqual([
    "apple-1",
    "apple-compatible",
  ]);
  expect(repository.catalogIdentities.every((identity) => /^[0-9a-f-]{36}$/u.test(identity.id))).toBe(true);
  expect(repository.stageEvents
    .filter((event) => event.candidateId === "v2-candidate")
    .map((event) => event.toStage)).toEqual([
      "claim_verified",
      "version_compatible",
      "catalog_resolved",
      "playable",
      "canonicalized",
    ]);
  expect(repository.stageEvents
    .filter((event) => event.candidateId === "v2-candidate")
    .map((event) => [event.fromStage, event.toStage])).toEqual([
      ["scope_qualified", "claim_verified"],
      ["claim_verified", "version_compatible"],
      ["version_compatible", "catalog_resolved"],
      ["catalog_resolved", "playable"],
      ["playable", "canonicalized"],
    ]);
  expect(repository.deficits).toEqual(expect.arrayContaining([
    expect.objectContaining({
      stage: "catalog_resolved",
      kind: "catalog_availability",
      requiredCount: 2,
      actualCount: 1,
      deficitCount: 1,
    }),
  ]));
});

test("Brazilian disco production policy accepts a full canonical pool and finalizes an immutable 25-track manifest", async () => {
  const productionBrief: PlaylistBrief = {
    title: "Brazilian Disco Essentials",
    description: "A cited survey of Brazilian disco recordings.",
    mode: "curated",
    subjectEntities: ["Brazilian disco"],
    relationship: "represents Brazilian disco",
    include: ["Brazilian disco recordings"],
    exclude: [],
    versionPolicy: "Prefer original-era recordings; include later reissues or remasters only if they preserve the original track identity.",
    evidencePolicy: "Require cited specialist sources at track scope.",
    orderingPolicy: "Intermix artists in editorial rank order.",
    targetSize: { min: 25, max: 25 },
    ambiguities: [],
  };
  const candidates = Array.from({ length: 30 }, (_, index): Candidate => {
    const ordinal = index + 1;
    const item = candidate(`brazilian-disco-${ordinal}`, "editorial");
    item.artist = `Artista Disco ${String(ordinal).padStart(2, "0")}`;
    item.title = `Faixa Disco ${String(ordinal).padStart(2, "0")}`;
    // This mirrors the album-null production candidates that were rejected
    // by v1.2.4 solely because the conditional remaster phrase was parsed as
    // a remaster-only whitelist.
    item.album = null;
    item.releaseYear = null;
    item.durationMs = null;
    item.isrc = null;
    item.versionLabel = null;
    item.candidateStage = "scope_qualified";
    item.scopeBindings = [{
      bindingKind: "track_specific_source",
      eligibility: "qualifying",
      scopeAxis: "genre_scene",
      scopeValue: "Brazilian disco",
      geographyRelationship: "unspecified",
      relationship: `${item.title} is a Brazilian disco recording`,
      confidence: 0.98,
      sourceUrl: `https://example.com/brazilian-disco/${ordinal}`,
      sourceRecordId: `source-record-brazilian-disco-${ordinal}`,
      researchContainerId: null,
      citationAttestationId: `citation-brazilian-disco-${ordinal}`,
      provenancePath: [
        { kind: "provenance_root", id: "independent-brazilian-disco-editorial-root" },
        { kind: "source_record", id: `source-record-brazilian-disco-${ordinal}` },
      ],
      note: "Track-specific Brazilian disco evidence from a stored source record.",
    }];
    return item;
  });
  const songsByOrdinal = new Map(candidates.map((item, index): [string, CatalogSong] => {
    const ordinal = index + 1;
    return [String(ordinal).padStart(2, "0"), {
      ...song,
      id: `apple-brazilian-disco-${ordinal}`,
      artistName: item.artist,
      name: item.title,
      albumName: `${item.title} - Single`,
      releaseDate: `${1977 + (index % 8)}-01-01`,
      durationInMillis: 210_000 + index,
      isrc: `BRDSC${String(ordinal).padStart(7, "0")}`,
      versionLabel: undefined,
    }];
  }));
  vi.mocked(searchAppleCatalog).mockImplementation(async (_storefront, query) => {
    const ordinal = /(?:Artista|Faixa) Disco (\d{2})/u.exec(query)?.[1];
    const match = ordinal ? songsByOrdinal.get(ordinal) : null;
    return match ? [match] : [];
  });

  const repository = new V2MemoryMatchingRepository(
    candidates,
    productionBrief,
    new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );
  repository.selectionPlan = createSelectionPlanV2({
    prompt: "Brazilian disco songs",
    brief: productionBrief,
    storefront: "us",
  });
  expect(repository.selectionPlan.versionPolicy).toMatchObject({
    preferred: ["canonical"],
    allowed: ["canonical", "remaster", "clean", "explicit", "unknown"],
  });

  await matchResearchRun(repository, "run-v2-brazilian-disco-manifest", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: emptyCatalogDiscoveryProvider(),
    musicBrainzEnricher: async () => null,
  });

  const accepted = repository.matches.filter((match) => match.status === "accepted" && match.song);
  expect(accepted).toHaveLength(30);
  expect(accepted.every((match) => catalogRecordingVersionClass(match.song!) === "canonical")).toBe(true);

  const manifestCandidates: ShadowManifestCandidate[] = accepted.map((match, index) => ({
    rank: index + 1,
    candidateId: match.candidateId,
    appleSongId: match.song!.id,
    recordingFamilyKey: `isrc:${match.song!.isrc}`,
    artist: match.song!.artistName,
    title: match.song!.name,
    scopeBindingIds: [`binding-${match.candidateId}`],
    includeInManifest: index < 25,
    evidenceEligible: true,
    hardConstraintsSatisfied: true,
    versionCompatible: true,
    storefrontPlayable: true,
  }));
  const manifestReport = evaluatePipelineV2ManifestShadow({
    schemaVersion: PIPELINE_V2_SHADOW_INPUT_SCHEMA,
    comparisonId: "production-regression-brazilian-disco-v124",
    generatedAt: "2026-07-19T12:00:00.000Z",
    promptHash: sha256Hex("Brazilian disco songs"),
    storefront: "us",
    targetTrackCount: 25,
    primary: {
      pipelineVersion: "legacy_v1",
      policyVersion: "legacy_v1",
      modelSnapshot: "legacy-regression-baseline",
      sourceRunId: "v124-failed-production-run",
      candidates: [],
    },
    shadow: {
      pipelineVersion: "catalog_first_v2",
      policyVersion: "relevance_first_2026_07",
      modelSnapshot: "v125-corrective-release",
      sourceRunId: "run-v2-brazilian-disco-manifest",
      candidates: manifestCandidates,
    },
  });

  expect(manifestReport.shadow).toMatchObject({
    pipelineVersion: "catalog_first_v2",
    trackCount: 25,
    exactCountSatisfied: true,
    contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
  });
  expect(manifestReport.shadow.tracks).toHaveLength(25);
  expect(new Set(manifestReport.shadow.tracks.map((track) => track.appleSongId)).size).toBe(25);
  expect(new Set(manifestReport.shadow.tracks.map((track) => track.recordingFamilyKey)).size).toBe(25);
});

test("conditional later-edit prose does not send an exact canonical house recording to review", async () => {
  const houseBrief: PlaylistBrief = {
    ...sceneBrief(1),
    title: "House Essentials 25",
    description: "A source-backed selection of recordings in the requested house music scope.",
    subjectEntities: ["House music"],
    relationship: "is a recording in the house music genre",
    include: ["Canonical house tracks"],
    versionPolicy: "Prefer original or definitive versions when multiple commonly cited versions exist; include later edits only if they are historically central or more widely recognized than the original.",
  };
  const houseCandidate = candidate("v2-house-conditional-edit", "editorial");
  houseCandidate.artist = "Marshall Jefferson";
  houseCandidate.title = "Move Your Body";
  houseCandidate.album = null;
  houseCandidate.releaseYear = null;
  houseCandidate.durationMs = null;
  houseCandidate.isrc = null;
  houseCandidate.versionLabel = null;
  houseCandidate.candidateStage = "scope_qualified";
  houseCandidate.scopeBindings = [{
    bindingKind: "track_specific_source",
    eligibility: "qualifying",
    scopeAxis: "genre_scene",
    scopeValue: "house music",
    relationship: "Move Your Body is a house recording",
    confidence: 0.98,
    sourceUrl: "https://example.com/house/move-your-body",
    sourceRecordId: "source-record-house-move-your-body",
    researchContainerId: null,
    citationAttestationId: "citation-house-move-your-body",
    provenancePath: [{ kind: "provenance_root", id: "independent-house-editorial-root" }],
    note: "Track-specific house evidence from a stored source record.",
  }];
  vi.mocked(searchAppleCatalog).mockResolvedValue([{
    ...song,
    id: "apple-house-canonical",
    artistName: houseCandidate.artist,
    name: houseCandidate.title,
    albumName: "Move Your Body - Single",
    releaseDate: "1986-01-01",
    durationInMillis: 405_760,
    isrc: "GBBLG0100315",
    versionLabel: undefined,
  }]);

  const repository = new V2MemoryMatchingRepository(
    [houseCandidate],
    houseBrief,
    new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );
  repository.selectionPlan = createSelectionPlanV2({
    prompt: "House music",
    brief: houseBrief,
    storefront: "us",
  });
  expect(repository.selectionPlan.versionPolicy).toMatchObject({
    preferred: ["canonical"],
    allowed: expect.arrayContaining(["canonical", "radio_edit"]),
  });

  await matchResearchRun(repository, "run-v2-house-conditional-edit", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: emptyCatalogDiscoveryProvider(),
    musicBrainzEnricher: async () => null,
  });

  expect(repository.matches).toEqual([expect.objectContaining({
    candidateId: houseCandidate.id,
    status: "accepted",
    song: expect.objectContaining({ id: "apple-house-canonical" }),
  })]);
});

test("V2 fixed-album scope never bypasses the requested album with an exact artist/title result", async () => {
  const fixedAlbumBrief: PlaylistBrief = {
    ...sceneBrief(1),
    title: "Michael Jackson — Thriller",
    description: "Songs from Michael Jackson's Thriller album.",
    subjectEntities: ["Michael Jackson", "Thriller"],
    relationship: "is included in the track list for the album Thriller by Michael Jackson",
    include: ["Tracks on the release Thriller."],
  };
  const fixedAlbumCandidate = candidate("v2-fixed-album", "editorial");
  fixedAlbumCandidate.artist = "Paulo Jerônimo";
  fixedAlbumCandidate.title = "Vida Agitada";
  fixedAlbumCandidate.album = "The Requested Album";
  fixedAlbumCandidate.releaseYear = null;
  fixedAlbumCandidate.durationMs = null;
  fixedAlbumCandidate.isrc = null;
  fixedAlbumCandidate.versionLabel = null;
  fixedAlbumCandidate.candidateStage = "scope_qualified";
  fixedAlbumCandidate.scopeBindings = [{
    bindingKind: "track_specific_source",
    eligibility: "qualifying",
    scopeAxis: "scene",
    scopeValue: "Test scene",
    relationship: "represents the Test scene",
    confidence: 0.98,
    sourceUrl: "https://example.com/test-scene/vida-agitada",
    sourceRecordId: "source-record-fixed-album",
    researchContainerId: "requested-album-container",
    citationAttestationId: "citation-fixed-album",
    provenancePath: [{ kind: "provenance_root", id: "fixed-album-source" }],
    note: "Track-specific evidence for the requested album.",
  }];
  vi.mocked(searchAppleCatalog).mockResolvedValue([{
    ...song,
    id: "apple-wrong-album",
    artistName: "Paulo Jeronimo",
    name: "Vida Agitada",
    albumName: "A Different Album",
    releaseDate: "1981-01-01",
    durationInMillis: 233_000,
    isrc: "BRABC8100001",
  }]);
  const repository = new V2MemoryMatchingRepository(
    [fixedAlbumCandidate],
    fixedAlbumBrief,
    new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );
  repository.selectionPlan = createSelectionPlanV2({
    prompt: "songs from Michael Jackson's Thriller",
    brief: fixedAlbumBrief,
    storefront: "us",
  });
  expect(repository.selectionPlan.scopeKind).toBe("fixed_release_container");
  expect(repository.selectionPlan.diversityGoals.maximumTracksPerAlbum).toBeNull();

  await matchResearchRun(repository, "run-v2-fixed-album", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: emptyCatalogDiscoveryProvider(),
    musicBrainzEnricher: async () => null,
  });

  expect(repository.matches).toEqual([expect.objectContaining({
    candidateId: fixedAlbumCandidate.id,
    status: "review",
    song: expect.objectContaining({ id: "apple-wrong-album" }),
  })]);
  expect(repository.matches[0]?.basis).not.toContain("non-binding editorial source album");
});

test("V2 broad curated matching does not discard a real album without durable container proof", async () => {
  const realAlbumCandidate = candidate("v2-real-album", "editorial");
  realAlbumCandidate.artist = "Paulo Jerônimo";
  realAlbumCandidate.title = "Vida Agitada";
  realAlbumCandidate.album = "Vida Agitada";
  realAlbumCandidate.releaseYear = null;
  realAlbumCandidate.durationMs = null;
  realAlbumCandidate.isrc = null;
  realAlbumCandidate.versionLabel = null;
  realAlbumCandidate.candidateStage = "scope_qualified";
  realAlbumCandidate.scopeBindings = [{
    bindingKind: "track_specific_source",
    eligibility: "qualifying",
    scopeAxis: "scene",
    scopeValue: "Test scene",
    relationship: "represents the Test scene",
    confidence: 0.98,
    sourceUrl: "https://example.com/test-scene/vida-agitada",
    sourceRecordId: "source-record-real-album",
    researchContainerId: null,
    citationAttestationId: "citation-real-album",
    provenancePath: [
      { kind: "provenance_root", id: "independent-editorial-root" },
      { kind: "source_record", id: "source-record-real-album" },
      { kind: "evidence_claim", id: "claim-real-album" },
    ],
    note: "Track-specific evidence names the recording's real album.",
  }];
  vi.mocked(searchAppleCatalog).mockResolvedValue([{
    ...song,
    id: "apple-different-album",
    artistName: "Paulo Jeronimo",
    name: "Vida Agitada",
    albumName: "Brazilian Disco Classics",
    releaseDate: "1981-01-01",
    durationInMillis: 233_000,
    isrc: "BRABC8100001",
  }]);
  const exactBrief = sceneBrief(1);
  const repository = new V2MemoryMatchingRepository(
    [realAlbumCandidate],
    exactBrief,
    new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );
  repository.selectionPlan = createSelectionPlanV2({
    prompt: "One documented Test scene track",
    brief: exactBrief,
    storefront: "us",
  });
  expect(repository.selectionPlan.scopeKind).toBe("broad_curated");

  await matchResearchRun(repository, "run-v2-real-album", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: emptyCatalogDiscoveryProvider(),
    musicBrainzEnricher: async () => null,
  });

  expect(repository.matches).toEqual([expect.objectContaining({
    candidateId: realAlbumCandidate.id,
    status: "review",
    song: expect.objectContaining({ id: "apple-different-album" }),
  })]);
  expect(repository.matches[0]?.basis).not.toContain("non-binding editorial source album");
});

function factualV2CandidateForVersionPolicy(id: string): Candidate {
  const row = candidate(id, "verified");
  row.isrc = null;
  row.durationMs = null;
  row.releaseYear = null;
  row.versionLabel = null;
  row.candidateStage = "scope_qualified";
  row.scopeBindings = [{
    bindingKind: "track_specific_source",
    eligibility: "qualifying",
    scopeAxis: "factual_relationship",
    scopeValue: "Test Artist performed on Test Song",
    relationship: brief.relationship,
    confidence: 0.98,
    sourceUrl: "https://example.com/test-artist/test-song",
    sourceRecordId: "source-record-version-policy",
    researchContainerId: null,
    citationAttestationId: "citation-version-policy",
    provenancePath: [{ kind: "provenance_root", id: "independent-credit-source" }],
    note: "Track-specific performed-on credit.",
  }];
  return row;
}

function setFactualV2VersionPolicy(
  repository: V2MemoryMatchingRepository,
  allowed: SelectionPlan["versionPolicy"]["allowed"],
) {
  const plan = createSelectionPlanV2({
    prompt: "Every released recording Test Artist performed on",
    brief,
    storefront: "us",
  });
  repository.selectionPlan = {
    ...plan,
    versionPolicy: {
      ...plan.versionPolicy,
      allowed,
      preferred: allowed.slice(0, 2),
    },
  };
}

test("V2 direct matching promotes the best safe allowed alternate before persistence", async () => {
  const canonical: CatalogSong = {
    ...song,
    id: "apple-canonical",
    releaseDate: "2020-01-01",
  };
  const remaster: CatalogSong = {
    ...song,
    id: "apple-remaster",
    releaseDate: "2021-01-01",
    versionLabel: "2021 Remaster",
  };
  vi.mocked(searchAppleCatalog).mockResolvedValue([canonical, remaster]);
  const repository = new V2MemoryMatchingRepository([
    factualV2CandidateForVersionPolicy("v2-version-promote"),
  ]);
  setFactualV2VersionPolicy(repository, ["remaster"]);

  await matchResearchRun(repository, "run-v2-version-promote", "us", undefined, {
    musicBrainzEnricher: async () => null,
  });

  expect(repository.matches).toEqual([expect.objectContaining({
    candidateId: "v2-version-promote",
    status: "accepted",
    song: expect.objectContaining({ id: "apple-remaster" }),
    basis: expect.stringContaining("V2 version policy promoted an allowed remaster alternative"),
  })]);
  expect(repository.families).toEqual([expect.objectContaining({ versionClass: "remaster" })]);
  expect(repository.catalogIdentities.map((identity) => identity.catalogId)).toEqual(["apple-remaster"]);
  expect(repository.stageEvents.map((event) => event.toStage)).toEqual([
    "claim_verified",
    "version_compatible",
    "catalog_resolved",
    "playable",
    "canonicalized",
  ]);
});

test("V2 direct matching records a version policy conflict without advancing playable stages", async () => {
  const remaster: CatalogSong = {
    ...song,
    id: "apple-remaster-only",
    versionLabel: "2021 Remaster",
  };
  vi.mocked(searchAppleCatalog).mockResolvedValue([song, remaster]);
  const repository = new V2MemoryMatchingRepository([
    factualV2CandidateForVersionPolicy("v2-version-conflict"),
  ]);
  setFactualV2VersionPolicy(repository, ["live"]);

  await matchResearchRun(repository, "run-v2-version-conflict", "us", undefined, {
    musicBrainzEnricher: async () => null,
  });

  expect(repository.matches).toEqual([expect.objectContaining({
    candidateId: "v2-version-conflict",
    status: "unsupported",
    song: null,
    basis: expect.stringContaining("version_policy_conflict"),
  })]);
  expect(repository.families).toHaveLength(0);
  expect(repository.catalogIdentities).toHaveLength(0);
  expect(repository.stageEvents).toEqual([expect.objectContaining({
    toStage: "rejected",
    reasonCode: "version_policy_conflict",
  })]);
  expect(repository.stageEvents.some((event) => [
    "version_compatible",
    "catalog_resolved",
    "playable",
    "canonicalized",
  ].includes(event.toStage))).toBe(false);
});

test("V2 retries a frontier version conflict through broader search and replaces it with an allowed version", async () => {
  const live: CatalogSong = {
    ...song,
    id: "apple-live-frontier",
    name: "Test Song (Live)",
    versionLabel: "Live",
  };
  const canonical: CatalogSong = {
    ...song,
    id: "apple-canonical-broader-search",
  };
  vi.mocked(searchAppleCatalog)
    .mockResolvedValueOnce([live])
    .mockResolvedValueOnce([canonical]);
  const row = factualV2CandidateForVersionPolicy("v2-frontier-version-retry");
  const repository = new V2MemoryMatchingRepository([row]);
  setFactualV2VersionPolicy(repository, ["canonical"]);
  repository.matches.push({
    candidateId: row.id,
    status: "unsupported",
    basis: "version_policy_conflict; live is not allowed and no allowed catalog alternative was found",
    score: 0,
    song: null,
    alternatives: [live],
  });

  await matchResearchRun(repository, "run-v2-frontier-version-retry", "us", undefined, {
    musicBrainzEnricher: async () => null,
  });

  expect(searchAppleCatalog).toHaveBeenCalledTimes(2);
  expect(repository.matches).toEqual([expect.objectContaining({
    candidateId: row.id,
    status: "accepted",
    song: expect.objectContaining({ id: canonical.id }),
  })]);
});

test("V2 exact-fill recovery counts only matches that can survive a hard era manifest", async () => {
  const exactBrief: PlaylistBrief = {
    ...sceneBrief(1),
    title: "Test scene recordings from the 1970s",
    description: "Documented Test scene recordings from the 1970s.",
    subjectEntities: ["Test scene", "1970s"],
    include: ["Documented Test scene recordings from the 1970s."],
  };
  const scopedCandidate = candidate("v2-era-refill", "editorial");
  scopedCandidate.releaseYear = 2020;
  scopedCandidate.isrc = null;
  scopedCandidate.scopeBindings = [
    {
      bindingKind: "track_specific_source",
      eligibility: "qualifying",
      scopeAxis: "scene",
      scopeValue: "Test scene",
      relationship: "represents the Test scene",
      confidence: 0.98,
      sourceUrl: "https://example.com/test-scene",
      sourceRecordId: "source-test-scene",
      researchContainerId: null,
      citationAttestationId: "citation-test-scene",
      provenancePath: [{ kind: "provenance_root", id: "test-scene-source" }],
      note: "Track-specific scene evidence.",
    },
    {
      bindingKind: "track_specific_source",
      eligibility: "qualifying",
      scopeAxis: "era",
      scopeValue: "1970s",
      relationship: "was released in the 1970s",
      confidence: 0.98,
      sourceUrl: "https://example.com/test-scene",
      sourceRecordId: "source-test-scene",
      researchContainerId: null,
      citationAttestationId: "citation-test-scene",
      provenancePath: [{ kind: "provenance_root", id: "test-scene-source" }],
      note: "Track-specific era evidence.",
    },
  ];
  vi.mocked(searchAppleCatalog).mockResolvedValue([{
    ...song,
    id: "apple-modern-only",
    releaseDate: "2020-01-01",
    isrc: "USAAA2000001",
  }, {
    ...song,
    id: "apple-unrelated-old-recording",
    releaseDate: "1978-01-01",
    isrc: "USAAA7800001",
  }]);
  const policy = researchExecutionPolicy(exactBrief, {});
  if (policy.kind !== "fast_curated") throw new Error("Fixture must use the fast curated route");
  const repository = new V2MemoryMatchingRepository(
    [scopedCandidate],
    exactBrief,
    new Map([["fast:route:fast_curated_v3", createFastRouteCheckpoint(policy)]]),
    undefined,
    true,
  );
  repository.selectionPlan = createSelectionPlanV2({
    prompt: "Test scene recording from the 1970s",
    brief: exactBrief,
    storefront: "us",
  });
  repository.automaticRefillState = "queued";
  const emptyDiscoveryProvider: CatalogDiscoveryProvider = {
    async search() { return { songs: [], artists: [], albums: [], playlists: [] }; },
    async playlistTracks() { return { items: [], next: null }; },
    async albumTracks() { return { items: [], next: null }; },
    async artistTopSongs() { return { items: [], next: null }; },
    async artistAlbums() { return { items: [], next: null }; },
    async similarArtists() { return { items: [], next: null }; },
  };

  await matchResearchRun(repository, "run-v2-era-refill", "us", undefined, {
    musicBrainzEnricher: async () => null,
    catalogDiscoveryProvider: emptyDiscoveryProvider,
  });

  expect(repository.matches).toEqual([expect.objectContaining({
    status: "accepted",
    song: expect.objectContaining({ id: "apple-modern-only" }),
  })]);
  expect(repository.automaticRefills).toEqual([expect.objectContaining({
    runId: "run-v2-era-refill",
    currentGeneration: 0,
  })]);
  expect(repository.automaticPublications).toEqual([]);
  expect(repository.checkpointWrites).toContainEqual(expect.objectContaining({
    phase: "catalog_matching_outcome",
    checkpoint: expect.objectContaining({ safePrimaryCount: 0, shortfall: 1 }),
  }));
});

test("V2 exact-fill safe count applies hard exclusions before publication handoff", async () => {
  const exactBrief = {
    ...sceneBrief(1),
    title: "Test scene tracks",
    description: "Documented tracks in the Test scene.",
  };
  const scopedCandidate = candidate("v2-excluded-artist", "editorial");
  scopedCandidate.scopeBindings = [{
    bindingKind: "track_specific_source",
    eligibility: "qualifying",
    scopeAxis: "scene",
    scopeValue: "Test scene",
    relationship: "represents the Test scene",
    confidence: 0.98,
    sourceUrl: "https://example.com/test-scene",
    sourceRecordId: "source-test-scene",
    researchContainerId: null,
    citationAttestationId: "citation-test-scene",
    provenancePath: [{ kind: "provenance_root", id: "test-scene-source" }],
    note: "Track-specific scene evidence.",
  }];
  const repository = new V2MemoryMatchingRepository(
    [scopedCandidate],
    exactBrief,
    new Map([["catalog_matching", {
      nextIndex: 1,
      storefront: "us",
      complete: true,
      updatedAt: new Date().toISOString(),
    }]]),
    undefined,
    true,
  );
  repository.selectionPlan = createSelectionPlanV2({
    prompt: "Test scene recording excluding Test Artist",
    brief: exactBrief,
    storefront: "us",
  });
  repository.selectionPlan.constraints.push({
    id: "exclude-test-artist",
    axis: "artist",
    operator: "exclude",
    values: ["Test Artist"],
    kind: "hard",
    relaxationRank: null,
  });
  repository.matches.push({
    candidateId: scopedCandidate.id,
    status: "accepted",
    basis: "Exact Apple identity",
    score: 1,
    song,
    alternatives: [],
  });
  repository.automaticRefillState = "queued";

  await matchResearchRun(repository, "run-v2-hard-exclude", "us");

  expect(repository.automaticPublications).toEqual([]);
  expect(repository.automaticRefills).toEqual([expect.objectContaining({
    runId: "run-v2-hard-exclude",
  })]);
  expect(repository.checkpointWrites).toContainEqual(expect.objectContaining({
    phase: "catalog_matching_outcome",
    checkpoint: expect.objectContaining({ safePrimaryCount: 0, shortfall: 1 }),
  }));
});

test("V2 exact-fill counts one recording family once across multiple Apple song IDs", async () => {
  const exactBrief = {
    ...sceneBrief(2),
    title: "Test scene tracks",
    description: "Documented tracks in the Test scene.",
  };
  const first = candidate("v2-family-a", "editorial");
  const second = candidate("v2-family-b", "editorial");
  for (const row of [first, second]) {
    row.scopeBindings = [{
      bindingKind: "track_specific_source",
      eligibility: "qualifying",
      scopeAxis: "scene",
      scopeValue: "Test scene",
      relationship: "represents the Test scene",
      confidence: 0.98,
      sourceUrl: `https://example.com/test-scene/${row.id}`,
      sourceRecordId: `source-${row.id}`,
      researchContainerId: null,
      citationAttestationId: `citation-${row.id}`,
      provenancePath: [{ kind: "provenance_root", id: `root-${row.id}` }],
      note: "Track-specific scene evidence.",
    }];
  }
  const repository = new V2MemoryMatchingRepository(
    [first, second],
    exactBrief,
    new Map([["catalog_matching", {
      nextIndex: 2,
      storefront: "us",
      complete: true,
      updatedAt: new Date().toISOString(),
    }]]),
    undefined,
    true,
  );
  repository.selectionPlan = createSelectionPlanV2({
    prompt: "Test scene recordings",
    brief: exactBrief,
    storefront: "us",
  });
  repository.matches.push({
    candidateId: first.id,
    status: "accepted",
    basis: "Exact Apple identity A",
    score: 1,
    song: { ...song, id: "apple-family-a" },
    alternatives: [],
  }, {
    candidateId: second.id,
    status: "accepted",
    basis: "Exact Apple identity B",
    score: 1,
    song: { ...song, id: "apple-family-b" },
    alternatives: [],
  });
  repository.automaticRefillState = "queued";

  await matchResearchRun(repository, "run-v2-family-dedupe", "us");

  expect(repository.automaticPublications).toEqual([]);
  expect(repository.automaticRefills).toEqual([expect.objectContaining({
    runId: "run-v2-family-dedupe",
  })]);
  expect(repository.checkpointWrites).toContainEqual(expect.objectContaining({
    phase: "catalog_matching_outcome",
    checkpoint: expect.objectContaining({ safePrimaryCount: 1, shortfall: 1 }),
  }));
});

test("V2 curated matching invokes bounded discovery and accepts only an exact evidence-bound identity", async () => {
  const discoveryBrief: PlaylistBrief = {
    title: "Test scene recordings",
    description: "A cited survey of the Test scene.",
    mode: "curated",
    subjectEntities: ["Test scene"],
    relationship: "represents the scene",
    include: ["documented Test scene recordings"],
    exclude: [],
    versionPolicy: "studio recordings",
    evidencePolicy: "cited editorial sources",
    orderingPolicy: "source order",
    targetSize: { min: 1, max: 1 },
    ambiguities: [],
  };
  const exactCandidate = candidate("v2-discovery-candidate", "editorial");
  exactCandidate.candidateStage = "scope_qualified";
  exactCandidate.scopeBindings = [{
    bindingKind: "track_specific_source",
    eligibility: "qualifying",
    scopeAxis: "scene",
    scopeValue: "Test scene",
    relationship: "represents the scene",
    confidence: 0.96,
    sourceUrl: "https://example.com/test-scene/test-song",
    sourceRecordId: "source-record-test-song",
    researchContainerId: null,
    citationAttestationId: "citation-test-song",
    provenancePath: [{ kind: "provenance_root", id: "independent-editorial-root" }],
    note: "The source explicitly places this recording in the Test scene.",
  }];
  const unrelatedSong: CatalogSong = {
    ...song,
    id: "apple-unbound",
    artistName: "House Builders",
    isrc: "USAAA2000999",
  };
  const queries: string[] = [];
  const provider: CatalogDiscoveryProvider = {
    async search(_storefront, query) {
      queries.push(query);
      return { songs: [unrelatedSong, song], artists: [], albums: [], playlists: [] };
    },
    async playlistTracks() { return { items: [], next: null }; },
    async albumTracks() { return { items: [], next: null }; },
    async artistTopSongs() { return { items: [], next: null }; },
    async artistAlbums() { return { items: [], next: null }; },
    async similarArtists() { return { items: [], next: null }; },
  };
  const repository = new V2MemoryMatchingRepository(
    [exactCandidate],
    discoveryBrief,
    new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );
  repository.selectionPlan = createSelectionPlanV2({
    prompt: "One track from the documented Test scene",
    brief: discoveryBrief,
    storefront: "us",
  });
  expect(repository.selectionPlan.intents).toEqual(["genre_scene"]);

  await matchResearchRun(repository, "run-v2-discovery", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: provider,
  });

  expect(queries.length).toBeGreaterThan(0);
  expect(queries.length).toBeLessThanOrEqual(16);
  expect(repository.matches).toEqual([expect.objectContaining({
    candidateId: "v2-discovery-candidate",
    status: "accepted",
    song: expect.objectContaining({ id: "apple-1" }),
  })]);
  expect(repository.matches.some((match) => match.song?.id === "apple-unbound")).toBe(false);
  expect(lookupAppleCatalogByIsrc).not.toHaveBeenCalled();
  expect(repository.checkpointWrites).toEqual(expect.arrayContaining([
    expect.objectContaining({
      phase: "catalog_discovery_v2",
      checkpoint: expect.objectContaining({
        schemaVersion: 2,
        state: "terminal",
        complete: true,
        discoveredCount: 2,
        qualifiedCount: 1,
        resolvedCount: 1,
        progress: expect.objectContaining({ version: CATALOG_DISCOVERY_PROGRESS_VERSION }),
      }),
    }),
  ]));
  expect(repository.checkpointWrites).toEqual(expect.arrayContaining([
    expect.objectContaining({
      phase: "catalog_discovery_v2",
      checkpoint: expect.objectContaining({
        schemaVersion: 2,
        state: "running",
        complete: false,
        attempt: 1,
        retryAttempt: 1,
        inputFingerprint: expect.any(String),
        progress: expect.objectContaining({
          version: CATALOG_DISCOVERY_PROGRESS_VERSION,
          sequence: expect.any(Number),
        }),
        trustedPlaylists: expect.any(Array),
      }),
    }),
  ]));
});

test("V2 curated discovery grows the persisted pool from a scoped Apple editorial playlist and exact-fills", async () => {
  const growthBrief: PlaylistBrief = {
    title: "House music survey",
    description: "A source-backed survey of house music.",
    mode: "curated",
    subjectEntities: ["house music"],
    relationship: "represents house music",
    include: ["house music"],
    exclude: [],
    versionPolicy: "studio recordings",
    evidencePolicy: "trusted scoped editorial sources",
    orderingPolicy: "source order",
    targetSize: { min: 2, max: 2 },
    ambiguities: [],
  };
  const existing = candidate("house-existing", "editorial");
  existing.scopeBindings = [{
    bindingKind: "track_specific_source",
    eligibility: "qualifying",
    scopeAxis: "genre",
    scopeValue: "house music",
    relationship: "represents house music",
    confidence: 0.96,
    sourceUrl: "https://example.com/house/existing",
    sourceRecordId: "source-existing",
    researchContainerId: null,
    citationAttestationId: "citation-existing",
    provenancePath: [{ kind: "provenance_root", id: "independent-house-history" }],
    note: "Track-specific house history.",
  }];
  const newSong: CatalogSong = {
    id: "apple-house-new",
    name: "Warehouse Signal",
    artistName: "South Side Unit",
    albumName: "Warehouse Signal",
    releaseDate: "1987-04-01",
    durationInMillis: 360_000,
    isrc: "USAAA8700002",
  };
  const provider: CatalogDiscoveryProvider = {
    async search() {
      return {
        songs: [song],
        artists: [],
        albums: [],
        playlists: [{
          id: "pl.house-editorial",
          name: "House Essentials",
          curatorName: "Apple Music Dance",
          description: "Foundational house music.",
          playlistType: "editorial",
          url: "https://music.apple.com/us/playlist/house-essentials/pl.house-editorial",
        }],
      };
    },
    async playlistTracks() { return { items: [newSong], next: null }; },
    async albumTracks() { return { items: [], next: null }; },
    async artistTopSongs() { return { items: [], next: null }; },
    async artistAlbums() { return { items: [], next: null }; },
    async similarArtists() { return { items: [], next: null }; },
  };
  const repository = new V2MemoryMatchingRepository(
    [existing],
    growthBrief,
    new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );
  repository.selectionPlan = createSelectionPlanV2({
    prompt: "Two documented house music tracks",
    brief: growthBrief,
    storefront: "us",
  });

  await matchResearchRun(repository, "run-v2-growth", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: provider,
  });

  expect(repository.persistedDiscoveries).toHaveLength(1);
  expect(repository.persistedDiscoveries[0]).toMatchObject({
    song: { id: "apple-house-new" },
    source: { sourceClass: "apple", provenanceRoot: "apple_music_editorial:pl.house-editorial" },
    bindings: [expect.objectContaining({ bindingKind: "catalog_editorial_membership", eligibility: "qualifying" })],
  });
  expect(repository.persistedDiscoveries[0]!.bindings[0]!.relationship).not.toContain(growthBrief.relationship);
  expect(repository.candidates).toHaveLength(2);
  expect(repository.matches).toEqual(expect.arrayContaining([
    expect.objectContaining({ candidateId: "house-existing", status: "accepted" }),
    expect.objectContaining({ candidateId: "catalog-apple-house-new", status: "accepted", song: expect.objectContaining({ id: "apple-house-new" }) }),
  ]));
  expect(repository.checkpointWrites).toContainEqual(expect.objectContaining({
    phase: "catalog_discovery_v2",
    checkpoint: expect.objectContaining({ persistedCandidateCount: 1, resolvedCount: 2 }),
  }));
});

test("V2 keeps qualified Apple rows resumable when the fast deadline expires before handoff", async () => {
  vi.useFakeTimers();
  const confirmedAt = new Date("2026-07-19T20:00:00.000Z");
  vi.setSystemTime(confirmedAt);
  const handoffBrief: PlaylistBrief = {
    title: "House music starter",
    description: "A source-backed house music playlist.",
    mode: "curated",
    subjectEntities: ["house music"],
    relationship: "represents house music",
    include: ["house music"],
    exclude: [],
    versionPolicy: "canonical studio recordings",
    evidencePolicy: "trusted scoped editorial sources",
    orderingPolicy: "source order",
    targetSize: { min: 1, max: 1 },
    ambiguities: [],
  };
  const editorialSongs: CatalogSong[] = Array.from({ length: 6 }, (_, index) => ({
    id: `apple-handoff-${index}`,
    name: `Handoff House Track ${index}`,
    artistName: `Handoff Artist ${index}`,
    albumName: `Handoff Release ${index}`,
    releaseDate: "1988-01-01",
    durationInMillis: 300_000 + index,
    isrc: `USHHH88${String(index).padStart(5, "0")}`,
  }));
  let providerCalls = 0;
  let consumeFirstRoute = true;
  const provider: CatalogDiscoveryProvider = {
    async search() {
      providerCalls += 1;
      return {
        songs: [], artists: [], albums: [], playlists: [{
          id: "pl.house-deadline-handoff",
          name: "House Essentials",
          curatorName: "Apple Music Dance",
          description: "Foundational house music.",
          playlistType: "editorial",
          url: "https://music.apple.com/us/playlist/house-essentials/pl.house-deadline-handoff",
        }],
      };
    },
    async playlistTracks() {
      providerCalls += 1;
      if (consumeFirstRoute) {
        consumeFirstRoute = false;
        const route = repository.checkpointsByPhase.get("fast:route:fast_curated_v3") as { deadlineAt: string };
        vi.setSystemTime(new Date(Date.parse(route.deadlineAt) - 1_000));
      }
      return { items: editorialSongs, next: null };
    },
    async albumTracks() { return { items: [], next: null }; },
    async artistTopSongs() { return { items: [], next: null }; },
    async artistAlbums() { return { items: [], next: null }; },
    async similarArtists() { return { items: [], next: null }; },
  };
  const repository = new V2MemoryMatchingRepository(
    [],
    handoffBrief,
    new Map([["fast:route:fast_curated_v3", routeCheckpoint(confirmedAt)]]),
  );
  repository.selectionPlan = createSelectionPlanV2({
    prompt: "One house music track",
    brief: handoffBrief,
    storefront: "us",
  });

  await expect(matchResearchRun(repository, "run-v2-deadline-handoff", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: provider,
    musicBrainzEnricher: async () => null,
  })).rejects.toThrow("awaiting durable handoff");

  expect(repository.persistedDiscoveries).toHaveLength(0);
  expect(repository.matches).toHaveLength(0);
  expect(repository.checkpointsByPhase.get("catalog_discovery_v2")).toMatchObject({
    schemaVersion: 2,
    state: "running",
    complete: false,
    retryable: true,
    qualifiedCount: 6,
    handoffPendingCount: 6,
    durableAcceptedCount: 0,
    progress: expect.objectContaining({ candidates: expect.any(Array) }),
  });
  const callsBeforeResume = providerCalls;

  await matchResearchRun(repository, "run-v2-deadline-handoff", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: provider,
    musicBrainzEnricher: async () => null,
  });

  expect(providerCalls).toBe(callsBeforeResume);
  expect(repository.persistedDiscoveries).toHaveLength(6);
  expect(repository.matches.filter((match) => match.status === "accepted")).toHaveLength(6);
  expect(repository.checkpointsByPhase.get("catalog_discovery_v2")).toMatchObject({
    schemaVersion: 2,
    state: "terminal",
    complete: true,
    retryable: false,
    handoffPendingCount: 0,
    durableAcceptedCount: 6,
  });
});

test("V2 promotes production-sized trusted Apple discoveries in bounded chunks before generic timeout", async () => {
  vi.useFakeTimers();
  const confirmedAt = new Date("2026-07-19T23:24:44.000Z");
  vi.setSystemTime(confirmedAt);
  const productionBrief: PlaylistBrief = {
    title: "House Essentials 25",
    description: "A source-backed selection of recordings in the requested house music scope.",
    mode: "curated",
    subjectEntities: ["house music"],
    relationship: "represents house music",
    include: ["house music"],
    exclude: [],
    versionPolicy: "canonical studio recordings",
    evidencePolicy: "trusted scoped editorial sources",
    orderingPolicy: "source order",
    targetSize: { min: 25, max: 25 },
    ambiguities: [],
  };
  const researchCandidates = Array.from({ length: 44 }, (_, index) => {
    const row = candidate(`house-research-${index}`, "editorial");
    row.artist = `Research Artist ${index}`;
    row.title = `Research Track ${index}`;
    row.album = `Research Album ${index}`;
    row.isrc = `USAAA26${String(index).padStart(5, "0")}`;
    row.candidateStage = index < 15 ? "canonicalized" : "scope_qualified";
    row.scopeBindings = [{
      bindingKind: "track_specific_source",
      eligibility: "qualifying",
      scopeAxis: "genre",
      scopeValue: "house music",
      relationship: "represents house music",
      confidence: 0.95,
      sourceUrl: `https://example.com/house/${index}`,
      sourceRecordId: `source-house-${index}`,
      researchContainerId: null,
      citationAttestationId: `citation-house-${index}`,
      provenancePath: [{ kind: "provenance_root", id: `house-root-${index}` }],
      note: "Track-specific house evidence.",
    }];
    return row;
  });
  const editorialSongs: CatalogSong[] = Array.from({ length: 122 }, (_, index) => ({
    id: `apple-house-editorial-${index}`,
    name: `Editorial House Track ${index}`,
    artistName: `Editorial House Artist ${index}`,
    albumName: `Editorial House Release ${index}`,
    releaseDate: "1988-01-01",
    durationInMillis: 300_000 + index,
    isrc: `GBBBB88${String(index).padStart(5, "0")}`,
  }));
  const provider: CatalogDiscoveryProvider = {
    async search() {
      return {
        songs: [], artists: [], albums: [], playlists: [{
          id: "pl.house-production-handoff",
          name: "House Essentials",
          curatorName: "Apple Music Dance",
          description: "Foundational house music.",
          playlistType: "editorial",
          url: "https://music.apple.com/us/playlist/house-essentials/pl.house-production-handoff",
        }],
      };
    },
    async playlistTracks() { return { items: editorialSongs, next: null }; },
    async albumTracks() { return { items: [], next: null }; },
    async artistTopSongs() { return { items: [], next: null }; },
    async artistAlbums() { return { items: [], next: null }; },
    async similarArtists() { return { items: [], next: null }; },
  };
  const repository = new V2MemoryMatchingRepository(
    researchCandidates,
    productionBrief,
    new Map([["fast:route:fast_curated_v3", routeCheckpoint(confirmedAt)]]),
  );
  repository.selectionPlan = createSelectionPlanV2({
    prompt: "25 house music tracks",
    brief: productionBrief,
    storefront: "us",
  });
  for (let index = 0; index < 15; index += 1) {
    repository.matches.push({
      candidateId: `house-research-${index}`,
      status: "accepted",
      basis: "Previously resolved exact Apple identity",
      score: 100,
      song: {
        id: `apple-house-research-${index}`,
        name: `Research Track ${index}`,
        artistName: `Research Artist ${index}`,
        albumName: `Research Album ${index}`,
      },
      alternatives: [],
    });
  }
  const persist = repository.persistCatalogDiscoveredCandidates.bind(repository);
  const persistedChunkSizes: number[] = [];
  repository.persistCatalogDiscoveredCandidates = async (...args) => {
    persistedChunkSizes.push(args[1].length);
    const result = await persist(...args);
    // Model a production database handoff that consumes most of the route.
    // The second acknowledged chunk crosses the absolute deadline, but its
    // exact identities must still be durable before generic timeout handling.
    vi.setSystemTime(new Date(Date.now() + (persistedChunkSizes.length === 1 ? 30_000 : 70_000)));
    return result;
  };
  vi.setSystemTime(new Date(confirmedAt.getTime() + 26_000));
  vi.mocked(lookupAppleCatalogByIsrc).mockResolvedValue([]);
  vi.mocked(searchAppleCatalog).mockResolvedValue([]);

  await matchResearchRun(repository, "run-v2-production-handoff", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: provider,
    musicBrainzEnricher: async () => null,
  });

  expect(persistedChunkSizes).toEqual([10, 10]);
  expect(repository.persistedDiscoveries).toHaveLength(20);
  const acceptedEditorial = repository.matches.filter((match) => (
    match.status === "accepted" && match.song?.id.startsWith("apple-house-editorial-")
  ));
  expect(acceptedEditorial).toHaveLength(20);
  expect(repository.matches.filter((match) => match.status === "accepted")).toHaveLength(35);
  expect(repository.bulkTimeoutWrites.flatMap((write) => write.candidateIds))
    .not.toEqual(expect.arrayContaining(acceptedEditorial.map((match) => match.candidateId)));
  expect(repository.persistedDiscoveries.length).toBeLessThan(editorialSongs.length);
});

test("bulk timeout recheck never overwrites a concurrently stored exact Apple identity", async () => {
  const row = candidate("concurrent-exact", "editorial");
  const repository = fastRepository([row], new Date(Date.now() - 180_000));
  let reads = 0;
  repository.listMatches = async () => {
    reads += 1;
    return reads === 1 ? [] : [{
      candidateId: row.id,
      status: "accepted",
      basis: "Concurrent trusted Apple identity",
      score: 100,
      song,
      alternatives: [],
    }];
  };

  await matchResearchRun(repository, "run-concurrent-exact", "us", undefined, { fast: true });

  expect(reads).toBeGreaterThanOrEqual(2);
  expect(repository.bulkTimeoutWrites).toEqual([]);
});

test("V2 catalog growth does not turn genre playlist membership into influence evidence", async () => {
  const influenceBrief: PlaylistBrief = {
    title: "Influential house music",
    description: "Historically influential house recordings.",
    mode: "curated",
    subjectEntities: ["house music"],
    relationship: "influenced the development of house music",
    include: ["house music with documented historical influence"],
    exclude: [],
    versionPolicy: "studio recordings",
    evidencePolicy: "track-specific music-history sources",
    orderingPolicy: "historical influence",
    targetSize: { min: 1, max: 1 },
    ambiguities: [],
  };
  const playlistSong: CatalogSong = {
    id: "apple-house-playlist-only",
    name: "Unproven Influence",
    artistName: "Warehouse Unit",
    albumName: "House Collection",
    isrc: "USAAA8700998",
  };
  const provider: CatalogDiscoveryProvider = {
    async search() {
      return {
        songs: [], artists: [], albums: [], playlists: [{
          id: "pl.house-membership-only",
          name: "House Essentials",
          curatorName: "Apple Music Dance",
          description: "House music across the decades.",
          playlistType: "editorial",
          url: "https://music.apple.com/us/playlist/house-essentials/pl.house-membership-only",
        }],
      };
    },
    async playlistTracks() { return { items: [playlistSong], next: null }; },
    async albumTracks() { return { items: [], next: null }; },
    async artistTopSongs() { return { items: [], next: null }; },
    async artistAlbums() { return { items: [], next: null }; },
    async similarArtists() { return { items: [], next: null }; },
  };
  const repository = new V2MemoryMatchingRepository(
    [], influenceBrief, new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );
  repository.selectionPlan = createSelectionPlanV2({
    prompt: "One influential house music track",
    brief: influenceBrief,
    storefront: "us",
  });
  expect(repository.selectionPlan.intents).toEqual(expect.arrayContaining(["genre_scene", "editorial_ranking"]));

  await matchResearchRun(repository, "run-v2-no-influence-laundering", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: provider,
  });

  expect(repository.persistedDiscoveries).toHaveLength(0);
  expect(repository.matches).toHaveLength(0);
});

test("editorial scope matching uses phrase boundaries instead of substrings", () => {
  expect(musicScopePhraseMatches("House Essentials", "house")).toBe(true);
  expect(musicScopePhraseMatches("Warehouse Anthems", "house")).toBe(false);
  expect(musicScopePhraseMatches("Rock Essentials", "rock")).toBe(true);
  expect(musicScopePhraseMatches("Rockabilly Essentials", "rock")).toBe(false);
});

test("catalog deficit searches preserve composite geography and genre scope", () => {
  const compositeBrief: PlaylistBrief = {
    title: "American drill essentials",
    description: "American drill across documented regional scenes.",
    mode: "curated",
    subjectEntities: ["American drill"],
    relationship: "represents American drill",
    include: ["drill from the United States"],
    exclude: [],
    versionPolicy: "studio recordings",
    evidencePolicy: "trusted scoped editorial sources",
    orderingPolicy: "editorial rank",
    targetSize: { min: 50, max: 50 },
    ambiguities: [],
  };
  const selectionPlan = createSelectionPlanV2({
    prompt: "50 American drill tracks",
    brief: compositeBrief,
    storefront: "us",
  });

  expect(catalogDeficitQueries({ brief: compositeBrief, selectionPlan })).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/American drill/iu),
      expect.stringMatching(/American drill essentials/iu),
    ]),
  );
});

test("catalog deficit searches preserve Brazilian disco as a composite query", () => {
  const discoBrief: PlaylistBrief = {
    title: "Brazilian Disco Classics",
    description: "A source-backed survey of Brazilian disco.",
    mode: "curated",
    subjectEntities: ["Brazilian disco"],
    relationship: "represents Brazilian disco",
    include: ["Brazilian disco recordings"],
    exclude: [],
    versionPolicy: "canonical studio recordings",
    evidencePolicy: "trusted scoped editorial sources",
    orderingPolicy: "editorial rank",
    targetSize: { min: 50, max: 50 },
    ambiguities: [],
  };
  const selectionPlan = createSelectionPlanV2({
    prompt: "50 Brazilian disco songs",
    brief: discoBrief,
    storefront: "us",
  });

  expect(catalogDeficitQueries({ brief: discoBrief, selectionPlan })).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/Brazilian disco/iu),
      expect.stringMatching(/Brazilian disco essentials/iu),
    ]),
  );
});

test("catalog growth persists one qualifying binding for every hard French-jazz scope axis", async () => {
  const compositeBrief: PlaylistBrief = {
    title: "French jazz essentials",
    description: "A source-backed survey of jazz from France.",
    mode: "curated",
    subjectEntities: ["French jazz"],
    relationship: "represents French jazz",
    include: ["jazz from France"],
    exclude: [],
    versionPolicy: "studio recordings",
    evidencePolicy: "trusted scoped editorial sources",
    orderingPolicy: "editorial rank",
    targetSize: { min: 1, max: 1 },
    ambiguities: [],
  };
  const newSong: CatalogSong = {
    id: "apple-french-jazz-new",
    name: "Paris at Midnight",
    artistName: "Quartet Moderne",
    albumName: "Paris at Midnight",
    isrc: "FRAAA2600001",
  };
  const provider: CatalogDiscoveryProvider = {
    async search() {
      return {
        songs: [], artists: [], albums: [], playlists: [{
          id: "pl.french-jazz-editorial",
          name: "French Jazz Essentials",
          curatorName: "Apple Music Jazz",
          description: "Jazz from France and the Paris scene.",
          playlistType: "editorial",
          url: "https://music.apple.com/us/playlist/french-jazz-essentials/pl.french-jazz-editorial",
        }],
      };
    },
    async playlistTracks() { return { items: [newSong], next: null }; },
    async albumTracks() { return { items: [], next: null }; },
    async artistTopSongs() { return { items: [], next: null }; },
    async artistAlbums() { return { items: [], next: null }; },
    async similarArtists() { return { items: [], next: null }; },
  };
  const repository = new V2MemoryMatchingRepository(
    [], compositeBrief, new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );
  repository.selectionPlan = createSelectionPlanV2({
    prompt: "One French jazz recording",
    brief: compositeBrief,
    storefront: "us",
  });

  await matchResearchRun(repository, "run-v2-composite", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: provider,
  });

  expect(repository.persistedDiscoveries).toHaveLength(1);
  expect(repository.persistedDiscoveries[0]!.bindings.map((binding) => [binding.scopeAxis, binding.scopeValue]))
    .toEqual(expect.arrayContaining([
      ["genre", "jazz"],
      ["geography", "French"],
    ]));
  expect(repository.candidates[0]!.scopeBindings?.map((binding) => binding.scopeAxis))
    .toEqual(expect.arrayContaining(["genre", "geography"]));
});

test("a geography-labelled French Jazz playlist does not prove a French-language constraint", async () => {
  const languageBrief: PlaylistBrief = {
    title: "French-language jazz",
    description: "Jazz with lyrics sung in French.",
    mode: "curated",
    subjectEntities: ["French-language jazz"],
    relationship: "is sung in French",
    include: ["French-language jazz"],
    exclude: [],
    versionPolicy: "studio recordings",
    evidencePolicy: "trusted scoped editorial sources",
    orderingPolicy: "editorial rank",
    targetSize: { min: 1, max: 1 },
    ambiguities: [],
  };
  const provider: CatalogDiscoveryProvider = {
    async search() {
      return { songs: [], artists: [], albums: [], playlists: [{
        id: "pl.french-jazz-geography",
        name: "French Jazz Essentials",
        curatorName: "Apple Music Jazz",
        description: "Jazz from France.",
        playlistType: "editorial",
        url: "https://music.apple.com/us/playlist/french-jazz-essentials/pl.french-jazz-geography",
      }] };
    },
    async playlistTracks() { return { items: [song], next: null }; },
    async albumTracks() { return { items: [], next: null }; },
    async artistTopSongs() { return { items: [], next: null }; },
    async artistAlbums() { return { items: [], next: null }; },
    async similarArtists() { return { items: [], next: null }; },
  };
  const repository = new V2MemoryMatchingRepository(
    [], languageBrief, new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );
  repository.selectionPlan = createSelectionPlanV2({
    prompt: "French-language jazz",
    brief: languageBrief,
    storefront: "us",
  });
  await matchResearchRun(repository, "run-v2-language", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: provider,
  });
  expect(repository.persistedDiscoveries).toHaveLength(0);
});

test("V2 catalog checkpoints keep transient failures retryable and recovery resumes discovery", async () => {
  const retryCandidate = candidate("v2-retry", "editorial");
  retryCandidate.scopeBindings = [{
    bindingKind: "track_specific_source",
    eligibility: "qualifying",
    scopeAxis: "genre",
    scopeValue: "Test scene",
    relationship: "represents the scene",
    confidence: 0.95,
    sourceUrl: "https://example.com/retry",
    sourceRecordId: "source-retry",
    researchContainerId: null,
    citationAttestationId: "citation-retry",
    provenancePath: [{ kind: "provenance_root", id: "retry-source" }],
    note: "Retry fixture.",
  }];
  let degraded = true;
  const provider: CatalogDiscoveryProvider = {
    async search() {
      if (degraded) throw new Error("temporary catalog outage");
      return { songs: [song], artists: [], albums: [], playlists: [] };
    },
    async playlistTracks() { return { items: [], next: null }; },
    async albumTracks() { return { items: [], next: null }; },
    async artistTopSongs() { return { items: [], next: null }; },
    async artistAlbums() { return { items: [], next: null }; },
    async similarArtists() { return { items: [], next: null }; },
  };
  const retryBrief = sceneBrief(1);
  const repository = new V2MemoryMatchingRepository(
    [retryCandidate],
    retryBrief,
    new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );
  repository.selectionPlan = createSelectionPlanV2({ prompt: "Test scene", brief: retryBrief, storefront: "us" });
  vi.mocked(lookupAppleCatalogByIsrc).mockResolvedValue([]);
  vi.mocked(searchAppleCatalog).mockResolvedValue([]);

  await matchResearchRun(repository, "run-v2-retry", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: provider,
  });
  const first = repository.checkpointWrites.filter((write) => write.phase === "catalog_discovery_v2").at(-1)?.checkpoint;
  expect(first).toMatchObject({
    schemaVersion: 2,
    state: "terminal",
    complete: false,
    retryable: true,
    attempt: 1,
    retryAttempt: 1,
    stoppedBecause: "provider_degraded",
  });

  degraded = false;
  await matchResearchRun(repository, "run-v2-retry", "us", undefined, {
    retryIncomplete: true,
    catalogDiscoveryProvider: provider,
  });
  const second = repository.checkpointWrites.filter((write) => write.phase === "catalog_discovery_v2").at(-1)?.checkpoint;
  expect(second).toMatchObject({
    schemaVersion: 2,
    state: "terminal",
    complete: true,
    retryable: false,
    attempt: 2,
    retryAttempt: 2,
    resolvedCount: 1,
  });
  expect(repository.matches).toContainEqual(expect.objectContaining({
    candidateId: "v2-retry",
    status: "accepted",
    song: expect.objectContaining({ id: "apple-1" }),
  }));
});

test("V2 discovery reruns a completed frontier when later research adds an evidenced candidate", async () => {
  const first = candidate("v2-first", "editorial");
  first.scopeBindings = [{
    bindingKind: "track_specific_source", eligibility: "qualifying", scopeAxis: "scene",
    scopeValue: "Test scene", relationship: "represents the scene", confidence: 0.95,
    sourceUrl: "https://example.com/first", sourceRecordId: "source-first", researchContainerId: null,
    citationAttestationId: "citation-first", provenancePath: [{ kind: "provenance_root", id: "first-root" }], note: "First.",
  }];
  const second = { ...candidate("v2-later", "editorial"), title: "Later Track", isrc: "USAAA2000002" };
  second.scopeBindings = [{
    bindingKind: "track_specific_source", eligibility: "qualifying", scopeAxis: "scene",
    scopeValue: "Test scene", relationship: "represents the scene", confidence: 0.95,
    sourceUrl: "https://example.com/later", sourceRecordId: "source-later", researchContainerId: null,
    citationAttestationId: "citation-later", provenancePath: [{ kind: "provenance_root", id: "later-root" }], note: "Later.",
  }];
  const laterSong: CatalogSong = { ...song, id: "apple-later", name: "Later Track", isrc: "USAAA2000002" };
  const provider: CatalogDiscoveryProvider = {
    async search() { return { songs: [song, laterSong], artists: [], albums: [], playlists: [] }; },
    async playlistTracks() { return { items: [], next: null }; },
    async albumTracks() { return { items: [], next: null }; },
    async artistTopSongs() { return { items: [], next: null }; },
    async artistAlbums() { return { items: [], next: null }; },
    async similarArtists() { return { items: [], next: null }; },
  };
  const rerunBrief = sceneBrief(2);
  const repository = new V2MemoryMatchingRepository(
    [first], rerunBrief, new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );
  repository.selectionPlan = createSelectionPlanV2({ prompt: "Test scene", brief: rerunBrief, storefront: "us" });

  await matchResearchRun(repository, "run-v2-later", "us", undefined, { fast: true, catalogDiscoveryProvider: provider });
  repository.candidates.push(second);
  await matchResearchRun(repository, "run-v2-later", "us", undefined, { retryIncomplete: true, catalogDiscoveryProvider: provider });

  const discoveryWrites = repository.checkpointWrites.filter((write) => write.phase === "catalog_discovery_v2");
  const terminalWrites = discoveryWrites.filter((write) => (
    (write.checkpoint as { state?: string }).state === "terminal"
  ));
  expect(terminalWrites).toHaveLength(2);
  expect(terminalWrites[1]?.checkpoint).toMatchObject({ attempt: 2, resolvedCount: 1 });
  expect(repository.matches).toContainEqual(expect.objectContaining({ candidateId: "v2-later", status: "accepted" }));
});

test("V2 catalog discovery resumes the last durable page without consuming provider retry budget", async () => {
  const retryCandidate = candidate("v2-page-resume", "editorial");
  retryCandidate.scopeBindings = [{
    bindingKind: "track_specific_source", eligibility: "qualifying", scopeAxis: "scene",
    scopeValue: "Test scene", relationship: "represents the scene", confidence: 0.95,
    sourceUrl: "https://example.com/page-resume", sourceRecordId: "source-page-resume", researchContainerId: null,
    citationAttestationId: "citation-page-resume", provenancePath: [{ kind: "provenance_root", id: "page-resume-root" }],
    note: "Durable page resume fixture.",
  }];
  const searchRequests: string[] = [];
  const provider: CatalogDiscoveryProvider = {
    async search(_storefront, query, types, _limit, _signal, cursor) {
      searchRequests.push(JSON.stringify({ query, types, cursor: cursor ?? null }));
      return { songs: [song], artists: [], albums: [], playlists: [] };
    },
    async playlistTracks() { return { items: [], next: null }; },
    async albumTracks() { return { items: [], next: null }; },
    async artistTopSongs() { return { items: [], next: null }; },
    async artistAlbums() { return { items: [], next: null }; },
    async similarArtists() { return { items: [], next: null }; },
  };
  const resumeBrief = sceneBrief(1);
  const repository = new V2MemoryMatchingRepository(
    [retryCandidate], resumeBrief, new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );
  repository.selectionPlan = createSelectionPlanV2({ prompt: "Test scene", brief: resumeBrief, storefront: "us" });
  const durableSave = repository.saveResearchCheckpoint.bind(repository);
  let interruptAfterFirstDurablePage = true;
  repository.saveResearchCheckpoint = async (runId, phase, checkpoint) => {
    await durableSave(runId, phase, checkpoint);
    if (phase === "catalog_discovery_v2"
      && (checkpoint as { state?: string }).state === "running"
      && interruptAfterFirstDurablePage) {
      interruptAfterFirstDurablePage = false;
      const cancellation = new Error("worker lease revoked");
      cancellation.name = "AbortError";
      throw cancellation;
    }
  };

  await expect(matchResearchRun(repository, "run-v2-page-resume", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: provider,
  })).rejects.toThrow("worker lease revoked");
  const interrupted = repository.checkpointsByPhase.get("catalog_discovery_v2") as Record<string, unknown>;
  expect(interrupted).toMatchObject({
    schemaVersion: 2,
    state: "running",
    attempt: 1,
    retryAttempt: 1,
    progress: expect.objectContaining({ sequence: 1, providerCallCount: 1 }),
  });
  const runningWritesBeforeResume = repository.checkpointWrites.filter((write) => (
    write.phase === "catalog_discovery_v2"
      && (write.checkpoint as { state?: string }).state === "running"
  ));
  expect(runningWritesBeforeResume).toHaveLength(1);

  await matchResearchRun(repository, "run-v2-page-resume", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: provider,
  });

  const runningWrites = repository.checkpointWrites.filter((write) => (
    write.phase === "catalog_discovery_v2"
      && (write.checkpoint as { state?: string }).state === "running"
  ));
  expect(runningWrites[1]?.checkpoint).toMatchObject({
    attempt: 1,
    retryAttempt: 1,
    progress: expect.objectContaining({ sequence: 2, providerCallCount: 2 }),
  });
  const terminal = repository.checkpointsByPhase.get("catalog_discovery_v2") as Record<string, unknown>;
  expect(terminal).toMatchObject({
    schemaVersion: 2,
    state: "terminal",
    complete: true,
    attempt: 1,
    retryAttempt: 1,
    resolvedCount: 1,
  });
});

test("V2 catalog discovery safely restarts malformed running progress as the same attempt", async () => {
  const retryCandidate = candidate("v2-malformed-resume", "editorial");
  retryCandidate.scopeBindings = [{
    bindingKind: "track_specific_source", eligibility: "qualifying", scopeAxis: "scene",
    scopeValue: "Test scene", relationship: "represents the scene", confidence: 0.95,
    sourceUrl: "https://example.com/malformed-resume", sourceRecordId: "source-malformed-resume", researchContainerId: null,
    citationAttestationId: "citation-malformed-resume", provenancePath: [{ kind: "provenance_root", id: "malformed-root" }],
    note: "Malformed resume fixture.",
  }];
  const searchRequests: string[] = [];
  const provider: CatalogDiscoveryProvider = {
    async search(_storefront, query, types, _limit, _signal, cursor) {
      searchRequests.push(JSON.stringify({ query, types, cursor: cursor ?? null }));
      return { songs: [song], artists: [], albums: [], playlists: [] };
    },
    async playlistTracks() { return { items: [], next: null }; },
    async albumTracks() { return { items: [], next: null }; },
    async artistTopSongs() { return { items: [], next: null }; },
    async artistAlbums() { return { items: [], next: null }; },
    async similarArtists() { return { items: [], next: null }; },
  };
  const resumeBrief = sceneBrief(1);
  const repository = new V2MemoryMatchingRepository(
    [retryCandidate], resumeBrief, new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );
  repository.selectionPlan = createSelectionPlanV2({ prompt: "Test scene", brief: resumeBrief, storefront: "us" });
  const durableSave = repository.saveResearchCheckpoint.bind(repository);
  let interruptAfterFirstDurablePage = true;
  repository.saveResearchCheckpoint = async (runId, phase, checkpoint) => {
    await durableSave(runId, phase, checkpoint);
    if (phase === "catalog_discovery_v2"
      && (checkpoint as { state?: string }).state === "running"
      && interruptAfterFirstDurablePage) {
      interruptAfterFirstDurablePage = false;
      throw new Error("simulated process crash");
    }
  };
  await expect(matchResearchRun(repository, "run-v2-malformed-resume", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: provider,
  })).rejects.toThrow("simulated process crash");
  const running = repository.checkpointsByPhase.get("catalog_discovery_v2") as {
    progress: Record<string, unknown>;
  } & Record<string, unknown>;
  repository.checkpointsByPhase.set("catalog_discovery_v2", {
    ...running,
    progress: { ...running.progress, sequence: -1 },
  });
  const writesBeforeRestart = repository.checkpointWrites.length;

  await matchResearchRun(repository, "run-v2-malformed-resume", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: provider,
  });

  const restartedRunning = repository.checkpointWrites.slice(writesBeforeRestart).find((write) => (
    write.phase === "catalog_discovery_v2"
      && (write.checkpoint as { state?: string }).state === "running"
  ));
  expect(restartedRunning?.checkpoint).toMatchObject({
    attempt: 1,
    retryAttempt: 1,
    progress: expect.objectContaining({ sequence: 1, providerCallCount: 1 }),
  });
  expect(repository.checkpointsByPhase.get("catalog_discovery_v2")).toMatchObject({
    schemaVersion: 2,
    state: "terminal",
    complete: true,
    attempt: 1,
    retryAttempt: 1,
  });
});

test("V2 catalog discovery preserves completed legacy terminal checkpoint compatibility", async () => {
  const exactCandidate = candidate("v2-legacy-terminal", "editorial");
  exactCandidate.scopeBindings = [{
    bindingKind: "track_specific_source", eligibility: "qualifying", scopeAxis: "scene",
    scopeValue: "Test scene", relationship: "represents the scene", confidence: 0.95,
    sourceUrl: "https://example.com/legacy-terminal", sourceRecordId: "source-legacy-terminal", researchContainerId: null,
    citationAttestationId: "citation-legacy-terminal", provenancePath: [{ kind: "provenance_root", id: "legacy-root" }],
    note: "Legacy terminal fixture.",
  }];
  let searchCalls = 0;
  const provider: CatalogDiscoveryProvider = {
    async search() {
      searchCalls += 1;
      return { songs: [song], artists: [], albums: [], playlists: [] };
    },
    async playlistTracks() { return { items: [], next: null }; },
    async albumTracks() { return { items: [], next: null }; },
    async artistTopSongs() { return { items: [], next: null }; },
    async artistAlbums() { return { items: [], next: null }; },
    async similarArtists() { return { items: [], next: null }; },
  };
  const legacyBrief = sceneBrief(1);
  const repository = new V2MemoryMatchingRepository(
    [exactCandidate], legacyBrief, new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
  );
  repository.selectionPlan = createSelectionPlanV2({ prompt: "Test scene", brief: legacyBrief, storefront: "us" });
  await matchResearchRun(repository, "run-v2-legacy-terminal", "us", undefined, {
    fast: true,
    catalogDiscoveryProvider: provider,
  });
  const terminal = repository.checkpointsByPhase.get("catalog_discovery_v2") as Record<string, unknown>;
  const legacy = { ...terminal };
  delete legacy.schemaVersion;
  delete legacy.state;
  delete legacy.progress;
  repository.checkpointsByPhase.set("catalog_discovery_v2", legacy);
  const callsAfterFirstRun = searchCalls;

  await matchResearchRun(repository, "run-v2-legacy-terminal", "us", undefined, {
    retryIncomplete: true,
    catalogDiscoveryProvider: provider,
  });

  expect(searchCalls).toBe(callsAfterFirstRun);
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
    error: expect.stringContaining("1 safe unique catalog match for the required 4; 3 remain unresolved"),
  });
  expect(repository.checkpoints).toContainEqual(expect.objectContaining({
    storefront: "us",
    targetMinimum: 4,
    safePrimaryCount: 1,
    shortfall: 3,
    status: "shortfall",
  }));
});

test("One Command publishes the maximum strict matches after bounded shortfall recovery", async () => {
  const exactBrief = { ...brief, targetSize: { min: 2, max: 2 } };
  const repository = new MemoryMatchingRepository([], exactBrief, new Map(), undefined, true);
  repository.matches.push({
    candidateId: "candidate-1",
    status: "accepted",
    basis: "exact",
    score: 1,
    song,
    alternatives: [],
  });

  await matchResearchRun(repository, "run-1", "us");

  expect(repository.updates.at(-1)).toMatchObject({
    status: "visitor_review",
    phase: "exception_review",
    error: null,
  });
  expect(repository.automaticRecoveries).toEqual([{
    runId: "run-1",
    storefront: "us",
    currentGeneration: 0,
    currentRefillGeneration: 0,
  }]);
  expect(repository.automaticPublications).toEqual(["run-1"]);
});

test("One Command queues bounded Apple recovery before terminalizing a retryable shortfall", async () => {
  const exactBrief = { ...brief, targetSize: { min: 2, max: 2 } };
  const repository = new MemoryMatchingRepository([], exactBrief, new Map(), undefined, true);
  repository.automaticRecoveryState = "queued";
  repository.matches.push(
    {
      candidateId: "candidate-1",
      status: "accepted",
      basis: "exact",
      score: 1,
      song,
      alternatives: [],
    },
    {
      candidateId: "candidate-2",
      status: "review",
      basis: RETRYABLE_CATALOG_MATCH_BASES[0],
      score: 0,
      song: null,
      alternatives: [],
    },
  );

  await matchResearchRun(repository, "run-1", "us", undefined, {
    retryIncomplete: true,
    recoveryGeneration: 1,
  });

  expect(repository.automaticRecoveries).toEqual([{
    runId: "run-1",
    storefront: "us",
    currentGeneration: 1,
    currentRefillGeneration: 0,
  }]);
  expect(repository.updates).not.toContainEqual(expect.objectContaining({ status: "failed" }));
  expect(repository.automaticPublications).toEqual([]);
  expect(repository.pipelineOutcomes).toEqual([]);
});

test("One Command counts only strict unique Apple matches toward an exact target", async () => {
  const exactBrief = { ...brief, targetSize: { min: 2, max: 2 } };
  const repository = new MemoryMatchingRepository([], exactBrief, new Map(), undefined, true);
  repository.matches.push(
    {
      candidateId: "candidate-1",
      status: "accepted",
      basis: "exact",
      score: 1,
      song,
      alternatives: [],
    },
    {
      candidateId: "candidate-2",
      status: "review",
      basis: "visitor choice required",
      score: 0.8,
      song,
      alternatives: [],
    },
  );

  await matchResearchRun(repository, "run-1", "us");

  expect(repository.updates.at(-1)).toMatchObject({
    status: "visitor_review",
    phase: "exception_review",
    error: null,
  });
  expect(repository.checkpoints).toContainEqual(expect.objectContaining({
    safePrimaryCount: 1,
    shortfall: 1,
  }));
  expect(repository.automaticPublications).toEqual(["run-1"]);
});

test("One Command records a zero-match shortfall as partial instead of failed", async () => {
  const exactBrief = { ...brief, targetSize: { min: 2, max: 2 } };
  const repository = new MemoryMatchingRepository([], exactBrief, new Map(), undefined, true);

  await matchResearchRun(repository, "run-1", "us");

  expect(repository.updates.at(-1)).toMatchObject({
    status: "partial",
    phase: "catalog_matching_empty",
    error: null,
  });
  expect(repository.automaticPublications).toEqual([]);
  expect(repository.pipelineOutcomes).toEqual([expect.objectContaining({
    status: "no_compatible_tracks",
    targetTrackCount: 2,
    publishedTrackCount: 0,
    exactCountSatisfied: false,
    reasonCodes: ["catalog_recovery_exhausted_without_compatible_tracks"],
  })]);
});

test("One Command matching durably hands a satisfied run to automatic publication", async () => {
  const exactTargetBrief = { ...curatedBrief, targetSize: { min: 1, max: 1 } };
  const repository = new MemoryMatchingRepository(
    [candidate("automatic", "verified")],
    exactTargetBrief,
    new Map([["fast:route:fast_curated_v3", routeCheckpoint()]]),
    undefined,
    true,
  );

  await matchResearchRun(repository, "run", "us", undefined, { fast: true });

  expect(repository.updates.at(-1)).toMatchObject({ status: "visitor_review", phase: "exception_review" });
  expect(repository.automaticPublications).toEqual(["run"]);
});

test.each(["publishing", "waiting_for_apple_authorization", "complete", "partial"])(
  "a replayed One Command matching lease never regresses a %s run",
  async (status) => {
    const repository = new MemoryMatchingRepository(
      [candidate("already-handed-off", "verified")],
      { ...curatedBrief, targetSize: { min: 1, max: 1 } },
      new Map(),
      undefined,
      true,
      status,
    );

    await matchResearchRun(repository, "run", "us");

    expect(repository.updates).toEqual([]);
    expect(repository.automaticPublications).toEqual([]);
    expect(lookupAppleCatalogByIsrc).not.toHaveBeenCalled();
  },
);

test("a replayed One Command matching lease resumes a locked manifest without regressing state", async () => {
  const repository = new MemoryMatchingRepository(
    [],
    { ...curatedBrief, targetSize: { min: 1, max: 1 } },
    new Map(),
    undefined,
    true,
    "manifest_ready",
  );

  await matchResearchRun(repository, "run", "us");

  expect(repository.updates).toEqual([]);
  expect(repository.automaticPublications).toEqual(["run"]);
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

test("fast matching isolates a candidate-specific Apple 400 and continues", async () => {
  const error = new AppleApiError("Invalid catalog request", 400, false);
  vi.mocked(lookupAppleCatalogByIsrc).mockRejectedValueOnce(error);
  const repository = fastRepository([candidate("non-transient", "verified")]);

  await expect(matchResearchRun(repository, "run", "us", undefined, { fast: true })).resolves.toBeUndefined();
  expect(repository.matches).toEqual([
    expect.objectContaining({ candidateId: "non-transient", status: "unavailable", song: null }),
  ]);
});

test("fast matching still propagates a non-Apple mapper failure", async () => {
  const error = new Error("catalog response mapper crashed");
  vi.mocked(lookupAppleCatalogByIsrc).mockRejectedValueOnce(error);
  const repository = fastRepository([candidate("mapper-error", "verified")]);

  await expect(matchResearchRun(repository, "run", "us", undefined, { fast: true })).rejects.toBe(error);
  expect(repository.matches).toHaveLength(0);
});
