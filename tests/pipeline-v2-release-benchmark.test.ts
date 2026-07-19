import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  PIPELINE_V2_BENCHMARK_ATTESTATION,
  PIPELINE_V2_BENCHMARK_RESULTS_SCHEMA,
  benchmarkSuiteHash,
  evaluatePipelineV2ReleaseBenchmark,
  parsePipelineV2BenchmarkSuite,
  pipelineV2BenchmarkRunSnapshot,
  type BenchmarkModelTier,
  type PipelineV2BenchmarkResultsArtifact,
  type PipelineV2BenchmarkRun,
  type PipelineV2BenchmarkSuite,
} from "../lib/pipeline-v2-release-benchmark.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";

const rawSuite = JSON.parse(readFileSync(
  new URL("./fixtures/pipeline-v2-release-benchmark-suite.json", import.meta.url),
  "utf8",
)) as unknown;

function uuid(value: number): string {
  return `10000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function digest(label: string): string {
  return sha256Hex(label);
}

function unsignedRun(run: PipelineV2BenchmarkRun) {
  return {
    scenarioId: run.scenarioId,
    modelTier: run.modelTier,
    modelSnapshot: run.modelSnapshot,
    pipelineVersion: run.pipelineVersion,
    selectionPlanVersion: run.selectionPlanVersion,
    policyVersion: run.policyVersion,
    runId: run.runId,
    manifestContentHash: run.manifestContentHash,
    costLedgerHash: run.costLedgerHash,
    storefront: run.storefront,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    actualCostUsd: run.actualCostUsd,
    outcome: run.outcome,
    tracks: run.tracks,
  };
}

function rebindRun(run: PipelineV2BenchmarkRun): void {
  run.runSnapshotSha256 = pipelineV2BenchmarkRunSnapshot(unsignedRun(run));
  run.adjudication.reviewedRunSnapshotSha256 = run.runSnapshotSha256;
}

function rehash(artifact: PipelineV2BenchmarkResultsArtifact): PipelineV2BenchmarkResultsArtifact {
  const unsigned = { ...artifact };
  delete (unsigned as Partial<PipelineV2BenchmarkResultsArtifact>).artifactSha256;
  artifact.artifactSha256 = sha256Hex(stableStringify(unsigned));
  return artifact;
}

function makeRun(
  suite: PipelineV2BenchmarkSuite,
  scenarioIndex: number,
  modelTier: BenchmarkModelTier,
): PipelineV2BenchmarkRun {
  const scenario = suite.scenarios[scenarioIndex]!;
  const tierOffset = modelTier === "luna" ? 0 : 10_000;
  const tracks = Array.from({ length: scenario.targetCount }, (_, index) => {
    const identifier = tierOffset + scenarioIndex * 1_000 + index + 1;
    return {
      position: index,
      candidateId: uuid(identifier),
      appleSongId: `apple-${identifier}`,
      recordingFamilyKey: `isrc:USAAA${identifier.toString().padStart(7, "0")}`,
      scopeBindingIds: [`binding-${identifier}`],
    };
  });
  const startedAt = new Date(Date.UTC(2026, 6, 19, 18, scenarioIndex * 2)).toISOString();
  const completedAt = new Date(Date.parse(startedAt) + 60_000).toISOString();
  const run: PipelineV2BenchmarkRun = {
    scenarioId: scenario.id,
    modelTier,
    modelSnapshot: modelTier === "luna" ? "gpt-5.6-luna-2026-07-15" : "gpt-5.6-terra-2026-07-15",
    pipelineVersion: "catalog_first_v2",
    selectionPlanVersion: "selection_plan_v2",
    policyVersion: "relevance_first_2026_07",
    runId: uuid(50_000 + tierOffset + scenarioIndex),
    manifestContentHash: digest(`${modelTier}:${scenario.id}:manifest`),
    costLedgerHash: digest(`${modelTier}:${scenario.id}:cost`),
    storefront: "us",
    startedAt,
    completedAt,
    actualCostUsd: modelTier === "luna" ? 0.1 : 0.2,
    outcome: "complete",
    tracks,
    runSnapshotSha256: digest("placeholder"),
    adjudication: {
      reviewedRunSnapshotSha256: digest("placeholder"),
      trackReviews: tracks.map((track) => ({
        candidateId: track.candidateId,
        appleSongId: track.appleSongId,
        catalogIdentityCorrect: true,
        relevant: true,
        evidenceEligible: true,
        evidenceAxes: [...scenario.requiredEvidenceAxes],
        note: "Independently checked against the US Apple catalog and the frozen scope rubric.",
      })),
      constraintReviews: scenario.hardConstraints.map(({ id }) => ({
        constraintId: id,
        compliant: true,
        note: "The complete manifest was independently checked against this hard constraint.",
      })),
    },
  };
  rebindRun(run);
  return run;
}

function makeArtifact(): PipelineV2BenchmarkResultsArtifact {
  const suite = parsePipelineV2BenchmarkSuite(rawSuite);
  return rehash({
    schemaVersion: PIPELINE_V2_BENCHMARK_RESULTS_SCHEMA,
    fixtureVersion: suite.fixtureVersion,
    suiteSha256: benchmarkSuiteHash(suite),
    generatedAt: "2026-07-19T20:00:00.000Z",
    provenance: {
      source: "postgres_export",
      exporterVersion: "pipeline-v2-benchmark-export/v1",
    },
    independentAdjudication: {
      reviewer: "Independent benchmark reviewer",
      reviewedAt: "2026-07-19T19:30:00.000Z",
      statement: PIPELINE_V2_BENCHMARK_ATTESTATION,
    },
    runs: suite.scenarios.flatMap((_, scenarioIndex) => [
      makeRun(suite, scenarioIndex, "luna"),
      makeRun(suite, scenarioIndex, "terra"),
    ]),
    artifactSha256: digest("placeholder"),
  });
}

describe("Pipeline V2 release benchmark gate", () => {
  test("freezes the required 25/50/100/200/300 scenarios and release thresholds", () => {
    const suite = parsePipelineV2BenchmarkSuite(rawSuite);
    expect(suite.scenarios.map(({ targetCount }) => targetCount)).toEqual([25, 50, 100, 200, 300]);
    expect(suite.thresholds).toEqual({
      catalogIdentityPrecision: 0.995,
      relevancePrecision: 0.95,
      evidenceCoverage: 1,
      hardConstraintCompliance: 1,
      exactFillRate: 0.98,
    });
    expect(benchmarkSuiteHash(suite)).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("selects the least expensive route only after both routes clear every gate", () => {
    const report = evaluatePipelineV2ReleaseBenchmark(rawSuite, makeArtifact());
    expect(report.passed).toBe(true);
    expect(report.models.luna).toMatchObject({ passed: true, exactFillRate: 1 });
    expect(report.models.terra).toMatchObject({ passed: true, exactFillRate: 1 });
    expect(report.selectedModelTier).toBe("luna");
    expect(report.selectionReason).toBe("lower_cost");
    expect(report.runs).toHaveLength(10);
  });

  test("fails closed when independent track or hard-constraint adjudication is incomplete", () => {
    const missingTrackReview = makeArtifact();
    missingTrackReview.runs[0]!.adjudication.trackReviews.pop();
    rehash(missingTrackReview);
    expect(() => evaluatePipelineV2ReleaseBenchmark(rawSuite, missingTrackReview)).toThrow(/adjudication does not exactly cover/i);

    const missingConstraintReview = makeArtifact();
    missingConstraintReview.runs[0]!.adjudication.constraintReviews.pop();
    rehash(missingConstraintReview);
    expect(() => evaluatePipelineV2ReleaseBenchmark(rawSuite, missingConstraintReview)).toThrow(/hard-constraint adjudication is incomplete/i);

    const noStatement = makeArtifact();
    (noStatement.independentAdjudication as { statement: string }).statement = "reviewed";
    rehash(noStatement);
    expect(() => evaluatePipelineV2ReleaseBenchmark(rawSuite, noStatement)).toThrow(/adjudication statement/i);
  });

  test("rejects missing model comparisons, stale suites, and artifact tampering", () => {
    const missingTerra = makeArtifact();
    missingTerra.runs = missingTerra.runs.filter(({ modelTier }) => modelTier === "luna");
    rehash(missingTerra);
    expect(() => evaluatePipelineV2ReleaseBenchmark(rawSuite, missingTerra)).toThrow(/exactly one Luna and one Terra/i);

    const stale = makeArtifact();
    stale.fixtureVersion = "stale";
    rehash(stale);
    expect(() => evaluatePipelineV2ReleaseBenchmark(rawSuite, stale)).toThrow(/not bound to this frozen suite/i);

    const tampered = makeArtifact();
    tampered.runs[0]!.actualCostUsd = 99;
    expect(() => evaluatePipelineV2ReleaseBenchmark(rawSuite, tampered)).toThrow(/content hash/i);
  });

  test("routes away from a model that misses relevance or exact-fill gates", () => {
    const relevanceFailure = makeArtifact();
    const lunaAmericanDrill = relevanceFailure.runs.find((run) => (
      run.modelTier === "luna" && run.scenarioId === "american_drill_25"
    ))!;
    lunaAmericanDrill.adjudication.trackReviews[0]!.relevant = false;
    lunaAmericanDrill.adjudication.trackReviews[1]!.relevant = false;
    rehash(relevanceFailure);
    const relevanceReport = evaluatePipelineV2ReleaseBenchmark(rawSuite, relevanceFailure);
    expect(relevanceReport.models.luna.passed).toBe(false);
    expect(relevanceReport.models.terra.passed).toBe(true);
    expect(relevanceReport.selectedModelTier).toBe("terra");

    const exactFillFailure = makeArtifact();
    const lunaHouse = exactFillFailure.runs.find((run) => (
      run.modelTier === "luna" && run.scenarioId === "house_music_50"
    ))!;
    const removed = lunaHouse.tracks.pop()!;
    lunaHouse.adjudication.trackReviews = lunaHouse.adjudication.trackReviews
      .filter(({ candidateId }) => candidateId !== removed.candidateId);
    lunaHouse.outcome = "partial_catalog_degraded";
    rebindRun(lunaHouse);
    rehash(exactFillFailure);
    const exactFillReport = evaluatePipelineV2ReleaseBenchmark(rawSuite, exactFillFailure);
    expect(exactFillReport.models.luna.failures).toContain("exact_fill_rate_below_threshold");
    expect(exactFillReport.selectedModelTier).toBe("terra");
  });

  test("requires every frozen evidence axis and one pinned snapshot per route", () => {
    const missingAxis = makeArtifact();
    const lunaRun = missingAxis.runs.find(({ modelTier }) => modelTier === "luna")!;
    lunaRun.adjudication.trackReviews[0]!.evidenceAxes.pop();
    rehash(missingAxis);
    const missingAxisReport = evaluatePipelineV2ReleaseBenchmark(rawSuite, missingAxis);
    expect(missingAxisReport.runs.find((run) => (
      run.scenarioId === lunaRun.scenarioId && run.modelTier === "luna"
    ))!.failures).toContain("required_evidence_axis_missing");
    expect(missingAxisReport.selectedModelTier).toBe("terra");

    const mixedSnapshots = makeArtifact();
    const secondLuna = mixedSnapshots.runs.filter(({ modelTier }) => modelTier === "luna")[1]!;
    secondLuna.modelSnapshot = "gpt-5.6-luna-different-snapshot";
    rebindRun(secondLuna);
    rehash(mixedSnapshots);
    const mixedReport = evaluatePipelineV2ReleaseBenchmark(rawSuite, mixedSnapshots);
    expect(mixedReport.models.luna.failures).toContain("model_snapshot_not_pinned");
    expect(mixedReport.selectedModelTier).toBe("terra");
  });

  test("captures cost and latency from persisted run metadata rather than reviewer scores", () => {
    const artifact = makeArtifact();
    const luna = artifact.runs.find(({ modelTier }) => modelTier === "luna")!;
    luna.actualCostUsd = 0.8;
    rebindRun(luna);
    rehash(artifact);
    const report = evaluatePipelineV2ReleaseBenchmark(rawSuite, artifact);
    expect(report.models.luna.failures).toContain("one_or_more_scenarios_failed");
    expect(report.runs.find(({ modelTier }) => modelTier === "luna")!.failures).toContain("cost_ceiling_exceeded");
    expect(report.models.terra.passed).toBe(true);
  });

  test("blocks release when neither independently reviewed model route passes", () => {
    const artifact = makeArtifact();
    for (const run of artifact.runs.filter(({ scenarioId }) => scenarioId === "american_drill_25")) {
      run.adjudication.trackReviews[0]!.relevant = false;
      run.adjudication.trackReviews[1]!.relevant = false;
    }
    rehash(artifact);
    expect(evaluatePipelineV2ReleaseBenchmark(rawSuite, artifact)).toMatchObject({
      passed: false,
      selectedModelTier: null,
      selectionReason: "no_model_passed",
    });
  });
});
