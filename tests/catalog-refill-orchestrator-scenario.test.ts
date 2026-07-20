import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  CatalogMatchResult,
  CatalogSong,
  EvidenceClaimInput,
  PlaylistBrief,
  SourceFrontierItem,
  SourceRecordInput,
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

import { lookupAppleCatalogByIsrc, searchAppleCatalog } from "../server/apple.ts";
import { processMatchingJob } from "../server/matching-service.ts";
import { ProviderRequestError } from "../server/openai.ts";
import {
  ResearchOrchestrator,
  type HostedCitationAttestation,
  type ResearchPhase,
} from "../server/research.ts";
import {
  createFastPostMatchRefillRouteCheckpoint,
  createFastRouteCheckpoint,
  FAST_POST_MATCH_REFILL_LIMIT,
  researchExecutionPolicy,
} from "../server/research-policy.ts";
import { HttpError } from "../server/security.ts";

const RUN_ID = "rio-exact-50-regression";

const brief: PlaylistBrief = {
  title: "Rio de Janeiro songs",
  description: "50 source-backed songs about Rio de Janeiro.",
  mode: "curated",
  subjectEntities: ["Rio de Janeiro songs"],
  relationship: "is editorially relevant to",
  include: [],
  exclude: [],
  versionPolicy: "one canonical studio recording",
  evidencePolicy: "cited editorial sources",
  orderingPolicy: "editorial",
  targetSize: { min: 50, max: 50 },
  ambiguities: [],
};

type Candidate = TrackCandidateInput & {
  id: string;
  evidence: EvidenceClaimInput[];
  duplicateClusterKey?: string | null;
};

type Job = {
  kind: string;
  runId?: string | null;
  payload: Record<string, unknown>;
  dedupeKey?: string;
};

function initialCandidate(index: number): Candidate {
  const ordinal = index + 1;
  const title = `Existing Rio Track ${String(ordinal).padStart(2, "0")}`;
  return {
    id: `existing-${String(ordinal).padStart(2, "0")}`,
    selectionRank: ordinal,
    artist: `Existing Rio Artist ${String(ordinal).padStart(2, "0")}`,
    title,
    album: null,
    releaseYear: null,
    durationMs: null,
    isrc: null,
    musicbrainzId: null,
    versionLabel: null,
    duplicateClusterKey: null,
    evidence: [{
      sourceUrl: `https://history.example/rio/existing-${ordinal}`,
      state: "editorial",
      supportScope: "editorial",
      subjectEntity: brief.subjectEntities[0]!,
      subjectRelationship: brief.relationship,
      relationship: brief.relationship,
      note: `${title} appears in a cited Rio music-history source.`,
      sourceClass: "web",
      citationSupport: {
        responseId: `existing-response-${ordinal}`,
        outputItemId: `existing-message-${ordinal}`,
        contentIndex: 0,
        startIndex: 0,
        endIndex: 80,
        excerpt: `${brief.subjectEntities[0]} ${brief.relationship} ${title}.`,
      },
    }],
  };
}

function acceptedSong(candidate: Candidate): CatalogSong {
  return {
    id: `apple-${candidate.id}`,
    name: candidate.title,
    artistName: candidate.artist,
    albumName: "Rio fixture",
    releaseDate: "2026-01-01",
    durationInMillis: 180_000,
    isrc: `USRIO26${candidate.id.replace(/\D/gu, "").padStart(5, "0").slice(-5)}`,
  };
}

function initialMatches(candidates: Candidate[]): CatalogMatchResult[] {
  return candidates.map((candidate, index) => index < 42
    ? {
        candidateId: candidate.id,
        status: "accepted",
        basis: "strict identifier match from the initial pass",
        score: 1,
        song: acceptedSong(candidate),
        alternatives: [],
      }
    : {
        candidateId: candidate.id,
        status: "review",
        basis: "No strict Apple version match",
        score: 0,
        song: null,
        alternatives: [],
      });
}

class PipelineRepository {
  readonly checkpoints = new Map<string, unknown>();
  readonly jobs: Job[] = [];
  readonly candidates = Array.from({ length: 88 }, (_, index) => initialCandidate(index));
  readonly matches = initialMatches(this.candidates);
  readonly updates: Array<Record<string, unknown>> = [];
  readonly publicationHandoffs: string[] = [];
  readonly candidateRefillRequests: Array<{
    storefront: string;
    additionalCandidateGoal: number;
    currentRefillGeneration: number;
  }> = [];
  readonly citations: HostedCitationAttestation[] = [];
  readonly frontier: SourceFrontierItem[] = [];
  readonly sources: SourceRecordInput[] = [];
  readonly run = {
    id: RUN_ID,
    brief,
    guidanceSourceHints: [],
    guidancePreferences: [],
    status: "matching",
    phase: "catalog_matching",
    error: null as string | null,
    autoPublish: true,
    createdAt: new Date().toISOString(),
    actualCostUsd: 0,
    approvedBudgetUsd: 5,
    noNewGapPasses: 0,
  };

  constructor() {
    const policy = researchExecutionPolicy(brief, {});
    if (policy.kind !== "fast_curated") throw new Error("Scenario requires the fast curated policy");
    this.checkpoints.set(`fast:route:${policy.version}`, createFastRouteCheckpoint(policy, new Date()));
  }

  takeJob(kind: string): Job {
    const index = this.jobs.findIndex((job) => job.kind === kind);
    if (index < 0) throw new Error(`Expected queued ${kind} job`);
    return this.jobs.splice(index, 1)[0]!;
  }

  async getBriefRequest() { return null; }
  async saveBriefResult() {}
  async getRun() { return structuredClone(this.run); }
  async updateRun(_runId: string, patch: Record<string, unknown>) {
    Object.assign(this.run, patch);
    this.updates.push(structuredClone(patch));
  }
  async getCoverage() {
    return {
      candidateCount: this.candidates.length,
      eligibleCandidateCount: this.candidates.length,
      sourceCount: this.sources.length,
      unresolvedCount: 0,
      existingKeys: this.candidates.map((candidate) => `${candidate.artist}\u0000${candidate.title}`),
      frontier: structuredClone(this.frontier),
      containers: [],
    };
  }
  async addSources(_runId: string, sources: SourceRecordInput[]) {
    this.sources.push(...structuredClone(sources));
    return new Map(sources.map((source, index) => [source.url, `source-${this.sources.length + index}`]));
  }
  async addCitationAttestations(_runId: string, attestations: readonly HostedCitationAttestation[]) {
    this.citations.push(...structuredClone(attestations));
  }
  async addCandidates(
    _runId: string,
    candidates: TrackCandidateInput[],
    sourceIds: Map<string, string>,
    verificationPhase: ResearchPhase,
  ) {
    void sourceIds;
    void verificationPhase;
    let added = 0;
    const existing = new Set(this.candidates.map((candidate) => (
      `${candidate.artist.toLocaleLowerCase()}\u0000${candidate.title.toLocaleLowerCase()}`
    )));
    for (const candidate of candidates) {
      const key = `${candidate.artist.toLocaleLowerCase()}\u0000${candidate.title.toLocaleLowerCase()}`;
      if (existing.has(key)) continue;
      existing.add(key);
      this.candidates.push({
        ...structuredClone(candidate),
        id: `refill-${String(this.candidates.length - 87).padStart(2, "0")}`,
        duplicateClusterKey: null,
      });
      added += 1;
    }
    return added;
  }
  async listCandidates() { return structuredClone(this.candidates); }
  async upsertFrontier(_runId: string, items: SourceFrontierItem[]) {
    this.frontier.push(...structuredClone(items));
  }
  async upsertResearchContainers() {}
  async listResearchContainers() { return []; }
  async getResearchCheckpoint(_runId: string, key: string) {
    const value = this.checkpoints.get(key);
    return value === undefined ? null : structuredClone(value);
  }
  async saveResearchCheckpoint(_runId: string, key: string, checkpoint: unknown) {
    this.checkpoints.set(key, structuredClone(checkpoint));
  }
  async enqueueJob(input: {
    kind: string;
    runId?: string | null;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
  }) {
    if (input.dedupeKey && this.jobs.some((job) => job.kind === input.kind && job.dedupeKey === input.dedupeKey)) {
      return null;
    }
    this.jobs.push({
      kind: input.kind,
      runId: input.runId,
      payload: structuredClone(input.payload ?? {}),
      dedupeKey: input.dedupeKey,
    });
    return input;
  }
  async reserveProviderCost() { return { reservationId: "unused-scripted-provider" }; }
  async reconcileProviderCost() {}
  async releaseProviderCost() {}

  async listMatches() { return structuredClone(this.matches); }
  async saveMatch(_runId: string, match: CatalogMatchResult) {
    const index = this.matches.findIndex((existing) => existing.candidateId === match.candidateId);
    if (index >= 0) this.matches[index] = structuredClone(match);
    else this.matches.push(structuredClone(match));
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
  async queueAutomaticCatalogRecovery() { return "not_needed" as const; }
  async queueAutomaticCandidateRefill(
    _runId: string,
    storefront: string,
    additionalCandidateGoal: number,
    currentRefillGeneration: number,
  ) {
    this.candidateRefillRequests.push({ storefront, additionalCandidateGoal, currentRefillGeneration });
    if (currentRefillGeneration >= FAST_POST_MATCH_REFILL_LIMIT) return "exhausted" as const;
    const generation = currentRefillGeneration + 1;
    if (this.jobs.some((job) => job.dedupeKey === `research-refill:${RUN_ID}:${generation}`)) {
      return "in_flight" as const;
    }
    const route = createFastPostMatchRefillRouteCheckpoint(
      generation,
      additionalCandidateGoal,
      storefront,
      new Date(),
      {},
      { eligibleCount: this.candidates.length, selectionRank: this.candidates.length },
    );
    this.checkpoints.set(`fast:post-match-refill:${generation}:route`, route);
    await this.enqueueJob({
      kind: "research",
      runId: RUN_ID,
      dedupeKey: `research-refill:${RUN_ID}:${generation}`,
      payload: {
        runId: RUN_ID,
        fast: true,
        postMatchRefill: true,
        refillGeneration: generation,
        additionalCandidateGoal: route.additionalCandidateGoal,
        storefront: route.storefront,
        refillConfirmedAt: route.confirmedAt,
        refillResearchDeadlineAt: route.researchDeadlineAt,
        refillDeadlineAt: route.deadlineAt,
      },
    });
    await this.updateRun(RUN_ID, {
      status: "researching",
      phase: "catalog_refill_research",
      error: null,
    });
    return "queued" as const;
  }
  async queueAutomaticPublication(runId: string) {
    this.publicationHandoffs.push(runId);
  }
}

class RowRejectingPipelineRepository extends PipelineRepository {
  override async addCandidates(
    runId: string,
    candidates: TrackCandidateInput[],
    sourceIds: Map<string, string>,
    verificationPhase: ResearchPhase,
  ) {
    if (candidates.some((candidate) => candidate.title === "Refill Track 03")) {
      throw new HttpError(
        400,
        "Fixture rejects one locally invalid candidate row",
        "evidence_subject_mismatch",
      );
    }
    return super.addCandidates(runId, candidates, sourceIds, verificationPhase);
  }
}

class ScriptedRefillOrchestrator extends ResearchOrchestrator {
  readonly calls: Array<{ operation: string; body: Record<string, unknown> }> = [];

  constructor(repository: PipelineRepository, private readonly responses: Array<unknown | Error>) {
    super(repository as never);
  }

  protected override async callModel(
    _runId: string,
    operation: string,
    _idempotencyKey: string,
    body: Record<string, unknown>,
  ) {
    this.calls.push({ operation, body: structuredClone(body) });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Scripted refill provider response was exhausted");
    return structuredClone(response);
  }
}

function refillProviderResponse(count = 8, searchCalls = 2) {
  const pairs = Array.from({ length: count }, (_, index) => (
    `Refill Artist ${String(index + 1).padStart(2, "0")} — Refill Track ${String(index + 1).padStart(2, "0")}`
  ));
  const containers = Array.from({ length: count }, (_, index) => (
    `Refill Artist ${String(index + 1).padStart(2, "0")} — Rio music-history fixture`
  ));
  const evidenceLine = `EVIDENCE GROUP | SUBJECT: ${brief.subjectEntities[0]} | RELATIONSHIP: ${brief.relationship} | TRACKS: ${pairs.join("; ")} | CONTAINERS: ${containers.join("; ")}`;
  // Responses renders the citation annotation as trailing Markdown inside the
  // attested evidence excerpt. It must not become part of the last album name.
  const marker = "([Rio source](https://history.example/rio/catalog-ready-refill))";
  const text = `${evidenceLine} ${marker}`;
  return {
    id: "refill-provider-response",
    model: "gpt-5.6-luna",
    usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 },
    output: [
      ...Array.from({ length: searchCalls }, (_, index) => ({
        type: "web_search_call",
        action: { type: "search", query: `catalog-ready Rio songs pass ${index + 1}` },
      })),
      {
        type: "web_search_call",
        action: { type: "open_page", url: "https://history.example/rio/catalog-ready-refill" },
      },
      {
        id: "refill-provider-message",
        type: "message",
        content: [{
          type: "output_text",
          text,
          annotations: [{
            type: "url_citation",
            url: "https://history.example/rio/catalog-ready-refill",
            title: "Rio music history",
            start_index: evidenceLine.length + 1,
            end_index: text.length,
          }],
        }],
      },
    ],
  };
}

function catalogSongFromQuery(query: string): CatalogSong[] {
  const track = query.match(/Refill Track (\d{2})/u)?.[1];
  const artist = query.match(/Refill Artist (\d{2})/u)?.[1];
  if (!track || artist !== track) return [];
  return [{
    id: `apple-refill-${track}`,
    name: `Refill Track ${track}`,
    artistName: `Refill Artist ${track}`,
    albumName: "Rio music-history fixture",
    releaseDate: "2026-01-01",
    durationInMillis: 180_000,
    // Refill tracks are distinct recordings from the initial fixture pool.
    // Reusing the initial ISRC namespace would correctly collapse them into
    // the same recording families and suppress an exact-fill handoff.
    isrc: `USNEW26000${track}`,
  }];
}

async function runInitialMatching(repository: PipelineRepository) {
  const policy = researchExecutionPolicy(brief, {});
  if (policy.kind !== "fast_curated") throw new Error("Scenario requires the fast curated policy");
  const route = repository.checkpoints.get(`fast:route:${policy.version}`) as ReturnType<typeof createFastRouteCheckpoint>;
  await processMatchingJob(repository, {
    runId: RUN_ID,
    storefront: "us",
    fast: true,
    fastConfirmedAt: route.confirmedAt,
    fastResearchDeadlineAt: route.researchDeadlineAt,
    fastDeadlineAt: route.deadlineAt,
  });
}

beforeEach(() => {
  vi.mocked(lookupAppleCatalogByIsrc).mockReset().mockResolvedValue([]);
  vi.mocked(searchAppleCatalog).mockReset().mockImplementation(async (_storefront, query) => (
    catalogSongFromQuery(query)
  ));
});

describe("catalog shortfall -> evidence refill -> exact publication scenario", () => {
  test("allows the same three hosted searches requested by the refill contract", async () => {
    const repository = new PipelineRepository();
    const orchestrator = new ScriptedRefillOrchestrator(repository, [refillProviderResponse(8, 3)]);

    await runInitialMatching(repository);
    const researchJob = repository.takeJob("research");
    await orchestrator.processJob(researchJob.payload);

    expect(orchestrator.calls[0]?.body).toMatchObject({
      max_tool_calls: 3,
      max_output_tokens: 3_000,
    });
    expect(repository.checkpoints.get("fast:post-match-refill:1:complete")).toMatchObject({
      status: "complete",
      hostedWebSearchCalls: 3,
      newlyAdded: 8,
    });
  });

  test("labels an over-limit completed response as a local contract error", async () => {
    const repository = new PipelineRepository();
    const orchestrator = new ScriptedRefillOrchestrator(repository, [refillProviderResponse(8, 4)]);

    await runInitialMatching(repository);
    const researchJob = repository.takeJob("research");
    await orchestrator.processJob(researchJob.payload);

    expect(repository.checkpoints.get("fast:post-match-refill:1:complete")).toMatchObject({
      status: "contract_error",
      newlyAdded: 0,
      contractError: true,
      contractCode: "hosted_search_limit",
    });
    expect(repository.checkpoints.get("fast:post-match-refill:1:complete"))
      .not.toMatchObject({ providerError: true });
  });

  test("isolates one locally invalid candidate row and persists its valid siblings", async () => {
    const repository = new RowRejectingPipelineRepository();
    const orchestrator = new ScriptedRefillOrchestrator(repository, [refillProviderResponse(8, 3)]);

    await runInitialMatching(repository);
    const researchJob = repository.takeJob("research");
    await orchestrator.processJob(researchJob.payload);

    expect(repository.checkpoints.get("fast:post-match-refill:1:complete")).toMatchObject({
      status: "complete",
      newlyAdded: 7,
      persistenceRejectedCandidateCount: 1,
      rejectedCandidateCount: 1,
    });
    expect(repository.candidates.some((candidate) => candidate.title === "Refill Track 02")).toBe(true);
    expect(repository.candidates.some((candidate) => candidate.title === "Refill Track 03")).toBe(false);
    expect(repository.candidates.some((candidate) => candidate.title === "Refill Track 04")).toBe(true);
  });

  test("a diversity-deficit route tells cited refill research which accepted artists to move beyond", async () => {
    const repository = new PipelineRepository();
    const representedArtists = [
      "Django Reinhardt",
      "Michel Petrucciani",
      "Stéphane Grappelli",
      "Martial Solal",
    ];
    const route = createFastPostMatchRefillRouteCheckpoint(
      1,
      19,
      "us",
      new Date(),
      {},
      {
        eligibleCount: 25,
        selectionRank: 44,
        diversityTarget: 10,
        representedArtists,
      },
    );
    repository.checkpoints.set("fast:post-match-refill:1:route", route);
    const orchestrator = new ScriptedRefillOrchestrator(repository, [refillProviderResponse(8)]);

    await orchestrator.processJob({
      runId: RUN_ID,
      fast: true,
      postMatchRefill: true,
      refillGeneration: 1,
      additionalCandidateGoal: route.additionalCandidateGoal,
      storefront: route.storefront,
      refillConfirmedAt: route.confirmedAt,
      refillResearchDeadlineAt: route.researchDeadlineAt,
      refillDeadlineAt: route.deadlineAt,
    });

    expect(orchestrator.calls).toHaveLength(1);
    expect(String(orchestrator.calls[0]!.body.instructions)).toContain(
      "Recover cited tracks by at least 6 additional credited recording artists",
    );
    const providerInput = JSON.parse(String(orchestrator.calls[0]!.body.input));
    expect(providerInput).toMatchObject({
      diversityTarget: 10,
      representedArtists,
      additionalDistinctArtistGoal: 6,
    });
    expect(repository.checkpoints.get("fast:post-match-refill:1:complete")).toMatchObject({
      diversityTarget: 10,
      representedArtistCount: 4,
      additionalDistinctArtistGoal: 6,
    });
  });

  test("recovers the observed 42-of-50 shortfall and hands exactly 50 strict matches to publication", async () => {
    const repository = new PipelineRepository();
    const orchestrator = new ScriptedRefillOrchestrator(repository, [refillProviderResponse(8)]);

    await runInitialMatching(repository);

    expect(repository.candidateRefillRequests).toEqual([{
      storefront: "us",
      additionalCandidateGoal: 34,
      currentRefillGeneration: 0,
    }]);
    expect(repository.run).toMatchObject({ status: "researching", phase: "catalog_refill_research", error: null });

    const researchJob = repository.takeJob("research");
    await orchestrator.processJob(researchJob.payload);

    expect(orchestrator.calls).toHaveLength(1);
    expect(orchestrator.calls[0]).toMatchObject({ operation: "research.fast.post_match_refill" });
    expect(String(orchestrator.calls[0]!.body.instructions)).toContain(
      "CONTAINERS: <credited recording artist — release title; ... or NONE>",
    );
    expect(String(orchestrator.calls[0]!.body.instructions)).toContain(
      "Use 3–5 unique TRACKS per line",
    );
    expect(String(orchestrator.calls[0]!.body.instructions)).toContain(
      "keep each complete line under 1,200 characters",
    );
    const providerInput = JSON.parse(String(orchestrator.calls[0]!.body.input));
    expect(providerInput.excludedPairs).toHaveLength(88);
    expect(providerInput.excludedPairs[0]).toContain("Existing Rio Artist");
    expect(repository.candidates).toHaveLength(96);
    expect(repository.candidates.slice(-8).map((candidate) => candidate.album))
      .toEqual(Array.from({ length: 8 }, () => "Rio music-history fixture"));
    expect(repository.checkpoints.get("fast:post-match-refill:1:complete")).toMatchObject({
      status: "complete",
      newlyAdded: 8,
      novelCandidateCount: 8,
      hostedWebSearchCalls: 2,
    });

    const refillMatchingJob = repository.takeJob("matching");
    await processMatchingJob(repository, refillMatchingJob.payload);

    const accepted = repository.matches.filter((match) => match.status === "accepted" && match.song?.id);
    expect(new Set(accepted.map((match) => match.song!.id))).toHaveLength(50);
    expect(repository.matches).toHaveLength(96);
    expect(repository.publicationHandoffs).toEqual([RUN_ID]);
    expect(repository.run).toMatchObject({ status: "visitor_review", phase: "exception_review", error: null });
    expect(repository.updates).not.toContainEqual(expect.objectContaining({ status: "failed" }));

    expect(lookupAppleCatalogByIsrc).not.toHaveBeenCalled();
    expect(searchAppleCatalog).toHaveBeenCalledTimes(8);
    expect(vi.mocked(searchAppleCatalog).mock.calls.every(([, query]) => query.includes("Refill"))).toBe(true);
  });

  test("bounded provider failures publish the maximum strict matches as partial", async () => {
    const repository = new PipelineRepository();
    const orchestrator = new ScriptedRefillOrchestrator(
      repository,
      Array.from({ length: FAST_POST_MATCH_REFILL_LIMIT }, () => (
        new ProviderRequestError(
          "fixture provider transport failure",
          "openai",
          503,
          true,
        )
      )),
    );

    await runInitialMatching(repository);
    for (let generation = 1; generation <= FAST_POST_MATCH_REFILL_LIMIT; generation += 1) {
      const researchJob = repository.takeJob("research");
      await orchestrator.processJob(researchJob.payload);
      expect(repository.checkpoints.get(`fast:post-match-refill:${generation}:complete`)).toMatchObject({
        status: "provider_error",
        newlyAdded: 0,
        providerError: true,
      });

      const matchingJob = repository.takeJob("matching");
      await processMatchingJob(repository, matchingJob.payload);
    }

    expect(repository.candidateRefillRequests.map((request) => request.currentRefillGeneration))
      .toEqual(Array.from({ length: FAST_POST_MATCH_REFILL_LIMIT }, (_, index) => index));
    expect(repository.publicationHandoffs).toEqual([]);
    expect(repository.run).toMatchObject({
      status: "partial_ready",
      phase: "partial_confirmation_required",
      error: null,
    });
    expect(repository.run.error).toBeNull();
    expect(repository.updates.some((patch) => patch.phase === "research_failed")).toBe(false);
    expect(searchAppleCatalog).not.toHaveBeenCalled();
  });

  test("worker cancellation aborts refill research without checkpointing a degraded handoff", async () => {
    const repository = new PipelineRepository();
    await runInitialMatching(repository);
    const researchJob = repository.takeJob("research");
    const orchestrator = new ScriptedRefillOrchestrator(repository, [refillProviderResponse(8)]);
    const controller = new AbortController();
    controller.abort(new DOMException("worker lease cancelled", "AbortError"));

    await expect(orchestrator.processJob(researchJob.payload, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(orchestrator.calls).toHaveLength(0);
    expect(repository.checkpoints.has("fast:post-match-refill:1:complete")).toBe(false);
    expect(repository.jobs.some((job) => job.kind === "matching")).toBe(false);
    expect(repository.updates.some((patch) => patch.phase === "research_failed")).toBe(false);
  });

  test("a retry replays a committed refill checkpoint into one matching handoff without another model call", async () => {
    const repository = new PipelineRepository();
    await runInitialMatching(repository);
    const researchJob = repository.takeJob("research");
    const generation = Number(researchJob.payload.refillGeneration);
    repository.checkpoints.set(`fast:post-match-refill:${generation}:complete`, {
      status: "complete",
      newlyAdded: 8,
      completedAt: new Date().toISOString(),
    });
    const orchestrator = new ScriptedRefillOrchestrator(repository, []);

    // Simulate a worker crash after the durable completion checkpoint commit
    // but before matching enqueue, followed by two delivery attempts. The
    // checkpoint must skip the provider and the matching dedupe must keep one
    // handoff.
    await orchestrator.processJob(researchJob.payload);
    await orchestrator.processJob(researchJob.payload);

    expect(orchestrator.calls).toHaveLength(0);
    expect(repository.jobs.filter((job) => job.kind === "matching")).toEqual([
      expect.objectContaining({
        dedupeKey: `matching-refill:${RUN_ID}:${generation}`,
        payload: expect.objectContaining({ refillGeneration: generation }),
      }),
    ]);
    expect(repository.run).toMatchObject({
      status: "ready_for_matching",
      phase: "catalog_refill_research_complete",
      error: null,
    });
  });
});
