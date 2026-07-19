import { sha256Hex, stableStringify } from "../server/security.ts";

export const PIPELINE_V2_BENCHMARK_SUITE_SCHEMA = "genio-pipeline-v2-release-suite/v1" as const;
export const PIPELINE_V2_BENCHMARK_RESULTS_SCHEMA = "genio-pipeline-v2-release-results/v1" as const;
export const PIPELINE_V2_BENCHMARK_ATTESTATION =
  "I independently adjudicated every published recording and every declared hard constraint without using model output as ground truth." as const;

export type BenchmarkModelTier = "luna" | "terra";
export type BenchmarkLatencyTier = "interactive_25_50" | "interactive_51_100" | "interactive_101_300";

export interface PipelineV2BenchmarkThresholds {
  catalogIdentityPrecision: number;
  relevancePrecision: number;
  evidenceCoverage: number;
  hardConstraintCompliance: number;
  exactFillRate: number;
}

export interface PipelineV2BenchmarkLatencyThreshold {
  p50Ms: number;
  p95Ms: number;
}

export interface PipelineV2BenchmarkConstraint {
  id: string;
  description: string;
}

export interface PipelineV2BenchmarkScenario {
  id: string;
  prompt: string;
  targetCount: number;
  catalogRich: boolean;
  exactFillRequired: boolean;
  minimumPublishedRatio: number;
  latencyTier: BenchmarkLatencyTier;
  maximumCostUsd: number;
  requiredEvidenceAxes: string[];
  hardConstraints: PipelineV2BenchmarkConstraint[];
}

export interface PipelineV2BenchmarkSuite {
  schemaVersion: typeof PIPELINE_V2_BENCHMARK_SUITE_SCHEMA;
  fixtureVersion: string;
  frozenAt: string;
  methodology: {
    independence: string;
    amendmentPolicy: string;
  };
  requiredModelTiers: BenchmarkModelTier[];
  thresholds: PipelineV2BenchmarkThresholds;
  latencyThresholds: Record<BenchmarkLatencyTier, PipelineV2BenchmarkLatencyThreshold>;
  scenarios: PipelineV2BenchmarkScenario[];
}

export interface PipelineV2BenchmarkTrack {
  position: number;
  candidateId: string;
  appleSongId: string;
  recordingFamilyKey: string;
  scopeBindingIds: string[];
}

export interface PipelineV2BenchmarkTrackReview {
  candidateId: string;
  appleSongId: string;
  catalogIdentityCorrect: boolean;
  relevant: boolean;
  evidenceEligible: boolean;
  evidenceAxes: string[];
  note: string;
}

export interface PipelineV2BenchmarkConstraintReview {
  constraintId: string;
  compliant: boolean;
  note: string;
}

export interface PipelineV2BenchmarkRun {
  scenarioId: string;
  modelTier: BenchmarkModelTier;
  modelSnapshot: string;
  pipelineVersion: "catalog_first_v2";
  selectionPlanVersion: "selection_plan_v2";
  policyVersion: string;
  runId: string;
  manifestContentHash: string;
  costLedgerHash: string;
  storefront: "us";
  startedAt: string;
  completedAt: string;
  actualCostUsd: number;
  outcome: string;
  tracks: PipelineV2BenchmarkTrack[];
  runSnapshotSha256: string;
  adjudication: {
    reviewedRunSnapshotSha256: string;
    trackReviews: PipelineV2BenchmarkTrackReview[];
    constraintReviews: PipelineV2BenchmarkConstraintReview[];
  };
}

export interface PipelineV2BenchmarkResultsArtifact {
  schemaVersion: typeof PIPELINE_V2_BENCHMARK_RESULTS_SCHEMA;
  fixtureVersion: string;
  suiteSha256: string;
  generatedAt: string;
  provenance: {
    source: "postgres_export";
    exporterVersion: string;
  };
  independentAdjudication: {
    reviewer: string;
    reviewedAt: string;
    statement: typeof PIPELINE_V2_BENCHMARK_ATTESTATION;
  };
  runs: PipelineV2BenchmarkRun[];
  artifactSha256: string;
}

export interface PipelineV2BenchmarkRunReport {
  scenarioId: string;
  modelTier: BenchmarkModelTier;
  modelSnapshot: string;
  targetCount: number;
  publishedCount: number;
  publishedRatio: number;
  exactFill: boolean;
  durationMs: number;
  actualCostUsd: number;
  catalogIdentityPrecision: number | null;
  relevancePrecision: number | null;
  evidenceCoverage: number | null;
  hardConstraintCompliance: number | null;
  failures: string[];
  passed: boolean;
}

export interface PipelineV2BenchmarkModelReport {
  modelTier: BenchmarkModelTier;
  modelSnapshots: string[];
  runCount: number;
  actualCostUsd: number;
  exactFillRate: number;
  catalogIdentityPrecision: number | null;
  relevancePrecision: number | null;
  evidenceCoverage: number | null;
  hardConstraintCompliance: number | null;
  latency: Record<BenchmarkLatencyTier, { sampleSize: number; p50Ms: number | null; p95Ms: number | null; passed: boolean }>;
  failures: string[];
  passed: boolean;
}

export interface PipelineV2BenchmarkReport {
  fixtureVersion: string;
  suiteSha256: string;
  artifactSha256: string;
  runs: PipelineV2BenchmarkRunReport[];
  models: Record<BenchmarkModelTier, PipelineV2BenchmarkModelReport>;
  selectedModelTier: BenchmarkModelTier | null;
  selectionReason: "only_passing_model" | "lower_cost" | "lower_latency_tiebreak" | "no_model_passed";
  passed: boolean;
}

const LATENCY_TIERS: BenchmarkLatencyTier[] = ["interactive_25_50", "interactive_51_100", "interactive_101_300"];
const MODEL_TIERS: BenchmarkModelTier[] = ["luna", "terra"];
const COMPLETE_OUTCOMES = new Set(["complete"]);
const SAFE_PARTIAL_OUTCOMES = new Set([
  "partial_frontier_exhausted",
  "partial_evidence_shortfall",
  "partial_catalog_degraded",
  "partial_timed_out",
  "partial_policy_conflict",
]);

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const missing = allowed.filter((key) => !(key in record));
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (missing.length || extra.length) {
    throw new Error(`${path} has invalid keys (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`);
  }
}

function stringValue(value: unknown, path: string, maximum = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function uuid(value: unknown, path: string): string {
  const result = stringValue(value, path, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result)) {
    throw new Error(`${path} must be a UUID`);
  }
  return result;
}

function digest(value: unknown, path: string): string {
  const result = stringValue(value, path, 64);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw new Error(`${path} must be a lowercase SHA-256 digest`);
  return result;
}

function timestamp(value: unknown, path: string): string {
  const result = stringValue(value, path, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new Error(`${path} must be an ISO-8601 UTC timestamp`);
  }
  return result;
}

function integer(value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${path} must be an integer from ${minimum} to ${maximum}`);
  return Number(value);
}

function finite(value: unknown, path: string, minimum = 0, maximum = Number.MAX_VALUE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${path} must be a number from ${minimum} to ${maximum}`);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function strings(value: unknown, path: string, options: { minimum?: number; maximum?: number } = {}): string[] {
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? 100;
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${path} must be an array of ${minimum} to ${maximum} strings`);
  }
  const parsed = value.map((item, index) => stringValue(item, `${path}[${index}]`, 240));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${path} contains duplicates`);
  return parsed;
}

function ratio(value: unknown, path: string): number {
  return finite(value, path, 0, 1);
}

export function benchmarkSuiteHash(suite: PipelineV2BenchmarkSuite): string {
  return sha256Hex(stableStringify(suite));
}

function unsignedResultArtifact(artifact: PipelineV2BenchmarkResultsArtifact): Omit<PipelineV2BenchmarkResultsArtifact, "artifactSha256"> {
  const unsigned = { ...artifact };
  delete (unsigned as Partial<PipelineV2BenchmarkResultsArtifact>).artifactSha256;
  return unsigned;
}

export function pipelineV2BenchmarkRunSnapshot(run: Omit<PipelineV2BenchmarkRun, "runSnapshotSha256" | "adjudication">): string {
  return sha256Hex(stableStringify(run));
}

export function parsePipelineV2BenchmarkSuite(value: unknown): PipelineV2BenchmarkSuite {
  const root = asObject(value, "suite");
  exactKeys(root, ["schemaVersion", "fixtureVersion", "frozenAt", "methodology", "requiredModelTiers", "thresholds", "latencyThresholds", "scenarios"], "suite");
  if (root.schemaVersion !== PIPELINE_V2_BENCHMARK_SUITE_SCHEMA) throw new Error("Unsupported Pipeline V2 benchmark suite schema");
  const methodology = asObject(root.methodology, "suite.methodology");
  exactKeys(methodology, ["independence", "amendmentPolicy"], "suite.methodology");
  const requiredModelTiers = strings(root.requiredModelTiers, "suite.requiredModelTiers", { minimum: 2, maximum: 2 });
  if (requiredModelTiers.join(",") !== MODEL_TIERS.join(",")) throw new Error("suite.requiredModelTiers must be luna then terra");

  const thresholdInput = asObject(root.thresholds, "suite.thresholds");
  exactKeys(thresholdInput, ["catalogIdentityPrecision", "relevancePrecision", "evidenceCoverage", "hardConstraintCompliance", "exactFillRate"], "suite.thresholds");
  const thresholds: PipelineV2BenchmarkThresholds = {
    catalogIdentityPrecision: ratio(thresholdInput.catalogIdentityPrecision, "suite.thresholds.catalogIdentityPrecision"),
    relevancePrecision: ratio(thresholdInput.relevancePrecision, "suite.thresholds.relevancePrecision"),
    evidenceCoverage: ratio(thresholdInput.evidenceCoverage, "suite.thresholds.evidenceCoverage"),
    hardConstraintCompliance: ratio(thresholdInput.hardConstraintCompliance, "suite.thresholds.hardConstraintCompliance"),
    exactFillRate: ratio(thresholdInput.exactFillRate, "suite.thresholds.exactFillRate"),
  };

  const latencyInput = asObject(root.latencyThresholds, "suite.latencyThresholds");
  exactKeys(latencyInput, LATENCY_TIERS, "suite.latencyThresholds");
  const latencyThresholds = Object.fromEntries(LATENCY_TIERS.map((tier) => {
    const item = asObject(latencyInput[tier], `suite.latencyThresholds.${tier}`);
    exactKeys(item, ["p50Ms", "p95Ms"], `suite.latencyThresholds.${tier}`);
    return [tier, {
      p50Ms: integer(item.p50Ms, `suite.latencyThresholds.${tier}.p50Ms`, 1),
      p95Ms: integer(item.p95Ms, `suite.latencyThresholds.${tier}.p95Ms`, 1),
    }];
  })) as Record<BenchmarkLatencyTier, PipelineV2BenchmarkLatencyThreshold>;

  if (!Array.isArray(root.scenarios) || root.scenarios.length < 5 || root.scenarios.length > 100) {
    throw new Error("suite.scenarios must contain at least five frozen scenarios");
  }
  const scenarios = root.scenarios.map((item, index) => {
    const scenario = asObject(item, `suite.scenarios[${index}]`);
    exactKeys(scenario, ["id", "prompt", "targetCount", "catalogRich", "exactFillRequired", "minimumPublishedRatio", "latencyTier", "maximumCostUsd", "requiredEvidenceAxes", "hardConstraints"], `suite.scenarios[${index}]`);
    if (!LATENCY_TIERS.includes(scenario.latencyTier as BenchmarkLatencyTier)) throw new Error(`suite.scenarios[${index}].latencyTier is invalid`);
    if (!Array.isArray(scenario.hardConstraints) || scenario.hardConstraints.length === 0 || scenario.hardConstraints.length > 20) {
      throw new Error(`suite.scenarios[${index}].hardConstraints must contain independently reviewable constraints`);
    }
    const hardConstraints = scenario.hardConstraints.map((value, constraintIndex) => {
      const constraint = asObject(value, `suite.scenarios[${index}].hardConstraints[${constraintIndex}]`);
      exactKeys(constraint, ["id", "description"], `suite.scenarios[${index}].hardConstraints[${constraintIndex}]`);
      return {
        id: stringValue(constraint.id, `suite.scenarios[${index}].hardConstraints[${constraintIndex}].id`, 80),
        description: stringValue(constraint.description, `suite.scenarios[${index}].hardConstraints[${constraintIndex}].description`, 500),
      };
    });
    if (new Set(hardConstraints.map(({ id }) => id)).size !== hardConstraints.length) throw new Error(`suite.scenarios[${index}] has duplicate hard constraint IDs`);
    return {
      id: stringValue(scenario.id, `suite.scenarios[${index}].id`, 80),
      prompt: stringValue(scenario.prompt, `suite.scenarios[${index}].prompt`, 2_000),
      targetCount: integer(scenario.targetCount, `suite.scenarios[${index}].targetCount`, 1, 300),
      catalogRich: booleanValue(scenario.catalogRich, `suite.scenarios[${index}].catalogRich`),
      exactFillRequired: booleanValue(scenario.exactFillRequired, `suite.scenarios[${index}].exactFillRequired`),
      minimumPublishedRatio: ratio(scenario.minimumPublishedRatio, `suite.scenarios[${index}].minimumPublishedRatio`),
      latencyTier: scenario.latencyTier as BenchmarkLatencyTier,
      maximumCostUsd: finite(scenario.maximumCostUsd, `suite.scenarios[${index}].maximumCostUsd`, 0.000001, 100),
      requiredEvidenceAxes: strings(scenario.requiredEvidenceAxes, `suite.scenarios[${index}].requiredEvidenceAxes`, { minimum: 1, maximum: 20 }),
      hardConstraints,
    };
  });
  if (new Set(scenarios.map(({ id }) => id)).size !== scenarios.length) throw new Error("suite.scenarios contains duplicate IDs");
  for (const requiredTarget of [25, 50, 100, 200, 300]) {
    if (!scenarios.some(({ targetCount }) => targetCount === requiredTarget)) throw new Error(`suite.scenarios is missing the required ${requiredTarget}-track benchmark`);
  }
  for (const scenario of scenarios.filter(({ targetCount }) => [25, 50, 100].includes(targetCount))) {
    if (!scenario.catalogRich || !scenario.exactFillRequired || scenario.minimumPublishedRatio !== 1) {
      throw new Error(`${scenario.id} must be catalog-rich and require exact fill`);
    }
  }
  return {
    schemaVersion: PIPELINE_V2_BENCHMARK_SUITE_SCHEMA,
    fixtureVersion: stringValue(root.fixtureVersion, "suite.fixtureVersion", 80),
    frozenAt: timestamp(root.frozenAt, "suite.frozenAt"),
    methodology: {
      independence: stringValue(methodology.independence, "suite.methodology.independence"),
      amendmentPolicy: stringValue(methodology.amendmentPolicy, "suite.methodology.amendmentPolicy"),
    },
    requiredModelTiers: requiredModelTiers as BenchmarkModelTier[],
    thresholds,
    latencyThresholds,
    scenarios,
  };
}

function parseRun(value: unknown, path: string): PipelineV2BenchmarkRun {
  const run = asObject(value, path);
  exactKeys(run, ["scenarioId", "modelTier", "modelSnapshot", "pipelineVersion", "selectionPlanVersion", "policyVersion", "runId", "manifestContentHash", "costLedgerHash", "storefront", "startedAt", "completedAt", "actualCostUsd", "outcome", "tracks", "runSnapshotSha256", "adjudication"], path);
  if (!MODEL_TIERS.includes(run.modelTier as BenchmarkModelTier)) throw new Error(`${path}.modelTier is invalid`);
  if (run.pipelineVersion !== "catalog_first_v2") throw new Error(`${path}.pipelineVersion must be catalog_first_v2`);
  if (run.selectionPlanVersion !== "selection_plan_v2") throw new Error(`${path}.selectionPlanVersion must be selection_plan_v2`);
  if (run.storefront !== "us") throw new Error(`${path}.storefront must be us`);
  if (!Array.isArray(run.tracks) || run.tracks.length > 300) throw new Error(`${path}.tracks must contain at most 300 rows`);
  const tracks = run.tracks.map((value, index) => {
    const track = asObject(value, `${path}.tracks[${index}]`);
    exactKeys(track, ["position", "candidateId", "appleSongId", "recordingFamilyKey", "scopeBindingIds"], `${path}.tracks[${index}]`);
    return {
      position: integer(track.position, `${path}.tracks[${index}].position`, 0, 299),
      candidateId: uuid(track.candidateId, `${path}.tracks[${index}].candidateId`),
      appleSongId: stringValue(track.appleSongId, `${path}.tracks[${index}].appleSongId`, 100),
      recordingFamilyKey: stringValue(track.recordingFamilyKey, `${path}.tracks[${index}].recordingFamilyKey`, 300),
      scopeBindingIds: strings(track.scopeBindingIds, `${path}.tracks[${index}].scopeBindingIds`, { minimum: 1, maximum: 20 }),
    };
  });
  if (tracks.some(({ position }, index) => position !== index)) throw new Error(`${path}.tracks positions must be contiguous from zero`);
  for (const key of ["candidateId", "appleSongId", "recordingFamilyKey"] as const) {
    if (new Set(tracks.map((track) => track[key])).size !== tracks.length) throw new Error(`${path}.tracks contains duplicate ${key} values`);
  }
  const adjudicationInput = asObject(run.adjudication, `${path}.adjudication`);
  exactKeys(adjudicationInput, ["reviewedRunSnapshotSha256", "trackReviews", "constraintReviews"], `${path}.adjudication`);
  if (!Array.isArray(adjudicationInput.trackReviews)) throw new Error(`${path}.adjudication.trackReviews must be an array`);
  const trackReviews = adjudicationInput.trackReviews.map((value, index) => {
    const review = asObject(value, `${path}.adjudication.trackReviews[${index}]`);
    exactKeys(review, ["candidateId", "appleSongId", "catalogIdentityCorrect", "relevant", "evidenceEligible", "evidenceAxes", "note"], `${path}.adjudication.trackReviews[${index}]`);
    return {
      candidateId: uuid(review.candidateId, `${path}.adjudication.trackReviews[${index}].candidateId`),
      appleSongId: stringValue(review.appleSongId, `${path}.adjudication.trackReviews[${index}].appleSongId`, 100),
      catalogIdentityCorrect: booleanValue(review.catalogIdentityCorrect, `${path}.adjudication.trackReviews[${index}].catalogIdentityCorrect`),
      relevant: booleanValue(review.relevant, `${path}.adjudication.trackReviews[${index}].relevant`),
      evidenceEligible: booleanValue(review.evidenceEligible, `${path}.adjudication.trackReviews[${index}].evidenceEligible`),
      evidenceAxes: strings(review.evidenceAxes, `${path}.adjudication.trackReviews[${index}].evidenceAxes`, { minimum: 1, maximum: 20 }),
      note: stringValue(review.note, `${path}.adjudication.trackReviews[${index}].note`, 1_000),
    };
  });
  if (!Array.isArray(adjudicationInput.constraintReviews)) throw new Error(`${path}.adjudication.constraintReviews must be an array`);
  const constraintReviews = adjudicationInput.constraintReviews.map((value, index) => {
    const review = asObject(value, `${path}.adjudication.constraintReviews[${index}]`);
    exactKeys(review, ["constraintId", "compliant", "note"], `${path}.adjudication.constraintReviews[${index}]`);
    return {
      constraintId: stringValue(review.constraintId, `${path}.adjudication.constraintReviews[${index}].constraintId`, 80),
      compliant: booleanValue(review.compliant, `${path}.adjudication.constraintReviews[${index}].compliant`),
      note: stringValue(review.note, `${path}.adjudication.constraintReviews[${index}].note`, 1_000),
    };
  });
  return {
    scenarioId: stringValue(run.scenarioId, `${path}.scenarioId`, 80),
    modelTier: run.modelTier as BenchmarkModelTier,
    modelSnapshot: stringValue(run.modelSnapshot, `${path}.modelSnapshot`, 120),
    pipelineVersion: "catalog_first_v2",
    selectionPlanVersion: "selection_plan_v2",
    policyVersion: stringValue(run.policyVersion, `${path}.policyVersion`, 120),
    runId: uuid(run.runId, `${path}.runId`),
    manifestContentHash: digest(run.manifestContentHash, `${path}.manifestContentHash`),
    costLedgerHash: digest(run.costLedgerHash, `${path}.costLedgerHash`),
    storefront: "us",
    startedAt: timestamp(run.startedAt, `${path}.startedAt`),
    completedAt: timestamp(run.completedAt, `${path}.completedAt`),
    actualCostUsd: finite(run.actualCostUsd, `${path}.actualCostUsd`, 0, 100),
    outcome: stringValue(run.outcome, `${path}.outcome`, 80),
    tracks,
    runSnapshotSha256: digest(run.runSnapshotSha256, `${path}.runSnapshotSha256`),
    adjudication: {
      reviewedRunSnapshotSha256: digest(adjudicationInput.reviewedRunSnapshotSha256, `${path}.adjudication.reviewedRunSnapshotSha256`),
      trackReviews,
      constraintReviews,
    },
  };
}

export function parsePipelineV2BenchmarkResults(value: unknown): PipelineV2BenchmarkResultsArtifact {
  const root = asObject(value, "results");
  exactKeys(root, ["schemaVersion", "fixtureVersion", "suiteSha256", "generatedAt", "provenance", "independentAdjudication", "runs", "artifactSha256"], "results");
  if (root.schemaVersion !== PIPELINE_V2_BENCHMARK_RESULTS_SCHEMA) throw new Error("Unsupported Pipeline V2 benchmark results schema");
  const provenance = asObject(root.provenance, "results.provenance");
  exactKeys(provenance, ["source", "exporterVersion"], "results.provenance");
  if (provenance.source !== "postgres_export") throw new Error("results.provenance.source must be postgres_export");
  const adjudication = asObject(root.independentAdjudication, "results.independentAdjudication");
  exactKeys(adjudication, ["reviewer", "reviewedAt", "statement"], "results.independentAdjudication");
  if (adjudication.statement !== PIPELINE_V2_BENCHMARK_ATTESTATION) {
    throw new Error("Independent adjudication statement is missing or modified");
  }
  if (!Array.isArray(root.runs) || root.runs.length === 0) throw new Error("results.runs must not be empty");
  const parsed: PipelineV2BenchmarkResultsArtifact = {
    schemaVersion: PIPELINE_V2_BENCHMARK_RESULTS_SCHEMA,
    fixtureVersion: stringValue(root.fixtureVersion, "results.fixtureVersion", 80),
    suiteSha256: digest(root.suiteSha256, "results.suiteSha256"),
    generatedAt: timestamp(root.generatedAt, "results.generatedAt"),
    provenance: {
      source: "postgres_export",
      exporterVersion: stringValue(provenance.exporterVersion, "results.provenance.exporterVersion", 120),
    },
    independentAdjudication: {
      reviewer: stringValue(adjudication.reviewer, "results.independentAdjudication.reviewer", 200),
      reviewedAt: timestamp(adjudication.reviewedAt, "results.independentAdjudication.reviewedAt"),
      statement: PIPELINE_V2_BENCHMARK_ATTESTATION,
    },
    runs: root.runs.map((run, index) => parseRun(run, `results.runs[${index}]`)),
    artifactSha256: digest(root.artifactSha256, "results.artifactSha256"),
  };
  if (parsed.artifactSha256 !== sha256Hex(stableStringify(unsignedResultArtifact(parsed)))) {
    throw new Error("Pipeline V2 benchmark artifact content hash is invalid");
  }
  return parsed;
}

function meanBoolean(values: readonly boolean[]): number | null {
  return values.length === 0 ? null : values.filter(Boolean).length / values.length;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function evaluateRun(
  suite: PipelineV2BenchmarkSuite,
  scenario: PipelineV2BenchmarkScenario,
  run: PipelineV2BenchmarkRun,
): PipelineV2BenchmarkRunReport {
  const unsignedRun = {
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
  } satisfies Omit<PipelineV2BenchmarkRun, "runSnapshotSha256" | "adjudication">;
  const expectedSnapshot = pipelineV2BenchmarkRunSnapshot(unsignedRun);
  if (run.runSnapshotSha256 !== expectedSnapshot || run.adjudication.reviewedRunSnapshotSha256 !== expectedSnapshot) {
    throw new Error(`${scenario.id}/${run.modelTier} adjudication is not bound to the persisted run snapshot`);
  }
  const reviewByCandidate = new Map(run.adjudication.trackReviews.map((review) => [review.candidateId, review]));
  if (reviewByCandidate.size !== run.adjudication.trackReviews.length || reviewByCandidate.size !== run.tracks.length) {
    throw new Error(`${scenario.id}/${run.modelTier} independent track adjudication does not exactly cover the manifest`);
  }
  for (const track of run.tracks) {
    const review = reviewByCandidate.get(track.candidateId);
    if (!review || review.appleSongId !== track.appleSongId) {
      throw new Error(`${scenario.id}/${run.modelTier} independent track adjudication does not match the manifest identities`);
    }
  }
  const expectedConstraints = new Set(scenario.hardConstraints.map(({ id }) => id));
  const constraintReviews = new Map(run.adjudication.constraintReviews.map((review) => [review.constraintId, review]));
  if (constraintReviews.size !== run.adjudication.constraintReviews.length
    || constraintReviews.size !== expectedConstraints.size
    || [...expectedConstraints].some((constraintId) => !constraintReviews.has(constraintId))) {
    throw new Error(`${scenario.id}/${run.modelTier} independent hard-constraint adjudication is incomplete`);
  }
  const durationMs = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error(`${scenario.id}/${run.modelTier} has invalid persisted timing`);
  const reviews = run.tracks.map((track) => reviewByCandidate.get(track.candidateId)!);
  const catalogIdentityPrecision = meanBoolean(reviews.map(({ catalogIdentityCorrect }) => catalogIdentityCorrect));
  const relevancePrecision = meanBoolean(reviews.map(({ relevant }) => relevant));
  const evidenceCoverage = meanBoolean(reviews.map(({ evidenceEligible }) => evidenceEligible));
  const hardConstraintCompliance = meanBoolean([...constraintReviews.values()].map(({ compliant }) => compliant));
  const publishedCount = run.tracks.length;
  const publishedRatio = publishedCount / scenario.targetCount;
  const exactFill = publishedCount === scenario.targetCount;
  const failures: string[] = [];
  const missingEvidenceAxes = reviews.some((review) => scenario.requiredEvidenceAxes
    .some((axis) => !review.evidenceAxes.includes(axis)));
  if (publishedCount > scenario.targetCount) failures.push("published_count_exceeds_target");
  if (scenario.exactFillRequired && !exactFill) failures.push("exact_fill_shortfall");
  if (publishedRatio < scenario.minimumPublishedRatio) failures.push("minimum_fill_ratio_shortfall");
  if (run.actualCostUsd > scenario.maximumCostUsd) failures.push("cost_ceiling_exceeded");
  if (catalogIdentityPrecision === null || catalogIdentityPrecision < suite.thresholds.catalogIdentityPrecision) failures.push("catalog_identity_precision_below_threshold");
  if (relevancePrecision === null || relevancePrecision < suite.thresholds.relevancePrecision) failures.push("relevance_precision_below_threshold");
  if (evidenceCoverage === null || evidenceCoverage < suite.thresholds.evidenceCoverage) failures.push("evidence_coverage_below_threshold");
  if (missingEvidenceAxes) failures.push("required_evidence_axis_missing");
  if (hardConstraintCompliance === null || hardConstraintCompliance < suite.thresholds.hardConstraintCompliance) failures.push("hard_constraint_violation");
  if (exactFill && !COMPLETE_OUTCOMES.has(run.outcome)) failures.push("exact_fill_has_non_complete_outcome");
  if (!exactFill && !SAFE_PARTIAL_OUTCOMES.has(run.outcome)) failures.push("shortfall_is_not_a_typed_safe_partial");
  return {
    scenarioId: scenario.id,
    modelTier: run.modelTier,
    modelSnapshot: run.modelSnapshot,
    targetCount: scenario.targetCount,
    publishedCount,
    publishedRatio,
    exactFill,
    durationMs,
    actualCostUsd: run.actualCostUsd,
    catalogIdentityPrecision,
    relevancePrecision,
    evidenceCoverage,
    hardConstraintCompliance,
    failures,
    passed: failures.length === 0,
  };
}

export function evaluatePipelineV2ReleaseBenchmark(
  suiteInput: unknown,
  resultsInput: unknown,
): PipelineV2BenchmarkReport {
  const suite = parsePipelineV2BenchmarkSuite(suiteInput);
  const artifact = parsePipelineV2BenchmarkResults(resultsInput);
  const suiteSha256 = benchmarkSuiteHash(suite);
  if (artifact.fixtureVersion !== suite.fixtureVersion || artifact.suiteSha256 !== suiteSha256) {
    throw new Error("Pipeline V2 benchmark results are not bound to this frozen suite");
  }
  const expectedPairs = suite.scenarios.flatMap(({ id }) => MODEL_TIERS.map((tier) => `${id}\u0000${tier}`));
  const runPairs = artifact.runs.map((run) => `${run.scenarioId}\u0000${run.modelTier}`);
  if (new Set(runPairs).size !== runPairs.length
    || runPairs.length !== expectedPairs.length
    || expectedPairs.some((pair) => !runPairs.includes(pair))) {
    throw new Error("Pipeline V2 benchmark results must contain exactly one Luna and one Terra run per frozen scenario");
  }
  const scenarios = new Map(suite.scenarios.map((scenario) => [scenario.id, scenario]));
  const runs = artifact.runs.map((run) => evaluateRun(suite, scenarios.get(run.scenarioId)!, run));
  const models = Object.fromEntries(MODEL_TIERS.map((modelTier) => {
    const tierRuns = runs.filter((run) => run.modelTier === modelTier);
    const sourceRuns = artifact.runs.filter((run) => run.modelTier === modelTier);
    const allReviews = sourceRuns.flatMap((run) => run.adjudication.trackReviews);
    const allConstraints = sourceRuns.flatMap((run) => run.adjudication.constraintReviews);
    const exactFillRuns = tierRuns.filter((run) => scenarios.get(run.scenarioId)!.exactFillRequired);
    const exactFillRate = exactFillRuns.length === 0 ? 0 : exactFillRuns.filter(({ exactFill }) => exactFill).length / exactFillRuns.length;
    const latency = Object.fromEntries(LATENCY_TIERS.map((latencyTier) => {
      const durations = tierRuns
        .filter((run) => scenarios.get(run.scenarioId)!.latencyTier === latencyTier)
        .map(({ durationMs }) => durationMs);
      const p50Ms = percentile(durations, 0.5);
      const p95Ms = percentile(durations, 0.95);
      const threshold = suite.latencyThresholds[latencyTier];
      return [latencyTier, {
        sampleSize: durations.length,
        p50Ms,
        p95Ms,
        passed: durations.length > 0 && p50Ms !== null && p95Ms !== null
          && p50Ms <= threshold.p50Ms && p95Ms <= threshold.p95Ms,
      }];
    })) as PipelineV2BenchmarkModelReport["latency"];
    const catalogIdentityPrecision = meanBoolean(allReviews.map(({ catalogIdentityCorrect }) => catalogIdentityCorrect));
    const relevancePrecision = meanBoolean(allReviews.map(({ relevant }) => relevant));
    const evidenceCoverage = meanBoolean(allReviews.map(({ evidenceEligible }) => evidenceEligible));
    const hardConstraintCompliance = meanBoolean(allConstraints.map(({ compliant }) => compliant));
    const failures: string[] = [];
    if (tierRuns.some(({ passed }) => !passed)) failures.push("one_or_more_scenarios_failed");
    if (exactFillRate < suite.thresholds.exactFillRate) failures.push("exact_fill_rate_below_threshold");
    if (catalogIdentityPrecision === null || catalogIdentityPrecision < suite.thresholds.catalogIdentityPrecision) failures.push("aggregate_catalog_identity_precision_below_threshold");
    if (relevancePrecision === null || relevancePrecision < suite.thresholds.relevancePrecision) failures.push("aggregate_relevance_precision_below_threshold");
    if (evidenceCoverage === null || evidenceCoverage < suite.thresholds.evidenceCoverage) failures.push("aggregate_evidence_coverage_below_threshold");
    if (hardConstraintCompliance === null || hardConstraintCompliance < suite.thresholds.hardConstraintCompliance) failures.push("aggregate_hard_constraint_compliance_below_threshold");
    if (Object.values(latency).some(({ passed }) => !passed)) failures.push("latency_threshold_failed");
    const report: PipelineV2BenchmarkModelReport = {
      modelTier,
      modelSnapshots: [...new Set(tierRuns.map(({ modelSnapshot }) => modelSnapshot))].sort(),
      runCount: tierRuns.length,
      actualCostUsd: tierRuns.reduce((total, run) => total + run.actualCostUsd, 0),
      exactFillRate,
      catalogIdentityPrecision,
      relevancePrecision,
      evidenceCoverage,
      hardConstraintCompliance,
      latency,
      failures,
      passed: failures.length === 0,
    };
    if (report.modelSnapshots.length !== 1) {
      report.failures.push("model_snapshot_not_pinned");
      report.passed = false;
    }
    return [modelTier, report];
  })) as Record<BenchmarkModelTier, PipelineV2BenchmarkModelReport>;

  if (models.luna.modelSnapshots.length === 1
    && models.terra.modelSnapshots.length === 1
    && models.luna.modelSnapshots[0] === models.terra.modelSnapshots[0]) {
    for (const tier of MODEL_TIERS) {
      models[tier].failures.push("luna_terra_snapshots_are_identical");
      models[tier].passed = false;
    }
  }

  const passing = MODEL_TIERS.filter((tier) => models[tier].passed);
  let selectedModelTier: BenchmarkModelTier | null = null;
  let selectionReason: PipelineV2BenchmarkReport["selectionReason"] = "no_model_passed";
  if (passing.length === 1) {
    selectedModelTier = passing[0]!;
    selectionReason = "only_passing_model";
  } else if (passing.length === 2) {
    const [left, right] = passing as [BenchmarkModelTier, BenchmarkModelTier];
    const difference = models[left].actualCostUsd - models[right].actualCostUsd;
    if (Math.abs(difference) > 0.000001) {
      selectedModelTier = difference < 0 ? left : right;
      selectionReason = "lower_cost";
    } else {
      const latencyTotal = (tier: BenchmarkModelTier) => Object.values(models[tier].latency)
        .reduce((total, value) => total + (value.p50Ms ?? Number.MAX_SAFE_INTEGER), 0);
      selectedModelTier = latencyTotal(left) <= latencyTotal(right) ? left : right;
      selectionReason = "lower_latency_tiebreak";
    }
  }
  return {
    fixtureVersion: suite.fixtureVersion,
    suiteSha256,
    artifactSha256: artifact.artifactSha256,
    runs,
    models,
    selectedModelTier,
    selectionReason,
    passed: selectedModelTier !== null,
  };
}
