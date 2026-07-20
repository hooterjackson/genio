import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  evaluatePipelineV3ModelBenchmark,
  type PipelineV3BenchmarkArtifact,
} from "../scripts/pipeline-v3-benchmark-lib.ts";

const scenarios = JSON.parse(readFileSync(
  new URL("./fixtures/pipeline-v3-regression-scenarios.json", import.meta.url),
  "utf8",
)) as { scenarios: Array<{ id: string }> };
const rawArtifact = JSON.parse(readFileSync(
  new URL("./fixtures/pipeline-v3-model-benchmark.json", import.meta.url),
  "utf8",
)) as PipelineV3BenchmarkArtifact;
const scenarioIds = scenarios.scenarios.map(({ id }) => id);

function cloneArtifact(): PipelineV3BenchmarkArtifact {
  return structuredClone(rawArtifact);
}

describe("Pipeline V3 provider-free model routing gate", () => {
  test("selects the cheaper baseline only after both pinned routes clear every gate", () => {
    const report = evaluatePipelineV3ModelBenchmark(cloneArtifact(), scenarioIds);
    expect(report).toMatchObject({
      passed: true,
      selectedTier: "baseline",
      selectedProviderModelId: "gpt-5.6-luna",
      selectionReason: "least_cost_passing_route",
      productionEvidence: false,
    });
    expect(report.routes.baseline.passed).toBe(true);
    expect(report.routes.escalation.passed).toBe(true);
    expect(report.routes.baseline.aggregateCostUsd).toBeLessThan(report.routes.escalation.aggregateCostUsd);
  });

  test("escalates only when the baseline misses a required quality gate", () => {
    const artifact = cloneArtifact();
    artifact.routes.find(({ tier }) => tier === "baseline")!.metrics.relevancePrecision = 0.94;
    const report = evaluatePipelineV3ModelBenchmark(artifact, scenarioIds);
    expect(report).toMatchObject({
      passed: true,
      selectedTier: "escalation",
      selectionReason: "least_cost_passing_route",
    });
    expect(report.routes.baseline.failures).toContain("relevancePrecision_below_threshold");
  });

  test("fails closed on aliases, incomplete scenario coverage, or two failing routes", () => {
    const unavailable = cloneArtifact();
    (unavailable.routes[0] as unknown as { providerModelId: string }).providerModelId = "gpt-5.6-luna-2026-07-15";
    expect(() => evaluatePipelineV3ModelBenchmark(unavailable, scenarioIds)).toThrow(/validated allowlist/i);

    const opaque = cloneArtifact();
    opaque.routes[0]!.resolutionMode = "provider_managed_alias";
    opaque.routes[0]!.modelCatalogValidatedAt = "not-a-time";
    expect(() => evaluatePipelineV3ModelBenchmark(opaque, scenarioIds)).toThrow(/validation timestamp/i);

    const incomplete = cloneArtifact();
    incomplete.routes[0]!.scenarioIds.pop();
    expect(() => evaluatePipelineV3ModelBenchmark(incomplete, scenarioIds)).toThrow(/exactly match/i);

    const failed = cloneArtifact();
    for (const route of failed.routes) route.metrics.schemaValidity = 0.99;
    expect(evaluatePipelineV3ModelBenchmark(failed, scenarioIds)).toMatchObject({
      passed: false,
      selectedTier: null,
      selectionReason: "no_route_passed",
    });
  });
});
