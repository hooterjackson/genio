import { createHash } from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_REVISION = /^[0-9a-f]{40}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

type JsonRecord = Record<string, unknown>;

export const IRISH_INFLUENCE_RELEASE_PROOF_SCHEMA_V1 =
  "genio-irish-influence-release-proof/v1" as const;

export interface IrishInfluenceReleaseProofV1 {
  schemaVersion: typeof IRISH_INFLUENCE_RELEASE_PROOF_SCHEMA_V1;
  fixtureId: "irish-influence-recovery-25-v1";
  candidate: {
    version: string;
    sourceRevision: string;
    workerConfigurationHash: string;
  };
  ownerAcceptance: {
    trafficClass: "owner_canary";
    assignmentKind: "signed_owner_canary";
    intentGroup: "editorial_influence";
    executionRoute: "corpus_first_v3";
    contractVersion: 3;
    guidanceVersion: "adaptive_guidance_v5";
    hardMembershipAxis: "geography";
    hardMembershipValue: "Irish";
    influenceKind: "influence";
    assignmentReceiptHash: string;
    routeReceiptHash: string;
    questionSetHash: string;
    questionHash: string;
    axis: "influence_scope";
    selectedOptionId: "balanced_influence";
    baseContractSemanticHash: string;
    successorContractSemanticHash: string;
    queryPlanSchema: 6;
    queryPlanHash: string;
    queryPlanRevisionHash: string;
    optionSimulationReceiptHash: string;
    executionEffectHash: string;
    workerConsumptionReceiptHash: string;
    workerConsumptionStatus: "consumed";
  };
  recoveryInjection: {
    discoveryObservationCount: 80;
    uniqueLeadCount: 80;
    qualificationObservationCount: 77;
    candidateBoundQualificationCount: 77;
    legacyUnboundQualificationCount: 0;
    qualificationBindingMismatchCount: 0;
    qualificationBindingSetHash: string;
    materializedCandidateCount: 77;
    applePlayableCount: 73;
    evidenceQualifiedCount: 0;
    limitingObligationUnknownCount: 77;
    limitingObligationFailCount: 0;
    acquisitionAttemptCount: number;
    disposition:
      | "bounded_evidence_enrichment"
      | "blocked_dependency"
      | "quarantined_capability_gap"
      | "quarantined_evidence_binding_defect";
    nextActionKind:
      | "resume_at"
      | "replay_after_repair";
    scarcityReported: false;
    actionless: false;
  };
  publication: {
    selectedCount: 25;
    manifestedCount: 25;
    appendedCount: 25;
    reconciledPublishedCount: 25;
    expectedOrderedAppleIdsHash: string;
    observedOrderedAppleIdsHash: string;
  };
  observedAt: string;
  evidenceHash: string;
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
    throw new Error(`${label} has missing or unapproved fields`);
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function exactCount(
  value: unknown,
  expected: number,
  label: string,
): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count !== expected) {
    throw new Error(`${label} must equal ${expected}`);
  }
  return count;
}

export function validateIrishInfluenceReleaseProofV1(
  value: unknown,
  expected: {
    version: string;
    sourceRevision: string;
    workerConfigurationHashes: readonly string[];
    contractHash: string;
    questionSetHash: string;
    questionHash: string;
    queryPlanRevisionHash: string;
    orderedAppleIdsHash: string;
  },
): IrishInfluenceReleaseProofV1 {
  const proof = record(value, "Irish-influence release proof");
  exactKeys(proof, [
    "schemaVersion",
    "fixtureId",
    "candidate",
    "ownerAcceptance",
    "recoveryInjection",
    "publication",
    "observedAt",
    "evidenceHash",
  ], "Irish-influence release proof");
  if (
    proof.schemaVersion !== IRISH_INFLUENCE_RELEASE_PROOF_SCHEMA_V1
    || proof.fixtureId !== "irish-influence-recovery-25-v1"
  ) {
    throw new Error("Irish-influence release proof uses the wrong schema or fixture");
  }

  const candidate = record(proof.candidate, "Irish-influence proof candidate");
  exactKeys(candidate, [
    "version",
    "sourceRevision",
    "workerConfigurationHash",
  ], "Irish-influence proof candidate");
  if (
    typeof candidate.version !== "string"
    || !VERSION.test(candidate.version)
    || candidate.version !== expected.version
    || typeof candidate.sourceRevision !== "string"
    || !SOURCE_REVISION.test(candidate.sourceRevision)
    || candidate.sourceRevision !== expected.sourceRevision
    || !expected.workerConfigurationHashes.includes(
      digest(
        candidate.workerConfigurationHash,
        "Irish-influence worker configuration hash",
      ),
    )
  ) {
    throw new Error("Irish-influence release proof does not bind the promoted worker");
  }

  const owner = record(
    proof.ownerAcceptance,
    "Irish-influence owner acceptance",
  );
  exactKeys(owner, [
    "trafficClass",
    "assignmentKind",
    "intentGroup",
    "executionRoute",
    "contractVersion",
    "guidanceVersion",
    "hardMembershipAxis",
    "hardMembershipValue",
    "influenceKind",
    "assignmentReceiptHash",
    "routeReceiptHash",
    "questionSetHash",
    "questionHash",
    "axis",
    "selectedOptionId",
    "baseContractSemanticHash",
    "successorContractSemanticHash",
    "queryPlanSchema",
    "queryPlanHash",
    "queryPlanRevisionHash",
    "optionSimulationReceiptHash",
    "executionEffectHash",
    "workerConsumptionReceiptHash",
    "workerConsumptionStatus",
  ], "Irish-influence owner acceptance");
  if (
    owner.trafficClass !== "owner_canary"
    || owner.assignmentKind !== "signed_owner_canary"
    || owner.intentGroup !== "editorial_influence"
    || owner.executionRoute !== "corpus_first_v3"
    || owner.contractVersion !== 3
    || owner.guidanceVersion !== "adaptive_guidance_v5"
    || owner.hardMembershipAxis !== "geography"
    || owner.hardMembershipValue !== "Irish"
    || owner.influenceKind !== "influence"
    || owner.axis !== "influence_scope"
    || owner.selectedOptionId !== "balanced_influence"
    || owner.queryPlanSchema !== 6
    || owner.workerConsumptionStatus !== "consumed"
    || owner.successorContractSemanticHash !== expected.contractHash
    || owner.questionSetHash !== expected.questionSetHash
    || owner.questionHash !== expected.questionHash
    || owner.queryPlanRevisionHash !== expected.queryPlanRevisionHash
    || owner.baseContractSemanticHash === owner.successorContractSemanticHash
  ) {
    throw new Error(
      "Irish-influence owner proof does not show the signed editorial V5 successor",
    );
  }
  for (const field of [
    "assignmentReceiptHash",
    "routeReceiptHash",
    "questionSetHash",
    "questionHash",
    "baseContractSemanticHash",
    "successorContractSemanticHash",
    "queryPlanHash",
    "queryPlanRevisionHash",
    "optionSimulationReceiptHash",
    "executionEffectHash",
    "workerConsumptionReceiptHash",
  ]) {
    digest(owner[field], `Irish-influence owner ${field}`);
  }

  const recovery = record(
    proof.recoveryInjection,
    "Irish-influence 80/77/73/0 recovery injection",
  );
  exactKeys(recovery, [
    "discoveryObservationCount",
    "uniqueLeadCount",
    "qualificationObservationCount",
    "candidateBoundQualificationCount",
    "legacyUnboundQualificationCount",
    "qualificationBindingMismatchCount",
    "qualificationBindingSetHash",
    "materializedCandidateCount",
    "applePlayableCount",
    "evidenceQualifiedCount",
    "limitingObligationUnknownCount",
    "limitingObligationFailCount",
    "acquisitionAttemptCount",
    "disposition",
    "nextActionKind",
    "scarcityReported",
    "actionless",
  ], "Irish-influence 80/77/73/0 recovery injection");
  exactCount(
    recovery.discoveryObservationCount,
    80,
    "recovery discoveryObservationCount",
  );
  exactCount(recovery.uniqueLeadCount, 80, "recovery uniqueLeadCount");
  exactCount(
    recovery.qualificationObservationCount,
    77,
    "recovery qualificationObservationCount",
  );
  exactCount(
    recovery.candidateBoundQualificationCount,
    77,
    "recovery candidateBoundQualificationCount",
  );
  exactCount(
    recovery.legacyUnboundQualificationCount,
    0,
    "recovery legacyUnboundQualificationCount",
  );
  exactCount(
    recovery.qualificationBindingMismatchCount,
    0,
    "recovery qualificationBindingMismatchCount",
  );
  digest(
    recovery.qualificationBindingSetHash,
    "recovery qualificationBindingSetHash",
  );
  exactCount(
    recovery.materializedCandidateCount,
    77,
    "recovery materializedCandidateCount",
  );
  exactCount(recovery.applePlayableCount, 73, "recovery applePlayableCount");
  exactCount(
    recovery.evidenceQualifiedCount,
    0,
    "recovery evidenceQualifiedCount",
  );
  exactCount(
    recovery.limitingObligationUnknownCount,
    77,
    "recovery limitingObligationUnknownCount",
  );
  exactCount(
    recovery.limitingObligationFailCount,
    0,
    "recovery limitingObligationFailCount",
  );
  const acquisitionAttemptCount = Number(recovery.acquisitionAttemptCount);
  const permittedDispositions = new Set([
    "bounded_evidence_enrichment",
    "blocked_dependency",
    "quarantined_capability_gap",
    "quarantined_evidence_binding_defect",
  ]);
  const advancingActions = new Set(["resume_at", "replay_after_repair"]);
  if (
    !Number.isSafeInteger(acquisitionAttemptCount)
    || acquisitionAttemptCount < 0
    || !permittedDispositions.has(String(recovery.disposition))
    || !advancingActions.has(String(recovery.nextActionKind))
    || recovery.scarcityReported !== false
    || recovery.actionless !== false
  ) {
    throw new Error(
      "Irish-influence 80/77/73/0 injection did not reach a bounded repair state",
    );
  }

  const publication = record(
    proof.publication,
    "Irish-influence publication proof",
  );
  exactKeys(publication, [
    "selectedCount",
    "manifestedCount",
    "appendedCount",
    "reconciledPublishedCount",
    "expectedOrderedAppleIdsHash",
    "observedOrderedAppleIdsHash",
  ], "Irish-influence publication proof");
  for (const field of [
    "selectedCount",
    "manifestedCount",
    "appendedCount",
    "reconciledPublishedCount",
  ]) {
    exactCount(publication[field], 25, `Irish-influence publication ${field}`);
  }
  const expectedOrderedAppleIdsHash = digest(
    publication.expectedOrderedAppleIdsHash,
    "Irish-influence expected ordered Apple IDs hash",
  );
  const observedOrderedAppleIdsHash = digest(
    publication.observedOrderedAppleIdsHash,
    "Irish-influence observed ordered Apple IDs hash",
  );
  if (
    expectedOrderedAppleIdsHash !== observedOrderedAppleIdsHash
    || observedOrderedAppleIdsHash !== expected.orderedAppleIdsHash
  ) {
    throw new Error(
      "Irish-influence publication does not match the independent ordered Apple readback",
    );
  }

  timestamp(proof.observedAt, "Irish-influence proof observedAt");
  const unsigned = { ...proof };
  delete unsigned.evidenceHash;
  if (
    digest(proof.evidenceHash, "Irish-influence proof evidenceHash")
      !== sha256(unsigned)
  ) {
    throw new Error("Irish-influence release proof hash is invalid");
  }
  return proof as unknown as IrishInfluenceReleaseProofV1;
}
