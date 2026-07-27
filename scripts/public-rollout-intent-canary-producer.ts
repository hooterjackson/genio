import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES,
  PUBLIC_ROLLOUT_INTENT_CANARY_PROVENANCE_SCHEMA_VERSION,
  PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
  SIGNED_PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
  publicRolloutIntentAssignmentHashV2,
  publicRolloutIntentCanaryAuthorityPolicyHashV1,
  publicRolloutIntentCanaryKeyFingerprint,
  verifyTrustedPublicRolloutIntentCanaryV1,
  type PublicRolloutIntentCanaryGroup,
  type PublicRolloutIntentCanaryPercent,
  type PublicRolloutIntentCanaryTrustV1,
} from "../shared/public-rollout-intent-canary.ts";
import { RELEASE_EVIDENCE_TTL_MS } from "../shared/release-evidence-constants.ts";
import {
  createStrictSignedEnvelope,
  exactObject,
  sha256Digest,
  signedArtifactSha256,
  verifyStrictSignedEnvelope,
  type JsonRecord,
} from "../shared/signed-artifact.ts";

export const SIGNED_PUBLIC_ROLLOUT_ASSIGNMENT_SOURCE_SCHEMA_VERSION =
  "genio-signed-public-rollout-assignment-source/v2" as const;
export const SIGNED_PUBLIC_ROLLOUT_MANIFEST_SOURCE_SCHEMA_VERSION =
  "genio-signed-public-rollout-manifest-source/v1" as const;
export const SIGNED_PUBLIC_ROLLOUT_APPLE_SOURCE_SCHEMA_VERSION =
  "genio-signed-public-rollout-apple-source/v1" as const;
export const SIGNED_PUBLIC_ROLLOUT_BROWSER_SOURCE_SCHEMA_VERSION =
  "genio-signed-public-rollout-browser-source/v1" as const;
export const SIGNED_PUBLIC_ROLLOUT_METRICS_SOURCE_SCHEMA_VERSION =
  "genio-signed-public-rollout-metrics-source/v2" as const;

const SOURCE_SCHEMAS = {
  assignment: "genio-public-rollout-assignment-source/v2",
  manifest: "genio-public-rollout-manifest-source/v1",
  apple: "genio-public-rollout-apple-source/v1",
  browser: "genio-public-rollout-browser-source/v1",
  metrics: "genio-public-rollout-metrics-source/v2",
} as const;
const SOURCE_ENVELOPE_SCHEMAS = {
  assignment: SIGNED_PUBLIC_ROLLOUT_ASSIGNMENT_SOURCE_SCHEMA_VERSION,
  manifest: SIGNED_PUBLIC_ROLLOUT_MANIFEST_SOURCE_SCHEMA_VERSION,
  apple: SIGNED_PUBLIC_ROLLOUT_APPLE_SOURCE_SCHEMA_VERSION,
  browser: SIGNED_PUBLIC_ROLLOUT_BROWSER_SOURCE_SCHEMA_VERSION,
  metrics: SIGNED_PUBLIC_ROLLOUT_METRICS_SOURCE_SCHEMA_VERSION,
} as const;
export const PUBLIC_ROLLOUT_INTENT_METRICS_QUERY_HASH_V2 =
  signedArtifactSha256({
    schemaVersion: "genio-public-rollout-intent-metrics-query/v2",
    source: "production_database",
    dimensions: [
      "candidate_source_revision",
      "api_configuration_hash",
      "intent_group",
      "stage_percent",
      "window",
    ],
    denominators: [
      "eligible_submission_count",
      "shared_provider_incident_count",
      "candidate_assigned_count",
      "control_assigned_count",
    ],
    outcomes: [
      "exact_completion_count",
      "actionable_decision_count",
      "visible_retry_state_count",
      "cancelled_count",
      "technical_quarantine_count",
      "control_exact_completion_count",
      "control_actionable_decision_count",
      "control_visible_retry_state_count",
      "control_cancelled_count",
      "control_technical_quarantine_count",
    ],
    invariants: [
      "unexplained_dead_end_count",
      "count_order_violation_count",
      "hard_constraint_violation_count",
      "stale_publication_count",
      "provider_scarcity_mislabel_count",
    ],
  });
const SOURCE_ROLES = Object.keys(SOURCE_SCHEMAS) as Array<
  keyof typeof SOURCE_SCHEMAS
>;
const SAFE_KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const SAFE_APPLE_ID = /^[0-9A-Za-z._-]{1,200}$/u;
const PERCENTAGES = ["0", "1", "10", "50", "100"] as const;

export interface ProtectedPublicRolloutSourceV1 {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  trust: PublicRolloutIntentCanaryTrustV1;
}

export interface PublicRolloutIntentCanaryProducerInputV1 {
  assignment: ProtectedPublicRolloutSourceV1;
  manifest: ProtectedPublicRolloutSourceV1;
  apple: ProtectedPublicRolloutSourceV1;
  browser: ProtectedPublicRolloutSourceV1;
  metrics: ProtectedPublicRolloutSourceV1;
  producerSigningKey: string | Buffer | KeyObject;
  producerTrust: PublicRolloutIntentCanaryTrustV1;
  rolloutEvidenceKeySha256: string;
  authorityPolicyHash: string;
  generatedAt?: string;
}

type SourceRole = keyof typeof SOURCE_SCHEMAS;

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}`);
  }
  return Number(value);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function nullableSha256(value: unknown, label: string): string | null {
  return value === null ? null : sha256Digest(value, label);
}

function candidate(value: unknown, label: string): JsonRecord {
  return exactObject(value, [
    "tag",
    "version",
    "sourceRevision",
    "imageDigest",
    "apiConfigurationHash",
    "executorIdentityHash",
  ], label);
}

function transition(value: unknown, label: string): JsonRecord {
  return exactObject(value, [
    "intentGroup",
    "fromPercent",
    "toPercent",
    "targetConfigurationHash",
  ], label);
}

function fixture(value: unknown, label: string): JsonRecord {
  return exactObject(value, [
    "fixtureId",
    "fixtureHash",
    "targetTrackCount",
    "contractSemanticHash",
  ], label);
}

function sourceValidator(
  role: SourceRole,
  value: unknown,
): JsonRecord {
  const keySets: Record<SourceRole, readonly string[]> = {
    assignment: [
      "schemaVersion",
      "capturedAt",
      "environment",
      "route",
      "assigned",
      "candidate",
      "transition",
      "fixture",
      "assignmentHash",
    ],
    manifest: [
      "schemaVersion",
      "completedAt",
      "environment",
      "fixtureId",
      "fixtureHash",
      "outcome",
      "requestedTrackCount",
      "selectedTrackCount",
      "contractSemanticHash",
      "guidanceLineageHash",
      "manifestContentHash",
      "orderedAppleIds",
      "apiConfigurationHash",
      "workerRevision",
      "workerConfigurationHash",
      "executorIdentityHash",
      "qualityScores",
    ],
    apple: [
      "schemaVersion",
      "observedAt",
      "environment",
      "fixtureId",
      "manifestContentHash",
      "orderedAppleIds",
      "exactOrderedReadback",
      "verifierRole",
      "verifierIdentityHash",
    ],
    browser: [
      "schemaVersion",
      "observedAt",
      "environment",
      "fixtureId",
      "manifestContentHash",
      "visibleTrackCount",
      "orderedContentsHash",
      "publicAccessibility",
      "verifierRole",
      "screenshotHash",
    ],
    metrics: [
      "schemaVersion",
      "capturedAt",
      "environment",
      "source",
      "databaseIdentityHash",
      "sourceQueryHash",
      "candidateSourceRevision",
      "apiConfigurationHash",
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
    ],
  };
  const payload = exactObject(
    value,
    keySets[role],
    `public rollout ${role} source`,
  );
  if (
    payload.schemaVersion !== SOURCE_SCHEMAS[role]
    || payload.environment !== "production"
  ) {
    throw new Error(`public rollout ${role} source must attest production`);
  }
  return payload;
}

function verifiedSource(
  role: SourceRole,
  source: ProtectedPublicRolloutSourceV1,
): { payload: JsonRecord; payloadHash: string; keyFingerprint: string } {
  if (
    !SAFE_KEY_ID.test(source.trust.producerKeyId)
    || !/^[0-9a-f]{64}$/u.test(source.trust.producerKeySha256)
  ) {
    throw new Error(`public rollout ${role} source trust is invalid`);
  }
  const envelope = exactObject(source.value, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], `signed public rollout ${role} source`);
  const signature = exactObject(envelope.signature, [
    "algorithm",
    "keyId",
    "value",
  ], `signed public rollout ${role} source signature`);
  const keyFingerprint =
    publicRolloutIntentCanaryKeyFingerprint(source.verificationKey);
  if (
    signature.keyId !== source.trust.producerKeyId
    || keyFingerprint !== source.trust.producerKeySha256
  ) {
    throw new Error(
      `public rollout ${role} source is not signed by its protected authority`,
    );
  }
  const verified = verifyStrictSignedEnvelope({
    value: source.value,
    verificationKey: source.verificationKey,
    envelopeSchemaVersion: SOURCE_ENVELOPE_SCHEMAS[role],
    payloadLabel: `public rollout ${role} source`,
    validatePayload: (payload) => sourceValidator(role, payload),
  });
  return {
    payload: verified.payload,
    payloadHash: verified.payloadHash,
    keyFingerprint,
  };
}

function exactStringArray(
  value: unknown,
  label: string,
): string[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((item) => (
      typeof item !== "string" || !SAFE_APPLE_ID.test(item)
    ))
    || new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must contain unique ordered Apple stable IDs`);
  }
  return value as string[];
}

function equalJson(left: unknown, right: unknown): boolean {
  return signedArtifactSha256(left) === signedArtifactSha256(right);
}

export function producePublicRolloutIntentCanaryV1(
  input: PublicRolloutIntentCanaryProducerInputV1,
) {
  const sources = Object.fromEntries(SOURCE_ROLES.map((role) => [
    role,
    verifiedSource(role, input[role]),
  ])) as Record<
    SourceRole,
    ReturnType<typeof verifiedSource>
  >;
  const producerPublicKey = createPublicKey(input.producerSigningKey);
  const producerFingerprint =
    publicRolloutIntentCanaryKeyFingerprint(producerPublicKey);
  if (
    !SAFE_KEY_ID.test(input.producerTrust.producerKeyId)
    || input.producerTrust.producerKeyId === ""
    || input.producerTrust.producerKeySha256 !== producerFingerprint
    || !/^[0-9a-f]{64}$/u.test(input.rolloutEvidenceKeySha256)
  ) {
    throw new Error("public rollout intent-canary producer trust is invalid");
  }
  const fingerprints = [
    producerFingerprint,
    input.rolloutEvidenceKeySha256,
    ...SOURCE_ROLES.map((role) => sources[role].keyFingerprint),
  ];
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error(
      "public rollout intent-canary producer and source authorities must use distinct protected keys",
    );
  }
  const sourceKeySha256 = Object.fromEntries(SOURCE_ROLES.map((role) => [
    role,
    sources[role].keyFingerprint,
  ])) as Record<SourceRole, string>;
  const authorityPolicyHash =
    publicRolloutIntentCanaryAuthorityPolicyHashV1({
      sourceKeySha256,
      producerKeySha256: producerFingerprint,
      rolloutEvidenceKeySha256: input.rolloutEvidenceKeySha256,
    });
  if (
    !/^[0-9a-f]{64}$/u.test(input.authorityPolicyHash)
    || input.authorityPolicyHash !== authorityPolicyHash
  ) {
    throw new Error(
      "public rollout intent-canary authorities do not match the immutable build policy",
    );
  }

  const assignment = sources.assignment.payload;
  const assignmentCandidate = candidate(
    assignment.candidate,
    "public rollout assignment candidate",
  );
  const assignmentTransition = transition(
    assignment.transition,
    "public rollout assignment transition",
  );
  const assignmentFixture = fixture(
    assignment.fixture,
    "public rollout assignment fixture",
  );
  const intentGroup = stringValue(
    assignmentTransition.intentGroup,
    "public rollout assignment intentGroup",
  ) as PublicRolloutIntentCanaryGroup;
  if (!Object.hasOwn(PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES, intentGroup)) {
    throw new Error("public rollout assignment intentGroup is invalid");
  }
  const fromPercent = stringValue(
    assignmentTransition.fromPercent,
    "public rollout assignment fromPercent",
  ) as PublicRolloutIntentCanaryPercent;
  const toPercent = stringValue(
    assignmentTransition.toPercent,
    "public rollout assignment toPercent",
  ) as Exclude<PublicRolloutIntentCanaryPercent, "0">;
  if (
    !(PERCENTAGES as readonly string[]).includes(fromPercent)
    || !(PERCENTAGES as readonly string[]).includes(toPercent)
    || PERCENTAGES[PERCENTAGES.indexOf(fromPercent) + 1] !== toPercent
    || assignment.route !== "owner_candidate"
    || assignment.assigned !== true
  ) {
    throw new Error(
      "public rollout assignment must prove the next owner-candidate stage",
    );
  }
  const expectedFixture = PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES[intentGroup];
  const fixtureId = stringValue(
    assignmentFixture.fixtureId,
    "public rollout assignment fixtureId",
  );
  const fixtureHash = sha256Digest(
    assignmentFixture.fixtureHash,
    "public rollout assignment fixtureHash",
  );
  const contractSemanticHash = sha256Digest(
    assignmentFixture.contractSemanticHash,
    "public rollout assignment contractSemanticHash",
  );
  const targetTrackCount = integer(
    assignmentFixture.targetTrackCount,
    "public rollout assignment targetTrackCount",
    1,
  );
  if (
    fixtureId !== expectedFixture.fixtureId
    || fixtureHash !== expectedFixture.fixtureHash
    || targetTrackCount !== expectedFixture.targetTrackCount
  ) {
    throw new Error("public rollout assignment uses the wrong intent fixture");
  }
  const sourceRevision = stringValue(
    assignmentCandidate.sourceRevision,
    "public rollout assignment sourceRevision",
  );
  const imageDigest = stringValue(
    assignmentCandidate.imageDigest,
    "public rollout assignment imageDigest",
  );
  const apiConfigurationHash = sha256Digest(
    assignmentCandidate.apiConfigurationHash,
    "public rollout assignment apiConfigurationHash",
  );
  const executorIdentityHash = sha256Digest(
    assignmentCandidate.executorIdentityHash,
    "public rollout assignment executorIdentityHash",
  );
  const targetConfigurationHash = sha256Digest(
    assignmentTransition.targetConfigurationHash,
    "public rollout assignment targetConfigurationHash",
  );
  const assignmentHash = publicRolloutIntentAssignmentHashV2({
    sourceRevision,
    imageDigest,
    apiConfigurationHash,
    executorIdentityHash,
    intentGroup,
    fromPercent,
    toPercent,
    targetConfigurationHash,
    fixtureHash,
    contractSemanticHash,
  });
  if (
    assignment.assignmentHash !== assignmentHash
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceRevision)
    || !/^sha256:[0-9a-f]{64}$/u.test(imageDigest)
  ) {
    throw new Error("public rollout assignment receipt binding is invalid");
  }

  const manifest = sources.manifest.payload;
  const orderedAppleIds = exactStringArray(
    manifest.orderedAppleIds,
    "public rollout manifest orderedAppleIds",
  );
  const manifestContentHash = sha256Digest(
    manifest.manifestContentHash,
    "public rollout manifest content hash",
  );
  const qualityScores = exactObject(manifest.qualityScores, [
    "relevance",
    "discoveryQuality",
    "coherence",
    "sequencing",
  ], "public rollout manifest quality scores");
  if (
    manifest.fixtureId !== fixtureId
    || manifest.fixtureHash !== fixtureHash
    || manifest.outcome !== "exact_ready"
    || integer(manifest.requestedTrackCount, "manifest requested count", 1)
      !== targetTrackCount
    || integer(manifest.selectedTrackCount, "manifest selected count", 1)
      !== targetTrackCount
    || orderedAppleIds.length !== targetTrackCount
    || manifest.apiConfigurationHash !== apiConfigurationHash
    || manifest.workerRevision !== sourceRevision
    || manifest.workerConfigurationHash !== apiConfigurationHash
    || manifest.executorIdentityHash !== executorIdentityHash
    || manifest.contractSemanticHash !== contractSemanticHash
    || Object.values(qualityScores).some((score) => (
      typeof score !== "number"
      || !Number.isFinite(score)
      || score < 4
      || score > 5
    ))
  ) {
    throw new Error(
      "public rollout manifest does not prove exact candidate execution",
    );
  }
  const guidanceLineageHash = nullableSha256(
    manifest.guidanceLineageHash,
    "public rollout manifest guidanceLineageHash",
  );
  const orderedAppleIdsHash = signedArtifactSha256(orderedAppleIds);

  const apple = sources.apple.payload;
  const appleOrderedIds = exactStringArray(
    apple.orderedAppleIds,
    "independent Apple orderedAppleIds",
  );
  if (
    apple.fixtureId !== fixtureId
    || apple.manifestContentHash !== manifestContentHash
    || apple.exactOrderedReadback !== true
    || apple.verifierRole !== "independent_apple_api"
    || !equalJson(appleOrderedIds, orderedAppleIds)
  ) {
    throw new Error(
      "independent Apple source does not prove exact manifest count and order",
    );
  }
  sha256Digest(
    apple.verifierIdentityHash,
    "independent Apple verifierIdentityHash",
  );

  const browser = sources.browser.payload;
  if (
    browser.fixtureId !== fixtureId
    || browser.manifestContentHash !== manifestContentHash
    || integer(browser.visibleTrackCount, "browser visible track count", 1)
      !== targetTrackCount
    || browser.orderedContentsHash !== orderedAppleIdsHash
    || browser.publicAccessibility !== true
    || browser.verifierRole !== "independent_browser"
  ) {
    throw new Error(
      "independent browser source does not prove public exact contents",
    );
  }
  sha256Digest(browser.screenshotHash, "independent browser screenshotHash");

  const metrics = sources.metrics.payload;
  if (
    metrics.source !== "production_database"
    || metrics.candidateSourceRevision !== sourceRevision
    || metrics.apiConfigurationHash !== apiConfigurationHash
    || metrics.intentGroup !== intentGroup
    || metrics.stagePercent !== fromPercent
  ) {
    throw new Error(
      "database metrics source does not bind the candidate intent stage",
    );
  }
  sha256Digest(metrics.databaseIdentityHash, "database metrics identity");
  if (
    sha256Digest(metrics.sourceQueryHash, "database metrics source query")
      !== PUBLIC_ROLLOUT_INTENT_METRICS_QUERY_HASH_V2
  ) {
    throw new Error(
      "database metrics source did not use the fixed intent-window query",
    );
  }

  const generatedAt = timestamp(
    input.generatedAt ?? new Date().toISOString(),
    "public rollout intent-canary generatedAt",
  );
  const metricsWindowStartedAt = timestamp(
    metrics.windowStartedAt,
    "metrics windowStartedAt",
  );
  const metricsWindowCompletedAt = timestamp(
    metrics.windowCompletedAt,
    "metrics windowCompletedAt",
  );
  const sourceTimes = [
    timestamp(assignment.capturedAt, "assignment capturedAt"),
    timestamp(manifest.completedAt, "manifest completedAt"),
    timestamp(apple.observedAt, "Apple observedAt"),
    timestamp(browser.observedAt, "browser observedAt"),
    timestamp(metrics.capturedAt, "metrics capturedAt"),
    metricsWindowCompletedAt,
  ];
  if (
    sourceTimes.some((value) => (
      Date.parse(value) > Date.parse(generatedAt)
      || Date.parse(generatedAt) - Date.parse(value)
        > RELEASE_EVIDENCE_TTL_MS
    ))
    || Date.parse(String(assignment.capturedAt))
      > Date.parse(String(manifest.completedAt))
    || Date.parse(String(manifest.completedAt))
      > Date.parse(String(apple.observedAt))
    || Date.parse(String(manifest.completedAt))
      > Date.parse(String(browser.observedAt))
    || Date.parse(metricsWindowStartedAt) >= Date.parse(metricsWindowCompletedAt)
    || Date.parse(metricsWindowCompletedAt)
      > Date.parse(String(metrics.capturedAt))
  ) {
    throw new Error(
      "public rollout intent-canary sources are stale or out of order",
    );
  }

  const stageMetrics = {
    windowStartedAt: metrics.windowStartedAt,
    windowCompletedAt: metrics.windowCompletedAt,
    intentGroup,
    stagePercent: fromPercent,
    eligibleSubmissionCount: metrics.eligibleSubmissionCount,
    sharedProviderIncidentCount: metrics.sharedProviderIncidentCount,
    candidateAssignedCount: metrics.candidateAssignedCount,
    controlAssignedCount: metrics.controlAssignedCount,
    exactCompletionCount: metrics.exactCompletionCount,
    actionableDecisionCount: metrics.actionableDecisionCount,
    visibleRetryStateCount: metrics.visibleRetryStateCount,
    cancelledCount: metrics.cancelledCount,
    technicalQuarantineCount: metrics.technicalQuarantineCount,
    controlExactCompletionCount: metrics.controlExactCompletionCount,
    controlActionableDecisionCount:
      metrics.controlActionableDecisionCount,
    controlVisibleRetryStateCount:
      metrics.controlVisibleRetryStateCount,
    controlCancelledCount: metrics.controlCancelledCount,
    controlTechnicalQuarantineCount:
      metrics.controlTechnicalQuarantineCount,
    unexplainedDeadEndCount: metrics.unexplainedDeadEndCount,
    countOrderViolationCount: metrics.countOrderViolationCount,
    hardConstraintViolationCount: metrics.hardConstraintViolationCount,
    stalePublicationCount: metrics.stalePublicationCount,
    providerScarcityMislabelCount: metrics.providerScarcityMislabelCount,
    controlExactCompletionRate: metrics.controlExactCompletionRate,
    candidateExactCompletionRate: metrics.candidateExactCompletionRate,
  };
  const sourcePayloadHashes = Object.fromEntries(SOURCE_ROLES.map((role) => [
    role,
    sources[role].payloadHash,
  ]));
  const unsignedProvenance = {
    schemaVersion: PUBLIC_ROLLOUT_INTENT_CANARY_PROVENANCE_SCHEMA_VERSION,
    producerKind: "protected_exact_source_derivation",
    sourcePayloadHashes,
    sourceKeySha256,
    producerKeySha256: producerFingerprint,
    rolloutEvidenceKeySha256: input.rolloutEvidenceKeySha256,
    authorityPolicyHash,
  };
  const payload = {
    schemaVersion: PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
    generatedAt,
    expiresAt: new Date(
      Date.parse(generatedAt) + RELEASE_EVIDENCE_TTL_MS,
    ).toISOString(),
    environment: "production",
    candidate: {
      tag: assignmentCandidate.tag,
      version: assignmentCandidate.version,
      sourceRevision,
      imageDigest,
      apiConfigurationHash,
      executorIdentityHash,
    },
    transition: {
      operation: "advance",
      intentGroup,
      fromPercent,
      toPercent,
      targetConfigurationHash,
      assignmentRoute: "owner_candidate",
      assignmentHash,
    },
    fixture: {
      fixtureId,
      fixtureHash,
      targetTrackCount,
      contractSemanticHash,
    },
    execution: {
      completedAt: [
        String(manifest.completedAt),
        String(apple.observedAt),
        String(browser.observedAt),
      ].sort().at(-1)!,
      outcome: "exact_ready",
      requestedTrackCount: targetTrackCount,
      selectedTrackCount: targetTrackCount,
      contractSemanticHash,
      guidanceLineageHash,
      manifestContentHash,
      orderedAppleIdsHash,
      independentAppleEvidenceHash: sources.apple.payloadHash,
      browserEvidenceHash: sources.browser.payloadHash,
      workerRevision: sourceRevision,
      workerConfigurationHash: apiConfigurationHash,
      workerIdentityHash: executorIdentityHash,
      qualityScores,
    },
    stageMetrics,
    provenance: {
      ...unsignedProvenance,
      derivationHash: signedArtifactSha256(unsignedProvenance),
    },
  };
  const envelope = createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
    payload,
    signingKey: input.producerSigningKey,
    keyId: input.producerTrust.producerKeyId,
  });
  const verified = verifyTrustedPublicRolloutIntentCanaryV1(
    envelope,
    producerPublicKey,
    {
      tag: String(assignmentCandidate.tag),
      version: String(assignmentCandidate.version),
      sourceRevision,
      imageDigest,
      apiConfigurationHash,
      executorIdentityHash,
      intentGroup,
      fromPercent,
      toPercent,
      targetConfigurationHash,
      authorityPolicyHash,
      now: generatedAt,
    },
    input.producerTrust,
  );
  return Object.freeze({
    envelope,
    verified,
    sourcePayloadHashes: Object.freeze(
      sourcePayloadHashes,
    ),
  });
}

interface ProducerCliArgs {
  sourcePaths: Record<SourceRole, string>;
  verificationKeyPaths: Record<SourceRole, string>;
  outputPath: string;
  producerSigningKeyPath: string;
  producerKeyId: string;
}

function option(argv: readonly string[], name: string): string {
  const positions = argv.flatMap((value, index) => value === name ? [index] : []);
  if (
    positions.length !== 1
    || positions[0] === argv.length - 1
    || argv[positions[0]! + 1]!.startsWith("--")
  ) {
    throw new Error(`${name} is required exactly once`);
  }
  return argv[positions[0]! + 1]!;
}

export function parsePublicRolloutIntentCanaryProducerArgs(
  argv: readonly string[],
): ProducerCliArgs {
  const names = [
    "--assignment-receipt",
    "--assignment-verification-key",
    "--manifest-receipt",
    "--manifest-verification-key",
    "--apple-evidence",
    "--apple-verification-key",
    "--browser-evidence",
    "--browser-verification-key",
    "--metrics-receipt",
    "--metrics-verification-key",
    "--output",
    "--producer-signing-key",
    "--producer-key-id",
  ] as const;
  for (let index = 0; index < argv.length; index += 2) {
    if (!names.includes(argv[index] as typeof names[number])) {
      throw new Error(`Unknown argument: ${argv[index] ?? "<missing>"}`);
    }
  }
  const producerKeyId = option(argv, "--producer-key-id");
  if (!SAFE_KEY_ID.test(producerKeyId)) throw new Error("producer key ID is invalid");
  return {
    sourcePaths: {
      assignment: option(argv, "--assignment-receipt"),
      manifest: option(argv, "--manifest-receipt"),
      apple: option(argv, "--apple-evidence"),
      browser: option(argv, "--browser-evidence"),
      metrics: option(argv, "--metrics-receipt"),
    },
    verificationKeyPaths: {
      assignment: option(argv, "--assignment-verification-key"),
      manifest: option(argv, "--manifest-verification-key"),
      apple: option(argv, "--apple-verification-key"),
      browser: option(argv, "--browser-verification-key"),
      metrics: option(argv, "--metrics-verification-key"),
    },
    outputPath: option(argv, "--output"),
    producerSigningKeyPath: option(argv, "--producer-signing-key"),
    producerKeyId,
  };
}

async function json(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error(`${label} must identify readable JSON`);
  }
}

async function key(path: string, kind: "private" | "public"): Promise<KeyObject> {
  try {
    const bytes = await readFile(path);
    const parsed = kind === "private"
      ? createPrivateKey(bytes)
      : createPublicKey(bytes);
    if (parsed.asymmetricKeyType !== "ed25519") throw new Error("wrong type");
    return parsed;
  } catch {
    throw new Error(`intent-canary ${kind} key must be readable Ed25519`);
  }
}

function protectedTrust(
  environment: NodeJS.ProcessEnv,
  prefix: string,
): PublicRolloutIntentCanaryTrustV1 {
  const producerKeyId = environment[`${prefix}_KEY_ID`]?.trim() ?? "";
  const producerKeySha256 =
    environment[`${prefix}_KEY_SHA256`]?.trim().toLowerCase() ?? "";
  if (
    !SAFE_KEY_ID.test(producerKeyId)
    || !/^[0-9a-f]{64}$/u.test(producerKeySha256)
  ) {
    throw new Error(`${prefix} protected key trust is required`);
  }
  return { producerKeyId, producerKeySha256 };
}

async function main(): Promise<void> {
  const args = parsePublicRolloutIntentCanaryProducerArgs(
    process.argv.slice(2),
  );
  const allPaths = [
    ...Object.values(args.sourcePaths),
    ...Object.values(args.verificationKeyPaths),
    args.outputPath,
    args.producerSigningKeyPath,
  ].map((value) => resolve(value));
  if (new Set(allPaths).size !== allPaths.length) {
    throw new Error("intent-canary inputs, keys, and output must be distinct");
  }
  try {
    await readFile(args.outputPath);
    throw new Error("intent-canary output already exists");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const values = await Promise.all(SOURCE_ROLES.map(async (role) => ({
    role,
    value: await json(args.sourcePaths[role], `${role} source`),
    verificationKey: await key(args.verificationKeyPaths[role], "public"),
  })));
  const producerSigningKey = await key(
    args.producerSigningKeyPath,
    "private",
  );
  const prefixByRole: Record<SourceRole, string> = {
    assignment: "RELEASE_PUBLIC_ROLLOUT_ASSIGNMENT_SOURCE",
    manifest: "RELEASE_PUBLIC_ROLLOUT_MANIFEST_SOURCE",
    apple: "RELEASE_PUBLIC_ROLLOUT_APPLE_SOURCE",
    browser: "RELEASE_PUBLIC_ROLLOUT_BROWSER_SOURCE",
    metrics: "RELEASE_PUBLIC_ROLLOUT_METRICS_SOURCE",
  };
  const sources = Object.fromEntries(values.map((source) => [
    source.role,
    {
      value: source.value,
      verificationKey: source.verificationKey,
      trust: protectedTrust(process.env, prefixByRole[source.role]),
    },
  ])) as Record<SourceRole, ProtectedPublicRolloutSourceV1>;
  const producerTrust = protectedTrust(
    process.env,
    "RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY",
  );
  if (
    producerTrust.producerKeyId !== args.producerKeyId
    || publicRolloutIntentCanaryKeyFingerprint(producerSigningKey)
      !== producerTrust.producerKeySha256
  ) {
    throw new Error("producer signing key does not match protected trust");
  }
  const rolloutEvidenceKeySha256 =
    process.env.RELEASE_PUBLIC_ROLLOUT_EVIDENCE_KEY_SHA256?.trim()
      .toLowerCase() ?? "";
  const authorityPolicyHash =
    process.env
      .RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256
      ?.trim().toLowerCase() ?? "";
  const produced = producePublicRolloutIntentCanaryV1({
    ...sources,
    producerSigningKey,
    producerTrust,
    rolloutEvidenceKeySha256,
    authorityPolicyHash,
  });
  await writeFile(
    args.outputPath,
    `${JSON.stringify(produced.envelope, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    payloadHash: produced.verified.payloadHash,
    intentGroup: produced.verified.transition.intentGroup,
    fromPercent: produced.verified.transition.fromPercent,
    toPercent: produced.verified.transition.toPercent,
    sourcePayloadHashes: produced.sourcePayloadHashes,
    producerKeyId: producerTrust.producerKeyId,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "public_rollout_intent_canary_producer_failed",
      message:
        "Production public rollout intent-canary producer failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
