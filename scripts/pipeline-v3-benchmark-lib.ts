export type PipelineV3BenchmarkTier = "baseline" | "escalation";

export interface PipelineV3BenchmarkThresholds {
  interpretationAccuracy: number;
  schemaValidity: number;
  relevancePrecision: number;
  hardConstraintCompliance: number;
  exactFillRate: number;
}

export interface PipelineV3BenchmarkRoute {
  tier: PipelineV3BenchmarkTier;
  providerModelId: "gpt-5.6-luna" | "gpt-5.6-terra";
  resolutionMode: "provider_managed_alias";
  modelCatalogValidatedAt: string;
  aggregateCostUsd: number;
  p50LatencyMs: number;
  metrics: PipelineV3BenchmarkThresholds;
  scenarioIds: string[];
}

export interface PipelineV3BenchmarkArtifact {
  fixtureVersion: string;
  provenance: {
    source: "deterministic_test_tape" | "persisted_independently_adjudicated_runs";
    generatedAt: string;
  };
  thresholds: PipelineV3BenchmarkThresholds;
  routes: PipelineV3BenchmarkRoute[];
}

export interface PipelineV3BenchmarkRouteReport extends PipelineV3BenchmarkRoute {
  passed: boolean;
  failures: string[];
}

export interface PipelineV3BenchmarkReport {
  passed: boolean;
  provenance: PipelineV3BenchmarkArtifact["provenance"];
  productionEvidence: boolean;
  selectedTier: PipelineV3BenchmarkTier | null;
  selectedProviderModelId: string | null;
  selectionReason: "least_cost_passing_route" | "no_route_passed";
  routes: Record<PipelineV3BenchmarkTier, PipelineV3BenchmarkRouteReport>;
}

const METRICS = [
  "interpretationAccuracy",
  "schemaValidity",
  "relevancePrecision",
  "hardConstraintCompliance",
  "exactFillRate",
] as const;

function assertRate(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite rate from zero through one`);
  }
}

const PROVIDER_MODEL_IDS = new Set(["gpt-5.6-luna", "gpt-5.6-terra"]);

function parseRoute(value: unknown, expectedScenarioIds: readonly string[]): PipelineV3BenchmarkRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Benchmark route must be an object");
  const route = value as Partial<PipelineV3BenchmarkRoute>;
  if (route.tier !== "baseline" && route.tier !== "escalation") throw new Error("Unknown benchmark route tier");
  if (typeof route.providerModelId !== "string" || !PROVIDER_MODEL_IDS.has(route.providerModelId)) {
    throw new Error(`${route.tier} model must be an exact provider model ID from the validated allowlist`);
  }
  if (route.resolutionMode !== "provider_managed_alias") {
    throw new Error(`${route.tier} model resolution mode must identify the provider-managed alias`);
  }
  const catalogValidatedAt = Date.parse(String(route.modelCatalogValidatedAt ?? ""));
  if (!Number.isFinite(catalogValidatedAt)
    || new Date(catalogValidatedAt).toISOString() !== route.modelCatalogValidatedAt) {
    throw new Error(`${route.tier} model catalog validation timestamp is invalid`);
  }
  if (typeof route.aggregateCostUsd !== "number" || !Number.isFinite(route.aggregateCostUsd) || route.aggregateCostUsd < 0) {
    throw new Error(`${route.tier} aggregate cost is invalid`);
  }
  if (!Number.isFinite(route.p50LatencyMs) || Number(route.p50LatencyMs) < 0) {
    throw new Error(`${route.tier} p50 latency is invalid`);
  }
  if (!route.metrics || typeof route.metrics !== "object") throw new Error(`${route.tier} metrics are missing`);
  for (const metric of METRICS) assertRate(route.metrics[metric], `${route.tier}.${metric}`);
  if (!Array.isArray(route.scenarioIds) || route.scenarioIds.some((id) => typeof id !== "string")) {
    throw new Error(`${route.tier} scenario coverage is invalid`);
  }
  const actual = [...new Set(route.scenarioIds)].sort();
  const expected = [...new Set(expectedScenarioIds)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${route.tier} scenario coverage does not exactly match the frozen regression suite`);
  }
  return route as PipelineV3BenchmarkRoute;
}

/**
 * Provider-free release gate for already-persisted benchmark measurements.
 * It never calls a model; live benchmark collection remains an explicit QA job.
 */
export function evaluatePipelineV3ModelBenchmark(
  value: unknown,
  expectedScenarioIds: readonly string[],
): PipelineV3BenchmarkReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Benchmark artifact must be an object");
  const artifact = value as Partial<PipelineV3BenchmarkArtifact>;
  if (typeof artifact.fixtureVersion !== "string" || artifact.fixtureVersion.length < 8) {
    throw new Error("Benchmark fixture version is missing");
  }
  if (!artifact.provenance || (
    artifact.provenance.source !== "deterministic_test_tape"
    && artifact.provenance.source !== "persisted_independently_adjudicated_runs"
  ) || !Number.isFinite(Date.parse(artifact.provenance.generatedAt))) {
    throw new Error("Benchmark provenance is missing or invalid");
  }
  if (!artifact.thresholds || typeof artifact.thresholds !== "object") throw new Error("Benchmark thresholds are missing");
  for (const metric of METRICS) assertRate(artifact.thresholds[metric], `thresholds.${metric}`);
  if (!Array.isArray(artifact.routes) || artifact.routes.length !== 2) {
    throw new Error("Benchmark artifact must contain exactly one baseline and one escalation route");
  }
  const routes = artifact.routes.map((route) => parseRoute(route, expectedScenarioIds));
  if (new Set(routes.map(({ tier }) => tier)).size !== 2) {
    throw new Error("Benchmark artifact must contain exactly one baseline and one escalation route");
  }
  if (new Set(routes.map(({ providerModelId }) => providerModelId)).size !== 2) {
    throw new Error("Baseline and escalation must use distinct provider model IDs");
  }
  const reports = Object.fromEntries(routes.map((route) => {
    const failures = METRICS.flatMap((metric) => (
      route.metrics[metric] + Number.EPSILON < artifact.thresholds![metric]
        ? [`${metric}_below_threshold`]
        : []
    ));
    return [route.tier, { ...route, passed: failures.length === 0, failures }];
  })) as Record<PipelineV3BenchmarkTier, PipelineV3BenchmarkRouteReport>;
  const baseline = reports.baseline;
  const escalation = reports.escalation;
  const passedRoutes = [baseline, escalation]
    .filter(({ passed }) => passed)
    .sort((left, right) => (
      left.aggregateCostUsd - right.aggregateCostUsd
      || left.p50LatencyMs - right.p50LatencyMs
      || left.tier.localeCompare(right.tier)
    ));
  const selected = passedRoutes[0];
  if (selected) {
    return {
      passed: true,
      provenance: artifact.provenance,
      productionEvidence: artifact.provenance.source === "persisted_independently_adjudicated_runs",
      selectedTier: selected.tier,
      selectedProviderModelId: selected.providerModelId,
      selectionReason: "least_cost_passing_route",
      routes: reports,
    };
  }
  return {
    passed: false,
    provenance: artifact.provenance,
    productionEvidence: artifact.provenance.source === "persisted_independently_adjudicated_runs",
    selectedTier: null,
    selectedProviderModelId: null,
    selectionReason: "no_route_passed",
    routes: reports,
  };
}
