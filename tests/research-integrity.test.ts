import { afterEach, describe, expect, test, vi } from "vitest";
import {
  adapterContainerInputs,
  BudgetPause,
  maximumOpenAICallCostUsd,
  ResearchOrchestrator,
  researchCompletionReadiness,
  researchGapPassLimit,
  researchSegmentLimit,
  researchTurnsPerSegment,
  responseContextTokenCount,
  validateCandidateBatch,
  validateContainerBatch,
  type AdapterLedgerEntry,
} from "../server/research.ts";
import type { PlaylistBrief, SourceAdapterResult } from "../shared/types.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

function brief(mode: PlaylistBrief["mode"], targetSize: PlaylistBrief["targetSize"]): PlaylistBrief {
  return {
    title: "Integrity fixture",
    description: "A deterministic research-integrity fixture.",
    mode,
    subjectEntities: ["Test Artist"],
    relationship: "performed on",
    include: ["released recordings"],
    exclude: [],
    versionPolicy: "documented versions",
    evidencePolicy: "source-backed",
    orderingPolicy: "chronological",
    targetSize,
    ambiguities: [],
  };
}

function candidateArgs(input: {
  sourceUrl?: string;
  sourceClass?: "web" | "musicbrainz" | "discogs" | "apple";
  state?: "verified" | "corroborated" | "editorial" | "inferred";
  supportScope?: "track" | "album" | "session" | "collection" | "editorial";
} = {}) {
  const sourceUrl = input.sourceUrl ?? "https://credits.example/track";
  return {
    sources: [{
      url: sourceUrl,
      title: "Credit source",
      sourceClass: input.sourceClass ?? "web",
      provenanceRoot: "ignored-model-value.example",
      note: "The source explicitly describes the asserted relationship.",
    }],
    candidates: [{
      artist: "Test Artist",
      title: "Test Song",
      album: "Test Album",
      releaseYear: 2020,
      durationMs: 240_000,
      isrc: null,
      musicbrainzId: null,
      versionLabel: null,
      evidence: [{
        sourceUrl,
        state: input.state ?? "verified",
        supportScope: input.supportScope ?? "track",
        relationship: "performed on",
        note: "Track-level credit.",
      }],
    }],
  };
}

describe("claim-level evidence integrity", () => {
  test("only dedicated track verification can promote explicit track support", () => {
    const args = candidateArgs();
    const known = new Set(["https://credits.example/track"]);

    expect(validateCandidateBatch(args, known, "source_discovery").candidates[0]!.evidence[0]!.state).toBe("inferred");
    expect(validateCandidateBatch(args, known, "track_verification").candidates[0]!.evidence[0]!.state).toBe("verified");
  });

  test("album-level and Apple catalog assertions cannot become verified track claims", () => {
    const knownWeb = new Set(["https://credits.example/track"]);
    const album = validateCandidateBatch(candidateArgs({ supportScope: "album" }), knownWeb, "track_verification");
    expect(album.candidates[0]!.evidence[0]).toMatchObject({ state: "inferred", supportScope: "album" });

    const appleUrl = "https://music.apple.com/us/song/test/1";
    const apple = validateCandidateBatch(candidateArgs({ sourceUrl: appleUrl, sourceClass: "apple" }), new Set([appleUrl]), "track_verification");
    expect(apple.candidates[0]!.evidence[0]).toMatchObject({ state: "inferred", supportScope: "track" });
    const appleEditorial = validateCandidateBatch(
      candidateArgs({ sourceUrl: appleUrl, sourceClass: "apple", state: "editorial", supportScope: "editorial" }),
      new Set([appleUrl]),
      "track_verification",
    );
    expect(appleEditorial.candidates[0]!.evidence[0]).toMatchObject({ state: "inferred", supportScope: "editorial" });
  });

  test("structured search URLs cannot be relabeled as web relationship evidence", () => {
    for (const [sourceUrl, sourceClass] of [
      ["https://musicbrainz.org/ws/2/recording?query=test", "musicbrainz"],
      ["https://api.discogs.com/database/search?artist=test", "discogs"],
    ] as const) {
      const result = validateCandidateBatch(
        candidateArgs({ sourceUrl, sourceClass: "web", state: "verified", supportScope: "track" }),
        new Set([sourceUrl]),
        "track_verification",
      );
      expect(result.sources[0]!.sourceClass).toBe(sourceClass);
      expect(result.candidates[0]!.evidence[0]).toMatchObject({ state: "inferred", supportScope: "track" });
    }
  });
});

describe("server-owned container completion", () => {
  const sourceUrl = "https://musicbrainz.org/ws/2/release?query=test";
  const sources = [{
    url: sourceUrl,
    title: "MusicBrainz release search",
    sourceClass: "musicbrainz" as const,
    provenanceRoot: "musicbrainz.org",
    note: "Structured release search.",
  }];
  const rawContainer = {
    sourceUrl,
    strategyId: null,
    parentContainerId: null,
    containerType: "release",
    providerId: "release-1",
    title: "Test Release",
    status: "complete",
    cursor: null,
    advertisedTotal: 999,
    recoveredTotal: 999,
  };

  test("model-supplied terminal status and totals cannot close a container", () => {
    const result = validateContainerBatch(
      { sources, containers: [rawContainer] },
      new Set([sourceUrl]),
      new Map([[sourceUrl, "source-1"]]),
      [],
      {},
    );
    expect(result[0]).toMatchObject({ status: "unresolved", advertisedTotal: null, recoveredTotal: 0 });

    const inaccessible = validateContainerBatch(
      { sources, containers: [{ ...rawContainer, status: "inaccessible" }] },
      new Set([sourceUrl]),
      new Map([[sourceUrl, "source-1"]]),
      [],
      {},
    );
    expect(inaccessible[0]!.status).toBe("unresolved");
  });

  test("a completed adapter strategy supplies the only accepted totals and status", () => {
    const strategyId = "musicbrainz:releases:fixture";
    const ledger: Record<string, AdapterLedgerEntry> = {
      [strategyId]: {
        sourceClass: "musicbrainz",
        strategy: "release query fixture",
        action: "enumerate",
        entity: "release",
        containerProviderId: "release-1",
        nextCursor: null,
        status: "complete",
        advertisedCount: 12,
        recoveredCount: 12,
        note: "12 of 12 releases",
      },
    };
    const result = validateContainerBatch(
      { sources, containers: [{ ...rawContainer, strategyId }] },
      new Set([sourceUrl]),
      new Map([[sourceUrl, "source-1"]]),
      [],
      ledger,
    );
    expect(result[0]).toMatchObject({ status: "complete", advertisedTotal: 12, recoveredTotal: 12 });
    expect(result[0]!.metadata).toMatchObject({ strategyId, serverValidatedStrategy: true });

    const separateTarget = validateContainerBatch(
      { sources, containers: [
        { ...rawContainer, strategyId },
        { ...rawContainer, strategyId, providerId: "release-2", title: "Other Release" },
      ] },
      new Set([sourceUrl]),
      new Map([[sourceUrl, "source-1"]]),
      [],
      ledger,
    );
    expect(separateTarget).toHaveLength(2);
    expect(separateTarget[0]!.status).toBe("complete");
    expect(separateTarget[1]!.status).toBe("unresolved");
  });

  test("hosted web and unbound ledgers cannot masquerade as container enumeration", () => {
    for (const [strategyId, strategy] of [
      ["web:track_verification", {
        sourceClass: "web",
        strategy: "hosted web search during track_verification",
        nextCursor: null,
        status: "complete" as const,
        advertisedCount: 12,
        recoveredCount: 12,
        note: "12 validated public URLs",
      }],
      ["musicbrainz:enumerate:unbound", {
        sourceClass: "musicbrainz",
        strategy: "unbound enumeration",
        action: "enumerate" as const,
        entity: "release" as const,
        nextCursor: null,
        status: "complete" as const,
        advertisedCount: 12,
        recoveredCount: 12,
        note: "12 tracks",
      }],
    ] as const) {
      const result = validateContainerBatch(
        { sources, containers: [{ ...rawContainer, strategyId }] },
        new Set([sourceUrl]),
        new Map([[sourceUrl, "source-1"]]),
        [],
        { [strategyId]: strategy },
      );
      expect(result[0]).toMatchObject({ status: "unresolved", advertisedTotal: null, recoveredTotal: 0 });
      expect(result[0]!.metadata).toMatchObject({ serverValidatedStrategy: false });
    }
  });

  test("a discovery page persists every returned release without copying page totals into releases", () => {
    const discovered = Array.from({ length: 12 }, (_, index) => ({
      containerType: "release" as const,
      providerId: `musicbrainz:release:${index}`,
      title: `Release ${index}`,
      advertisedTotal: index + 1,
      metadata: { adapterId: "musicbrainz", externalId: String(index) },
    }));
    const result: SourceAdapterResult = {
      records: sources,
      items: Array.from({ length: 12 }, (_, index) => ({ id: index })),
      containers: discovered,
      evidence: [],
      nextCursor: null,
      complete: true,
      note: "12 of 12 releases",
      advertisedTotal: 12,
    };
    const ledger: AdapterLedgerEntry = {
      sourceClass: "musicbrainz",
      strategy: "discover release fixture",
      action: "discover",
      entity: "release",
      nextCursor: null,
      status: "complete",
      advertisedCount: 12,
      recoveredCount: 12,
      note: "12 of 12 releases",
    };
    const inputs = adapterContainerInputs(
      "musicbrainz",
      "discover",
      result,
      new Map([[sourceUrl, "source-1"]]),
      null,
      ledger,
    );
    expect(inputs).toHaveLength(12);
    expect(inputs.every((item) => item.status === "discovered" && item.recoveredTotal === 0)).toBe(true);
    expect(inputs.map((item) => item.advertisedTotal)).toEqual(discovered.map((item) => item.advertisedTotal));
  });

  test("enumeration completion updates only the bound release container", () => {
    const detailUrl = "https://musicbrainz.org/ws/2/release/00000000-0000-4000-8000-000000000001?inc=recordings";
    const result: SourceAdapterResult = {
      records: [{ ...sources[0]!, url: detailUrl, title: "Release detail" }],
      items: [{ title: "One" }, { title: "Two" }, { title: "Three" }],
      containers: [],
      evidence: [],
      nextCursor: null,
      complete: true,
      note: "3 recordings",
      advertisedTotal: 3,
    };
    const target = {
      id: "00000000-0000-4000-8000-000000000002",
      sourceRecordId: "source-1",
      parentContainerId: null,
      containerType: "release" as const,
      providerId: "musicbrainz:release:00000000-0000-4000-8000-000000000001",
      title: "Release",
      status: "discovered" as const,
      cursor: null,
      advertisedTotal: null,
      recoveredTotal: 0,
      metadata: { adapterId: "musicbrainz" },
    };
    const ledger: AdapterLedgerEntry = {
      sourceClass: "musicbrainz",
      strategy: "enumerate release fixture",
      action: "enumerate",
      entity: "release",
      containerProviderId: target.providerId,
      nextCursor: null,
      status: "complete",
      advertisedCount: 3,
      recoveredCount: 3,
      note: "3 recordings",
    };
    const inputs = adapterContainerInputs(
      "musicbrainz",
      "enumerate",
      result,
      new Map([[detailUrl, "source-2"]]),
      target,
      ledger,
    );
    expect(inputs).toEqual([expect.objectContaining({
      providerId: target.providerId,
      status: "complete",
      advertisedTotal: 3,
      recoveredTotal: 3,
      sourceRecordId: "source-2",
    })]);
  });

  test("a multi-page enumeration remains open until all items are recovered", () => {
    const target = {
      id: "00000000-0000-4000-8000-000000000003",
      sourceRecordId: "source-1",
      parentContainerId: null,
      containerType: "release" as const,
      providerId: "discogs:release:101",
      title: "Large Release",
      status: "discovered" as const,
      cursor: null,
      advertisedTotal: 61,
      recoveredTotal: 0,
      metadata: { adapterId: "discogs", externalId: 101 },
    };
    const firstPage: SourceAdapterResult = {
      records: sources,
      items: Array.from({ length: 25 }, (_, index) => ({ title: `Track ${index + 1}` })),
      containers: [],
      evidence: [],
      nextCursor: "25",
      complete: false,
      note: "25 tracks at offset 0 of 61",
      advertisedTotal: 61,
    };
    const firstLedger: AdapterLedgerEntry = {
      sourceClass: "discogs",
      strategy: "enumerate release fixture",
      action: "enumerate",
      entity: "release",
      containerProviderId: target.providerId,
      nextCursor: "25",
      status: "pending",
      advertisedCount: 61,
      recoveredCount: 25,
      note: firstPage.note,
    };
    expect(adapterContainerInputs("discogs", "enumerate", firstPage, new Map([[sourceUrl, "source-1"]]), target, firstLedger))
      .toEqual([expect.objectContaining({ status: "enumerating", cursor: "25", advertisedTotal: 61, recoveredTotal: 25 })]);

    const finalPage = { ...firstPage, items: Array.from({ length: 11 }, (_, index) => ({ title: `Track ${index + 51}` })), nextCursor: null, complete: true };
    const finalLedger = { ...firstLedger, nextCursor: null, status: "complete" as const, recoveredCount: 61 };
    expect(adapterContainerInputs("discogs", "enumerate", finalPage, new Map([[sourceUrl, "source-1"]]), target, finalLedger))
      .toEqual([expect.objectContaining({ status: "complete", cursor: null, advertisedTotal: 61, recoveredTotal: 61 })]);
  });
});

describe("research completion policy", () => {
  const observedFrontier = [{
    sourceClass: "musicbrainz",
    strategy: "recording enumeration",
    cursor: null,
    status: "complete" as const,
    discoveredCount: 1,
    recoveredCount: 1,
    note: "1 of 1",
  }];

  test("curated and hybrid briefs enforce minimums, never maximums", () => {
    expect(researchCompletionReadiness(brief("curated", { min: 3, max: 100 }), { candidateCount: 100, eligibleCandidateCount: 2, sourceCount: 1 }, []).ready).toBe(false);
    expect(researchCompletionReadiness(brief("curated", { min: 3, max: 100 }), { candidateCount: 100, eligibleCandidateCount: 3, sourceCount: 1 }, []).ready).toBe(true);
    expect(researchCompletionReadiness(brief("hybrid", { min: 2, max: 5 }), { candidateCount: 100, eligibleCandidateCount: 1, sourceCount: 1 }, []).ready).toBe(false);
    expect(researchCompletionReadiness(brief("hybrid", { min: 2, max: 5 }), { candidateCount: 100, eligibleCandidateCount: 2, sourceCount: 1 }, []).ready).toBe(true);
  });

  test("exhaustive and unconstrained hybrid runs require real candidates and sources", () => {
    expect(researchCompletionReadiness(brief("exhaustive", null), { candidateCount: 100, eligibleCandidateCount: 0, sourceCount: 1 }, observedFrontier).ready).toBe(false);
    expect(researchCompletionReadiness(brief("exhaustive", null), { candidateCount: 1, eligibleCandidateCount: 1, sourceCount: 1 }, []).ready).toBe(false);
    expect(researchCompletionReadiness(brief("exhaustive", null), { candidateCount: 1, eligibleCandidateCount: 1, sourceCount: 1 }, observedFrontier).ready).toBe(true);
    expect(researchCompletionReadiness(brief("hybrid", null), { candidateCount: 100, eligibleCandidateCount: 0, sourceCount: 1 }, []).ready).toBe(false);
    expect(researchCompletionReadiness(brief("hybrid", null), { candidateCount: 1, eligibleCandidateCount: 1, sourceCount: 1 }, []).ready).toBe(true);
  });

  test("gap-pass bounds are configurable and stale excess work fails durably", async () => {
    vi.stubEnv("RESEARCH_MAX_GAP_PASSES", "2");
    expect(researchGapPassLimit()).toBe(2);
    expect(researchGapPassLimit("1")).toBe(2);
    expect(researchGapPassLimit("500")).toBe(20);

    const checkpoints: unknown[] = [];
    const updates: unknown[] = [];
    const orchestrator = new ResearchOrchestrator({
      async getResearchCheckpoint() { return null; },
      async getRun() { return { status: "researching" }; },
      async saveResearchCheckpoint(_runId: string, _key: string, value: unknown) { checkpoints.push(value); },
      async updateRun(_runId: string, value: unknown) { updates.push(value); },
    } as any);
    await orchestrator.processJob({ runId: "run-1", phase: "gap_analysis", gapAttempt: 2 });
    expect(checkpoints).toContainEqual(expect.objectContaining({ status: "complete" }));
    expect(updates).toContainEqual(expect.objectContaining({ status: "failed", phase: "research_incomplete" }));
  });
});

test("provider reservations grow with hidden response context and bound output/tool usage", () => {
  vi.stubEnv("OPENAI_INPUT_USD_PER_MILLION", "5");
  vi.stubEnv("OPENAI_OUTPUT_USD_PER_MILLION", "30");
  vi.stubEnv("OPENAI_WEB_SEARCH_USD", "0.01");
  const body = { model: "test", input: "research", max_output_tokens: 4_000, max_tool_calls: 8 };
  const first = maximumOpenAICallCostUsd(body, 0, 0);
  const resumed = maximumOpenAICallCostUsd(body, 250_000, 0);
  expect(first).toBeGreaterThan(0.2);
  expect(resumed).toBeGreaterThan(first + 1);
  expect(responseContextTokenCount({ usage: { input_tokens: 120, output_tokens: 30 } })).toBe(150);
  expect(responseContextTokenCount({ usage: { total_tokens: 200, input_tokens: 120, output_tokens: 30 } })).toBe(200);
});

function segmentedRepository() {
  const checkpoints = new Map<string, any>();
  const jobs: any[] = [];
  const updates: any[] = [];
  const run = {
    id: "run-segmented",
    brief: brief("exhaustive", null),
    status: "researching",
    phase: "scope_resolution",
    actualCostUsd: 0,
    approvedBudgetUsd: 5,
    noNewGapPasses: 0,
  };
  const coverage = {
    candidateCount: 0,
    eligibleCandidateCount: 0,
    sourceCount: 0,
    unresolvedCount: 0,
    frontier: [],
    containers: [],
    existingKeys: [],
  };
  const repository = {
    async getResearchCheckpoint(_runId: string, key: string) { return checkpoints.get(key) ?? null; },
    async saveResearchCheckpoint(_runId: string, key: string, value: unknown) { checkpoints.set(key, structuredClone(value)); },
    async getRun() { return structuredClone(run); },
    async updateRun(_runId: string, patch: Record<string, unknown>) { Object.assign(run, patch); updates.push(structuredClone(patch)); },
    async getCoverage() { return structuredClone(coverage); },
    async listResearchContainers() { return []; },
    async upsertFrontier() {},
    async enqueueJob(input: unknown) { jobs.push(structuredClone(input)); return input; },
    async addSources() { return new Map(); },
    async addCandidates() { return 0; },
    async upsertResearchContainers() {},
  };
  return { repository, checkpoints, jobs, updates, run, coverage };
}

class ScriptedResearchOrchestrator extends ResearchOrchestrator {
  readonly calls: Array<{ operation: string; body: Record<string, unknown> }> = [];

  constructor(repository: any, private readonly script: Array<any | Error>) {
    super(repository);
  }

  protected override async callModel(
    _runId: string,
    operation: string,
    _idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<any> {
    this.calls.push({ operation, body: structuredClone(body) });
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("Test model script was exhausted");
    return structuredClone(next);
  }
}

function coverageToolResponse(id: string) {
  return {
    id,
    usage: { total_tokens: 100 },
    output: [{
      type: "function_call",
      name: "get_research_coverage",
      call_id: `${id}-coverage`,
      arguments: JSON.stringify({ frontierOffset: 0, containerOffset: 0 }),
    }],
  };
}

function completionResponse(id: string, phase = "scope_resolution") {
  return {
    id,
    usage: { total_tokens: 100 },
    output: [{
      type: "function_call",
      name: "complete_research_pass",
      call_id: `${id}-complete`,
      arguments: JSON.stringify({ phase, summary: "Segmented pass complete", newCandidateCount: 0, frontierItems: [] }),
    }],
  };
}

describe("durable research segmentation", () => {
  test("archives the boundary response, starts fresh context, and advances after continuation", async () => {
    vi.stubEnv("RESEARCH_TURNS_PER_SEGMENT", "1");
    vi.stubEnv("RESEARCH_MAX_SEGMENTS_PER_PASS", "3");
    expect(researchTurnsPerSegment()).toBe(1);
    expect(researchSegmentLimit()).toBe(3);
    const state = segmentedRepository();
    const boundaryResponse = coverageToolResponse("segment-0");
    boundaryResponse.output.unshift(
      { type: "web_search_call", id: "web-0", status: "completed" } as any,
      { type: "message", content: [{ annotations: [{ type: "url_citation", url: "https://evidence.example/credit" }] }] } as any,
    );
    const orchestrator = new ScriptedResearchOrchestrator(state.repository as any, [
      boundaryResponse,
      completionResponse("segment-1"),
    ]);

    await orchestrator.processJob({ runId: state.run.id, phase: "scope_resolution", gapAttempt: 0, generation: 0, segment: 0 });

    expect(orchestrator.calls).toHaveLength(1);
    expect(state.checkpoints.get("scope_resolution:segment:0")).toMatchObject({
      status: "complete",
      segment: 0,
      turn: 1,
      responseId: "segment-0",
      knownUrls: ["https://evidence.example/credit"],
      adapterLedger: expect.objectContaining({
        "web:scope_resolution": expect.objectContaining({ status: "complete", recoveredCount: 1 }),
      }),
    });
    expect(state.checkpoints.get("scope_resolution")).toMatchObject({
      status: "in_progress",
      segment: 1,
      turn: 0,
      pendingOutputs: [],
    });
    expect(state.checkpoints.get("resume")).toMatchObject({ status: "queued", generation: 1, segment: 1 });
    expect(state.jobs.at(-1)).toMatchObject({
      payload: { phase: "scope_resolution", generation: 1, segment: 1 },
      dedupeKey: expect.stringContaining(":g1"),
    });

    await orchestrator.processJob({ runId: state.run.id, phase: "scope_resolution", gapAttempt: 0, generation: 1, segment: 1 });

    expect(orchestrator.calls).toHaveLength(2);
    expect(orchestrator.calls[1]!.body).not.toHaveProperty("previous_response_id");
    expect(JSON.parse(String(orchestrator.calls[1]!.body.input))).toMatchObject({
      segment: 1,
      continuation: {
        knownUrlCount: 1,
        knownUrls: ["https://evidence.example/credit"],
        adapterStrategyCount: 1,
      },
    });
    expect(state.checkpoints.get("scope_resolution")).toMatchObject({ status: "complete", segment: 1 });
    expect(state.jobs.at(-1)).toMatchObject({ payload: { phase: "source_discovery", generation: 0, segment: 0 } });
  });

  test("a stale generation repairs a checkpointed but potentially missed queue handoff", async () => {
    const state = segmentedRepository();
    state.checkpoints.set("resume", {
      phase: "scope_resolution",
      gapAttempt: 0,
      generation: 4,
      segment: 2,
      status: "queued",
    });
    const orchestrator = new ScriptedResearchOrchestrator(state.repository as any, []);

    await orchestrator.processJob({ runId: state.run.id, phase: "scope_resolution", gapAttempt: 0, generation: 3, segment: 1 });

    expect(orchestrator.calls).toHaveLength(0);
    expect(state.jobs).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ generation: 4, segment: 2 }),
      dedupeKey: expect.stringContaining(":g4"),
    }));
  });

  test("a stale job repairs a checkpointed next-phase handoff", async () => {
    const state = segmentedRepository();
    state.checkpoints.set("resume", {
      phase: "source_discovery",
      gapAttempt: 0,
      generation: 0,
      segment: 0,
      status: "queued",
    });
    const orchestrator = new ScriptedResearchOrchestrator(state.repository as any, []);

    await orchestrator.processJob({
      runId: state.run.id,
      phase: "scope_resolution",
      gapAttempt: 0,
      generation: 0,
      segment: 0,
    });

    expect(orchestrator.calls).toHaveLength(0);
    expect(state.jobs).toContainEqual(expect.objectContaining({
      kind: "research",
      payload: expect.objectContaining({ phase: "source_discovery", gapAttempt: 0, generation: 0, segment: 0 }),
      dedupeKey: expect.stringContaining(":source_discovery:g0"),
    }));
  });

  test("a stale gap job repairs a checkpointed next-gap handoff", async () => {
    const state = segmentedRepository();
    state.checkpoints.set("resume", {
      phase: "gap_analysis",
      gapAttempt: 2,
      generation: 0,
      segment: 0,
      status: "queued",
    });
    const orchestrator = new ScriptedResearchOrchestrator(state.repository as any, []);

    await orchestrator.processJob({
      runId: state.run.id,
      phase: "gap_analysis",
      gapAttempt: 1,
      generation: 0,
      segment: 0,
    });

    expect(orchestrator.calls).toHaveLength(0);
    expect(state.jobs).toContainEqual(expect.objectContaining({
      kind: "research",
      payload: expect.objectContaining({ phase: "gap_analysis", gapAttempt: 2, generation: 0, segment: 0 }),
      dedupeKey: expect.stringContaining(":gap_analysis:2:g0"),
    }));
  });

  test("a stale final gap job repairs a checkpointed matching handoff", async () => {
    const state = segmentedRepository();
    Object.assign(state.run, { status: "ready_for_matching", phase: "research_complete" });
    state.checkpoints.set("resume", {
      phase: "gap_analysis",
      gapAttempt: 1,
      generation: 0,
      segment: 0,
      status: "complete",
    });
    const orchestrator = new ScriptedResearchOrchestrator(state.repository as any, []);

    await orchestrator.processJob({
      runId: state.run.id,
      phase: "gap_analysis",
      gapAttempt: 1,
      generation: 0,
      segment: 0,
    });

    expect(orchestrator.calls).toHaveLength(0);
    expect(state.jobs).toContainEqual(expect.objectContaining({
      kind: "matching",
      payload: { runId: state.run.id, storefront: "br" },
      dedupeKey: `matching:${state.run.id}`,
    }));
  });

  test("fails transparently at the segment ceiling without making an extra provider call", async () => {
    vi.stubEnv("RESEARCH_TURNS_PER_SEGMENT", "1");
    vi.stubEnv("RESEARCH_MAX_SEGMENTS_PER_PASS", "1");
    const state = segmentedRepository();
    const orchestrator = new ScriptedResearchOrchestrator(state.repository as any, [coverageToolResponse("only-segment")]);

    await orchestrator.processJob({ runId: state.run.id, phase: "scope_resolution", gapAttempt: 0, generation: 0, segment: 0 });

    expect(orchestrator.calls).toHaveLength(1);
    expect(state.run).toMatchObject({ status: "failed", phase: "research_incomplete" });
    expect(state.checkpoints.get("resume")).toMatchObject({ status: "complete", segment: 1 });
    expect(state.checkpoints.get("scope_resolution:segment-limit").completionBlockers[0]).toMatch(/1 durable segments/);
    expect(state.jobs).toHaveLength(0);
  });

  test("budget pause increments generation and resumes pending outputs in the same context segment", async () => {
    vi.stubEnv("RESEARCH_TURNS_PER_SEGMENT", "2");
    const state = segmentedRepository();
    const orchestrator = new ScriptedResearchOrchestrator(state.repository as any, [
      coverageToolResponse("before-budget"),
      new BudgetPause("Approval required"),
      completionResponse("after-budget"),
    ]);

    await orchestrator.processJob({ runId: state.run.id, phase: "scope_resolution", gapAttempt: 0, generation: 0, segment: 0 });

    expect(state.run).toMatchObject({ status: "awaiting_budget", phase: "scope_resolution" });
    expect(state.checkpoints.get("resume")).toMatchObject({ status: "paused", generation: 1, segment: 0 });
    expect(state.checkpoints.get("scope_resolution")).toMatchObject({
      status: "in_progress",
      segment: 0,
      turn: 1,
      responseId: "before-budget",
      pendingOutputs: [expect.objectContaining({ call_id: "before-budget-coverage" })],
    });
    await orchestrator.enqueue(state.run.id);
    expect(state.jobs.at(-1)).toMatchObject({ payload: { generation: 1, segment: 0 } });

    await orchestrator.processJob({ runId: state.run.id, phase: "scope_resolution", gapAttempt: 0, generation: 1, segment: 0 });
    expect(orchestrator.calls[2]!.body).toMatchObject({ previous_response_id: "before-budget" });
    expect(state.checkpoints.get("scope_resolution")).toMatchObject({ status: "complete", segment: 0 });
  });
});
