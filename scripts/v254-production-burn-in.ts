import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  releaseGateProducerKeyFingerprint,
} from "./release-evidence.ts";
import {
  validateReleaseGateArtifact,
  verifyReleaseGateProducerAttestation,
} from "./release-fixtures.ts";
import {
  validateNativeSchema20PromotionReceipt,
} from "./finalize-native-schema20-release.ts";
import {
  verifyV254DirectExposureAuthorityAndWarrantV1,
  type V254DirectExposureExpectedV1,
} from "../shared/v254-direct-exposure-authority.ts";
import {
  signedArtifactSha256,
} from "../shared/signed-artifact.ts";
import {
  parseExecutionRouteReceiptV1,
} from "../server/execution-route-receipt-v1.ts";
import {
  assertGuidanceWorkerConsumptionReceiptV5,
} from "../server/guidance-worker-consumption-v5.ts";
import {
  auditSemanticCollapseV2,
} from "../server/semantic-collapse-audit-v2.ts";
import {
  parseSemanticCollapseCoverageV2,
} from "../server/semantic-collapse-coverage-v2.ts";
import {
  sitesRevisionFromHtml,
  sitesVersionFromHtml,
} from "./verify-release-convergence.ts";

type JsonRecord = Record<string, unknown>;

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE =
  /^ghcr\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{2,79}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RUN_ID = /^[1-9]\d*$/u;
const EXACT_ORIGIN = "https://9enio.com";
const EXISTING_SITES_PROJECT_ID =
  "appgprj_6a5565cf7d6c8191ab9f2084e8eda856";
export const V254_BURN_IN_REQUIRED_DURATION_MS = 24 * 60 * 60_000;
export const V254_BURN_IN_MAX_OBSERVATION_GAP_MS = 15 * 60_000;
export const V254_BURN_IN_MINIMUM_SAMPLES = 97;
export const V254_BURN_IN_MAX_SEGMENT_MS = 5.5 * 60 * 60_000;

const VIOLATION_KEYS = Object.freeze([
  "nullCandidateQualifications",
  "falseScarcity",
  "counterDivergence",
  "actionlessDecisions",
  "unchangedSemanticRetries",
  "falseLiveStates",
  "newAppleOrphans",
  "appleOrderedIdMismatches",
  "ownerPublicRouteDivergence",
] as const);

export type V254BurnInViolationKey = typeof VIOLATION_KEYS[number];

export type V254BurnInViolationCounts = Readonly<Record<
  V254BurnInViolationKey,
  number
>>;

export interface V254BurnInBindingV1 {
  schemaVersion: "genio-v254-production-burn-in-binding/v2";
  candidate: {
    tag: string;
    version: string;
    sourceRevision: string;
    imageReference: string;
    imageDigest: string;
  };
  backend: {
    promotionReceiptHash: string;
    semanticBehaviorManifestHash: string;
    semanticExecutionConfigurationHash: string;
    containmentReceiptHash: string;
    guidanceCheckpointMigrationReceiptHash: string;
    legacyExecutionRouteDrainInventoryReceiptHash: string;
    schema20EvidenceRecoveryReceiptHash: string;
    railwayProjectId: string;
    services: {
      interactive: { serviceId: string; deploymentId: string };
      deep: { serviceId: string; deploymentId: string };
      api: { serviceId: string; deploymentId: string };
    };
  };
  sites: {
    projectId: string;
    versionId: string;
    deploymentId: string;
    archiveSha256: string;
    controlPlaneEvidenceHash: string;
    sourceRevision: string;
  };
  route: {
    executionRoute: "corpus_first_v3";
    intentGroup: "editorial_influence";
    contractVersion: 3;
    guidanceVersion: "adaptive_guidance_v5";
    queryPlanSchema: 6;
    directExposureAuthorityPayloadHash: string;
    directExposureAuthorityArtifactHash: string;
    rollbackWarrantPayloadHash: string;
    rollbackWarrantArtifactHash: string;
    preconditionsHash: string;
    rollbackPlanHash: string;
    targetConfigurationHash: string;
    preExposureSemanticConfigurationHash: string;
    postExposureSemanticConfigurationHash: string;
    rollbackSemanticConfigurationHash: string;
    preExposureRuntimeTupleHash: string;
    postExposureRuntimeTupleHash: string;
    rollbackRuntimeTupleHash: string;
    databaseActivateReceiptHash: string;
    runtimeTransitionReceiptHash: string;
    directExposureStage:
      "editorial_influence:0->100:fully_exposed_unproven";
    exposureClass: "fully_exposed_unproven";
    organicReliabilityProven: false;
    directAssignmentHash: string;
    publicQuestionSetHash: string;
    publicQuestionHash: string;
    ownerAppleGateEvidenceHash: string;
    preExposureCleanGateEvidenceHash: string;
    databaseRouteReceiptHash: string;
  };
  evidence: {
    finalBrowserEvidenceHash: string;
    finalBrowserConfigurationHash: string;
    finalBrowserRuntimeHash: string;
    finalBrowserCompletedAt: string;
  };
  bindingHash: string;
}

export interface V254BurnInTrafficCountsV1 {
  publicOrganic: { briefs: number; runs: number };
  ownerCanary: { briefs: number; runs: number };
  synthetic: { briefs: number; runs: number };
  replay: { briefs: number; runs: number };
  /**
   * Fresh, signed, non-owner editorial-influence runs whose Guidance V5
   * answer, successor contract, query plan, and worker-consumption receipt
   * form one valid execution lineage. This is deliberately narrower than
   * `publicOrganic`: a legacy/control run cannot satisfy the burn-in gate.
   */
  cleanNonOwnerEditorialInfluence: { briefs: number; runs: number };
}

export interface V254BurnInDatabaseSnapshotV1 {
  schemaVersion: "genio-v254-burn-in-database-snapshot/v1";
  observedAt: string;
  windowStartedAt: string;
  sourceRevision: string;
  semanticExecutionConfigurationHash: string;
  traffic: V254BurnInTrafficCountsV1;
  violations: V254BurnInViolationCounts;
  trip: null | {
    incidentSignature: string;
    route: "corpus_first_v3";
    intentGroup: "editorial_influence";
    reasonCode: "v254_burn_in_invariant_trip";
  };
  snapshotHash: string;
}

export interface V254BurnInObservationV1 {
  observedAt: string;
  health: {
    liveStatus: 200;
    readyStatus: 200;
    systemStatus: 200;
    sitesVersion: string;
    sitesRevision: string;
    schemaVersion: "20";
    workerProtocol: "playlist-pipeline-v12";
    apiConfigurationHash: string;
    interactiveConfigurationHash: string;
    deepConfigurationHash: string;
    semanticExecutionConfigurationHash: string;
    standardRolloutAuthorityActive: false;
    directExposureActive: true;
    directExposureState: "active";
    directExposureAuthorityPayloadHash: string;
    directExposureRollbackWarrantPayloadHash: string;
    directExposureStage:
      "editorial_influence:0->100:fully_exposed_unproven";
    directExposureTargetConfigurationHash: string;
    exposureClass: "fully_exposed_unproven";
    organicReliabilityProven: false;
    healthHash: string;
  };
  database: V254BurnInDatabaseSnapshotV1;
  observationHash: string;
}

export interface V254ProductionBurnInReceiptV1 {
  schemaVersion: "genio-v254-production-burn-in/v1";
  status: "monitoring" | "complete";
  binding: V254BurnInBindingV1;
  producer: {
    repository: string;
    workflow: ".github/workflows/v254-production-burn-in.yml";
    runId: string;
    runAttempt: number;
    headSha: string;
  };
  window: {
    startedAt: string;
    observedThrough: string;
    elapsedMs: number;
    requiredDurationMs: typeof V254_BURN_IN_REQUIRED_DURATION_MS;
  };
  chain: {
    segmentOrdinal: number;
    chainRootHash: string;
    priorCheckpointHash: string | null;
    cumulativeObservationHash: string;
  };
  monitoring: {
    sampleCount: number;
    maximumObservationGapMs: number;
    lastObservationHash: string;
    traffic: V254BurnInTrafficCountsV1;
    violations: V254BurnInViolationCounts;
  };
  completedAt: string | null;
  receiptHash: string;
}

export interface V254BurnInRuntime {
  now(): number;
  wait(ms: number): Promise<void>;
  fetchJson(url: string): Promise<{ status: number; value: unknown }>;
  fetchText(url: string): Promise<{ status: number; value: string }>;
  databaseSnapshot(input: {
    windowStartedAt: string;
    sourceRevision: string;
    semanticExecutionConfigurationHash: string;
  }): Promise<V254BurnInDatabaseSnapshotV1>;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function string(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => (
        left < right ? -1 : left > right ? 1 : 0
      ))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => (
        typeof item === "string" && item.trim().length > 0
      ))
    : [];
}

function advancingDecisionAction(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as JsonRecord;
  if (action.kind === "another_bounded_pass") return true;
  if (action.kind === "review_named_constraint") {
    return stringArray(action.clauseIds).length > 0
      && stringArray(action.options).length >= 2;
  }
  if (action.kind === "resume_at") {
    return typeof action.nextRetryAt === "string"
      && Number.isFinite(Date.parse(action.nextRetryAt))
      && typeof action.blockerId === "string"
      && action.blockerId.trim().length > 0;
  }
  if (action.kind === "replay_after_repair") {
    return typeof action.incidentRef === "string"
      && action.incidentRef.trim().length > 0;
  }
  if (action.kind === "answer_question") {
    return typeof action.questionSetId === "string"
      && action.questionSetId.trim().length > 0;
  }
  if (action.kind === "approve_partial") {
    return typeof action.manifestId === "string"
      && action.manifestId.trim().length > 0
      && typeof action.consentExpiresAt === "string"
      && Number.isFinite(Date.parse(action.consentExpiresAt));
  }
  return false;
}

/**
 * Recomputes the hash of the immutable run-decision body and binds it to the
 * active contract. The worker appends coverage/audit metadata after the base
 * decision is minted; those extension fields are deliberately not part of
 * `decisionHash`.
 */
export function isValidV254RunDecisionV1(
  value: unknown,
  expected: {
    contractRevisionId: string;
    contractSemanticHash: string;
    requireScarcity?: boolean;
  },
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const decision = value as JsonRecord;
  const body = {
    schemaVersion: decision.schemaVersion,
    contractRevisionId: decision.contractRevisionId,
    contractSemanticHash: decision.contractSemanticHash,
    reason: decision.reason,
    targetTrackCount: decision.targetTrackCount,
    verifiedTrackCount: decision.verifiedTrackCount,
    remainingStrategyCount: decision.remainingStrategyCount,
    consumedActiveComputeMs: decision.consumedActiveComputeMs,
    activeComputeLimitMs: decision.activeComputeLimitMs,
    activeComputeExtensionsUsed: decision.activeComputeExtensionsUsed,
    namedPredicates: decision.namedPredicates,
    interpretationSummary: decision.interpretationSummary,
    actions: decision.actions,
    reachedAt: decision.reachedAt,
  };
  const actions = decision.actions;
  const hasBaseAdvancingAction = Boolean(
    actions
    && typeof actions === "object"
    && !Array.isArray(actions)
    && (
      (actions as JsonRecord).anotherBoundedPass === true
      || (actions as JsonRecord).reviseNamedPredicate === true
      || (actions as JsonRecord).reduceCount === true
      || (actions as JsonRecord).publishVerifiedPartial === true
      || (actions as JsonRecord).resumeLater === true
    )
  );
  const hasTypedAdvancingAction = Array.isArray(decision.advancingActions)
    && decision.advancingActions.some(advancingDecisionAction);
  return decision.schemaVersion === "genio-run-decision/v1"
    && decision.contractRevisionId === expected.contractRevisionId
    && decision.contractSemanticHash === expected.contractSemanticHash
    && typeof decision.decisionHash === "string"
    && SHA256.test(decision.decisionHash)
    && decision.decisionHash === sha256(body)
    && typeof decision.reachedAt === "string"
    && Number.isFinite(Date.parse(decision.reachedAt))
    && (!expected.requireScarcity
      || (
        decision.reason === "frontier_exhausted_under_policy"
        && decision.reasonCode === "frontier_exhausted_under_policy"
      ))
    && (hasBaseAdvancingAction || hasTypedAdvancingAction);
}

export function isValidV254ScarcityProofV2(input: {
  coverage: unknown;
  audit: unknown;
  decision: unknown;
  contractRevisionId: string;
  contractSemanticHash: string;
}): boolean {
  const coverage = parseSemanticCollapseCoverageV2(input.coverage);
  if (!coverage
    || coverage.telemetryDivergenceCodes.length > 0
    || coverage.nullCandidateQualificationCount !== 0) {
    return false;
  }
  const recomputed = auditSemanticCollapseV2(coverage);
  if (!input.audit
    || typeof input.audit !== "object"
    || Array.isArray(input.audit)) {
    return false;
  }
  const audit = input.audit as JsonRecord;
  const auditMatches = audit.version === recomputed.version
    && audit.triggered === recomputed.triggered
    && audit.disposition === recomputed.disposition
    && audit.reasonCode === recomputed.reasonCode
    && JSON.stringify(stable(audit.signalCodes))
      === JSON.stringify(stable(recomputed.signalCodes))
    && JSON.stringify(stable(audit.limitingObligationIds))
      === JSON.stringify(stable(recomputed.limitingObligationIds))
    && JSON.stringify(stable(audit.independentDependencyRootIds))
      === JSON.stringify(stable(recomputed.independentDependencyRootIds))
    && (audit.nextRetryAt ?? null) === recomputed.nextRetryAt
    && audit.auditHash === recomputed.auditHash
    && audit.coverageHash === coverage.coverageHash
    && audit.queryPlanHash === coverage.queryPlanHash;
  if (!auditMatches
    || recomputed.disposition !== "scarcity_decision"
    || recomputed.reasonCode !== "frontier_exhausted_under_policy"
    || recomputed.limitingObligationIds.length === 0
    || recomputed.independentDependencyRootIds.length < 2) {
    return false;
  }
  if (!isValidV254RunDecisionV1(input.decision, {
    contractRevisionId: input.contractRevisionId,
    contractSemanticHash: input.contractSemanticHash,
    requireScarcity: true,
  })) {
    return false;
  }
  const decision = input.decision as JsonRecord;
  return decision.coverageHash === coverage.coverageHash
    && decision.auditHash === recomputed.auditHash
    && JSON.stringify(stable(decision.limitingObligationIds))
      === JSON.stringify(stable(recomputed.limitingObligationIds))
    && JSON.stringify(stable(decision.independentDependencyRootIds))
      === JSON.stringify(stable(recomputed.independentDependencyRootIds));
}

export function isValidV254RouteReceiptV1(input: {
  receipt: unknown;
  sourceRevision: string;
  semanticExecutionConfigurationHash: string;
}): boolean {
  const receipt = parseExecutionRouteReceiptV1(input.receipt);
  return receipt !== null
    && receipt.executionRoute === "corpus_first_v3"
    && receipt.assignmentAuthority.intentGroup === "editorial_influence"
    && receipt.contractVersion === 3
    && receipt.guidanceVersion === "adaptive_guidance_v5"
    && receipt.queryPlanSchema === 6
    && receipt.releaseRevision === input.sourceRevision
    && receipt.executorConfigurationHash
      === input.semanticExecutionConfigurationHash
    && (
      ((receipt.trafficClass === "public"
        || receipt.trafficClass === "synthetic"
        || receipt.trafficClass === "replay")
        && receipt.assignmentAuthority.kind
          === "signed_public_direct_exposure")
      || (receipt.trafficClass === "owner_canary"
        && receipt.assignmentAuthority.kind === "signed_owner_canary")
    );
}

export function isValidV254WorkerConsumptionReceiptV5(
  value: unknown,
): boolean {
  try {
    assertGuidanceWorkerConsumptionReceiptV5(value);
    return true;
  } catch {
    return false;
  }
}

function withoutHash(value: JsonRecord, key: string): JsonRecord {
  const unsigned = { ...value };
  delete unsigned[key];
  return unsigned;
}

function zeroViolations(): Record<V254BurnInViolationKey, number> {
  return Object.fromEntries(VIOLATION_KEYS.map((key) => [key, 0])) as
    Record<V254BurnInViolationKey, number>;
}

function zeroTraffic(): V254BurnInTrafficCountsV1 {
  return {
    publicOrganic: { briefs: 0, runs: 0 },
    ownerCanary: { briefs: 0, runs: 0 },
    synthetic: { briefs: 0, runs: 0 },
    replay: { briefs: 0, runs: 0 },
    cleanNonOwnerEditorialInfluence: { briefs: 0, runs: 0 },
  };
}

function validateTraffic(
  value: unknown,
  label: string,
): V254BurnInTrafficCountsV1 {
  const traffic = record(value, label);
  exactKeys(
    traffic,
    [
      "publicOrganic",
      "ownerCanary",
      "synthetic",
      "replay",
      "cleanNonOwnerEditorialInfluence",
    ],
    label,
  );
  const parsed = zeroTraffic();
  for (const trafficClass of Object.keys(parsed) as
    Array<keyof V254BurnInTrafficCountsV1>) {
    const item = record(traffic[trafficClass], `${label}.${trafficClass}`);
    exactKeys(item, ["briefs", "runs"], `${label}.${trafficClass}`);
    parsed[trafficClass] = {
      briefs: count(item.briefs, `${label}.${trafficClass}.briefs`),
      runs: count(item.runs, `${label}.${trafficClass}.runs`),
    };
  }
  return parsed;
}

function validateViolations(
  value: unknown,
  label: string,
): V254BurnInViolationCounts {
  const violations = record(value, label);
  exactKeys(violations, VIOLATION_KEYS, label);
  const parsed = zeroViolations();
  for (const key of VIOLATION_KEYS) {
    parsed[key] = count(violations[key], `${label}.${key}`);
  }
  return parsed;
}

function assertZeroViolations(violations: V254BurnInViolationCounts): void {
  const tripped = VIOLATION_KEYS.filter((key) => violations[key] !== 0);
  if (tripped.length > 0) {
    throw new Error(`production burn-in tripped: ${tripped.join(",")}`);
  }
}

function addTraffic(
  left: V254BurnInTrafficCountsV1,
  right: V254BurnInTrafficCountsV1,
): V254BurnInTrafficCountsV1 {
  const result = zeroTraffic();
  for (const trafficClass of Object.keys(result) as
    Array<keyof V254BurnInTrafficCountsV1>) {
    result[trafficClass] = {
      briefs: left[trafficClass].briefs + right[trafficClass].briefs,
      runs: left[trafficClass].runs + right[trafficClass].runs,
    };
  }
  return result;
}

function option(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function validateV254BurnInBindingV1(
  value: unknown,
): V254BurnInBindingV1 {
  const binding = record(value, "burn-in binding");
  exactKeys(binding, [
    "schemaVersion",
    "candidate",
    "backend",
    "sites",
    "route",
    "evidence",
    "bindingHash",
  ], "burn-in binding");
  if (binding.schemaVersion !== "genio-v254-production-burn-in-binding/v2") {
    throw new Error("burn-in binding uses an unsupported schema");
  }
  const candidate = record(binding.candidate, "burn-in candidate");
  exactKeys(candidate, [
    "tag", "version", "sourceRevision", "imageReference", "imageDigest",
  ], "burn-in candidate");
  const version = string(candidate.version, "burn-in version", VERSION);
  string(
    candidate.tag,
    "burn-in candidate tag",
    new RegExp(`^v${version.replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`, "u"),
  );
  string(candidate.sourceRevision, "burn-in source revision", SHA1);
  const imageDigest = string(
    candidate.imageDigest,
    "burn-in image digest",
    IMAGE_DIGEST,
  );
  if (!string(
    candidate.imageReference,
    "burn-in image reference",
    IMAGE_REFERENCE,
  ).endsWith(`@${imageDigest}`)) {
    throw new Error("burn-in image reference and digest differ");
  }
  const backend = record(binding.backend, "burn-in backend");
  exactKeys(backend, [
    "promotionReceiptHash",
    "semanticBehaviorManifestHash",
    "semanticExecutionConfigurationHash",
    "containmentReceiptHash",
    "guidanceCheckpointMigrationReceiptHash",
    "legacyExecutionRouteDrainInventoryReceiptHash",
    "schema20EvidenceRecoveryReceiptHash",
    "railwayProjectId",
    "services",
  ], "burn-in backend");
  for (const key of [
    "promotionReceiptHash",
    "semanticBehaviorManifestHash",
    "semanticExecutionConfigurationHash",
    "containmentReceiptHash",
    "guidanceCheckpointMigrationReceiptHash",
    "legacyExecutionRouteDrainInventoryReceiptHash",
    "schema20EvidenceRecoveryReceiptHash",
  ]) string(backend[key], `burn-in backend.${key}`, SHA256);
  string(backend.railwayProjectId, "burn-in Railway project", UUID);
  const services = record(backend.services, "burn-in services");
  exactKeys(services, ["interactive", "deep", "api"], "burn-in services");
  for (const lane of ["interactive", "deep", "api"] as const) {
    const service = record(services[lane], `burn-in ${lane} service`);
    exactKeys(service, ["serviceId", "deploymentId"], `burn-in ${lane} service`);
    string(service.serviceId, `burn-in ${lane} service ID`, UUID);
    string(service.deploymentId, `burn-in ${lane} deployment ID`, UUID);
  }
  const sites = record(binding.sites, "burn-in Sites");
  exactKeys(sites, [
    "projectId", "versionId", "deploymentId", "archiveSha256",
    "controlPlaneEvidenceHash", "sourceRevision",
  ], "burn-in Sites");
  if (sites.projectId !== EXISTING_SITES_PROJECT_ID) {
    throw new Error("burn-in Sites binding does not use the existing project");
  }
  for (const key of ["versionId", "deploymentId"] as const) {
    if (typeof sites[key] !== "string" || !sites[key]) {
      throw new Error(`burn-in Sites ${key} is invalid`);
    }
  }
  string(sites.archiveSha256, "burn-in Sites archive hash", SHA256);
  string(sites.controlPlaneEvidenceHash, "burn-in Sites evidence hash", SHA256);
  if (sites.sourceRevision !== candidate.sourceRevision) {
    throw new Error("burn-in Sites source differs from the candidate");
  }
  const route = record(binding.route, "burn-in route");
  exactKeys(route, [
    "executionRoute", "intentGroup", "contractVersion", "guidanceVersion",
    "queryPlanSchema", "directExposureAuthorityPayloadHash",
    "directExposureAuthorityArtifactHash", "rollbackWarrantPayloadHash",
    "rollbackWarrantArtifactHash", "preconditionsHash", "rollbackPlanHash",
    "targetConfigurationHash", "preExposureSemanticConfigurationHash",
    "postExposureSemanticConfigurationHash",
    "rollbackSemanticConfigurationHash", "preExposureRuntimeTupleHash",
    "postExposureRuntimeTupleHash", "rollbackRuntimeTupleHash",
    "databaseActivateReceiptHash", "runtimeTransitionReceiptHash",
    "directExposureStage", "exposureClass", "organicReliabilityProven",
    "directAssignmentHash", "publicQuestionSetHash", "publicQuestionHash",
    "ownerAppleGateEvidenceHash", "preExposureCleanGateEvidenceHash",
    "databaseRouteReceiptHash",
  ], "burn-in route");
  if (
    route.executionRoute !== "corpus_first_v3"
    || route.intentGroup !== "editorial_influence"
    || route.contractVersion !== 3
    || route.guidanceVersion !== "adaptive_guidance_v5"
    || route.queryPlanSchema !== 6
    || route.directExposureStage
      !== "editorial_influence:0->100:fully_exposed_unproven"
    || route.exposureClass !== "fully_exposed_unproven"
    || route.organicReliabilityProven !== false
    || route.preExposureSemanticConfigurationHash
      !== route.rollbackSemanticConfigurationHash
    || route.preExposureSemanticConfigurationHash
      === route.postExposureSemanticConfigurationHash
    || route.postExposureSemanticConfigurationHash
      !== backend.semanticExecutionConfigurationHash
  ) throw new Error("burn-in route does not bind public editorial V5");
  for (const key of [
    "directExposureAuthorityPayloadHash",
    "directExposureAuthorityArtifactHash",
    "rollbackWarrantPayloadHash",
    "rollbackWarrantArtifactHash",
    "preconditionsHash",
    "rollbackPlanHash",
    "targetConfigurationHash",
    "preExposureSemanticConfigurationHash",
    "postExposureSemanticConfigurationHash",
    "rollbackSemanticConfigurationHash",
    "preExposureRuntimeTupleHash",
    "postExposureRuntimeTupleHash",
    "rollbackRuntimeTupleHash",
    "databaseActivateReceiptHash",
    "runtimeTransitionReceiptHash",
    "directAssignmentHash",
    "publicQuestionSetHash",
    "publicQuestionHash",
    "ownerAppleGateEvidenceHash",
    "preExposureCleanGateEvidenceHash",
    "databaseRouteReceiptHash",
  ]) string(route[key], `burn-in route.${key}`, SHA256);
  const evidence = record(binding.evidence, "burn-in evidence");
  exactKeys(evidence, [
    "finalBrowserEvidenceHash",
    "finalBrowserConfigurationHash",
    "finalBrowserRuntimeHash",
    "finalBrowserCompletedAt",
  ], "burn-in evidence");
  for (const key of [
    "finalBrowserEvidenceHash",
    "finalBrowserConfigurationHash",
    "finalBrowserRuntimeHash",
  ]) string(evidence[key], `burn-in evidence.${key}`, SHA256);
  timestamp(evidence.finalBrowserCompletedAt, "burn-in browser completion time");
  const bindingHash = string(binding.bindingHash, "burn-in binding hash", SHA256);
  if (bindingHash !== sha256(withoutHash(binding, "bindingHash"))) {
    throw new Error("burn-in binding hash is invalid");
  }
  return binding as unknown as V254BurnInBindingV1;
}

export async function createV254BurnInBindingV1(input: {
  candidateTag: string;
  sourceRevision: string;
  version: string;
  backendPromotionPath: string;
  directExposureAuthorityPath: string;
  directExposureRollbackWarrantPath: string;
  directExposureDatabaseActivateReceiptPath: string;
  directExposureRuntimeReceiptPath: string;
  finalBrowserArtifactPath: string;
  finalBrowserAttestationPath: string;
  producerVerificationKeyPath: string;
  producerKeyId: string;
  producerKeySha256: string;
  directExposureVerificationKeyPath: string;
  directExposureKeyId: string;
  directExposureKeySha256: string;
}): Promise<V254BurnInBindingV1> {
  const [
    promotionValue,
    directAuthorityValue,
    rollbackWarrantValue,
    databaseActivateValue,
    runtimeTransitionValue,
    artifactValue,
    attestationValue,
    producerKey,
    directExposureKey,
  ] =
    await Promise.all([
      readFile(input.backendPromotionPath, "utf8").then(JSON.parse),
      readFile(input.directExposureAuthorityPath, "utf8").then(JSON.parse),
      readFile(input.directExposureRollbackWarrantPath, "utf8").then(JSON.parse),
      readFile(
        input.directExposureDatabaseActivateReceiptPath,
        "utf8",
      ).then(JSON.parse),
      readFile(input.directExposureRuntimeReceiptPath, "utf8").then(JSON.parse),
      readFile(input.finalBrowserArtifactPath, "utf8").then(JSON.parse),
      readFile(input.finalBrowserAttestationPath, "utf8").then(JSON.parse),
      readFile(input.producerVerificationKeyPath),
      readFile(input.directExposureVerificationKeyPath),
    ]);
  if (releaseGateProducerKeyFingerprint(producerKey) !== input.producerKeySha256) {
    throw new Error("burn-in producer key is not the protected key");
  }
  const promotion = validateNativeSchema20PromotionReceipt(promotionValue, {
    sourceRevision: input.sourceRevision,
    version: input.version,
  });
  const authorityEnvelope = record(
    directAuthorityValue,
    "burn-in direct-exposure authority",
  );
  const authorityPayload = record(
    authorityEnvelope.payload,
    "burn-in direct-exposure authority payload",
  );
  const authorityCandidate = record(
    authorityPayload.candidate,
    "burn-in direct-exposure candidate",
  );
  const authorityPromotion = record(
    authorityPayload.promotion,
    "burn-in direct-exposure promotion",
  );
  const authorityProofs = record(
    authorityPayload.proofs,
    "burn-in direct-exposure proofs",
  );
  const ownerProof = record(
    authorityProofs.ownerApple,
    "burn-in direct-exposure owner proof",
  );
  const cleanProof = record(
    authorityProofs.cleanNonOwner,
    "burn-in direct-exposure clean proof",
  );
  const routeProof = record(
    authorityProofs.databaseRouteAuthority,
    "burn-in direct-exposure database route proof",
  );
  const directExpected: V254DirectExposureExpectedV1 = {
    keyId: input.directExposureKeyId,
    keySha256: input.directExposureKeySha256,
    candidate: authorityCandidate as unknown as
      V254DirectExposureExpectedV1["candidate"],
    signedNativePromotionAuthorityHash:
      String(authorityPromotion.signedNativePromotionAuthorityHash ?? ""),
    nativePromotionReceiptHash:
      String(authorityPromotion.nativePromotionReceiptHash ?? ""),
    configurationHash: String(authorityPromotion.configurationHash ?? ""),
    runtimeHash: String(authorityPromotion.runtimeHash ?? ""),
    semanticBehaviorHash:
      String(authorityPromotion.semanticBehaviorHash ?? ""),
    sites: {
      projectId: String(authorityPromotion.sitesProjectId ?? ""),
      versionId: String(authorityPromotion.sitesVersionId ?? ""),
      deploymentId: String(authorityPromotion.sitesDeploymentId ?? ""),
      revision: String(authorityPromotion.sitesRevision ?? ""),
    },
    runtimeTransition: authorityPromotion.runtimeTransition as
      V254DirectExposureExpectedV1["runtimeTransition"],
    ownerAppleGateEvidenceHash: String(ownerProof.gateEvidenceHash ?? ""),
    cleanNonOwnerGateEvidenceHash: String(cleanProof.gateEvidenceHash ?? ""),
    databaseRouteReceiptHash: String(routeProof.receiptHash ?? ""),
    currentConfiguration: authorityPayload.currentConfiguration as
      V254DirectExposureExpectedV1["currentConfiguration"],
    targetConfiguration: authorityPayload.targetConfiguration as
      V254DirectExposureExpectedV1["targetConfiguration"],
    // Burn-in verifies the immutable historical authorization signature. The
    // database activation receipt below proves it was applied before expiry.
    now: String(authorityPayload.generatedAt ?? ""),
  };
  const direct = verifyV254DirectExposureAuthorityAndWarrantV1({
    authority: directAuthorityValue,
    rollbackWarrant: rollbackWarrantValue,
    verificationKey: directExposureKey,
    expected: directExpected,
  });
  if (
    direct.candidate.tag !== input.candidateTag
    || direct.candidate.version !== input.version
    || direct.candidate.sourceRevision !== input.sourceRevision
    || direct.candidate.imageReference !== promotion.imageReference
    || direct.candidate.imageDigest !== promotion.imageDigest
    || authorityPromotion.nativePromotionReceiptHash !== promotion.receiptHash
    || authorityPromotion.configurationHash
      !== promotion.semanticExecutionConfigurationHash
    || authorityPromotion.runtimeHash
      !== promotion.backendConvergenceEvidenceHash
    || authorityPromotion.semanticBehaviorHash
      !== promotion.semanticBehaviorManifestHash
    || authorityPromotion.railwayProjectId !== promotion.projectId
    || direct.exposureClass !== "fully_exposed_unproven"
    || direct.organicReliabilityProven !== false
  ) throw new Error("burn-in direct exposure does not bind native promotion");
  const databaseActivate = record(
    databaseActivateValue,
    "burn-in database activate receipt",
  );
  exactKeys(databaseActivate, [
    "schemaVersion", "operation", "candidateHash", "authorityPayloadHash",
    "rollbackWarrantPayloadHash", "targetConfigurationHash",
    "exposureClass", "organicReliabilityProven", "applied", "state",
    "terminal", "completedAt", "receiptHash",
  ], "burn-in database activate receipt");
  if (
    databaseActivate.schemaVersion
      !== "genio-v254-direct-exposure-apply-receipt/v1"
    || databaseActivate.operation !== "activate"
    || databaseActivate.state !== "active"
    || databaseActivate.terminal !== false
    || (databaseActivate.applied !== true
      && databaseActivate.applied !== false)
    || databaseActivate.authorityPayloadHash
      !== direct.authorityPayloadHash
    || databaseActivate.rollbackWarrantPayloadHash
      !== direct.rollbackWarrantPayloadHash
    || databaseActivate.targetConfigurationHash
      !== direct.targetConfigurationHash
    || databaseActivate.exposureClass !== "fully_exposed_unproven"
    || databaseActivate.organicReliabilityProven !== false
    || databaseActivate.receiptHash
      !== createHash("sha256")
        .update(JSON.stringify(withoutHash(databaseActivate, "receiptHash")))
        .digest("hex")
  ) throw new Error("burn-in database activation receipt is invalid");
  const databaseActivatedAt = timestamp(
    databaseActivate.completedAt,
    "burn-in database activation completion",
  );
  const runtimeTransition = record(
    runtimeTransitionValue,
    "burn-in direct-exposure runtime receipt",
  );
  exactKeys(runtimeTransition, [
    "schemaVersion", "operation", "candidate", "authorityArtifactHash",
    "rollbackWarrantArtifactHash", "authorityPayloadHash",
    "rollbackWarrantPayloadHash", "preconditionsHash", "rollbackPlanHash",
    "semanticConfigurationHash", "runtimeTupleHash", "services",
    "heartbeatFenceHash", "healthHash", "exposureClass",
    "organicReliabilityProven", "completedAt", "receiptHash",
  ], "burn-in direct-exposure runtime receipt");
  const runtimeCandidate = record(
    runtimeTransition.candidate,
    "burn-in runtime candidate",
  );
  const runtimeServices = record(
    runtimeTransition.services,
    "burn-in runtime services",
  );
  if (
    runtimeTransition.schemaVersion !== "genio-v254-direct-exposure-runtime/v1"
    || runtimeTransition.operation !== "apply"
    || signedArtifactSha256(runtimeCandidate)
      !== signedArtifactSha256(direct.candidate)
    || runtimeTransition.authorityArtifactHash
      !== signedArtifactSha256(directAuthorityValue)
    || runtimeTransition.rollbackWarrantArtifactHash
      !== signedArtifactSha256(rollbackWarrantValue)
    || runtimeTransition.authorityPayloadHash !== direct.authorityPayloadHash
    || runtimeTransition.rollbackWarrantPayloadHash
      !== direct.rollbackWarrantPayloadHash
    || runtimeTransition.preconditionsHash !== direct.preconditionsHash
    || runtimeTransition.rollbackPlanHash !== direct.rollbackPlanHash
    || runtimeTransition.semanticConfigurationHash
      !== direct.runtimeTransition.postExposureSemanticConfigurationHash
    || runtimeTransition.runtimeTupleHash
      !== direct.runtimeTransition.postExposureRuntimeTupleHash
    || runtimeTransition.exposureClass !== "fully_exposed_unproven"
    || runtimeTransition.organicReliabilityProven !== false
    || runtimeTransition.receiptHash
      !== createHash("sha256")
        .update(JSON.stringify(withoutHash(runtimeTransition, "receiptHash")))
        .digest("hex")
  ) throw new Error("burn-in direct runtime transition receipt is invalid");
  const runtimeCompletedAt = timestamp(
    runtimeTransition.completedAt,
    "burn-in runtime transition completion",
  );
  if (
    Date.parse(runtimeCompletedAt) > Date.parse(databaseActivatedAt)
    || Date.parse(databaseActivatedAt) > Date.parse(
      String(authorityPayload.expiresAt),
    )
  ) throw new Error("burn-in direct activation chronology is invalid");
  const runtimeService = (lane: "interactive" | "deep" | "api") => {
    const value = record(runtimeServices[lane], `burn-in runtime ${lane}`);
    exactKeys(value, ["serviceId", "deploymentId"], `burn-in runtime ${lane}`);
    string(value.serviceId, `burn-in runtime ${lane} service`, UUID);
    string(value.deploymentId, `burn-in runtime ${lane} deployment`, UUID);
    if (
      value.serviceId !== direct.runtimeTransition.services[lane].serviceId
    ) throw new Error(`burn-in runtime ${lane} service diverged`);
    return {
      serviceId: String(value.serviceId),
      deploymentId: String(value.deploymentId),
    };
  };
  const artifact = validateReleaseGateArtifact(artifactValue);
  if (
    artifact.gate !== "final_custom_domain_browser"
    || artifact.environment !== "production"
    || artifact.candidate.tag !== input.candidateTag
    || artifact.candidate.version !== input.version
    || artifact.candidate.sourceRevision !== input.sourceRevision
    || artifact.candidate.sitesSourceRevision !== input.sourceRevision
    || artifact.candidate.imageDigest !== promotion.imageDigest
  ) throw new Error("burn-in final browser evidence does not bind the candidate");
  const attestation = verifyReleaseGateProducerAttestation(
    attestationValue,
    artifact,
    producerKey,
  );
  if (attestation.signature.keyId !== input.producerKeyId) {
    throw new Error("burn-in final browser evidence used an unapproved producer");
  }
  if (Date.parse(artifact.completedAt) < Date.parse(promotion.completedAt)) {
    throw new Error("burn-in browser evidence predates backend promotion");
  }
  const sitesSource = record(
    artifact.sources.sitesControlPlane,
    "burn-in Sites source",
  );
  if (
    sitesSource.projectId !== authorityPromotion.sitesProjectId
    || sitesSource.versionId !== authorityPromotion.sitesVersionId
    || sitesSource.deploymentId !== authorityPromotion.sitesDeploymentId
  ) throw new Error("burn-in post-browser Sites differs from direct authority");
  const browserSource = record(artifact.sources.browser, "burn-in browser source");
  if (
    browserSource.schemaVersion !== "genio-final-custom-domain-browser/v8"
    || browserSource.assignmentMode !== "direct_exposure"
    || browserSource.exposureClass !== "fully_exposed_unproven"
    || browserSource.organicReliabilityProven !== false
    || Date.parse(artifact.completedAt) < Date.parse(databaseActivatedAt)
  ) throw new Error("burn-in browser evidence is not post-exposure v8 proof");
  const probes = Array.isArray(browserSource.publicAssignmentProbes)
    ? browserSource.publicAssignmentProbes
    : [];
  if (probes.length !== 2) {
    throw new Error(
      "burn-in requires the exact typo and corrected public editorial assignment probes",
    );
  }
  const typedProbes = probes.map((value, index) => (
    record(value, `burn-in public assignment probe ${index}`)
  ));
  const directAuthorityHashes = new Set(
    typedProbes.map((probe) => String(probe.rolloutEvidenceHash)),
  );
  if (
    directAuthorityHashes.size !== 1
    || !directAuthorityHashes.has(direct.authorityPayloadHash)
    || typedProbes.some((probe) => (
      probe.rolloutStage
        !== "editorial_influence:0->100:fully_exposed_unproven"
      || probe.assignmentAuthority !== "signed_public_direct_exposure"
      || probe.publicPercentageBypass !== false
      || probe.organicAssignment !== false
      || probe.manifestOnly !== true
      || probe.appleWriteAccess !== "forbidden"
    ))
  ) {
    throw new Error("burn-in browser probes do not share direct authority");
  }
  const unsigned = {
    schemaVersion: "genio-v254-production-burn-in-binding/v2" as const,
    candidate: {
      tag: input.candidateTag,
      version: input.version,
      sourceRevision: input.sourceRevision,
      imageReference: promotion.imageReference,
      imageDigest: promotion.imageDigest,
    },
    backend: {
      promotionReceiptHash: promotion.receiptHash,
      semanticBehaviorManifestHash: promotion.semanticBehaviorManifestHash,
      semanticExecutionConfigurationHash:
        direct.runtimeTransition.postExposureSemanticConfigurationHash,
      containmentReceiptHash: promotion.containmentReceiptHash,
      guidanceCheckpointMigrationReceiptHash:
        promotion.guidanceCheckpointMigrationReceiptHash,
      legacyExecutionRouteDrainInventoryReceiptHash:
        promotion.legacyExecutionRouteDrainInventoryReceiptHash,
      schema20EvidenceRecoveryReceiptHash:
        promotion.schema20EvidenceRecoveryReceiptHash,
      railwayProjectId: promotion.projectId,
      services: {
        interactive: runtimeService("interactive"),
        deep: runtimeService("deep"),
        api: runtimeService("api"),
      },
    },
    sites: {
      projectId: String(sitesSource.projectId),
      versionId: String(sitesSource.versionId),
      deploymentId: String(sitesSource.deploymentId),
      archiveSha256: String(sitesSource.archiveSha256),
      controlPlaneEvidenceHash: String(sitesSource.evidenceHash),
      sourceRevision: input.sourceRevision,
    },
    route: {
      executionRoute: "corpus_first_v3" as const,
      intentGroup: "editorial_influence" as const,
      contractVersion: 3 as const,
      guidanceVersion: "adaptive_guidance_v5" as const,
      queryPlanSchema: 6 as const,
      directExposureAuthorityPayloadHash: direct.authorityPayloadHash,
      directExposureAuthorityArtifactHash:
        signedArtifactSha256(directAuthorityValue),
      rollbackWarrantPayloadHash: direct.rollbackWarrantPayloadHash,
      rollbackWarrantArtifactHash:
        signedArtifactSha256(rollbackWarrantValue),
      preconditionsHash: direct.preconditionsHash,
      rollbackPlanHash: direct.rollbackPlanHash,
      targetConfigurationHash: direct.targetConfigurationHash,
      preExposureSemanticConfigurationHash:
        direct.runtimeTransition.preExposureSemanticConfigurationHash,
      postExposureSemanticConfigurationHash:
        direct.runtimeTransition.postExposureSemanticConfigurationHash,
      rollbackSemanticConfigurationHash:
        direct.runtimeTransition.rollbackSemanticConfigurationHash,
      preExposureRuntimeTupleHash:
        direct.runtimeTransition.preExposureRuntimeTupleHash,
      postExposureRuntimeTupleHash:
        direct.runtimeTransition.postExposureRuntimeTupleHash,
      rollbackRuntimeTupleHash:
        direct.runtimeTransition.rollbackRuntimeTupleHash,
      databaseActivateReceiptHash: String(databaseActivate.receiptHash),
      runtimeTransitionReceiptHash: String(runtimeTransition.receiptHash),
      directExposureStage:
        "editorial_influence:0->100:fully_exposed_unproven" as const,
      exposureClass: "fully_exposed_unproven" as const,
      organicReliabilityProven: false as const,
      directAssignmentHash: sha256(
        typedProbes.map((item) => String(item.assignmentHash)).sort(),
      ),
      publicQuestionSetHash: sha256(
        typedProbes.map((item) => String(item.questionSetHash)).sort(),
      ),
      publicQuestionHash: sha256(
        typedProbes.map((item) => String(item.questionHash)).sort(),
      ),
      ownerAppleGateEvidenceHash: String(ownerProof.gateEvidenceHash),
      preExposureCleanGateEvidenceHash: String(cleanProof.gateEvidenceHash),
      databaseRouteReceiptHash: String(routeProof.receiptHash),
    },
    evidence: {
      finalBrowserEvidenceHash: artifact.evidenceHash,
      finalBrowserConfigurationHash: artifact.configurationHash,
      finalBrowserRuntimeHash: artifact.runtimeHash,
      finalBrowserCompletedAt: artifact.completedAt,
    },
  };
  return validateV254BurnInBindingV1({
    ...unsigned,
    bindingHash: sha256(unsigned),
  });
}

export function validateV254BurnInDatabaseSnapshotV1(
  value: unknown,
  expected?: {
    windowStartedAt: string;
    sourceRevision: string;
    semanticExecutionConfigurationHash: string;
    allowViolations?: boolean;
  },
): V254BurnInDatabaseSnapshotV1 {
  const snapshot = record(value, "burn-in database snapshot");
  exactKeys(snapshot, [
    "schemaVersion", "observedAt", "windowStartedAt", "sourceRevision",
    "semanticExecutionConfigurationHash", "traffic", "violations", "trip",
    "snapshotHash",
  ], "burn-in database snapshot");
  if (snapshot.schemaVersion !== "genio-v254-burn-in-database-snapshot/v1") {
    throw new Error("burn-in database snapshot uses an unsupported schema");
  }
  timestamp(snapshot.observedAt, "burn-in database observation time");
  timestamp(snapshot.windowStartedAt, "burn-in database window start");
  string(snapshot.sourceRevision, "burn-in database source revision", SHA1);
  string(
    snapshot.semanticExecutionConfigurationHash,
    "burn-in database semantic configuration hash",
    SHA256,
  );
  if (expected && (
    snapshot.windowStartedAt !== expected.windowStartedAt
    || snapshot.sourceRevision !== expected.sourceRevision
    || snapshot.semanticExecutionConfigurationHash
      !== expected.semanticExecutionConfigurationHash
  )) throw new Error("burn-in database snapshot does not bind the monitor");
  validateTraffic(snapshot.traffic, "burn-in database traffic");
  const violations = validateViolations(
    snapshot.violations,
    "burn-in database violations",
  );
  const tripped = VIOLATION_KEYS.filter((key) => violations[key] !== 0);
  if (tripped.length === 0 && snapshot.trip !== null) {
    throw new Error("clean burn-in database snapshot cannot contain a trip");
  }
  if (tripped.length > 0) {
    const trip = record(snapshot.trip, "burn-in database trip");
    exactKeys(
      trip,
      ["incidentSignature", "route", "intentGroup", "reasonCode"],
      "burn-in database trip",
    );
    if (
      trip.route !== "corpus_first_v3"
      || trip.intentGroup !== "editorial_influence"
      || trip.reasonCode !== "v254_burn_in_invariant_trip"
    ) throw new Error("burn-in database trip targets the wrong route");
    string(trip.incidentSignature, "burn-in incident signature", SHA256);
    if (expected?.allowViolations !== true) assertZeroViolations(violations);
  }
  if (
    string(snapshot.snapshotHash, "burn-in database snapshot hash", SHA256)
      !== sha256(withoutHash(snapshot, "snapshotHash"))
  ) throw new Error("burn-in database snapshot hash is invalid");
  return snapshot as unknown as V254BurnInDatabaseSnapshotV1;
}

export async function persistV254BurnInTripV1(
  client: Pick<pg.Client, "query">,
  input: {
    windowStartedAt: string;
    sourceRevision: string;
    semanticExecutionConfigurationHash: string;
    violations: V254BurnInViolationCounts;
  },
): Promise<NonNullable<V254BurnInDatabaseSnapshotV1["trip"]> | null> {
  const tripped = VIOLATION_KEYS.filter((key) => input.violations[key] !== 0);
  if (tripped.length === 0) return null;
  const incidentSignature = sha256({
    domain: "genio-v254-production-burn-in-trip/v1",
    windowStartedAt: input.windowStartedAt,
    sourceRevision: input.sourceRevision,
    semanticExecutionConfigurationHash:
      input.semanticExecutionConfigurationHash,
    tripped,
  });
  await client.query(
    `INSERT INTO quality_incident_groups(
       id,incident_signature,incident_class,stop_reason,root_cause,
       downstream_state,first_seen_at,last_seen_at,total_count,overflow_count,
       qa_promoted,expires_at,created_at,updated_at)
     VALUES($1,$2,'release_burn_in','v254_burn_in_invariant_trip',
            'production_invariant_trip','route_disabled',now(),now(),1,0,
            false,now()+interval '13 months',now(),now())
     ON CONFLICT(incident_signature) DO UPDATE SET
       last_seen_at=excluded.last_seen_at,
       stop_reason=excluded.stop_reason,
       root_cause=excluded.root_cause,
       downstream_state=excluded.downstream_state,
       updated_at=now()`,
    [randomUUID(), incidentSignature],
  );
  await client.query(
    `INSERT INTO pipeline_cohort_kill_switches(
       cohort_key,route,intent_group,disabled,reason_code,changed_by,changed_at)
     VALUES('v254-production-burn-in-trip','corpus_first_v3',
            'editorial_influence',true,'v254_burn_in_invariant_trip',
            'v254_burn_in_monitor',now())
     ON CONFLICT(route,intent_group) DO UPDATE SET
       cohort_key=excluded.cohort_key,
       disabled=true,
       reason_code=excluded.reason_code,
       changed_by=excluded.changed_by,
       changed_at=now()`,
  );
  const verification = await client.query<{
    incident_recorded: boolean;
    kill_switch_engaged: boolean;
  }>(
    `SELECT
       EXISTS(
         SELECT 1 FROM quality_incident_groups
         WHERE incident_signature=$1
           AND stop_reason='v254_burn_in_invariant_trip'
       ) incident_recorded,
       EXISTS(
         SELECT 1 FROM pipeline_cohort_kill_switches
         WHERE route='corpus_first_v3'
           AND intent_group='editorial_influence'
           AND disabled
           AND reason_code='v254_burn_in_invariant_trip'
       ) kill_switch_engaged`,
    [incidentSignature],
  );
  if (
    verification.rows[0]?.incident_recorded !== true
    || verification.rows[0]?.kill_switch_engaged !== true
  ) throw new Error("burn-in trip transaction did not preserve shutdown authority");
  return {
    incidentSignature,
    route: "corpus_first_v3",
    intentGroup: "editorial_influence",
    reasonCode: "v254_burn_in_invariant_trip",
  };
}

function validateObservation(
  value: unknown,
  binding: V254BurnInBindingV1,
): V254BurnInObservationV1 {
  const observation = record(value, "burn-in observation");
  exactKeys(
    observation,
    ["observedAt", "health", "database", "observationHash"],
    "burn-in observation",
  );
  timestamp(observation.observedAt, "burn-in observation time");
  const health = record(observation.health, "burn-in health");
  exactKeys(health, [
    "liveStatus", "readyStatus", "systemStatus", "sitesVersion",
    "sitesRevision", "schemaVersion",
    "workerProtocol", "apiConfigurationHash", "interactiveConfigurationHash",
    "deepConfigurationHash", "semanticExecutionConfigurationHash",
    "standardRolloutAuthorityActive", "directExposureActive",
    "directExposureState", "directExposureAuthorityPayloadHash",
    "directExposureRollbackWarrantPayloadHash", "directExposureStage",
    "directExposureTargetConfigurationHash", "exposureClass",
    "organicReliabilityProven", "healthHash",
  ], "burn-in health");
  if (
    health.liveStatus !== 200
    || health.readyStatus !== 200
    || health.systemStatus !== 200
    || health.sitesVersion !== binding.candidate.version
    || health.sitesRevision !== binding.candidate.sourceRevision
    || health.schemaVersion !== "20"
    || health.workerProtocol !== "playlist-pipeline-v12"
    || health.semanticExecutionConfigurationHash
      !== binding.backend.semanticExecutionConfigurationHash
    || health.standardRolloutAuthorityActive !== false
    || health.directExposureActive !== true
    || health.directExposureState !== "active"
    || health.directExposureAuthorityPayloadHash
      !== binding.route.directExposureAuthorityPayloadHash
    || health.directExposureRollbackWarrantPayloadHash
      !== binding.route.rollbackWarrantPayloadHash
    || health.directExposureStage !== binding.route.directExposureStage
    || health.directExposureTargetConfigurationHash
      !== binding.route.targetConfigurationHash
    || health.exposureClass !== "fully_exposed_unproven"
    || health.organicReliabilityProven !== false
  ) throw new Error("burn-in health does not bind the active candidate");
  for (const key of [
    "apiConfigurationHash",
    "interactiveConfigurationHash",
    "deepConfigurationHash",
    "semanticExecutionConfigurationHash",
    "directExposureAuthorityPayloadHash",
    "directExposureRollbackWarrantPayloadHash",
    "directExposureTargetConfigurationHash",
  ]) string(health[key], `burn-in health.${key}`, SHA256);
  const healthHash = string(health.healthHash, "burn-in health hash", SHA256);
  if (healthHash !== sha256(withoutHash(health, "healthHash"))) {
    throw new Error("burn-in health hash is invalid");
  }
  validateV254BurnInDatabaseSnapshotV1(observation.database, {
    windowStartedAt: String(
      (observation.database as JsonRecord).windowStartedAt,
    ),
    sourceRevision: binding.candidate.sourceRevision,
    semanticExecutionConfigurationHash:
      binding.backend.semanticExecutionConfigurationHash,
  });
  if (
    string(observation.observationHash, "burn-in observation hash", SHA256)
      !== sha256(withoutHash(observation, "observationHash"))
  ) throw new Error("burn-in observation hash is invalid");
  return observation as unknown as V254BurnInObservationV1;
}

export function validateV254ProductionBurnInReceiptV1(
  value: unknown,
  expected?: {
    candidateTag: string;
    version: string;
    sourceRevision: string;
    imageDigest: string;
    semanticBehaviorManifestHash: string;
    semanticExecutionConfigurationHash: string;
    sitesProjectId: string;
    sitesVersionId: string;
    sitesDeploymentId: string;
    finalBrowserEvidenceHash: string;
    requireComplete?: boolean;
    observedNow?: string;
  },
): V254ProductionBurnInReceiptV1 {
  const receipt = record(value, "production burn-in receipt");
  exactKeys(receipt, [
    "schemaVersion", "status", "binding", "producer", "window", "chain",
    "monitoring", "completedAt", "receiptHash",
  ], "production burn-in receipt");
  if (
    receipt.schemaVersion !== "genio-v254-production-burn-in/v1"
    || (receipt.status !== "monitoring" && receipt.status !== "complete")
  ) throw new Error("production burn-in receipt schema or status is invalid");
  const binding = validateV254BurnInBindingV1(receipt.binding);
  const producer = record(receipt.producer, "burn-in producer");
  exactKeys(producer, [
    "repository", "workflow", "runId", "runAttempt", "headSha",
  ], "burn-in producer");
  if (
    typeof producer.repository !== "string"
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(producer.repository)
    || producer.workflow !== ".github/workflows/v254-production-burn-in.yml"
  ) throw new Error("burn-in producer identity is invalid");
  string(producer.runId, "burn-in producer run ID", RUN_ID);
  count(producer.runAttempt, "burn-in producer run attempt");
  string(producer.headSha, "burn-in producer head SHA", SHA1);
  if (producer.headSha !== binding.candidate.sourceRevision) {
    throw new Error("burn-in producer head differs from the candidate");
  }
  const window = record(receipt.window, "burn-in window");
  exactKeys(window, [
    "startedAt", "observedThrough", "elapsedMs", "requiredDurationMs",
  ], "burn-in window");
  const startedAt = timestamp(window.startedAt, "burn-in start");
  const observedThrough = timestamp(window.observedThrough, "burn-in end");
  const elapsedMs = count(window.elapsedMs, "burn-in elapsed time");
  const observedNowMs = expected?.observedNow
    ? Date.parse(timestamp(expected.observedNow, "burn-in validation time"))
    : Date.now();
  if (
    window.requiredDurationMs !== V254_BURN_IN_REQUIRED_DURATION_MS
    || elapsedMs !== Date.parse(observedThrough) - Date.parse(startedAt)
    || elapsedMs < 0
    || Date.parse(startedAt)
      < Date.parse(binding.evidence.finalBrowserCompletedAt)
    || Date.parse(observedThrough) > observedNowMs + 60_000
  ) throw new Error("burn-in window is invalid");
  const chain = record(receipt.chain, "burn-in chain");
  exactKeys(chain, [
    "segmentOrdinal", "chainRootHash", "priorCheckpointHash",
    "cumulativeObservationHash",
  ], "burn-in chain");
  const segmentOrdinal = count(
    chain.segmentOrdinal,
    "burn-in segment ordinal",
  );
  if (segmentOrdinal < 1) {
    throw new Error("burn-in segment ordinal is invalid");
  }
  const chainRootHash = string(
    chain.chainRootHash,
    "burn-in chain root",
    SHA256,
  );
  if (chainRootHash !== sha256({
    domain: "genio-v254-burn-in-chain-root/v1",
    bindingHash: binding.bindingHash,
    startedAt,
  })) throw new Error("burn-in chain root is invalid");
  if (chain.priorCheckpointHash !== null) {
    string(chain.priorCheckpointHash, "burn-in prior checkpoint", SHA256);
  }
  if (
    (segmentOrdinal === 1) !== (chain.priorCheckpointHash === null)
  ) throw new Error("burn-in prior checkpoint chain is invalid");
  string(chain.cumulativeObservationHash, "burn-in observation chain", SHA256);
  const monitoring = record(receipt.monitoring, "burn-in monitoring");
  exactKeys(monitoring, [
    "sampleCount", "maximumObservationGapMs", "lastObservationHash",
    "traffic", "violations",
  ], "burn-in monitoring");
  const sampleCount = count(monitoring.sampleCount, "burn-in sample count");
  const maximumGap = count(
    monitoring.maximumObservationGapMs,
    "burn-in maximum observation gap",
  );
  string(monitoring.lastObservationHash, "burn-in last observation", SHA256);
  const traffic = validateTraffic(
    monitoring.traffic,
    "burn-in cumulative traffic",
  );
  assertZeroViolations(validateViolations(
    monitoring.violations,
    "burn-in cumulative violations",
  ));
  const complete = receipt.status === "complete";
  if (
    complete !== (receipt.completedAt !== null)
    || (receipt.completedAt !== null
      && timestamp(receipt.completedAt, "burn-in completion time")
        !== observedThrough)
  ) throw new Error("burn-in completion marker is invalid");
  if (complete && (
    elapsedMs < V254_BURN_IN_REQUIRED_DURATION_MS
    || sampleCount < V254_BURN_IN_MINIMUM_SAMPLES
    || maximumGap > V254_BURN_IN_MAX_OBSERVATION_GAP_MS
  )) throw new Error("burn-in receipt does not prove 24 continuous hours");
  if (complete && (
    traffic.cleanNonOwnerEditorialInfluence.runs < 1
    || traffic.cleanNonOwnerEditorialInfluence.briefs < 1
  )) {
    throw new Error(
      "burn-in receipt lacks a fresh clean non-owner editorial-influence run",
    );
  }
  if (!complete && elapsedMs >= V254_BURN_IN_REQUIRED_DURATION_MS) {
    throw new Error("mature burn-in receipt was not finalized");
  }
  const receiptHash = string(receipt.receiptHash, "burn-in receipt hash", SHA256);
  if (receiptHash !== sha256(withoutHash(receipt, "receiptHash"))) {
    throw new Error("burn-in receipt hash is invalid");
  }
  if (expected && (
    binding.candidate.tag !== expected.candidateTag
    || binding.candidate.version !== expected.version
    || binding.candidate.sourceRevision !== expected.sourceRevision
    || binding.candidate.imageDigest !== expected.imageDigest
    || binding.backend.semanticBehaviorManifestHash
      !== expected.semanticBehaviorManifestHash
    || binding.backend.semanticExecutionConfigurationHash
      !== expected.semanticExecutionConfigurationHash
    || binding.sites.projectId !== expected.sitesProjectId
    || binding.sites.versionId !== expected.sitesVersionId
    || binding.sites.deploymentId !== expected.sitesDeploymentId
    || binding.evidence.finalBrowserEvidenceHash
      !== expected.finalBrowserEvidenceHash
  )) throw new Error("burn-in receipt does not bind finalization evidence");
  if (expected?.requireComplete !== false && !complete) {
    throw new Error("production burn-in is not complete");
  }
  return receipt as unknown as V254ProductionBurnInReceiptV1;
}

function combineObservationHash(previous: string, current: string): string {
  return sha256({ domain: "genio-v254-burn-in-observation-chain/v1", previous, current });
}

function activeCandidateRuntimeHashes(
  system: JsonRecord,
  binding: V254BurnInBindingV1,
): { api: string; interactive: string; deep: string; semantic: string } {
  const api = record(system.api, "burn-in API identity");
  const build = record(api.build, "burn-in API build");
  const lanes = record(system.workerLanes, "burn-in worker lanes");
  const lane = (name: "interactive" | "deep") => {
    const value = record(lanes[name], `burn-in ${name} worker lane`);
    const revisions = value.eligibleRevisions;
    const configurations = value.eligibleConfigurationHashes;
    const semantics = value.eligibleSemanticExecutionConfigurationHashes;
    if (
      value.status !== "healthy"
      || value.protocolVersion !== "playlist-pipeline-v12"
      || value.eligibleIdentityCount !== 1
      || !Array.isArray(revisions)
      || revisions.length !== 1
      || revisions[0] !== binding.candidate.sourceRevision
      || !Array.isArray(configurations)
      || configurations.length !== 1
      || typeof configurations[0] !== "string"
      || !SHA256.test(configurations[0])
      || !Array.isArray(semantics)
      || semantics.length !== 1
      || typeof semantics[0] !== "string"
      || !SHA256.test(semantics[0])
    ) throw new Error(`burn-in ${name} worker lane is not exclusively ready`);
    return { configuration: configurations[0], semantic: semantics[0] };
  };
  const interactive = lane("interactive");
  const deep = lane("deep");
  const apiConfiguration = string(
    api.configurationHash,
    "burn-in API configuration hash",
    SHA256,
  );
  const apiSemantic = string(
    api.semanticExecutionConfigurationHash,
    "burn-in API semantic configuration hash",
    SHA256,
  );
  if (
    build.version !== binding.candidate.version
    || build.revision !== binding.candidate.sourceRevision
    || apiSemantic !== interactive.semantic
    || apiSemantic !== deep.semantic
  ) throw new Error("burn-in API and workers do not converge");
  return {
    api: apiConfiguration,
    interactive: interactive.configuration,
    deep: deep.configuration,
    semantic: apiSemantic,
  };
}

function observationTrafficDelta(
  previous: V254BurnInTrafficCountsV1,
  current: V254BurnInTrafficCountsV1,
): V254BurnInTrafficCountsV1 {
  const delta = zeroTraffic();
  for (const trafficClass of Object.keys(delta) as
    Array<keyof V254BurnInTrafficCountsV1>) {
    const briefs = current[trafficClass].briefs - previous[trafficClass].briefs;
    const runs = current[trafficClass].runs - previous[trafficClass].runs;
    if (briefs < 0 || runs < 0) {
      throw new Error("burn-in traffic counters moved backwards");
    }
    delta[trafficClass] = { briefs, runs };
  }
  return delta;
}

async function observeHealth(
  runtime: V254BurnInRuntime,
  binding: V254BurnInBindingV1,
  windowStartedAt: string,
): Promise<V254BurnInObservationV1> {
  const [sites, live, ready, systemResponse] = await Promise.all([
    runtime.fetchText(`${EXACT_ORIGIN}/about?burn-in=${randomUUID()}`),
    runtime.fetchJson(`${EXACT_ORIGIN}/health/live`),
    runtime.fetchJson(`${EXACT_ORIGIN}/health/ready`),
    runtime.fetchJson(`${EXACT_ORIGIN}/health/system`),
  ]);
  if (
    sites.status !== 200
    || live.status !== 200
    || ready.status !== 200
    || systemResponse.status !== 200
  ) {
    throw new Error("production health endpoint is not HTTP 200");
  }
  const sitesVersion = sitesVersionFromHtml(sites.value);
  const sitesRevision = sitesRevisionFromHtml(sites.value);
  if (
    sitesVersion !== binding.candidate.version
    || sitesRevision !== binding.candidate.sourceRevision
  ) throw new Error("production Sites identity drifted during burn-in");
  const liveBody = record(live.value, "burn-in live health");
  if (
    liveBody.version !== binding.candidate.version
    || liveBody.revision !== binding.candidate.sourceRevision
  ) throw new Error("production live health does not identify the candidate");
  const system = systemResponse.value;
  const systemBody = record(system, "burn-in system health");
  const workerProtocol = record(
    systemBody.workerProtocol,
    "burn-in worker protocol",
  );
  const executorFencing = record(
    systemBody.executorFencing,
    "burn-in executor fencing",
  );
  if (
    systemBody.ok !== true
    || systemBody.activationReady !== true
    || systemBody.schemaVersion !== "20"
    || systemBody.proofArchitectureAuthority !== "native"
    || workerProtocol.actual !== "playlist-pipeline-v12"
    || executorFencing.ready !== true
    || executorFencing.uncoveredJobs !== 0
    || executorFencing.incompleteJobs !== 0
  ) throw new Error("production is not healthy native schema-20 protocol-12");
  const hashes = activeCandidateRuntimeHashes(systemBody, binding);
  const publicRollout = record(
    systemBody.publicRollout,
    "burn-in standard rollout",
  );
  const directExposure = record(
    systemBody.directExposure,
    "burn-in direct exposure",
  );
  if (
    publicRollout.active !== false
    || publicRollout.evidenceHash !== null
    || publicRollout.stage !== null
    || directExposure.active !== true
    || directExposure.state !== "active"
    || directExposure.databaseAuthorized !== true
    || directExposure.authorityPayloadHash
      !== binding.route.directExposureAuthorityPayloadHash
    || directExposure.rollbackWarrantPayloadHash
      !== binding.route.rollbackWarrantPayloadHash
    || directExposure.stage !== binding.route.directExposureStage
    || directExposure.targetConfigurationHash
      !== binding.route.targetConfigurationHash
    || directExposure.exposureClass !== "fully_exposed_unproven"
    || directExposure.organicReliabilityProven !== false
    || hashes.semantic !== binding.backend.semanticExecutionConfigurationHash
  ) {
    throw new Error(
      "production direct-exposure or semantic identity drifted during burn-in",
    );
  }
  const healthUnsigned = {
    liveStatus: 200 as const,
    readyStatus: 200 as const,
    systemStatus: 200 as const,
    sitesVersion,
    sitesRevision,
    schemaVersion: "20" as const,
    workerProtocol: "playlist-pipeline-v12" as const,
    apiConfigurationHash: hashes.api,
    interactiveConfigurationHash: hashes.interactive,
    deepConfigurationHash: hashes.deep,
    semanticExecutionConfigurationHash: hashes.semantic,
    standardRolloutAuthorityActive: false as const,
    directExposureActive: true as const,
    directExposureState: "active" as const,
    directExposureAuthorityPayloadHash:
      binding.route.directExposureAuthorityPayloadHash,
    directExposureRollbackWarrantPayloadHash:
      binding.route.rollbackWarrantPayloadHash,
    directExposureStage: binding.route.directExposureStage,
    directExposureTargetConfigurationHash:
      binding.route.targetConfigurationHash,
    exposureClass: "fully_exposed_unproven" as const,
    organicReliabilityProven: false as const,
  };
  const database = await runtime.databaseSnapshot({
    windowStartedAt,
    sourceRevision: binding.candidate.sourceRevision,
    semanticExecutionConfigurationHash:
      binding.backend.semanticExecutionConfigurationHash,
  });
  const observedAt = new Date(runtime.now()).toISOString();
  const unsigned = {
    observedAt,
    health: { ...healthUnsigned, healthHash: sha256(healthUnsigned) },
    database,
  };
  return validateObservation({
    ...unsigned,
    observationHash: sha256(unsigned),
  }, binding);
}

export async function runV254BurnInSegment(input: {
  binding: V254BurnInBindingV1;
  priorReceipt: V254ProductionBurnInReceiptV1 | null;
  producer: V254ProductionBurnInReceiptV1["producer"];
  segmentDurationMs: number;
  pollIntervalMs: number;
  runtime: V254BurnInRuntime;
}): Promise<V254ProductionBurnInReceiptV1> {
  const binding = validateV254BurnInBindingV1(input.binding);
  if (
    !Number.isSafeInteger(input.segmentDurationMs)
    || input.segmentDurationMs < 60_000
    || input.segmentDurationMs > V254_BURN_IN_MAX_SEGMENT_MS
    || !Number.isSafeInteger(input.pollIntervalMs)
    || input.pollIntervalMs < 30_000
    || input.pollIntervalMs > 5 * 60_000
  ) throw new Error("burn-in segment or poll interval is out of bounds");
  const prior = input.priorReceipt
    ? validateV254ProductionBurnInReceiptV1(input.priorReceipt, {
        candidateTag: binding.candidate.tag,
        version: binding.candidate.version,
        sourceRevision: binding.candidate.sourceRevision,
        imageDigest: binding.candidate.imageDigest,
        semanticBehaviorManifestHash:
          binding.backend.semanticBehaviorManifestHash,
        semanticExecutionConfigurationHash:
          binding.backend.semanticExecutionConfigurationHash,
        sitesProjectId: binding.sites.projectId,
        sitesVersionId: binding.sites.versionId,
        sitesDeploymentId: binding.sites.deploymentId,
        finalBrowserEvidenceHash:
          binding.evidence.finalBrowserEvidenceHash,
        requireComplete: false,
        observedNow: new Date(input.runtime.now()).toISOString(),
      })
    : null;
  if (prior?.status === "complete") {
    throw new Error("completed burn-in cannot be resumed");
  }
  const segmentStartedMs = input.runtime.now();
  const startedAt = prior?.window.startedAt
    ?? new Date(segmentStartedMs).toISOString();
  const segmentDeadline = segmentStartedMs + input.segmentDurationMs;
  let previousObservedAt = prior?.window.observedThrough ?? null;
  let sampleCount = prior?.monitoring.sampleCount ?? 0;
  let maximumGap = prior?.monitoring.maximumObservationGapMs ?? 0;
  let cumulativeHash = prior?.chain.cumulativeObservationHash
    ?? sha256({
      domain: "genio-v254-burn-in-observation-chain/v1",
      bindingHash: binding.bindingHash,
    });
  let lastObservationHash = prior?.monitoring.lastObservationHash
    ?? cumulativeHash;
  let cumulativeTraffic = prior?.monitoring.traffic ?? zeroTraffic();
  let priorSnapshotTraffic = prior?.monitoring.traffic ?? zeroTraffic();
  let lastObservation: V254BurnInObservationV1 | null = null;
  while (true) {
    const observation = await observeHealth(
      input.runtime,
      binding,
      startedAt,
    );
    if (previousObservedAt) {
      const gap = Date.parse(observation.observedAt) - Date.parse(previousObservedAt);
      if (gap <= 0 || gap > V254_BURN_IN_MAX_OBSERVATION_GAP_MS) {
        throw new Error("burn-in observation chain has a gap or time reversal");
      }
      maximumGap = Math.max(maximumGap, gap);
    }
    const snapshotTraffic = observation.database.traffic;
    const delta = observationTrafficDelta(priorSnapshotTraffic, snapshotTraffic);
    cumulativeTraffic = addTraffic(cumulativeTraffic, delta);
    priorSnapshotTraffic = snapshotTraffic;
    cumulativeHash = combineObservationHash(
      cumulativeHash,
      observation.observationHash,
    );
    lastObservationHash = observation.observationHash;
    lastObservation = observation;
    sampleCount += 1;
    previousObservedAt = observation.observedAt;
    if (input.runtime.now() >= segmentDeadline) break;
    await input.runtime.wait(Math.min(
      input.pollIntervalMs,
      Math.max(0, segmentDeadline - input.runtime.now()),
    ));
  }
  if (!lastObservation) throw new Error("burn-in segment produced no observation");
  const observedThrough = lastObservation.observedAt;
  const elapsedMs = Date.parse(observedThrough) - Date.parse(startedAt);
  const complete = elapsedMs >= V254_BURN_IN_REQUIRED_DURATION_MS
    && sampleCount >= V254_BURN_IN_MINIMUM_SAMPLES
    && maximumGap <= V254_BURN_IN_MAX_OBSERVATION_GAP_MS;
  const chainRootHash = prior?.chain.chainRootHash ?? sha256({
    domain: "genio-v254-burn-in-chain-root/v1",
    bindingHash: binding.bindingHash,
    startedAt,
  });
  const unsigned = {
    schemaVersion: "genio-v254-production-burn-in/v1" as const,
    status: complete ? "complete" as const : "monitoring" as const,
    binding,
    producer: input.producer,
    window: {
      startedAt,
      observedThrough,
      elapsedMs,
      requiredDurationMs: V254_BURN_IN_REQUIRED_DURATION_MS,
    },
    chain: {
      segmentOrdinal: (prior?.chain.segmentOrdinal ?? 0) + 1,
      chainRootHash,
      priorCheckpointHash: prior?.receiptHash ?? null,
      cumulativeObservationHash: cumulativeHash,
    },
    monitoring: {
      sampleCount,
      maximumObservationGapMs: maximumGap,
      lastObservationHash,
      traffic: cumulativeTraffic,
      violations: zeroViolations(),
    },
    completedAt: complete ? observedThrough : null,
  };
  return validateV254ProductionBurnInReceiptV1({
    ...unsigned,
    receiptHash: sha256(unsigned),
  }, {
    candidateTag: binding.candidate.tag,
    version: binding.candidate.version,
    sourceRevision: binding.candidate.sourceRevision,
    imageDigest: binding.candidate.imageDigest,
    semanticBehaviorManifestHash: binding.backend.semanticBehaviorManifestHash,
    semanticExecutionConfigurationHash:
      binding.backend.semanticExecutionConfigurationHash,
    sitesProjectId: binding.sites.projectId,
    sitesVersionId: binding.sites.versionId,
    sitesDeploymentId: binding.sites.deploymentId,
    finalBrowserEvidenceHash: binding.evidence.finalBrowserEvidenceHash,
    requireComplete: false,
    observedNow: new Date(input.runtime.now()).toISOString(),
  });
}

function databaseUrl(): string {
  const value = process.env.DATABASE_PUBLIC_URL?.trim()
    || process.env.DATABASE_URL?.trim()
    || "";
  if (!value) throw new Error("burn-in database connection is unavailable");
  return value;
}

async function databaseSnapshotMain(argv: readonly string[]): Promise<void> {
  const names = new Set([
    "--window-started-at",
    "--source-revision",
    "--semantic-execution-configuration-hash",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1] ?? "";
    if (!names.has(name) || !value || values.has(name)) {
      throw new Error(`Invalid burn-in database argument: ${name || "(missing)"}`);
    }
    values.set(name, value);
  }
  if (values.size !== names.size) {
    throw new Error("burn-in database snapshot requires every argument");
  }
  const windowStartedAt = timestamp(
    option(values, "--window-started-at"),
    "burn-in database window start",
  );
  const sourceRevision = string(
    option(values, "--source-revision"),
    "burn-in database source revision",
    SHA1,
  );
  const semanticExecutionConfigurationHash = string(
    option(values, "--semantic-execution-configuration-hash"),
    "burn-in database semantic configuration hash",
    SHA256,
  );
  const connectionString = databaseUrl();
  const client = new pg.Client({
    connectionString,
    ssl: connectionString.includes("railway.internal")
      ? undefined
      : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('genio:v254:production-burn-in'))",
    );
    const result = await client.query<Record<string, unknown>>(
      `WITH activity_runs AS (
         SELECT run.id run_id
         FROM research_runs run
         WHERE run.created_at >= $1::timestamptz
            OR run.updated_at >= $1::timestamptz
         UNION
         SELECT job.run_id
         FROM job_queue job
         WHERE job.created_at >= $1::timestamptz
            OR job.updated_at >= $1::timestamptz
         UNION
         SELECT attempt.run_id
         FROM playlist_execution_attempts attempt
         WHERE attempt.created_at >= $1::timestamptz
            OR attempt.started_at >= $1::timestamptz
            OR attempt.last_active_at >= $1::timestamptz
            OR attempt.completed_at >= $1::timestamptz
         UNION
         SELECT checkpoint.run_id
         FROM research_checkpoints checkpoint
         WHERE checkpoint.updated_at >= $1::timestamptz
         UNION
         SELECT qualification.run_id
         FROM playlist_qualification_records qualification
         WHERE qualification.qualified_at >= $1::timestamptz
            OR qualification.revoked_at >= $1::timestamptz
         UNION
         SELECT candidate.run_id
         FROM track_candidates candidate
         WHERE candidate.created_at >= $1::timestamptz
            OR candidate.stage_updated_at >= $1::timestamptz
         UNION
         SELECT blocker.run_id
         FROM playlist_run_blockers blocker
         WHERE blocker.created_at >= $1::timestamptz
            OR blocker.updated_at >= $1::timestamptz
            OR blocker.resolved_at >= $1::timestamptz
         UNION
         SELECT resolution.run_id
         FROM playlist_run_resolutions resolution
         WHERE resolution.created_at >= $1::timestamptz
            OR resolution.updated_at >= $1::timestamptz
         UNION
         SELECT reconciliation.run_id
         FROM playlist_publication_reconciliations reconciliation
         WHERE reconciliation.created_at >= $1::timestamptz
            OR reconciliation.updated_at >= $1::timestamptz
            OR reconciliation.completed_at >= $1::timestamptz
       ), route_receipts AS (
         SELECT DISTINCT ON (checkpoint.run_id)
                checkpoint.run_id,
                checkpoint.state_json,
                checkpoint.updated_at,
                checkpoint.state_json->>'version' route_receipt_version,
                checkpoint.state_json->>'briefId' brief_id,
                checkpoint.state_json->>'rootLineageId' root_lineage_id,
                checkpoint.state_json->>'trafficClass' traffic_class,
                checkpoint.state_json->>'contractVersion' contract_version,
                checkpoint.state_json->>'executionRoute' execution_route,
                checkpoint.state_json->>'guidanceVersion' guidance_version,
                checkpoint.state_json->>'queryPlanSchema' query_plan_schema,
                checkpoint.state_json->>'queryPlanHash' query_plan_hash,
                checkpoint.state_json->>'capabilitySnapshotHash'
                  capability_snapshot_hash,
                checkpoint.state_json->>'releaseRevision' release_revision,
                checkpoint.state_json->>'executorConfigurationHash'
                  executor_configuration_hash,
                checkpoint.state_json->>'receiptHash' route_receipt_hash,
                checkpoint.state_json
                  #>> '{assignmentAuthority,receiptHash}'
                  assignment_receipt_hash,
                checkpoint.state_json->'assignmentAuthority'->>'intentGroup'
                  intent_group,
                checkpoint.state_json->'assignmentAuthority'->>'kind'
                  assignment_kind,
                checkpoint.state_json->>'createdAt' route_created_at
         FROM research_checkpoints checkpoint
         WHERE checkpoint.phase='execution_route_receipt_v1'
         ORDER BY checkpoint.run_id,checkpoint.updated_at DESC
       ), routed_runs AS (
         SELECT run.id,run.status,run.phase,run.created_at,run.updated_at,
                route.brief_id,route.root_lineage_id,
                route.traffic_class,route.contract_version,
                route.execution_route,route.guidance_version,
                route.query_plan_schema,route.query_plan_hash,
                route.capability_snapshot_hash,route.assignment_kind,
                route.assignment_receipt_hash,route.route_receipt_hash,
                route.release_revision,route.executor_configuration_hash,
                route.intent_group,route.route_receipt_version,
                route.route_created_at,route.state_json route_receipt_json
         FROM activity_runs activity
         JOIN research_runs run ON run.id=activity.run_id
         JOIN route_receipts route ON route.run_id=run.id
       ), affected_runs AS (
         SELECT routed.*
         FROM routed_runs routed
         WHERE routed.execution_route='corpus_first_v3'
           AND routed.intent_group='editorial_influence'
           AND routed.contract_version='3'
           AND routed.guidance_version='adaptive_guidance_v5'
           AND routed.query_plan_schema='6'
           AND routed.release_revision=$2
           AND routed.executor_configuration_hash=$3
       ), claimed_affected_runs AS (
         SELECT affected.*,
                contract.id contract_revision_id,
                contract.contract_json->>'revisionId'
                  contract_revision_public_id,
                contract.contract_hash contract_semantic_hash,
                plan.id query_plan_revision_id,
                plan.plan_hash active_query_plan_hash
         FROM affected_runs affected
         JOIN research_runs run ON run.id=affected.id
         JOIN playlist_contract_revisions contract
           ON contract.id=run.active_playlist_contract_revision_id
         JOIN run_active_query_plans active_plan
           ON active_plan.run_id=run.id
         JOIN query_plan_revisions plan
           ON plan.id=active_plan.query_plan_revision_id
         WHERE EXISTS (
           SELECT 1 FROM playlist_execution_attempts attempt
           WHERE attempt.run_id=affected.id
         )
       ), parity_valid_runs AS (
         SELECT claimed.*
         FROM claimed_affected_runs claimed
         WHERE claimed.query_plan_hash=claimed.active_query_plan_hash
           AND EXISTS (
             SELECT 1
             FROM guidance_answer_sets answer
             JOIN guidance_question_sets question_set
               ON question_set.id=answer.question_set_id
              AND question_set.question_set_hash=answer.question_set_hash
             JOIN research_checkpoints consumption
               ON consumption.run_id=claimed.id
              AND consumption.phase=
                    'v3:guidance:v5:worker-consumption:'
                    || left(
                         claimed.active_query_plan_hash,
                         80-length('v3:guidance:v5:worker-consumption:')
                       )
             WHERE answer.invalidated_at IS NULL
               AND answer.resulting_contract_revision_id=
                     claimed.contract_revision_id
               AND answer.resulting_query_plan_revision_id=
                     claimed.query_plan_revision_id
               AND answer.brief_request_id::text=claimed.brief_id
               AND question_set.brief_request_id::text=claimed.brief_id
               AND question_set.base_contract_revision_id=
                     answer.base_contract_revision_id
               AND question_set.guidance_policy_version=
                     'adaptive_guidance_v5'
               AND question_set.axis IS NOT NULL
               AND jsonb_typeof(question_set.questions_json)='array'
               AND consumption.state_json->>'schemaVersion'=
                     'genio-guidance-v5-worker-consumption/v1'
               AND consumption.state_json->>'kind'='worker_consumption'
               AND consumption.state_json->>'status'='consumed'
               AND consumption.state_json->>'questionSetHash'
                     =answer.question_set_hash
               AND consumption.state_json->>'queryPlanHash'
                     =claimed.active_query_plan_hash
               AND consumption.state_json->>'queryPlanRevisionId'
                     =claimed.query_plan_revision_id::text
               AND consumption.state_json->>'contractRevisionId'
                     =claimed.contract_revision_public_id
               AND consumption.state_json->>'contractSemanticHash'
                     =claimed.contract_semantic_hash
               AND consumption.state_json->>'capabilitySnapshotHash'
                     =claimed.capability_snapshot_hash
               AND consumption.state_json->>'semanticConfigurationHash'
                     =claimed.executor_configuration_hash
               AND consumption.state_json->>'axis'=question_set.axis
               AND consumption.state_json->>'executionField' IS NOT NULL
               AND consumption.state_json->>'authorityHash'
                     ~ '^[0-9a-f]{64}$'
               AND consumption.state_json->>'effectHash'
                     ~ '^[0-9a-f]{64}$'
               AND consumption.state_json->>'consumerId' IS NOT NULL
               AND consumption.state_json->>'resultEffectHash'
                     ~ '^[0-9a-f]{64}$'
               AND consumption.state_json->>'workerProjectionHash'
                     ~ '^[0-9a-f]{64}$'
               AND consumption.state_json->>'receiptHash'
                     ~ '^[0-9a-f]{64}$'
               AND consumption.state_json->>'beforeQueryPlanHash'
                     IS DISTINCT FROM
                   consumption.state_json->>'afterQueryPlanHash'
               AND consumption.state_json->>'beforeConsumerResultHash'
                     IS DISTINCT FROM
                   consumption.state_json->>'afterConsumerResultHash'
               AND EXISTS (
                 SELECT 1
                 FROM playlist_execution_attempts attempt
                 WHERE attempt.run_id=claimed.id
                   AND attempt.contract_revision_id=
                         claimed.contract_revision_id
                   AND attempt.query_plan_revision_id=
                         claimed.query_plan_revision_id
                   AND attempt.executor_revision=claimed.release_revision
                   AND attempt.semantic_execution_configuration_hash=
                         claimed.executor_configuration_hash
                   AND attempt.executor_capability_hash=
                         claimed.capability_snapshot_hash
                   AND attempt.job_id::text=
                         consumption.state_json->>'jobId'
                   AND attempt.lease_generation::text=
                         consumption.state_json->>'leaseEpoch'
               )
               AND EXISTS (
                 SELECT 1
                 FROM research_checkpoints authority
                 WHERE authority.run_id=claimed.id
                   AND authority.phase='v3:guidance:v5:execution-authority'
                   AND authority.state_json->>'schemaVersion'=
                         'genio-guidance-v5-worker-consumption/v1'
                   AND authority.state_json->>'kind'='execution_authority'
                   AND authority.state_json->>'authorityHash'=
                         consumption.state_json->>'authorityHash'
                   AND authority.state_json->>'questionSetHash'=
                         consumption.state_json->>'questionSetHash'
                   AND authority.state_json->>'questionHash'=
                         consumption.state_json->>'questionHash'
                   AND authority.state_json->>'selectedOptionId'=
                         consumption.state_json->>'selectedOptionId'
                   AND authority.state_json->>'queryPlanHash'=
                         claimed.active_query_plan_hash
                   AND authority.state_json->>'queryPlanRevisionId'=
                         claimed.query_plan_revision_id::text
                   AND authority.state_json->>'resultEffectHash'=
                         consumption.state_json->>'resultEffectHash'
               )
               AND EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements(
                   CASE
                     WHEN jsonb_typeof(answer.normalized_answers_json)='array'
                       THEN answer.normalized_answers_json
                     ELSE '[]'::jsonb
                   END
                 )
                   answer_item
                 WHERE answer_item->>'optionId'
                       =consumption.state_json->>'selectedOptionId'
                   AND EXISTS (
                     SELECT 1
                     FROM jsonb_array_elements(
                       CASE
                         WHEN jsonb_typeof(
                           question_set.questions_json
                         )='array'
                           THEN question_set.questions_json
                         ELSE '[]'::jsonb
                       END
                     ) answered_question
                     WHERE answered_question->>'id'=
                           answer_item->>'questionId'
                       AND answered_question->>'questionHash'=
                           consumption.state_json->>'questionHash'
                   )
               )
               AND EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements(question_set.questions_json)
                   question
                 WHERE question->>'questionHash'
                       =consumption.state_json->>'questionHash'
                   AND question->>'axis'=question_set.axis
                   AND EXISTS (
                     SELECT 1
                     FROM jsonb_array_elements(
                       CASE
                         WHEN jsonb_typeof(question->'options')='array'
                           THEN question->'options'
                         ELSE '[]'::jsonb
                       END
                     ) option
                     WHERE option->>'id'
                           =consumption.state_json->>'selectedOptionId'
                       AND option
                             #>> '{executionEffect,effectHash}'
                           =consumption.state_json->>'effectHash'
                       AND option
                             #>> '{executionEffect,consumerId}'
                           =consumption.state_json->>'consumerId'
                   )
               )
           )
       ), fresh_clean_public AS (
         SELECT count(DISTINCT parity.brief_id)::int briefs,
                count(DISTINCT parity.id)::int runs
         FROM parity_valid_runs parity
         WHERE parity.traffic_class='public'
           AND parity.assignment_kind='signed_public_direct_exposure'
           AND parity.created_at >= $1::timestamptz
       ), traffic AS (
         SELECT
           count(*) FILTER (WHERE traffic_class='public')::int public_runs,
           count(*) FILTER (WHERE traffic_class='owner_canary')::int owner_runs,
           count(*) FILTER (WHERE traffic_class='synthetic')::int synthetic_runs,
           count(*) FILTER (WHERE traffic_class='replay')::int replay_runs
         FROM routed_runs
       ), brief_traffic AS (
         SELECT
           count(DISTINCT routed.brief_id) FILTER (
             WHERE routed.traffic_class='public'
           )::int public_briefs,
           count(DISTINCT routed.brief_id) FILTER (
             WHERE routed.traffic_class='owner_canary'
           )::int owner_briefs,
           count(DISTINCT routed.brief_id) FILTER (
             WHERE routed.traffic_class='synthetic'
           )::int synthetic_briefs,
           count(DISTINCT routed.brief_id) FILTER (
             WHERE routed.traffic_class='replay'
           )::int replay_briefs
         FROM routed_runs routed
       ), null_candidates AS (
         SELECT count(*)::int value
         FROM playlist_qualification_records qualification
         JOIN affected_runs affected ON affected.id=qualification.run_id
         WHERE qualification.qualified_at >= $1::timestamptz
           AND qualification.candidate_id IS NULL
       ), scarcity_claims AS (
         SELECT DISTINCT run.id
         FROM affected_runs run
         WHERE run.status='no_compatible_tracks'
            OR lower(COALESCE(run.phase,'')) ~
                 '(no_compatible|scarcity|frontier_exhausted)'
            OR EXISTS (
              SELECT 1
              FROM playlist_run_resolutions resolution
              WHERE resolution.run_id=run.id
                AND lower(concat_ws(
                  ' ',
                  resolution.state_json->>'legacyStatus',
                  resolution.state_json->>'resolutionReasonCode',
                  resolution.decision_json->>'reason',
                  resolution.decision_json->>'reasonCode'
                )) ~ '(no_compatible|scarcity|frontier_exhausted)'
            )
            OR EXISTS (
              SELECT 1
              FROM research_checkpoints decision
              WHERE decision.run_id=run.id
                AND decision.phase='run_decision'
                AND lower(concat_ws(
                  ' ',
                  decision.state_json->>'reason',
                  decision.state_json->>'reasonCode'
                )) ~ '(no_compatible|scarcity|frontier_exhausted)'
            )
            OR EXISTS (
              SELECT 1
              FROM playlist_run_blockers blocker
              WHERE blocker.run_id=run.id
                AND lower(concat_ws(
                  ' ',
                  blocker.dependency_key,
                  blocker.state_json->>'reason',
                  blocker.state_json->>'reasonCode'
                )) ~ '(no_compatible|scarcity|frontier_exhausted)'
            )
       ), false_scarcity AS (
         SELECT count(DISTINCT claim.id)::int value
         FROM scarcity_claims claim
         JOIN affected_runs run ON run.id=claim.id
         WHERE EXISTS (
             SELECT 1 FROM playlist_run_blockers blocker
             WHERE blocker.run_id=run.id
               AND blocker.resolved_at IS NULL
               AND blocker.blocker_kind IN (
                 'provider','budget','integrity',
                 'publication_reconciliation'
               )
           )
           OR EXISTS (
             SELECT 1 FROM research_checkpoints audit
             WHERE audit.run_id=run.id
               AND (
                 audit.phase IN (
                   'semantic_collapse_audit_v2',
                   'v3:semantic-collapse:audit:v2',
                   'capability_evidence_coverage_audit'
                 )
                 OR audit.phase LIKE 'v3:retrieval:%'
               )
               AND (
                 audit.state_json->>'disposition' IN (
                   'technical_quarantine','dependency_blocker',
                   'deficit_research','needs_input'
                 )
                 OR audit.state_json->>'reasonCode' IN (
                   'capability_gap','evidence_binding_defect',
                   'local_budget_exhausted',
                   'provider_unavailable',
                   'provider_dependency'
                 )
                 OR audit.state_json->>'feasibilityState'='unknown'
               )
           )
           OR run.phase ~
             '(capability|evidence_binding|provider|budget|coverage_audit)'
       ), counter_divergence AS (
         SELECT count(*)::int value
         FROM playlist_run_resolutions resolution
         JOIN affected_runs affected ON affected.id=resolution.run_id
         WHERE resolution.updated_at >= $1::timestamptz
           AND (
             COALESCE(NULLIF(resolution.state_json->>'selectedTrackCount','')::int,0)
               < COALESCE(NULLIF(resolution.state_json->>'manifestedTrackCount','')::int,0)
             OR COALESCE(NULLIF(resolution.state_json->>'manifestedTrackCount','')::int,0)
               < COALESCE(NULLIF(resolution.state_json->>'appendedTrackCount','')::int,0)
             OR COALESCE(NULLIF(resolution.state_json->>'appendedTrackCount','')::int,0)
               < COALESCE(
                   NULLIF(
                     resolution.state_json->>'reconciledPublishedTrackCount',''
                   )::int,
                   0
                 )
           )
       ), actionless AS (
         SELECT count(*)::int value
         FROM playlist_run_resolutions resolution
         JOIN affected_runs affected ON affected.id=resolution.run_id
         WHERE resolution.updated_at >= $1::timestamptz
           AND resolution.state='needs_decision'
           AND (
             resolution.decision_json IS NULL
             OR resolution.next_action NOT IN (
               'resume_research','decide_verified_partial','review_contract'
             )
             OR NOT (
               (
                 resolution.next_action='resume_research'
                 AND resolution.blocker_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1 FROM playlist_run_blockers blocker
                   WHERE blocker.id=resolution.blocker_id
                     AND blocker.run_id=resolution.run_id
                     AND blocker.contract_revision_id=
                           resolution.active_contract_revision_id
                     AND blocker.blocker_kind='provider'
                     AND blocker.resolved_at IS NULL
                     AND blocker.state_json->>'decisionHash'
                           ~ '^[0-9a-f]{64}$'
                     AND blocker.state_json->>'nextAction'
                           ='resume_revise_or_cancel'
                     AND blocker.state_json->>'nextRetryAt'
                           ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
                 )
               )
               OR (
                 resolution.next_action='decide_verified_partial'
                 AND resolution.manifest_id IS NOT NULL
                 AND resolution.state_json
                       ->>'verifiedPartialDecisionAvailable'='true'
                 AND EXISTS (
                   SELECT 1
                   FROM manifests manifest
                   WHERE manifest.id=resolution.manifest_id
                     AND manifest.run_id=resolution.run_id
                     AND (
                       SELECT count(*)::int
                       FROM manifest_tracks track
                       WHERE track.manifest_id=manifest.id
                     ) BETWEEN 1 AND
                       GREATEST(
                         1,
                         COALESCE(
                           NULLIF(
                             resolution.state_json
                               ->>'requestedTrackCount',
                             ''
                           )::int,
                           1
                         ) - 1
                       )
                 )
               )
               OR (
                 resolution.next_action='review_contract'
                 AND (
                   EXISTS (
                     SELECT 1
                     FROM research_checkpoints decision
                     JOIN playlist_contract_revisions contract
                       ON contract.id=
                            resolution.active_contract_revision_id
                     WHERE decision.run_id=resolution.run_id
                       AND decision.phase='run_decision'
                       AND decision.state_json->>'schemaVersion'
                             ='genio-run-decision/v1'
                       AND decision.state_json->>'decisionHash'
                             ~ '^[0-9a-f]{64}$'
                       AND decision.state_json->>'contractRevisionId'
                             =contract.contract_json->>'revisionId'
                       AND decision.state_json->>'contractSemanticHash'
                             =contract.contract_hash
                       AND (
                         decision.state_json
                           #>> '{actions,anotherBoundedPass}'='true'
                         OR decision.state_json
                           #>> '{actions,reviseNamedPredicate}'='true'
                         OR decision.state_json
                           #>> '{actions,reduceCount}'='true'
                         OR decision.state_json
                           #>> '{actions,publishVerifiedPartial}'='true'
                         OR decision.state_json
                           #>> '{actions,resumeLater}'='true'
                         OR EXISTS (
                           SELECT 1
                           FROM jsonb_array_elements(
                             CASE
                               WHEN jsonb_typeof(
                                 decision.state_json->'advancingActions'
                               )='array'
                                 THEN decision.state_json->'advancingActions'
                               ELSE '[]'::jsonb
                             END
                           ) action
                           WHERE action->>'kind' IN (
                             'another_bounded_pass',
                             'review_named_constraint',
                             'resume_at',
                             'replay_after_repair',
                             'answer_question',
                             'approve_partial'
                           )
                           AND (
                             action->>'kind'<>'review_named_constraint'
                             OR (
                               jsonb_typeof(action->'clauseIds')='array'
                               AND jsonb_array_length(action->'clauseIds')>0
                               AND jsonb_typeof(action->'options')='array'
                               AND jsonb_array_length(action->'options')>=2
                             )
                           )
                         )
                       )
                   )
                 )
               )
             )
           )
       ), unchanged_retry AS (
         SELECT count(*)::int value
         FROM (
           SELECT affected.root_lineage_id,
                  attempt.stage,
                  history.entry->>'errorSignature' error_signature,
                  history.entry->>'attemptStrategyHash' strategy_hash
           FROM affected_runs affected
           JOIN research_checkpoints checkpoint
             ON checkpoint.run_id=affected.id
            AND checkpoint.phase='execution_failure_fingerprint_v1'
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(checkpoint.state_json->'history')='array'
                 THEN checkpoint.state_json->'history'
               ELSE '[]'::jsonb
             END
           ) history(entry)
           JOIN playlist_execution_attempts attempt
             ON attempt.run_id=affected.id
            AND attempt.id::text=history.entry->>'attemptId'
           WHERE checkpoint.updated_at >= $1::timestamptz
             AND history.entry->>'errorSignature'
                   ~ '^[0-9a-f]{64}$'
             AND history.entry->>'attemptStrategyHash'
                   ~ '^[0-9a-f]{64}$'
             AND history.entry->>'stage'=attempt.stage
           GROUP BY affected.root_lineage_id,
                    attempt.stage,
                    history.entry->>'errorSignature',
                    history.entry->>'attemptStrategyHash'
           HAVING count(DISTINCT attempt.id)>1
         ) duplicate_strategy
       ), false_live AS (
         SELECT count(*)::int value
         FROM playlist_run_resolutions resolution
         JOIN affected_runs affected ON affected.id=resolution.run_id
         WHERE resolution.updated_at >= $1::timestamptz
           AND resolution.state_json->>'workMotion'='running'
           AND NOT EXISTS (
             SELECT 1
             FROM job_queue job
             JOIN playlist_execution_attempts attempt
               ON attempt.job_id=job.id AND attempt.run_id=resolution.run_id
             JOIN worker_heartbeats heartbeat
               ON heartbeat.worker_id=job.lease_owner
             WHERE job.run_id=resolution.run_id
               AND job.status='leased'
               AND job.lease_expires_at>now()
               AND attempt.status='running'
               AND attempt.lease_generation=job.lease_epoch
               AND attempt.last_active_at>now()-interval '2 minutes'
               AND heartbeat.last_seen_at>now()-interval '2 minutes'
               AND (
                 job.required_executor_revision IS NULL
                 OR heartbeat.metadata_json->>'version'
                   =job.required_executor_revision
               )
               AND (
                 job.required_executor_semantic_configuration_hash IS NULL
                 OR heartbeat.metadata_json
                   ->>'semanticExecutionConfigurationHash'
                   =job.required_executor_semantic_configuration_hash
               )
           )
       ), apple_orphans AS (
         SELECT count(*)::int value FROM orphan_playlists orphan
         WHERE orphan.created_at >= $1::timestamptz
           AND orphan.cleaned_at IS NULL
       ), apple_mismatch AS (
         SELECT count(*)::int value
         FROM playlist_publication_reconciliations reconciliation
         WHERE reconciliation.updated_at >= $1::timestamptz
           AND (
             (reconciliation.state='complete' AND (
               reconciliation.appended_count<>reconciliation.expected_count
               OR reconciliation.batch_cursor<>reconciliation.expected_count
               OR reconciliation.observed_ordered_ids_hash IS DISTINCT FROM
                  reconciliation.expected_ordered_ids_hash
             ))
             OR (
               reconciliation.state='quarantined'
               AND lower(COALESCE(
                 reconciliation.reconciliation_json->>'reason',''
               )) ~ '(order|reorder|mismatch)'
             )
           )
       ), expected_editorial_runs AS (
         SELECT DISTINCT activity.run_id id
         FROM activity_runs activity
         JOIN run_accesses access ON access.run_id=activity.run_id
         JOIN brief_requests brief ON brief.id=access.brief_request_id
         WHERE brief.public_rollout_assignment_json->>'version'=
                 'signed_public_direct_exposure_v1'
           AND brief.public_rollout_assignment_json->>'intentGroup'=
                 'editorial_influence'
           AND brief.public_rollout_assignment_json->>'assigned'='true'
       ), route_divergence AS (
         SELECT count(DISTINCT divergence.id)::int value
         FROM (
           SELECT run.id
           FROM routed_runs run
           LEFT JOIN brief_requests brief
             ON brief.id::text=run.brief_id
           WHERE run.traffic_class IN ('public','owner_canary')
             AND (
               run.intent_group='editorial_influence'
               OR brief.public_rollout_assignment_json
                    ->>'intentGroup'='editorial_influence'
             )
             AND (
               run.execution_route IS DISTINCT FROM 'corpus_first_v3'
               OR run.route_receipt_version
                    IS DISTINCT FROM 'execution_route_receipt_v1'
               OR run.intent_group IS DISTINCT FROM 'editorial_influence'
               OR run.contract_version IS DISTINCT FROM '3'
               OR run.guidance_version IS DISTINCT FROM 'adaptive_guidance_v5'
               OR run.query_plan_schema IS DISTINCT FROM '6'
               OR COALESCE(run.query_plan_hash,'')
                    !~ '^[0-9a-f]{64}$'
               OR COALESCE(run.capability_snapshot_hash,'')
                    !~ '^[0-9a-f]{64}$'
               OR COALESCE(run.route_receipt_hash,'')
                    !~ '^[0-9a-f]{64}$'
               OR COALESCE(run.assignment_receipt_hash,'')
                    !~ '^[0-9a-f]{64}$'
               OR COALESCE(run.route_created_at,'')
                    !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
               OR (
                 run.traffic_class='public'
                 AND run.assignment_kind
                       IS DISTINCT FROM 'signed_public_direct_exposure'
               )
               OR (
                 run.traffic_class='owner_canary'
                 AND run.assignment_kind
                       IS DISTINCT FROM 'signed_owner_canary'
               )
               OR run.release_revision IS DISTINCT FROM $2
               OR run.executor_configuration_hash IS DISTINCT FROM $3
             )
           UNION
           SELECT claimed.id
           FROM claimed_affected_runs claimed
           WHERE claimed.traffic_class IN ('public','owner_canary')
             AND NOT EXISTS (
               SELECT 1 FROM parity_valid_runs parity
               WHERE parity.id=claimed.id
             )
           UNION
           SELECT expected.id
           FROM expected_editorial_runs expected
           WHERE NOT EXISTS (
             SELECT 1
             FROM route_receipts route
             WHERE route.run_id=expected.id
           )
         ) divergence
       )
       SELECT traffic.*,brief_traffic.*,
              fresh_clean_public.briefs clean_public_editorial_briefs,
              fresh_clean_public.runs clean_public_editorial_runs,
              null_candidates.value null_candidate_qualifications,
              false_scarcity.value false_scarcity,
              counter_divergence.value counter_divergence,
              actionless.value actionless_decisions,
              unchanged_retry.value unchanged_semantic_retries,
              false_live.value false_live_states,
              apple_orphans.value new_apple_orphans,
              apple_mismatch.value apple_ordered_id_mismatches,
              route_divergence.value owner_public_route_divergence
       FROM traffic,brief_traffic,fresh_clean_public,
            null_candidates,false_scarcity,
            counter_divergence,actionless,unchanged_retry,false_live,
            apple_orphans,apple_mismatch,route_divergence`,
      [windowStartedAt, sourceRevision, semanticExecutionConfigurationHash],
    );
    const routeProofRows = await client.query<{
      run_id: string;
      route_receipt_json: unknown;
      consumption_receipts_json: unknown;
      has_attempt: boolean;
    }>(
      `SELECT route.run_id,
              route.state_json route_receipt_json,
              COALESCE(
                jsonb_agg(consumption.state_json)
                  FILTER (WHERE consumption.run_id IS NOT NULL),
                '[]'::jsonb
              ) consumption_receipts_json,
              EXISTS (
                SELECT 1
                FROM playlist_execution_attempts attempt
                WHERE attempt.run_id=route.run_id
              ) has_attempt
       FROM research_checkpoints route
       LEFT JOIN research_checkpoints consumption
         ON consumption.run_id=route.run_id
        AND consumption.phase LIKE
              'v3:guidance:v5:worker-consumption:%'
       WHERE route.phase='execution_route_receipt_v1'
         AND (
           route.state_json #>> '{assignmentAuthority,intentGroup}'
             ='editorial_influence'
           OR EXISTS (
             SELECT 1
             FROM run_accesses access
             JOIN brief_requests brief ON brief.id=access.brief_request_id
             WHERE access.run_id=route.run_id
               AND brief.public_rollout_assignment_json->>'version'=
                     'signed_public_direct_exposure_v1'
               AND brief.public_rollout_assignment_json->>'intentGroup'=
                     'editorial_influence'
               AND brief.public_rollout_assignment_json->>'assigned'='true'
           )
         )
         AND (
           EXISTS (
             SELECT 1 FROM research_runs run
             WHERE run.id=route.run_id
               AND (
                 run.created_at >= $1::timestamptz
                 OR run.updated_at >= $1::timestamptz
               )
           )
           OR EXISTS (
             SELECT 1 FROM job_queue job
             WHERE job.run_id=route.run_id
               AND (
                 job.created_at >= $1::timestamptz
                 OR job.updated_at >= $1::timestamptz
               )
           )
           OR EXISTS (
             SELECT 1 FROM playlist_execution_attempts attempt
             WHERE attempt.run_id=route.run_id
               AND (
                 attempt.created_at >= $1::timestamptz
                 OR attempt.started_at >= $1::timestamptz
                 OR attempt.last_active_at >= $1::timestamptz
                 OR attempt.completed_at >= $1::timestamptz
               )
           )
           OR EXISTS (
             SELECT 1 FROM playlist_run_resolutions resolution
             WHERE resolution.run_id=route.run_id
               AND (
                 resolution.created_at >= $1::timestamptz
                 OR resolution.updated_at >= $1::timestamptz
               )
           )
         )
       GROUP BY route.run_id,route.state_json`,
      [windowStartedAt],
    );
    let cryptographicRouteDivergence = 0;
    for (const proof of routeProofRows.rows) {
      if (!isValidV254RouteReceiptV1({
        receipt: proof.route_receipt_json,
        sourceRevision,
        semanticExecutionConfigurationHash,
      })) {
        cryptographicRouteDivergence += 1;
        continue;
      }
      const receipt = parseExecutionRouteReceiptV1(proof.route_receipt_json)!;
      const consumptions = Array.isArray(proof.consumption_receipts_json)
        ? proof.consumption_receipts_json
        : [];
      const matchingConsumption = consumptions.find((value) => (
        value
        && typeof value === "object"
        && !Array.isArray(value)
        && (value as JsonRecord).queryPlanHash === receipt.queryPlanHash
      ));
      if (
        proof.has_attempt
        && (
          !isValidV254WorkerConsumptionReceiptV5(matchingConsumption)
          || (matchingConsumption as JsonRecord).capabilitySnapshotHash
            !== receipt.capabilitySnapshotHash
          || (matchingConsumption as JsonRecord).semanticConfigurationHash
            !== receipt.executorConfigurationHash
        )
      ) {
        cryptographicRouteDivergence += 1;
      }
    }

    const scarcityProofRows = await client.query<{
      run_id: string;
      contract_revision_id: string;
      contract_semantic_hash: string;
      coverage_json: unknown;
      audit_json: unknown;
      decision_json: unknown;
    }>(
      `WITH target_runs AS (
         SELECT run.id,
                contract.contract_json->>'revisionId' contract_revision_id,
                contract.contract_hash contract_semantic_hash
         FROM research_runs run
         JOIN playlist_contract_revisions contract
           ON contract.id=run.active_playlist_contract_revision_id
         JOIN LATERAL (
           SELECT checkpoint.state_json
           FROM research_checkpoints checkpoint
           WHERE checkpoint.run_id=run.id
             AND checkpoint.phase='execution_route_receipt_v1'
           ORDER BY checkpoint.updated_at DESC LIMIT 1
         ) route ON true
         WHERE route.state_json->>'executionRoute'='corpus_first_v3'
           AND route.state_json
                 #>> '{assignmentAuthority,intentGroup}'=
               'editorial_influence'
           AND route.state_json->>'releaseRevision'=$2
           AND route.state_json->>'executorConfigurationHash'=$3
           AND (
             run.created_at >= $1::timestamptz
             OR run.updated_at >= $1::timestamptz
             OR EXISTS (
               SELECT 1 FROM playlist_run_resolutions resolution
               WHERE resolution.run_id=run.id
                 AND resolution.updated_at >= $1::timestamptz
             )
             OR EXISTS (
               SELECT 1 FROM research_checkpoints checkpoint
               WHERE checkpoint.run_id=run.id
                 AND checkpoint.updated_at >= $1::timestamptz
             )
           )
           AND (
             run.status='no_compatible_tracks'
             OR lower(COALESCE(run.phase,'')) ~
                  '(no_compatible|scarcity|frontier_exhausted)'
             OR EXISTS (
               SELECT 1 FROM playlist_run_resolutions resolution
               WHERE resolution.run_id=run.id
                 AND lower(concat_ws(
                   ' ',
                   resolution.state_json->>'legacyStatus',
                   resolution.state_json->>'resolutionReasonCode',
                   resolution.decision_json->>'reason',
                   resolution.decision_json->>'reasonCode'
                 )) ~ '(no_compatible|scarcity|frontier_exhausted)'
             )
             OR EXISTS (
               SELECT 1 FROM research_checkpoints decision
               WHERE decision.run_id=run.id
                 AND decision.phase='run_decision'
                 AND lower(concat_ws(
                   ' ',
                   decision.state_json->>'reason',
                   decision.state_json->>'reasonCode'
                 )) ~ '(no_compatible|scarcity|frontier_exhausted)'
             )
             OR EXISTS (
               SELECT 1 FROM playlist_run_blockers blocker
               WHERE blocker.run_id=run.id
                 AND lower(concat_ws(
                   ' ',
                   blocker.dependency_key,
                   blocker.state_json->>'reason',
                   blocker.state_json->>'reasonCode'
                 )) ~ '(no_compatible|scarcity|frontier_exhausted)'
             )
           )
       )
       SELECT target.id run_id,target.contract_revision_id,
              target.contract_semantic_hash,
              coverage.state_json coverage_json,
              audit.state_json audit_json,
              decision.state_json decision_json
       FROM target_runs target
       LEFT JOIN LATERAL (
         SELECT checkpoint.state_json
         FROM research_checkpoints checkpoint
         WHERE checkpoint.run_id=target.id
           AND checkpoint.phase='v3:semantic-collapse:coverage:v2'
         ORDER BY checkpoint.updated_at DESC LIMIT 1
       ) coverage ON true
       LEFT JOIN LATERAL (
         SELECT checkpoint.state_json
         FROM research_checkpoints checkpoint
         WHERE checkpoint.run_id=target.id
           AND checkpoint.phase='v3:semantic-collapse:audit:v2'
         ORDER BY checkpoint.updated_at DESC LIMIT 1
       ) audit ON true
       LEFT JOIN LATERAL (
         SELECT checkpoint.state_json
         FROM research_checkpoints checkpoint
         WHERE checkpoint.run_id=target.id
           AND checkpoint.phase='run_decision'
         ORDER BY checkpoint.updated_at DESC LIMIT 1
       ) decision ON true`,
      [windowStartedAt, sourceRevision, semanticExecutionConfigurationHash],
    );
    const invalidScarcityProofs = scarcityProofRows.rows.filter((proof) => (
      !isValidV254ScarcityProofV2({
        coverage: proof.coverage_json,
        audit: proof.audit_json,
        decision: proof.decision_json,
        contractRevisionId: proof.contract_revision_id,
        contractSemanticHash: proof.contract_semantic_hash,
      })
    )).length;

    const decisionProofRows = await client.query<{
      contract_revision_id: string;
      contract_semantic_hash: string;
      decision_json: unknown;
    }>(
      `SELECT contract.contract_json->>'revisionId' contract_revision_id,
              contract.contract_hash contract_semantic_hash,
              decision.state_json decision_json
       FROM playlist_run_resolutions resolution
       JOIN research_runs run ON run.id=resolution.run_id
       JOIN playlist_contract_revisions contract
         ON contract.id=resolution.active_contract_revision_id
       JOIN LATERAL (
         SELECT checkpoint.state_json
         FROM research_checkpoints checkpoint
         WHERE checkpoint.run_id=resolution.run_id
           AND checkpoint.phase='run_decision'
         ORDER BY checkpoint.updated_at DESC LIMIT 1
       ) decision ON true
       JOIN LATERAL (
         SELECT checkpoint.state_json
         FROM research_checkpoints checkpoint
         WHERE checkpoint.run_id=resolution.run_id
           AND checkpoint.phase='execution_route_receipt_v1'
         ORDER BY checkpoint.updated_at DESC LIMIT 1
       ) route ON true
       WHERE resolution.updated_at >= $1::timestamptz
         AND resolution.state='needs_decision'
         AND resolution.next_action='review_contract'
         AND route.state_json->>'executionRoute'='corpus_first_v3'
         AND route.state_json
               #>> '{assignmentAuthority,intentGroup}'=
             'editorial_influence'
         AND route.state_json->>'releaseRevision'=$2
         AND route.state_json->>'executorConfigurationHash'=$3`,
      [windowStartedAt, sourceRevision, semanticExecutionConfigurationHash],
    );
    const invalidDecisionProofs = decisionProofRows.rows.filter((proof) => (
      !isValidV254RunDecisionV1(proof.decision_json, {
        contractRevisionId: proof.contract_revision_id,
        contractSemanticHash: proof.contract_semantic_hash,
      })
    )).length;
    const row = result.rows[0] ?? {};
    const integer = (key: string) => Math.max(0, Number(row[key] ?? 0));
    const violations: V254BurnInViolationCounts = {
      nullCandidateQualifications: integer("null_candidate_qualifications"),
      falseScarcity: Math.max(
        integer("false_scarcity"),
        invalidScarcityProofs,
      ),
      counterDivergence: integer("counter_divergence"),
      actionlessDecisions: Math.max(
        integer("actionless_decisions"),
        invalidDecisionProofs,
      ),
      unchangedSemanticRetries: integer("unchanged_semantic_retries"),
      falseLiveStates: integer("false_live_states"),
      newAppleOrphans: integer("new_apple_orphans"),
      appleOrderedIdMismatches: integer("apple_ordered_id_mismatches"),
      ownerPublicRouteDivergence: Math.max(
        integer("owner_public_route_divergence"),
        cryptographicRouteDivergence,
      ),
    };
    const trip = await persistV254BurnInTripV1(client, {
      windowStartedAt,
      sourceRevision,
      semanticExecutionConfigurationHash,
      violations,
    });
    const unsigned = {
      schemaVersion: "genio-v254-burn-in-database-snapshot/v1" as const,
      observedAt: new Date().toISOString(),
      windowStartedAt,
      sourceRevision,
      semanticExecutionConfigurationHash,
      traffic: {
        publicOrganic: {
          briefs: integer("public_briefs"),
          runs: integer("public_runs"),
        },
        ownerCanary: {
          briefs: integer("owner_briefs"),
          runs: integer("owner_runs"),
        },
        synthetic: {
          briefs: integer("synthetic_briefs"),
          runs: integer("synthetic_runs"),
        },
        replay: {
          briefs: integer("replay_briefs"),
          runs: integer("replay_runs"),
        },
        cleanNonOwnerEditorialInfluence: {
          briefs: integer("clean_public_editorial_briefs"),
          runs: integer("clean_public_editorial_runs"),
        },
      },
      violations,
      trip,
    };
    const snapshot = validateV254BurnInDatabaseSnapshotV1({
      ...unsigned,
      snapshotHash: sha256(unsigned),
    }, {
      windowStartedAt,
      sourceRevision,
      semanticExecutionConfigurationHash,
      allowViolations: true,
    });
    await client.query("COMMIT");
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

class ProcessRunner {
  async run(command: string, args: readonly string[]): Promise<string> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) return resolve(stdout);
        reject(new Error(
          `${command} exited with status ${code ?? "unknown"}: ${
            redactV254ProductionBurnInCommandStderr(stderr)
          }`,
        ));
      });
    });
  }
}

export function redactV254ProductionBurnInCommandStderr(
  stderr: string,
): string {
  // Burn-in invokes Railway with production credentials. Provider stderr is
  // untrusted and no credential-pattern list can exhaust future formats.
  return stderr.trim().length > 0
    ? "[redacted Railway stderr]"
    : "[no Railway stderr]";
}

function parseSingleJsonLine(value: string, label: string): unknown {
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const candidates = lines.filter((line) => line.startsWith("{") && line.endsWith("}"));
  if (candidates.length !== 1) throw new Error(`${label} output is malformed`);
  return JSON.parse(candidates[0]!);
}

async function monitorMain(argv: readonly string[]): Promise<void> {
  const names = [
    "--candidate-tag", "--source-revision", "--version",
    "--backend-promotion", "--direct-exposure-authority",
    "--direct-exposure-rollback-warrant",
    "--direct-exposure-database-activate-receipt",
    "--direct-exposure-runtime-receipt",
    "--final-browser-artifact",
    "--final-browser-attestation", "--producer-verification-key",
    "--producer-key-id", "--producer-key-sha256",
    "--direct-exposure-verification-key", "--direct-exposure-key-id",
    "--direct-exposure-key-sha256", "--prior-receipt",
    "--project-id", "--segment-seconds", "--poll-interval-seconds",
    "--output",
  ] as const;
  const allowed = new Set(names);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1] ?? "";
    if (!allowed.has(name as typeof names[number]) || !value || values.has(name)) {
      throw new Error(`Invalid burn-in monitor argument: ${name || "(missing)"}`);
    }
    values.set(name, value);
  }
  for (const required of names.filter((name) => name !== "--prior-receipt")) {
    option(values, required);
  }
  const sourceRevision = string(
    option(values, "--source-revision"),
    "burn-in source revision",
    SHA1,
  );
  const version = string(option(values, "--version"), "burn-in version", VERSION);
  const producerKeySha256 = string(
    option(values, "--producer-key-sha256"),
    "burn-in producer key hash",
    SHA256,
  );
  const producerKeyId = string(
    option(values, "--producer-key-id"),
    "burn-in producer key ID",
    KEY_ID,
  );
  const directExposureKeySha256 = string(
    option(values, "--direct-exposure-key-sha256"),
    "burn-in direct-exposure key hash",
    SHA256,
  );
  const directExposureKeyId = string(
    option(values, "--direct-exposure-key-id"),
    "burn-in direct-exposure key ID",
    KEY_ID,
  );
  const projectId = string(
    option(values, "--project-id"),
    "burn-in Railway project",
    UUID,
  );
  const binding = await createV254BurnInBindingV1({
    candidateTag: option(values, "--candidate-tag"),
    sourceRevision,
    version,
    backendPromotionPath: option(values, "--backend-promotion"),
    directExposureAuthorityPath:
      option(values, "--direct-exposure-authority"),
    directExposureRollbackWarrantPath:
      option(values, "--direct-exposure-rollback-warrant"),
    directExposureDatabaseActivateReceiptPath:
      option(values, "--direct-exposure-database-activate-receipt"),
    directExposureRuntimeReceiptPath:
      option(values, "--direct-exposure-runtime-receipt"),
    finalBrowserArtifactPath: option(values, "--final-browser-artifact"),
    finalBrowserAttestationPath: option(values, "--final-browser-attestation"),
    producerVerificationKeyPath: option(values, "--producer-verification-key"),
    producerKeyId,
    producerKeySha256,
    directExposureVerificationKeyPath:
      option(values, "--direct-exposure-verification-key"),
    directExposureKeyId,
    directExposureKeySha256,
  });
  if (binding.backend.railwayProjectId !== projectId) {
    throw new Error("burn-in Railway project differs from promotion");
  }
  const priorPath = values.get("--prior-receipt")?.trim();
  const prior = priorPath
    ? validateV254ProductionBurnInReceiptV1(
        JSON.parse(await readFile(priorPath, "utf8")),
        {
          candidateTag: binding.candidate.tag,
          version: binding.candidate.version,
          sourceRevision: binding.candidate.sourceRevision,
          imageDigest: binding.candidate.imageDigest,
          semanticBehaviorManifestHash:
            binding.backend.semanticBehaviorManifestHash,
          semanticExecutionConfigurationHash:
            binding.backend.semanticExecutionConfigurationHash,
          sitesProjectId: binding.sites.projectId,
          sitesVersionId: binding.sites.versionId,
          sitesDeploymentId: binding.sites.deploymentId,
          finalBrowserEvidenceHash:
            binding.evidence.finalBrowserEvidenceHash,
          requireComplete: false,
        },
      )
    : null;
  const runner = new ProcessRunner();
  const runtime: V254BurnInRuntime = {
    now: () => Date.now(),
    async wait(ms) { await new Promise((resolve) => setTimeout(resolve, ms)); },
    async fetchJson(url) {
      const response = await fetch(url, {
        cache: "no-store",
        redirect: "error",
        headers: { "cache-control": "no-cache", pragma: "no-cache" },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.text();
      let value: unknown = {};
      try { value = body ? JSON.parse(body) : {}; } catch { /* fail downstream */ }
      return { status: response.status, value };
    },
    async fetchText(url) {
      const response = await fetch(url, {
        cache: "no-store",
        redirect: "error",
        headers: { "cache-control": "no-cache", pragma: "no-cache" },
        signal: AbortSignal.timeout(15_000),
      });
      return { status: response.status, value: await response.text() };
    },
    async databaseSnapshot(snapshotInput) {
      const output = await runner.run("railway", [
        "run", "--service", "Postgres", "--project", projectId,
        "--environment", "production", "--no-local", "--",
        "node", "--experimental-transform-types",
        "scripts/v254-production-burn-in.ts", "database-snapshot",
        "--window-started-at", snapshotInput.windowStartedAt,
        "--source-revision", snapshotInput.sourceRevision,
        "--semantic-execution-configuration-hash",
        snapshotInput.semanticExecutionConfigurationHash,
      ]);
      return validateV254BurnInDatabaseSnapshotV1(
        parseSingleJsonLine(output, "burn-in database snapshot"),
        snapshotInput,
      );
    },
  };
  const receipt = await runV254BurnInSegment({
    binding,
    priorReceipt: prior,
    producer: {
      repository: process.env.GITHUB_REPOSITORY ?? "local/unsupported",
      workflow: ".github/workflows/v254-production-burn-in.yml",
      runId: string(process.env.GITHUB_RUN_ID ?? "1", "GITHUB_RUN_ID", RUN_ID),
      runAttempt: count(Number(process.env.GITHUB_RUN_ATTEMPT ?? "1"), "GITHUB_RUN_ATTEMPT"),
      headSha: string(process.env.GITHUB_SHA ?? sourceRevision, "GITHUB_SHA", SHA1),
    },
    segmentDurationMs: count(
      Number(option(values, "--segment-seconds")),
      "burn-in segment seconds",
    ) * 1_000,
    pollIntervalMs: count(
      Number(option(values, "--poll-interval-seconds")),
      "burn-in poll seconds",
    ) * 1_000,
    runtime,
  });
  await writeFile(
    option(values, "--output"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: receipt.status,
    sourceRevision: receipt.binding.candidate.sourceRevision,
    segmentOrdinal: receipt.chain.segmentOrdinal,
    observedThrough: receipt.window.observedThrough,
    receiptHash: receipt.receiptHash,
  })}\n`);
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "database-snapshot") {
    await databaseSnapshotMain(argv);
    return;
  }
  if (command === "monitor") {
    await monitorMain(argv);
    return;
  }
  throw new Error("Expected burn-in command: monitor or database-snapshot");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "v254_production_burn_in_failed",
      message: error instanceof Error
        ? error.message
        : "v2.5.4 production burn-in failed",
    })}\n`);
    process.exitCode = 1;
  });
}
