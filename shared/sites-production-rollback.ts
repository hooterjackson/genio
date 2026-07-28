import { RELEASE_EVIDENCE_TTL_MS } from "./release-evidence-constants.ts";
import {
  SITES_CONTROL_PLANE_ISSUER_V1,
  sitesControlPlaneKeyFingerprint,
  validateSitesControlPlaneTrustPolicyV1,
  validateSitesControlPlaneVerificationKeyV1,
} from "./sites-control-plane-attestation.ts";
import {
  exactObject,
  type JsonRecord,
  sha256Digest,
  signedArtifactSha256,
  verifyStrictSignedEnvelope,
} from "./signed-artifact.ts";

export const SITES_PRODUCTION_ROLLBACK_TARGET_SCHEMA_V1 =
  "genio-sites-production-rollback-target/v1";
export const SITES_PRODUCTION_ROLLBACK_RECEIPT_SCHEMA_V1 =
  "genio-sites-production-rollback-receipt/v1";
export const SITES_PRODUCTION_ROLLBACK_ATTESTATION_SCHEMA_V1 =
  "genio-sites-production-rollback-attestation/v1";
export const SIGNED_SITES_PRODUCTION_ROLLBACK_ATTESTATION_SCHEMA_V1 =
  "genio-signed-sites-production-rollback-attestation/v1";
export const SITES_PRODUCTION_ROLLBACK_PROOF_SCHEMA_V1 =
  "genio-sites-production-rollback-proof/v1";
export const SITES_PRODUCTION_ROLLBACK_OPERATION =
  "production_rollback_ready";
export const SITES_PRODUCTION_ROLLBACK_PROBE_PARAMETER =
  "__genio_rollback_probe";
export const SITES_PRODUCTION_ROLLBACK_MINIMUM_LIVE_PROBES = 2;

const MAX_CONTROL_PLANE_OBSERVATION_AGE_MS = 5 * 60_000;
const MAX_RECEIPT_ATTESTATION_SKEW_MS = 5 * 60_000;
const OPAQUE_ID = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;
const GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const BUILD_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u;
const SAFE_NONCE = /^[0-9A-Za-z][0-9A-Za-z._~-]{7,159}$/u;

export type SitesReadyStatus = "ready" | "succeeded";
export type SitesDeploymentPollStatus =
  | "pending"
  | "queued"
  | "deploying"
  | SitesReadyStatus;

export type SitesProductionRollbackTargetV1 = {
  schemaVersion: typeof SITES_PRODUCTION_ROLLBACK_TARGET_SCHEMA_V1;
  capturedAt: string;
  projectId: string;
  productionUrl: string;
  plannedCandidate: {
    commitSha: string;
    buildVersion: string;
  };
  previous: {
    versionId: string;
    versionNumber: number;
    commitSha: string;
    archiveSha256: string;
    deploymentId: string;
    deploymentStatus: SitesReadyStatus;
    controlPlaneObservedAt: string;
    liveObservedAt: string;
    liveBuildVersion: string;
    liveBuildRevision: string;
  };
  evidenceHash: string;
};

export type SitesProductionRollbackReceiptV1 = {
  schemaVersion: typeof SITES_PRODUCTION_ROLLBACK_RECEIPT_SCHEMA_V1;
  generatedAt: string;
  expiresAt: string;
  targetHash: string;
  projectId: string;
  productionUrl: string;
  candidate: {
    versionId: string;
    versionNumber: number;
    commitSha: string;
    buildVersion: string;
    deploymentId: string;
    status: SitesReadyStatus;
    requestedAt: string;
    readyAt: string;
  };
  rollback: {
    requestedAt: string;
    versionId: string;
    versionNumber: number;
    commitSha: string;
    archiveSha256: string;
    deploymentId: string;
    status: SitesReadyStatus;
  };
  pollObservations: Array<{
    observedAt: string;
    projectId: string;
    versionId: string;
    versionNumber: number;
    deploymentId: string;
    status: SitesDeploymentPollStatus;
  }>;
  liveObservations: Array<{
    observedAt: string;
    requestUrl: string;
    cacheBustNonce: string;
    cacheMode: "no-store";
    responseStatus: 200;
    buildVersion: string;
    buildRevision: string;
  }>;
  evidenceHash: string;
};

export type SitesProductionRollbackProofV1 = {
  schemaVersion: typeof SITES_PRODUCTION_ROLLBACK_PROOF_SCHEMA_V1;
  verifiedAt: string;
  projectId: string;
  productionUrl: string;
  versionId: string;
  versionNumber: number;
  rollbackDeploymentId: string;
  restoredBuildVersion: string;
  restoredBuildRevision: string;
  targetHash: string;
  receiptHash: string;
  attestationPayloadHash: string;
  verificationKeyFingerprint: string;
  evidenceHash: string;
};

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new Error(`${label} must be an exact opaque Sites ID`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
  ) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function gitRevision(value: unknown, label: string): string {
  if (typeof value !== "string" || !GIT_REVISION.test(value)) {
    throw new Error(`${label} must be a full lowercase Git commit SHA`);
  }
  return value;
}

function buildVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !BUILD_VERSION.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function productionUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.origin !== value
  ) {
    throw new Error(`${label} must be an exact HTTPS origin`);
  }
  return value;
}

function readyStatus(value: unknown, label: string): SitesReadyStatus {
  if (value !== "ready" && value !== "succeeded") {
    throw new Error(`${label} must be ready or succeeded`);
  }
  return value;
}

function pollStatus(value: unknown, label: string): SitesDeploymentPollStatus {
  if (
    value !== "pending"
    && value !== "queued"
    && value !== "deploying"
    && value !== "ready"
    && value !== "succeeded"
  ) {
    throw new Error(`${label} is unsupported`);
  }
  return value;
}

function hashMatches(
  value: JsonRecord,
  hashField: "evidenceHash",
  label: string,
): void {
  const actual = sha256Digest(value[hashField], `${label}.${hashField}`);
  const source = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== hashField),
  );
  if (actual !== signedArtifactSha256(source)) {
    throw new Error(`${label} hash does not match`);
  }
}

function ensureExact<T>(left: T, right: T, label: string): void {
  if (left !== right) throw new Error(`${label} does not match`);
}

function targetPrevious(value: unknown): SitesProductionRollbackTargetV1["previous"] {
  const source = exactObject(value, [
    "versionId",
    "versionNumber",
    "commitSha",
    "archiveSha256",
    "deploymentId",
    "deploymentStatus",
    "controlPlaneObservedAt",
    "liveObservedAt",
    "liveBuildVersion",
    "liveBuildRevision",
  ], "Sites rollback previous version");
  const result: SitesProductionRollbackTargetV1["previous"] = {
    versionId: opaqueId(source.versionId, "previous Sites versionId"),
    versionNumber: positiveInteger(
      source.versionNumber,
      "previous Sites versionNumber",
    ),
    commitSha: gitRevision(source.commitSha, "previous Sites commitSha"),
    archiveSha256: sha256Digest(
      source.archiveSha256,
      "previous Sites archive content hash",
    ),
    deploymentId: opaqueId(
      source.deploymentId,
      "previous Sites deploymentId",
    ),
    deploymentStatus: readyStatus(
      source.deploymentStatus,
      "previous Sites deployment status",
    ),
    controlPlaneObservedAt: timestamp(
      source.controlPlaneObservedAt,
      "previous Sites control-plane observedAt",
    ),
    liveObservedAt: timestamp(
      source.liveObservedAt,
      "previous Sites live observedAt",
    ),
    liveBuildVersion: buildVersion(
      source.liveBuildVersion,
      "previous Sites live build version",
    ),
    liveBuildRevision: gitRevision(
      source.liveBuildRevision,
      "previous Sites live build revision",
    ),
  };
  ensureExact(
    result.liveBuildRevision,
    result.commitSha,
    "previous Sites live build revision and saved commitSha",
  );
  return result;
}

export function createSitesProductionRollbackTargetV1(input: {
  capturedAt: string;
  projectId: string;
  productionUrl: string;
  plannedCandidate: {
    commitSha: string;
    buildVersion: string;
  };
  previous: SitesProductionRollbackTargetV1["previous"];
}): SitesProductionRollbackTargetV1 {
  const capturedAt = timestamp(input.capturedAt, "Sites rollback capturedAt");
  const plannedCandidate = exactObject(input.plannedCandidate, [
    "commitSha",
    "buildVersion",
  ], "planned Sites candidate");
  const previous = targetPrevious(input.previous);
  const capturedAtMs = Date.parse(capturedAt);
  const controlPlaneAtMs = Date.parse(previous.controlPlaneObservedAt);
  const liveAtMs = Date.parse(previous.liveObservedAt);
  if (
    controlPlaneAtMs > capturedAtMs
    || liveAtMs > capturedAtMs
    || capturedAtMs - controlPlaneAtMs > MAX_CONTROL_PLANE_OBSERVATION_AGE_MS
    || capturedAtMs - liveAtMs > MAX_CONTROL_PLANE_OBSERVATION_AGE_MS
  ) {
    throw new Error(
      "previous Sites version and live identity must be observed within five minutes before capture",
    );
  }
  const source: Omit<SitesProductionRollbackTargetV1, "evidenceHash"> = {
    schemaVersion: SITES_PRODUCTION_ROLLBACK_TARGET_SCHEMA_V1,
    capturedAt,
    projectId: opaqueId(input.projectId, "Sites projectId"),
    productionUrl: productionUrl(input.productionUrl, "Sites production URL"),
    plannedCandidate: {
      commitSha: gitRevision(
        plannedCandidate.commitSha,
        "planned Sites candidate commitSha",
      ),
      buildVersion: buildVersion(
        plannedCandidate.buildVersion,
        "planned Sites candidate build version",
      ),
    },
    previous,
  };
  if (
    source.plannedCandidate.commitSha === source.previous.commitSha
    && source.plannedCandidate.buildVersion === source.previous.liveBuildVersion
  ) {
    throw new Error("planned Sites candidate is already the live saved version");
  }
  return {
    ...source,
    evidenceHash: signedArtifactSha256(source),
  };
}

export function validateSitesProductionRollbackTargetV1(
  value: unknown,
): SitesProductionRollbackTargetV1 {
  const target = exactObject(value, [
    "schemaVersion",
    "capturedAt",
    "projectId",
    "productionUrl",
    "plannedCandidate",
    "previous",
    "evidenceHash",
  ], "Sites production rollback target");
  if (target.schemaVersion !== SITES_PRODUCTION_ROLLBACK_TARGET_SCHEMA_V1) {
    throw new Error("Sites production rollback target uses an unsupported schema");
  }
  hashMatches(target, "evidenceHash", "Sites production rollback target");
  const plannedCandidate = exactObject(target.plannedCandidate, [
    "commitSha",
    "buildVersion",
  ], "planned Sites candidate");
  const recreated = createSitesProductionRollbackTargetV1({
    capturedAt: timestamp(target.capturedAt, "Sites rollback capturedAt"),
    projectId: opaqueId(target.projectId, "Sites projectId"),
    productionUrl: productionUrl(target.productionUrl, "Sites production URL"),
    plannedCandidate: {
      commitSha: gitRevision(
        plannedCandidate.commitSha,
        "planned Sites candidate commitSha",
      ),
      buildVersion: buildVersion(
        plannedCandidate.buildVersion,
        "planned Sites candidate build version",
      ),
    },
    previous: targetPrevious(target.previous),
  });
  ensureExact(
    recreated.evidenceHash,
    target.evidenceHash as string,
    "Sites production rollback target evidenceHash",
  );
  return recreated;
}

function candidateBinding(
  value: unknown,
): SitesProductionRollbackReceiptV1["candidate"] {
  const source = exactObject(value, [
    "versionId",
    "versionNumber",
    "commitSha",
    "buildVersion",
    "deploymentId",
    "status",
    "requestedAt",
    "readyAt",
  ], "Sites candidate deployment");
  return {
    versionId: opaqueId(source.versionId, "candidate Sites versionId"),
    versionNumber: positiveInteger(
      source.versionNumber,
      "candidate Sites versionNumber",
    ),
    commitSha: gitRevision(source.commitSha, "candidate Sites commitSha"),
    buildVersion: buildVersion(
      source.buildVersion,
      "candidate Sites build version",
    ),
    deploymentId: opaqueId(
      source.deploymentId,
      "candidate Sites deploymentId",
    ),
    status: readyStatus(source.status, "candidate Sites deployment status"),
    requestedAt: timestamp(source.requestedAt, "candidate Sites requestedAt"),
    readyAt: timestamp(source.readyAt, "candidate Sites readyAt"),
  };
}

function rollbackBinding(
  value: unknown,
): SitesProductionRollbackReceiptV1["rollback"] {
  const source = exactObject(value, [
    "requestedAt",
    "versionId",
    "versionNumber",
    "commitSha",
    "archiveSha256",
    "deploymentId",
    "status",
  ], "Sites rollback deployment");
  return {
    requestedAt: timestamp(source.requestedAt, "Sites rollback requestedAt"),
    versionId: opaqueId(source.versionId, "rollback Sites versionId"),
    versionNumber: positiveInteger(
      source.versionNumber,
      "rollback Sites versionNumber",
    ),
    commitSha: gitRevision(source.commitSha, "rollback Sites commitSha"),
    archiveSha256: sha256Digest(
      source.archiveSha256,
      "rollback Sites archive content hash",
    ),
    deploymentId: opaqueId(
      source.deploymentId,
      "rollback Sites deploymentId",
    ),
    status: readyStatus(source.status, "rollback Sites deployment status"),
  };
}

function pollObservation(
  value: unknown,
  index: number,
): SitesProductionRollbackReceiptV1["pollObservations"][number] {
  const source = exactObject(value, [
    "observedAt",
    "projectId",
    "versionId",
    "versionNumber",
    "deploymentId",
    "status",
  ], `Sites rollback poll observation ${index}`);
  return {
    observedAt: timestamp(
      source.observedAt,
      `Sites rollback poll observation ${index} observedAt`,
    ),
    projectId: opaqueId(
      source.projectId,
      `Sites rollback poll observation ${index} projectId`,
    ),
    versionId: opaqueId(
      source.versionId,
      `Sites rollback poll observation ${index} versionId`,
    ),
    versionNumber: positiveInteger(
      source.versionNumber,
      `Sites rollback poll observation ${index} versionNumber`,
    ),
    deploymentId: opaqueId(
      source.deploymentId,
      `Sites rollback poll observation ${index} deploymentId`,
    ),
    status: pollStatus(
      source.status,
      `Sites rollback poll observation ${index} status`,
    ),
  };
}

function probeRequestUrl(
  value: unknown,
  expectedOrigin: string,
  expectedNonce: string,
  label: string,
): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  const origin = new URL(expectedOrigin);
  const entries = [...parsed.searchParams.entries()];
  if (
    parsed.protocol !== "https:"
    || parsed.origin !== origin.origin
    || parsed.pathname !== "/"
    || parsed.username
    || parsed.password
    || parsed.hash
    || entries.length !== 1
    || entries[0]?.[0] !== SITES_PRODUCTION_ROLLBACK_PROBE_PARAMETER
    || entries[0]?.[1] !== expectedNonce
    || parsed.toString() !== value
  ) {
    throw new Error(`${label} is not the exact cache-busted production URL`);
  }
  return value;
}

function liveObservation(
  value: unknown,
  index: number,
  expectedOrigin: string,
): SitesProductionRollbackReceiptV1["liveObservations"][number] {
  const source = exactObject(value, [
    "observedAt",
    "requestUrl",
    "cacheBustNonce",
    "cacheMode",
    "responseStatus",
    "buildVersion",
    "buildRevision",
  ], `Sites rollback live observation ${index}`);
  const nonce = typeof source.cacheBustNonce === "string"
    ? source.cacheBustNonce
    : "";
  if (!SAFE_NONCE.test(nonce)) {
    throw new Error(`Sites rollback live observation ${index} nonce is invalid`);
  }
  if (source.cacheMode !== "no-store" || source.responseStatus !== 200) {
    throw new Error(
      `Sites rollback live observation ${index} did not use a successful no-store request`,
    );
  }
  return {
    observedAt: timestamp(
      source.observedAt,
      `Sites rollback live observation ${index} observedAt`,
    ),
    requestUrl: probeRequestUrl(
      source.requestUrl,
      expectedOrigin,
      nonce,
      `Sites rollback live observation ${index} requestUrl`,
    ),
    cacheBustNonce: nonce,
    cacheMode: "no-store",
    responseStatus: 200,
    buildVersion: buildVersion(
      source.buildVersion,
      `Sites rollback live observation ${index} build version`,
    ),
    buildRevision: gitRevision(
      source.buildRevision,
      `Sites rollback live observation ${index} build revision`,
    ),
  };
}

export function createSitesProductionRollbackReceiptV1(input: {
  generatedAt: string;
  expiresAt: string;
  target: SitesProductionRollbackTargetV1;
  projectId: string;
  productionUrl: string;
  candidate: SitesProductionRollbackReceiptV1["candidate"];
  rollback: SitesProductionRollbackReceiptV1["rollback"];
  pollObservations: SitesProductionRollbackReceiptV1["pollObservations"];
  liveObservations: SitesProductionRollbackReceiptV1["liveObservations"];
}): SitesProductionRollbackReceiptV1 {
  const target = validateSitesProductionRollbackTargetV1(input.target);
  const generatedAt = timestamp(
    input.generatedAt,
    "Sites rollback receipt generatedAt",
  );
  const expiresAt = timestamp(
    input.expiresAt,
    "Sites rollback receipt expiresAt",
  );
  const generatedAtMs = Date.parse(generatedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (
    expiresAtMs <= generatedAtMs
    || expiresAtMs - generatedAtMs > RELEASE_EVIDENCE_TTL_MS
  ) {
    throw new Error("Sites rollback receipt must expire within 24 hours");
  }
  const projectId = opaqueId(input.projectId, "Sites rollback projectId");
  const origin = productionUrl(
    input.productionUrl,
    "Sites rollback production URL",
  );
  ensureExact(projectId, target.projectId, "Sites rollback projectId and target");
  ensureExact(origin, target.productionUrl, "Sites rollback URL and target");
  const candidate = candidateBinding(input.candidate);
  const rollback = rollbackBinding(input.rollback);
  ensureExact(
    candidate.commitSha,
    target.plannedCandidate.commitSha,
    "candidate Sites commitSha and planned candidate",
  );
  ensureExact(
    candidate.buildVersion,
    target.plannedCandidate.buildVersion,
    "candidate Sites build version and planned candidate",
  );
  if (
    candidate.versionId === target.previous.versionId
    || candidate.deploymentId === target.previous.deploymentId
    || Date.parse(candidate.requestedAt) <= Date.parse(target.capturedAt)
    || Date.parse(candidate.readyAt) < Date.parse(candidate.requestedAt)
  ) {
    throw new Error(
      "Sites rollback target was not captured before a distinct candidate deployment",
    );
  }
  if (Date.parse(rollback.requestedAt) < Date.parse(candidate.readyAt)) {
    throw new Error("Sites rollback was requested before the candidate was ready");
  }
  ensureExact(
    rollback.versionId,
    target.previous.versionId,
    "rollback Sites versionId and saved target",
  );
  ensureExact(
    rollback.versionNumber,
    target.previous.versionNumber,
    "rollback Sites versionNumber and saved target",
  );
  ensureExact(
    rollback.commitSha,
    target.previous.commitSha,
    "rollback Sites commitSha and saved target",
  );
  ensureExact(
    rollback.archiveSha256,
    target.previous.archiveSha256,
    "rollback Sites archive content hash and saved target",
  );
  if (
    rollback.deploymentId === target.previous.deploymentId
    || rollback.deploymentId === candidate.deploymentId
  ) {
    throw new Error("Sites rollback must create a distinct deployment");
  }
  if (
    !Array.isArray(input.pollObservations)
    || input.pollObservations.length < 2
  ) {
    throw new Error("Sites rollback requires at least two deployment polls");
  }
  const pollObservations = input.pollObservations.map(pollObservation);
  let priorPollAt = Date.parse(rollback.requestedAt);
  pollObservations.forEach((observation, index) => {
    const observedAt = Date.parse(observation.observedAt);
    if (observedAt < priorPollAt) {
      throw new Error("Sites rollback poll timestamps are out of order");
    }
    priorPollAt = observedAt;
    ensureExact(
      observation.projectId,
      projectId,
      `Sites rollback poll ${index} projectId`,
    );
    ensureExact(
      observation.versionId,
      rollback.versionId,
      `Sites rollback poll ${index} versionId`,
    );
    ensureExact(
      observation.versionNumber,
      rollback.versionNumber,
      `Sites rollback poll ${index} versionNumber`,
    );
    ensureExact(
      observation.deploymentId,
      rollback.deploymentId,
      `Sites rollback poll ${index} deploymentId`,
    );
    if (
      index < pollObservations.length - 1
      && (observation.status === "ready" || observation.status === "succeeded")
    ) {
      throw new Error("Sites rollback polling continued after a terminal status");
    }
  });
  const terminalPoll = pollObservations[pollObservations.length - 1]!;
  ensureExact(
    terminalPoll.status,
    rollback.status,
    "Sites rollback terminal poll status",
  );
  if (
    !Array.isArray(input.liveObservations)
    || input.liveObservations.length < SITES_PRODUCTION_ROLLBACK_MINIMUM_LIVE_PROBES
  ) {
    throw new Error(
      `Sites rollback requires at least ${SITES_PRODUCTION_ROLLBACK_MINIMUM_LIVE_PROBES} cache-busted live probes`,
    );
  }
  const liveObservations = input.liveObservations.map((value, index) =>
    liveObservation(value, index, origin));
  const seenNonces = new Set<string>();
  let priorLiveAt = Date.parse(terminalPoll.observedAt);
  liveObservations.forEach((observation) => {
    const observedAt = Date.parse(observation.observedAt);
    if (observedAt < priorLiveAt) {
      throw new Error("Sites rollback live proof predates deployment readiness");
    }
    priorLiveAt = observedAt;
    if (seenNonces.has(observation.cacheBustNonce)) {
      throw new Error("Sites rollback live proof reused a cache-busting nonce");
    }
    seenNonces.add(observation.cacheBustNonce);
    ensureExact(
      observation.buildVersion,
      target.previous.liveBuildVersion,
      "restored Sites live build version",
    );
    ensureExact(
      observation.buildRevision,
      target.previous.liveBuildRevision,
      "restored Sites live build revision",
    );
  });
  if (
    generatedAtMs < priorLiveAt
    || generatedAtMs - priorLiveAt > MAX_CONTROL_PLANE_OBSERVATION_AGE_MS
  ) {
    throw new Error(
      "Sites rollback receipt must be generated within five minutes of live proof",
    );
  }
  const source: Omit<SitesProductionRollbackReceiptV1, "evidenceHash"> = {
    schemaVersion: SITES_PRODUCTION_ROLLBACK_RECEIPT_SCHEMA_V1,
    generatedAt,
    expiresAt,
    targetHash: target.evidenceHash,
    projectId,
    productionUrl: origin,
    candidate,
    rollback,
    pollObservations,
    liveObservations,
  };
  return {
    ...source,
    evidenceHash: signedArtifactSha256(source),
  };
}

export function validateSitesProductionRollbackReceiptV1(input: {
  value: unknown;
  target: SitesProductionRollbackTargetV1;
}): SitesProductionRollbackReceiptV1 {
  const receipt = exactObject(input.value, [
    "schemaVersion",
    "generatedAt",
    "expiresAt",
    "targetHash",
    "projectId",
    "productionUrl",
    "candidate",
    "rollback",
    "pollObservations",
    "liveObservations",
    "evidenceHash",
  ], "Sites production rollback receipt");
  if (receipt.schemaVersion !== SITES_PRODUCTION_ROLLBACK_RECEIPT_SCHEMA_V1) {
    throw new Error("Sites production rollback receipt uses an unsupported schema");
  }
  hashMatches(receipt, "evidenceHash", "Sites production rollback receipt");
  const recreated = createSitesProductionRollbackReceiptV1({
    generatedAt: timestamp(
      receipt.generatedAt,
      "Sites rollback receipt generatedAt",
    ),
    expiresAt: timestamp(
      receipt.expiresAt,
      "Sites rollback receipt expiresAt",
    ),
    target: input.target,
    projectId: opaqueId(receipt.projectId, "Sites rollback projectId"),
    productionUrl: productionUrl(
      receipt.productionUrl,
      "Sites rollback production URL",
    ),
    candidate: candidateBinding(receipt.candidate),
    rollback: rollbackBinding(receipt.rollback),
    pollObservations: Array.isArray(receipt.pollObservations)
      ? receipt.pollObservations.map(pollObservation)
      : [],
    liveObservations: Array.isArray(receipt.liveObservations)
      ? receipt.liveObservations.map((value, index) =>
        liveObservation(value, index, String(receipt.productionUrl)))
      : [],
  });
  ensureExact(
    recreated.evidenceHash,
    receipt.evidenceHash as string,
    "Sites production rollback receipt evidenceHash",
  );
  return recreated;
}

function attestationPayload(value: unknown): JsonRecord {
  const source = exactObject(value, [
    "schemaVersion",
    "generatedAt",
    "expiresAt",
    "issuer",
    "operation",
    "receiptHash",
    "targetHash",
    "projectId",
    "productionUrl",
    "versionId",
    "versionNumber",
    "deploymentId",
  ], "Sites production rollback attestation");
  if (
    source.schemaVersion !== SITES_PRODUCTION_ROLLBACK_ATTESTATION_SCHEMA_V1
    || source.issuer !== SITES_CONTROL_PLANE_ISSUER_V1
    || source.operation !== SITES_PRODUCTION_ROLLBACK_OPERATION
  ) {
    throw new Error("Sites production rollback attestation has unsupported provenance");
  }
  const generatedAt = timestamp(
    source.generatedAt,
    "Sites rollback attestation generatedAt",
  );
  const expiresAt = timestamp(
    source.expiresAt,
    "Sites rollback attestation expiresAt",
  );
  const ttl = Date.parse(expiresAt) - Date.parse(generatedAt);
  if (ttl <= 0 || ttl > RELEASE_EVIDENCE_TTL_MS) {
    throw new Error("Sites rollback attestation must expire within 24 hours");
  }
  sha256Digest(source.receiptHash, "Sites rollback attestation receiptHash");
  sha256Digest(source.targetHash, "Sites rollback attestation targetHash");
  opaqueId(source.projectId, "Sites rollback attestation projectId");
  productionUrl(
    source.productionUrl,
    "Sites rollback attestation production URL",
  );
  opaqueId(source.versionId, "Sites rollback attestation versionId");
  positiveInteger(
    source.versionNumber,
    "Sites rollback attestation versionNumber",
  );
  opaqueId(source.deploymentId, "Sites rollback attestation deploymentId");
  return source;
}

export function verifySitesProductionRollbackV1(input: {
  target: unknown;
  receipt: unknown;
  attestation: unknown;
  verificationKeySource: unknown;
  trustPolicy: unknown;
  expectedProjectId: string;
  expectedProductionUrl: string;
  expectedVersionId: string;
  expectedVersionNumber: number;
  expectedDeploymentId: string;
  now?: string;
}): SitesProductionRollbackProofV1 {
  const target = validateSitesProductionRollbackTargetV1(input.target);
  const receipt = validateSitesProductionRollbackReceiptV1({
    value: input.receipt,
    target,
  });
  const key = validateSitesControlPlaneVerificationKeyV1(
    input.verificationKeySource,
  );
  const policy = validateSitesControlPlaneTrustPolicyV1(input.trustPolicy);
  const fingerprint = sitesControlPlaneKeyFingerprint(key.key);
  if (
    key.source.sha256 !== fingerprint
    || policy.approvedKeyId === ""
    || policy.approvedKeySha256 !== fingerprint
  ) {
    throw new Error(
      "Sites rollback verification key is not the protected trusted key",
    );
  }
  const expectedProjectId = opaqueId(
    input.expectedProjectId,
    "expected Sites rollback projectId",
  );
  const expectedOrigin = productionUrl(
    input.expectedProductionUrl,
    "expected Sites rollback production URL",
  );
  const expectedVersionId = opaqueId(
    input.expectedVersionId,
    "expected Sites rollback versionId",
  );
  const expectedVersionNumber = positiveInteger(
    input.expectedVersionNumber,
    "expected Sites rollback versionNumber",
  );
  const expectedDeploymentId = opaqueId(
    input.expectedDeploymentId,
    "expected Sites rollback deploymentId",
  );
  ensureExact(target.projectId, expectedProjectId, "rollback target projectId");
  ensureExact(
    target.productionUrl,
    expectedOrigin,
    "rollback target production URL",
  );
  ensureExact(
    target.previous.versionId,
    expectedVersionId,
    "rollback target versionId",
  );
  ensureExact(
    target.previous.versionNumber,
    expectedVersionNumber,
    "rollback target versionNumber",
  );
  ensureExact(
    receipt.rollback.deploymentId,
    expectedDeploymentId,
    "rollback receipt deploymentId",
  );
  const verified = verifyStrictSignedEnvelope({
    value: input.attestation,
    verificationKey: key.key,
    envelopeSchemaVersion:
      SIGNED_SITES_PRODUCTION_ROLLBACK_ATTESTATION_SCHEMA_V1,
    payloadLabel: "Sites production rollback attestation",
    validatePayload: attestationPayload,
  });
  if (verified.keyId !== policy.approvedKeyId) {
    throw new Error("Sites rollback attestation key ID is not trusted");
  }
  const payload = verified.payload;
  ensureExact(
    payload.receiptHash,
    receipt.evidenceHash,
    "Sites rollback attestation receiptHash",
  );
  ensureExact(
    payload.targetHash,
    target.evidenceHash,
    "Sites rollback attestation targetHash",
  );
  ensureExact(
    payload.projectId,
    expectedProjectId,
    "Sites rollback attestation projectId",
  );
  ensureExact(
    payload.productionUrl,
    expectedOrigin,
    "Sites rollback attestation production URL",
  );
  ensureExact(
    payload.versionId,
    expectedVersionId,
    "Sites rollback attestation versionId",
  );
  ensureExact(
    Number(payload.versionNumber),
    expectedVersionNumber,
    "Sites rollback attestation versionNumber",
  );
  ensureExact(
    payload.deploymentId,
    expectedDeploymentId,
    "Sites rollback attestation deploymentId",
  );
  const receiptGeneratedAt = Date.parse(receipt.generatedAt);
  const receiptExpiresAt = Date.parse(receipt.expiresAt);
  const attestationGeneratedAt = Date.parse(String(payload.generatedAt));
  const attestationExpiresAt = Date.parse(String(payload.expiresAt));
  if (
    attestationGeneratedAt < receiptGeneratedAt
    || attestationGeneratedAt - receiptGeneratedAt
      > MAX_RECEIPT_ATTESTATION_SKEW_MS
    || attestationExpiresAt > receiptExpiresAt
  ) {
    throw new Error(
      "Sites rollback attestation timestamps do not bind the fresh receipt",
    );
  }
  const verifiedAt = input.now
    ? timestamp(input.now, "Sites rollback verification time")
    : new Date().toISOString();
  const now = Date.parse(verifiedAt);
  if (
    receiptGeneratedAt > now + MAX_RECEIPT_ATTESTATION_SKEW_MS
    || attestationGeneratedAt > now + MAX_RECEIPT_ATTESTATION_SKEW_MS
    || now >= receiptExpiresAt
    || now >= attestationExpiresAt
  ) {
    throw new Error("Sites rollback receipt or attestation is not currently valid");
  }
  const proofSource: Omit<SitesProductionRollbackProofV1, "evidenceHash"> = {
    schemaVersion: SITES_PRODUCTION_ROLLBACK_PROOF_SCHEMA_V1,
    verifiedAt,
    projectId: expectedProjectId,
    productionUrl: expectedOrigin,
    versionId: expectedVersionId,
    versionNumber: expectedVersionNumber,
    rollbackDeploymentId: expectedDeploymentId,
    restoredBuildVersion: target.previous.liveBuildVersion,
    restoredBuildRevision: target.previous.liveBuildRevision,
    targetHash: target.evidenceHash,
    receiptHash: receipt.evidenceHash,
    attestationPayloadHash: verified.payloadHash,
    verificationKeyFingerprint: fingerprint,
  };
  return {
    ...proofSource,
    evidenceHash: signedArtifactSha256(proofSource),
  };
}

export function sitesProductionRollbackAttestationPayloadV1(input: {
  generatedAt: string;
  expiresAt: string;
  receipt: SitesProductionRollbackReceiptV1;
}): JsonRecord {
  const generatedAt = timestamp(
    input.generatedAt,
    "Sites rollback attestation generatedAt",
  );
  const expiresAt = timestamp(
    input.expiresAt,
    "Sites rollback attestation expiresAt",
  );
  const payload: JsonRecord = {
    schemaVersion: SITES_PRODUCTION_ROLLBACK_ATTESTATION_SCHEMA_V1,
    generatedAt,
    expiresAt,
    issuer: SITES_CONTROL_PLANE_ISSUER_V1,
    operation: SITES_PRODUCTION_ROLLBACK_OPERATION,
    receiptHash: input.receipt.evidenceHash,
    targetHash: input.receipt.targetHash,
    projectId: input.receipt.projectId,
    productionUrl: input.receipt.productionUrl,
    versionId: input.receipt.rollback.versionId,
    versionNumber: input.receipt.rollback.versionNumber,
    deploymentId: input.receipt.rollback.deploymentId,
  };
  return attestationPayload(payload);
}
