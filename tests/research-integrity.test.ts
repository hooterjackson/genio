import { afterEach, describe, expect, test, vi } from "vitest";
import {
  maximumOpenAICallCostUsd,
  ResearchOrchestrator,
  researchCompletionReadiness,
  researchGapPassLimit,
  responseContextTokenCount,
  validateCandidateBatch,
  validateContainerBatch,
  type AdapterLedgerEntry,
} from "../server/research.ts";
import type { PlaylistBrief } from "../shared/types.ts";

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
  sourceClass?: "web" | "apple";
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
});

describe("server-owned container completion", () => {
  const sourceUrl = "https://musicbrainz.org/ws/2/release?query=test";
  const sources = [{
    url: sourceUrl,
    title: "MusicBrainz release search",
    sourceClass: "musicbrainz",
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

    const reused = validateContainerBatch(
      { sources, containers: [
        { ...rawContainer, strategyId },
        { ...rawContainer, strategyId, providerId: "release-2", title: "Other Release" },
      ] },
      new Set([sourceUrl]),
      new Map([[sourceUrl, "source-1"]]),
      [],
      ledger,
    );
    expect(reused).toHaveLength(1);
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
