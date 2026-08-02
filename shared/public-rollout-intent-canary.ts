import {
  createHash,
  createPublicKey,
  KeyObject,
} from "node:crypto";
import { RELEASE_EVIDENCE_TTL_MS } from "./release-evidence-constants.ts";
import {
  exactObject,
  sha256Digest,
  signedArtifactSha256,
  verifyStrictSignedEnvelope,
  type JsonRecord,
} from "./signed-artifact.ts";

export const PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION =
  "genio-public-rollout-intent-canary/v4" as const;
export const SIGNED_PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION =
  "genio-signed-public-rollout-intent-canary/v4" as const;
export const PUBLIC_ROLLOUT_INTENT_ASSIGNMENT_SCHEMA_VERSION =
  "genio-public-rollout-intent-assignment/v2" as const;
export const PUBLIC_ROLLOUT_INTENT_CANARY_PROVENANCE_SCHEMA_VERSION =
  "genio-public-rollout-intent-canary-provenance/v2" as const;
export const PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SCHEMA_VERSION =
  "genio-public-rollout-intent-canary-authority-policy/v1" as const;
export const PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURE_REGISTRY_SCHEMA_VERSION =
  "genio-public-rollout-intent-canary-fixture-registry/v1" as const;

const codeOwnedIntentFixtureHash = (
  fixtureId: string,
  targetTrackCount: number,
): string => signedArtifactSha256({
  schemaVersion: "genio-public-rollout-intent-protected-fixture/v1",
  fixtureId,
  targetTrackCount,
});

export const PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES = Object.freeze({
  editorial_influence: Object.freeze({
    fixtureId: "irish-influence-25-v1",
    fixtureHash: codeOwnedIntentFixtureHash("irish-influence-25-v1", 25),
    targetTrackCount: 25,
  }),
  genre_scene: Object.freeze({
    fixtureId: "smooth-reggaeton-heat-50-v1",
    // This is the exact code-owned RELEASE_FIXTURES descriptor hash. It binds
    // the original prompt plus the recommended >=70% core-reggaeton guidance.
    fixtureHash:
      "b4c3bd0be8b9020f0fb05959fd7b03763f875a676fc058f507a52e1b10083a80",
    targetTrackCount: 50,
  }),
  mood_activity_theme: Object.freeze({
    fixtureId: "dark-ambient-sleep-25-v1",
    fixtureHash: codeOwnedIntentFixtureHash("dark-ambient-sleep-25-v1", 25),
    targetTrackCount: 25,
  }),
  similarity: Object.freeze({
    fixtureId: "radiohead-similarity-exclusion-25-v1",
    fixtureHash: codeOwnedIntentFixtureHash(
      "radiohead-similarity-exclusion-25-v1",
      25,
    ),
    targetTrackCount: 25,
  }),
  artist_catalogue: Object.freeze({
    fixtureId: "artist-catalogue-scope-25-v1",
    fixtureHash: codeOwnedIntentFixtureHash(
      "artist-catalogue-scope-25-v1",
      25,
    ),
    targetTrackCount: 25,
  }),
  fixed_container: Object.freeze({
    fixtureId: "kind-of-blue-fixed-container-5-v1",
    fixtureHash: codeOwnedIntentFixtureHash(
      "kind-of-blue-fixed-container-5-v1",
      5,
    ),
    targetTrackCount: 5,
  }),
  factual_relationship: Object.freeze({
    fixtureId: "paulinho-da-costa-factual-25-v1",
    fixtureHash: codeOwnedIntentFixtureHash(
      "paulinho-da-costa-factual-25-v1",
      25,
    ),
    targetTrackCount: 25,
  }),
  exhaustive: Object.freeze({
    fixtureId: "source-bounded-exhaustive-25-v1",
    fixtureHash: codeOwnedIntentFixtureHash(
      "source-bounded-exhaustive-25-v1",
      25,
    ),
    targetTrackCount: 25,
  }),
} as const);

export const PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURE_REGISTRY_HASH_V1 =
  signedArtifactSha256({
    schemaVersion:
      PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURE_REGISTRY_SCHEMA_VERSION,
    fixtures: PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES,
  });

export type PublicRolloutIntentCanaryGroup =
  keyof typeof PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES;
export type PublicRolloutIntentCanaryPercent =
  "0" | "1" | "10" | "50" | "100";

export interface VerifiedPublicRolloutIntentCanaryV1 {
  payloadHash: string;
  generatedAt: string;
  expiresAt: string;
  candidate: {
    tag: string;
    version: string;
    sourceRevision: string;
    imageDigest: string;
    apiConfigurationHash: string;
    executorIdentityHash: string;
  };
  transition: {
    intentGroup: PublicRolloutIntentCanaryGroup;
    fromPercent: PublicRolloutIntentCanaryPercent;
    toPercent: Exclude<PublicRolloutIntentCanaryPercent, "0">;
    targetConfigurationHash: string;
    assignmentHash: string;
  };
  fixture: {
    fixtureId: string;
    fixtureHash: string;
    targetTrackCount: number;
    contractSemanticHash: string;
  };
  execution: {
    completedAt: string;
    manifestContentHash: string;
    orderedAppleIdsHash: string;
    independentAppleEvidenceHash: string;
    browserEvidenceHash: string;
    workerConfigurationHash: string;
  };
  stageMetrics: {
    windowStartedAt: string;
    windowCompletedAt: string;
    eligibleSubmissionCount: number;
    candidateAssignedCount: number;
    exactCompletionCount: number;
  };
  provenance: {
    derivationHash: string;
    sourcePayloadHashes: {
      assignment: string;
      manifest: string;
      apple: string;
      browser: string;
      metrics: string;
    };
    producerKeySha256: string;
    rolloutEvidenceKeySha256: string;
    authorityPolicyHash: string;
  };
}

export interface PublicRolloutIntentCanaryTrustV1 {
  producerKeyId: string;
  producerKeySha256: string;
}

const FULL_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const RC_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.[1-9]\d*$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PERCENTAGES = ["0", "1", "10", "50", "100"] as const;
const FIXTURE_ID = /^[0-9a-z][0-9a-z-]{2,95}$/u;
const MINIMUM_STAGE_SAMPLES: Readonly<
  Record<PublicRolloutIntentCanaryPercent, number>
> = Object.freeze({
  "0": 0,
  "1": 5,
  "10": 20,
  "50": 50,
  "100": 100,
});
const MINIMUM_ELIGIBLE_SUBMISSIONS: Readonly<
  Record<PublicRolloutIntentCanaryPercent, number>
> = Object.freeze({
  "0": 0,
  "1": 100,
  "10": 200,
  "50": 200,
  "100": 250,
});
const MINIMUM_STAGE_DURATION_MS: Readonly<
  Record<PublicRolloutIntentCanaryPercent, number>
> = Object.freeze({
  "0": 60_000,
  "1": 60 * 60_000,
  "10": 2 * 60 * 60_000,
  "50": 6 * 60 * 60_000,
  "100": 24 * 60 * 60_000,
});

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonnegativeInteger(value, label);
  if (result < 1) throw new Error(`${label} must be positive`);
  return result;
}

function intentGroup(value: unknown): PublicRolloutIntentCanaryGroup {
  if (
    typeof value !== "string"
    || !Object.hasOwn(PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES, value)
  ) {
    throw new Error("public rollout intent canary intentGroup is invalid");
  }
  return value as PublicRolloutIntentCanaryGroup;
}

function percentage(
  value: unknown,
  label: string,
): PublicRolloutIntentCanaryPercent {
  if (
    typeof value !== "string"
    || !(PERCENTAGES as readonly string[]).includes(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value as PublicRolloutIntentCanaryPercent;
}

function score(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 5) {
    throw new Error(`${label} must be between one and five`);
  }
  return value;
}

function exactRate(
  value: unknown,
  numerator: number,
  denominator: number,
  label: string,
): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > 1
    || Math.abs(value - (denominator === 0 ? 0 : numerator / denominator))
      > Number.EPSILON
  ) {
    throw new Error(`${label} is not recomputable from its exact counts`);
  }
  return value;
}

function stageAllocationIsPlausible(
  stage: PublicRolloutIntentCanaryPercent,
  candidateAssignedCount: number,
  controlAssignedCount: number,
): boolean {
  if (stage === "0") return candidateAssignedCount === 0;
  if (stage === "100") return controlAssignedCount === 0;
  const total = candidateAssignedCount + controlAssignedCount;
  if (total === 0 || controlAssignedCount === 0) return false;
  const expectedShare = Number(stage) / 100;
  const observedShare = candidateAssignedCount / total;
  return observedShare >= expectedShare / 2
    && observedShare <= expectedShare * 2;
}

export function publicRolloutIntentAssignmentHashV2(input: {
  sourceRevision: string;
  imageDigest: string;
  apiConfigurationHash: string;
  executorIdentityHash: string;
  intentGroup: PublicRolloutIntentCanaryGroup;
  fromPercent: PublicRolloutIntentCanaryPercent;
  toPercent: Exclude<PublicRolloutIntentCanaryPercent, "0">;
  targetConfigurationHash: string;
  fixtureHash: string;
  contractSemanticHash: string;
}): string {
  return signedArtifactSha256({
    schemaVersion: PUBLIC_ROLLOUT_INTENT_ASSIGNMENT_SCHEMA_VERSION,
    route: "owner_candidate",
    ...input,
  });
}

const PUBLIC_ROLLOUT_SOURCE_ROLES = [
  "assignment",
  "manifest",
  "apple",
  "browser",
  "metrics",
] as const;

export function publicRolloutIntentCanaryAuthorityPolicyHashV1(input: {
  sourceKeySha256: Record<
    typeof PUBLIC_ROLLOUT_SOURCE_ROLES[number],
    string
  >;
  producerKeySha256: string;
  rolloutEvidenceKeySha256: string;
}): string {
  const sourceKeySha256 = Object.fromEntries(
    PUBLIC_ROLLOUT_SOURCE_ROLES.map((role) => [
      role,
      sha256Digest(
        input.sourceKeySha256[role],
        `public rollout intent canary authority ${role} key`,
      ),
    ]),
  ) as Record<typeof PUBLIC_ROLLOUT_SOURCE_ROLES[number], string>;
  const producerKeySha256 = sha256Digest(
    input.producerKeySha256,
    "public rollout intent canary authority producer key",
  );
  const rolloutEvidenceKeySha256 = sha256Digest(
    input.rolloutEvidenceKeySha256,
    "public rollout intent canary authority rollout evidence key",
  );
  const fingerprints = [
    ...PUBLIC_ROLLOUT_SOURCE_ROLES.map((role) => sourceKeySha256[role]),
    producerKeySha256,
    rolloutEvidenceKeySha256,
  ];
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error(
      "public rollout intent canary authority keys must be distinct",
    );
  }
  return signedArtifactSha256({
    schemaVersion:
      PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SCHEMA_VERSION,
    fixtureRegistryHash:
      PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURE_REGISTRY_HASH_V1,
    sourceKeySha256,
    producerKeySha256,
    rolloutEvidenceKeySha256,
  });
}

function validatePayload(value: unknown): {
  payload: JsonRecord;
  verified: Omit<VerifiedPublicRolloutIntentCanaryV1, "payloadHash">;
} {
  const payload = exactObject(value, [
    "schemaVersion",
    "generatedAt",
    "expiresAt",
    "environment",
    "candidate",
    "transition",
    "fixture",
    "execution",
    "stageMetrics",
    "provenance",
  ], "public rollout intent canary");
  if (
    payload.schemaVersion !== PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION
    || payload.environment !== "production"
  ) {
    throw new Error("public rollout intent canary must attest production");
  }
  const generatedAt = isoTimestamp(
    payload.generatedAt,
    "public rollout intent canary.generatedAt",
  );
  const expiresAt = isoTimestamp(
    payload.expiresAt,
    "public rollout intent canary.expiresAt",
  );
  const validity = Date.parse(expiresAt) - Date.parse(generatedAt);
  if (validity <= 0 || validity > RELEASE_EVIDENCE_TTL_MS) {
    throw new Error("public rollout intent canary must expire within 24 hours");
  }
  const candidate = exactObject(payload.candidate, [
    "tag",
    "version",
    "sourceRevision",
    "imageDigest",
    "apiConfigurationHash",
    "executorIdentityHash",
  ], "public rollout intent canary candidate");
  if (
    typeof candidate.tag !== "string"
    || !RC_TAG.test(candidate.tag)
    || typeof candidate.version !== "string"
    || !VERSION.test(candidate.version)
    || !candidate.tag.startsWith(`v${candidate.version}-rc.`)
    || typeof candidate.sourceRevision !== "string"
    || !FULL_REVISION.test(candidate.sourceRevision)
    || typeof candidate.imageDigest !== "string"
    || !IMAGE_DIGEST.test(candidate.imageDigest)
  ) {
    throw new Error("public rollout intent canary candidate is invalid");
  }
  const apiConfigurationHash = sha256Digest(
    candidate.apiConfigurationHash,
    "public rollout intent canary candidate.apiConfigurationHash",
  );
  const executorIdentityHash = sha256Digest(
    candidate.executorIdentityHash,
    "public rollout intent canary candidate.executorIdentityHash",
  );
  const transition = exactObject(payload.transition, [
    "operation",
    "intentGroup",
    "fromPercent",
    "toPercent",
    "targetConfigurationHash",
    "assignmentRoute",
    "assignmentHash",
  ], "public rollout intent canary transition");
  const group = intentGroup(transition.intentGroup);
  const fromPercent = percentage(
    transition.fromPercent,
    "public rollout intent canary transition.fromPercent",
  );
  const toPercent = percentage(
    transition.toPercent,
    "public rollout intent canary transition.toPercent",
  );
  if (
    transition.operation !== "advance"
    || transition.assignmentRoute !== "owner_candidate"
    || toPercent === "0"
    || PERCENTAGES[PERCENTAGES.indexOf(fromPercent) + 1] !== toPercent
  ) {
    throw new Error(
      "public rollout intent canary must bind the next owner-candidate advance",
    );
  }
  const targetConfigurationHash = sha256Digest(
    transition.targetConfigurationHash,
    "public rollout intent canary transition.targetConfigurationHash",
  );
  const assignmentHash = sha256Digest(
    transition.assignmentHash,
    "public rollout intent canary transition.assignmentHash",
  );
  const fixture = exactObject(payload.fixture, [
    "fixtureId",
    "fixtureHash",
    "targetTrackCount",
    "contractSemanticHash",
  ], "public rollout intent canary fixture");
  const expectedFixture = PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES[group];
  if (
    typeof fixture.fixtureId !== "string"
    || !FIXTURE_ID.test(fixture.fixtureId)
    || fixture.fixtureId !== expectedFixture.fixtureId
    || positiveInteger(
      fixture.targetTrackCount,
      "public rollout intent canary fixture.targetTrackCount",
    ) !== expectedFixture.targetTrackCount
  ) {
    throw new Error("public rollout intent canary uses the wrong capability fixture");
  }
  const fixtureHash = sha256Digest(
    fixture.fixtureHash,
    "public rollout intent canary fixture.fixtureHash",
  );
  const contractSemanticHash = sha256Digest(
    fixture.contractSemanticHash,
    "public rollout intent canary fixture.contractSemanticHash",
  );
  if (fixtureHash !== expectedFixture.fixtureHash) {
    throw new Error(
      "public rollout intent canary fixture hash is not the protected capability fixture",
    );
  }
  const expectedAssignmentHash = publicRolloutIntentAssignmentHashV2({
    sourceRevision: String(candidate.sourceRevision),
    imageDigest: String(candidate.imageDigest),
    apiConfigurationHash,
    executorIdentityHash,
    intentGroup: group,
    fromPercent,
    toPercent: toPercent as Exclude<PublicRolloutIntentCanaryPercent, "0">,
    targetConfigurationHash,
    fixtureHash,
    contractSemanticHash,
  });
  if (assignmentHash !== expectedAssignmentHash) {
    throw new Error("public rollout intent canary assignment hash does not match");
  }
  const execution = exactObject(payload.execution, [
    "completedAt",
    "outcome",
    "requestedTrackCount",
    "selectedTrackCount",
    "contractSemanticHash",
    "guidanceLineageHash",
    "manifestContentHash",
    "orderedAppleIdsHash",
    "independentAppleEvidenceHash",
    "browserEvidenceHash",
    "workerRevision",
    "workerConfigurationHash",
    "workerIdentityHash",
    "qualityScores",
  ], "public rollout intent canary execution");
  const completedAt = isoTimestamp(
    execution.completedAt,
    "public rollout intent canary execution.completedAt",
  );
  if (
    execution.outcome !== "exact_ready"
    || positiveInteger(
      execution.requestedTrackCount,
      "public rollout intent canary execution.requestedTrackCount",
    ) !== expectedFixture.targetTrackCount
    || positiveInteger(
      execution.selectedTrackCount,
      "public rollout intent canary execution.selectedTrackCount",
    ) !== expectedFixture.targetTrackCount
    || execution.workerRevision !== candidate.sourceRevision
    || execution.workerIdentityHash !== executorIdentityHash
    || execution.contractSemanticHash !== contractSemanticHash
    || (
      group === "editorial_influence"
      && (
        typeof execution.guidanceLineageHash !== "string"
        || !/^[0-9a-f]{64}$/u.test(execution.guidanceLineageHash)
      )
    )
    || (
      execution.guidanceLineageHash !== null
      && (
        typeof execution.guidanceLineageHash !== "string"
        || !/^[0-9a-f]{64}$/u.test(execution.guidanceLineageHash)
      )
    )
  ) {
    throw new Error("public rollout intent canary execution is not exact");
  }
  const workerConfigurationHash = sha256Digest(
    execution.workerConfigurationHash,
    "public rollout intent canary execution.workerConfigurationHash",
  );
  for (const field of [
    "manifestContentHash",
    "orderedAppleIdsHash",
    "independentAppleEvidenceHash",
    "browserEvidenceHash",
  ] as const) {
    sha256Digest(
      execution[field],
      `public rollout intent canary execution.${field}`,
    );
  }
  const qualityScores = exactObject(execution.qualityScores, [
    "relevance",
    "discoveryQuality",
    "coherence",
    "sequencing",
  ], "public rollout intent canary execution.qualityScores");
  for (const [dimension, value] of Object.entries(qualityScores)) {
    if (score(value, `public rollout intent canary quality ${dimension}`) < 4) {
      throw new Error("public rollout intent canary quality is below four");
    }
  }
  const metrics = exactObject(payload.stageMetrics, [
    "windowStartedAt",
    "windowCompletedAt",
    "intentGroup",
    "stagePercent",
    "eligibleSubmissionCount",
    "sharedProviderIncidentCount",
    "candidateAssignedCount",
    "controlAssignedCount",
    "exactCompletionCount",
    "actionableDecisionCount",
    "visibleRetryStateCount",
    "cancelledCount",
    "technicalQuarantineCount",
    "controlExactCompletionCount",
    "controlActionableDecisionCount",
    "controlVisibleRetryStateCount",
    "controlCancelledCount",
    "controlTechnicalQuarantineCount",
    "unexplainedDeadEndCount",
    "countOrderViolationCount",
    "hardConstraintViolationCount",
    "stalePublicationCount",
    "providerScarcityMislabelCount",
    "controlExactCompletionRate",
    "candidateExactCompletionRate",
  ], "public rollout intent canary stageMetrics");
  const windowStartedAt = isoTimestamp(
    metrics.windowStartedAt,
    "public rollout intent canary stageMetrics.windowStartedAt",
  );
  const windowCompletedAt = isoTimestamp(
    metrics.windowCompletedAt,
    "public rollout intent canary stageMetrics.windowCompletedAt",
  );
  if (
    metrics.intentGroup !== group
    || metrics.stagePercent !== fromPercent
    || Date.parse(windowCompletedAt) <= Date.parse(windowStartedAt)
    || Date.parse(windowCompletedAt) - Date.parse(windowStartedAt)
      < MINIMUM_STAGE_DURATION_MS[fromPercent]
  ) {
    throw new Error("public rollout intent canary metrics do not bind the current stage");
  }
  const eligibleSubmissionCount = nonnegativeInteger(
    metrics.eligibleSubmissionCount,
    "public rollout intent canary eligibleSubmissionCount",
  );
  const sharedProviderIncidentCount = nonnegativeInteger(
    metrics.sharedProviderIncidentCount,
    "public rollout intent canary sharedProviderIncidentCount",
  );
  const candidateAssignedCount = nonnegativeInteger(
    metrics.candidateAssignedCount,
    "public rollout intent canary candidateAssignedCount",
  );
  const exactCompletionCount = nonnegativeInteger(
    metrics.exactCompletionCount,
    "public rollout intent canary exactCompletionCount",
  );
  const controlAssignedCount = nonnegativeInteger(
    metrics.controlAssignedCount,
    "public rollout intent canary controlAssignedCount",
  );
  const candidateOutcomeCounts = [
    exactCompletionCount,
    nonnegativeInteger(metrics.actionableDecisionCount, "public rollout intent canary actionableDecisionCount"),
    nonnegativeInteger(metrics.visibleRetryStateCount, "public rollout intent canary visibleRetryStateCount"),
    nonnegativeInteger(metrics.cancelledCount, "public rollout intent canary cancelledCount"),
    nonnegativeInteger(metrics.technicalQuarantineCount, "public rollout intent canary technicalQuarantineCount"),
  ];
  const controlExactCompletionCount = nonnegativeInteger(
    metrics.controlExactCompletionCount,
    "public rollout intent canary controlExactCompletionCount",
  );
  const controlOutcomeCounts = [
    controlExactCompletionCount,
    nonnegativeInteger(metrics.controlActionableDecisionCount, "public rollout intent canary controlActionableDecisionCount"),
    nonnegativeInteger(metrics.controlVisibleRetryStateCount, "public rollout intent canary controlVisibleRetryStateCount"),
    nonnegativeInteger(metrics.controlCancelledCount, "public rollout intent canary controlCancelledCount"),
    nonnegativeInteger(metrics.controlTechnicalQuarantineCount, "public rollout intent canary controlTechnicalQuarantineCount"),
  ];
  const invariantCounts = [
    nonnegativeInteger(metrics.unexplainedDeadEndCount, "public rollout intent canary unexplainedDeadEndCount"),
    nonnegativeInteger(metrics.countOrderViolationCount, "public rollout intent canary countOrderViolationCount"),
    nonnegativeInteger(metrics.hardConstraintViolationCount, "public rollout intent canary hardConstraintViolationCount"),
    nonnegativeInteger(metrics.stalePublicationCount, "public rollout intent canary stalePublicationCount"),
    nonnegativeInteger(metrics.providerScarcityMislabelCount, "public rollout intent canary providerScarcityMislabelCount"),
  ];
  if (
    sharedProviderIncidentCount > eligibleSubmissionCount
    || eligibleSubmissionCount < MINIMUM_ELIGIBLE_SUBMISSIONS[fromPercent]
    || candidateAssignedCount < MINIMUM_STAGE_SAMPLES[fromPercent]
    || candidateAssignedCount + controlAssignedCount
      !== eligibleSubmissionCount
    || !stageAllocationIsPlausible(
      fromPercent,
      candidateAssignedCount,
      controlAssignedCount,
    )
    || candidateOutcomeCounts.reduce((sum, count) => sum + count, 0)
      !== candidateAssignedCount
    || controlOutcomeCounts.reduce((sum, count) => sum + count, 0)
      !== controlAssignedCount
    || candidateOutcomeCounts[4] !== 0
    || invariantCounts.some((count) => count !== 0)
    || exactRate(
      metrics.controlExactCompletionRate,
      controlExactCompletionCount,
      controlAssignedCount,
      "public rollout intent canary controlExactCompletionRate",
    ) < 0
    || exactRate(
      metrics.candidateExactCompletionRate,
      exactCompletionCount,
      candidateAssignedCount,
      "public rollout intent canary candidateExactCompletionRate",
    ) < 0
    || (
      candidateAssignedCount > 0
      && Number(metrics.candidateExactCompletionRate) + 0.005
        < Number(metrics.controlExactCompletionRate)
    )
  ) {
    throw new Error(
      "public rollout intent canary stage lacks samples or regresses outcomes/invariants",
    );
  }
  if (
    Date.parse(completedAt) > Date.parse(generatedAt)
    || Date.parse(windowCompletedAt) > Date.parse(generatedAt)
  ) {
    throw new Error("public rollout intent canary sources postdate the signed evidence");
  }
  const provenance = exactObject(payload.provenance, [
    "schemaVersion",
    "producerKind",
    "sourcePayloadHashes",
    "sourceKeySha256",
    "producerKeySha256",
    "rolloutEvidenceKeySha256",
    "authorityPolicyHash",
    "derivationHash",
  ], "public rollout intent canary provenance");
  const sourcePayloadHashes = exactObject(provenance.sourcePayloadHashes, [
    "assignment",
    "manifest",
    "apple",
    "browser",
    "metrics",
  ], "public rollout intent canary provenance source payload hashes");
  const sourceKeySha256 = exactObject(provenance.sourceKeySha256, [
    "assignment",
    "manifest",
    "apple",
    "browser",
    "metrics",
  ], "public rollout intent canary provenance source keys");
  const payloadHashValues = PUBLIC_ROLLOUT_SOURCE_ROLES.map((role) =>
    sha256Digest(
      sourcePayloadHashes[role],
      `public rollout intent canary provenance ${role} payload hash`,
    ));
  const sourceKeyValues = PUBLIC_ROLLOUT_SOURCE_ROLES.map((role) =>
    sha256Digest(
      sourceKeySha256[role],
      `public rollout intent canary provenance ${role} key`,
    ));
  const producerKeySha256 = sha256Digest(
    provenance.producerKeySha256,
    "public rollout intent canary provenance producer key",
  );
  const rolloutEvidenceKeySha256 = sha256Digest(
    provenance.rolloutEvidenceKeySha256,
    "public rollout intent canary provenance rollout evidence key",
  );
  const derivationHash = sha256Digest(
    provenance.derivationHash,
    "public rollout intent canary provenance derivation hash",
  );
  const authorityPolicyHash = sha256Digest(
    provenance.authorityPolicyHash,
    "public rollout intent canary provenance authority policy",
  );
  const unsignedProvenance = {
    schemaVersion: PUBLIC_ROLLOUT_INTENT_CANARY_PROVENANCE_SCHEMA_VERSION,
    producerKind: "protected_exact_source_derivation",
    sourcePayloadHashes,
    sourceKeySha256,
    producerKeySha256,
    rolloutEvidenceKeySha256,
    authorityPolicyHash,
  };
  if (
    provenance.schemaVersion
      !== PUBLIC_ROLLOUT_INTENT_CANARY_PROVENANCE_SCHEMA_VERSION
    || provenance.producerKind !== "protected_exact_source_derivation"
    || new Set(payloadHashValues).size !== payloadHashValues.length
    || new Set([
      ...sourceKeyValues,
      producerKeySha256,
      rolloutEvidenceKeySha256,
    ]).size !== sourceKeyValues.length + 2
    || authorityPolicyHash
      !== publicRolloutIntentCanaryAuthorityPolicyHashV1({
        sourceKeySha256: sourceKeySha256 as Record<
          typeof PUBLIC_ROLLOUT_SOURCE_ROLES[number],
          string
        >,
        producerKeySha256,
        rolloutEvidenceKeySha256,
      })
    || derivationHash !== signedArtifactSha256(unsignedProvenance)
    || sourcePayloadHashes.apple !== execution.independentAppleEvidenceHash
    || sourcePayloadHashes.browser !== execution.browserEvidenceHash
  ) {
    throw new Error(
      "public rollout intent canary provenance is not an exact protected-source derivation",
    );
  }
  return {
    payload,
    verified: {
      generatedAt,
      expiresAt,
      candidate: {
        tag: String(candidate.tag),
        version: String(candidate.version),
        sourceRevision: String(candidate.sourceRevision),
        imageDigest: String(candidate.imageDigest),
        apiConfigurationHash,
        executorIdentityHash,
      },
      transition: {
        intentGroup: group,
        fromPercent,
        toPercent: toPercent as Exclude<PublicRolloutIntentCanaryPercent, "0">,
        targetConfigurationHash,
        assignmentHash,
      },
      fixture: {
        fixtureId: String(fixture.fixtureId),
        fixtureHash,
        targetTrackCount: expectedFixture.targetTrackCount,
        contractSemanticHash,
      },
      execution: {
        completedAt,
        manifestContentHash: String(execution.manifestContentHash),
        orderedAppleIdsHash: String(execution.orderedAppleIdsHash),
        independentAppleEvidenceHash: String(
          execution.independentAppleEvidenceHash,
        ),
        browserEvidenceHash: String(execution.browserEvidenceHash),
        workerConfigurationHash,
      },
      stageMetrics: {
        windowStartedAt,
        windowCompletedAt,
        eligibleSubmissionCount,
        candidateAssignedCount,
        exactCompletionCount,
      },
      provenance: {
        derivationHash,
        sourcePayloadHashes: {
          assignment: String(sourcePayloadHashes.assignment),
          manifest: String(sourcePayloadHashes.manifest),
          apple: String(sourcePayloadHashes.apple),
          browser: String(sourcePayloadHashes.browser),
          metrics: String(sourcePayloadHashes.metrics),
        },
        producerKeySha256,
        rolloutEvidenceKeySha256,
        authorityPolicyHash,
      },
    },
  };
}

export function verifyPublicRolloutIntentCanaryV1(
  value: unknown,
  verificationKey: string | Buffer | KeyObject,
  expected: {
    tag: string;
    version: string;
    sourceRevision: string;
    imageDigest: string;
    apiConfigurationHash: string;
    executorIdentityHash: string;
    intentGroup: PublicRolloutIntentCanaryGroup;
    fromPercent: PublicRolloutIntentCanaryPercent;
    toPercent: Exclude<PublicRolloutIntentCanaryPercent, "0">;
    targetConfigurationHash: string;
    authorityPolicyHash: string;
    now?: string;
  },
): VerifiedPublicRolloutIntentCanaryV1 {
  let validated: ReturnType<typeof validatePayload> | null = null;
  const envelope = verifyStrictSignedEnvelope({
    value,
    verificationKey,
    envelopeSchemaVersion:
      SIGNED_PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
    payloadLabel: "public rollout intent canary",
    validatePayload: (payload) => {
      validated = validatePayload(payload);
      return validated.payload;
    },
  });
  const result = validated!.verified;
  if (
    result.provenance.producerKeySha256
      !== publicRolloutIntentCanaryKeyFingerprint(verificationKey)
  ) {
    throw new Error(
      "public rollout intent canary provenance does not bind its producer key",
    );
  }
  if (
    result.candidate.tag !== expected.tag
    || result.candidate.version !== expected.version
    || result.candidate.sourceRevision !== expected.sourceRevision
    || result.candidate.imageDigest !== expected.imageDigest
    || result.candidate.apiConfigurationHash
      !== expected.apiConfigurationHash
    || result.candidate.executorIdentityHash
      !== expected.executorIdentityHash
    || result.transition.intentGroup !== expected.intentGroup
    || result.transition.fromPercent !== expected.fromPercent
    || result.transition.toPercent !== expected.toPercent
    || result.transition.targetConfigurationHash
      !== expected.targetConfigurationHash
    || result.provenance.authorityPolicyHash
      !== expected.authorityPolicyHash
  ) {
    throw new Error(
      "public rollout intent canary does not bind the exact candidate transition",
    );
  }
  const now = isoTimestamp(
    expected.now ?? new Date().toISOString(),
    "public rollout intent canary verification time",
  );
  if (
    Date.parse(result.generatedAt) > Date.parse(now) + 5 * 60_000
    || Date.parse(result.expiresAt) <= Date.parse(now)
  ) {
    throw new Error("public rollout intent canary is not fresh");
  }
  return Object.freeze({
    payloadHash: envelope.payloadHash,
    ...result,
  });
}

export function publicRolloutIntentCanaryKeyFingerprint(
  value: string | Buffer | KeyObject,
): string {
  const key = value instanceof KeyObject
    ? (value.type === "private" ? createPublicKey(value) : value)
    : createPublicKey(value);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("public rollout intent canary key must be Ed25519");
  }
  return createHash("sha256").update(key.export({
    type: "spki",
    format: "der",
  })).digest("hex");
}

export function verifyTrustedPublicRolloutIntentCanaryV1(
  value: unknown,
  verificationKey: string | Buffer | KeyObject,
  expected: Parameters<typeof verifyPublicRolloutIntentCanaryV1>[2],
  trust: PublicRolloutIntentCanaryTrustV1,
): VerifiedPublicRolloutIntentCanaryV1 {
  const envelope = exactObject(
    value,
    ["schemaVersion", "payload", "payloadHash", "signature"],
    "signed public rollout intent canary",
  );
  const signature = exactObject(
    envelope.signature,
    ["algorithm", "keyId", "value"],
    "signed public rollout intent canary.signature",
  );
  if (
    typeof trust.producerKeyId !== "string"
    || !/^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u.test(
      trust.producerKeyId,
    )
    || !/^[0-9a-f]{64}$/u.test(trust.producerKeySha256)
    || signature.keyId !== trust.producerKeyId
    || publicRolloutIntentCanaryKeyFingerprint(verificationKey)
      !== trust.producerKeySha256
  ) {
    throw new Error(
      "public rollout intent canary is not signed by the protected producer",
    );
  }
  return verifyPublicRolloutIntentCanaryV1(
    value,
    verificationKey,
    expected,
  );
}
