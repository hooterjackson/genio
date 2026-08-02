import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  releaseEvidenceConfigurationHash,
  releaseEvidenceRuntimeHash,
  verifyReleaseEvidence,
  type ReleaseEvidencePayloadV1,
} from "../scripts/release-evidence.ts";
import {
  type ActivationRolloutConfiguration,
  verifyPromotionPhaseEvidence,
} from "../shared/promotion-phase-evidence.ts";
import {
  publicRolloutLatestProductionCanaryCompletedAt,
  publicRolloutPercentages,
  publicRolloutProductionCanaryEvidenceHash,
  type PublicRolloutConfiguration,
  verifyPreviousPublicRolloutLineage,
  verifyPublicRolloutEvidence,
  verifyPublicRolloutRollbackWarrant,
} from "../shared/public-rollout-evidence.ts";
import {
  publicRolloutIntentCanaryKeyFingerprint,
  type PublicRolloutIntentCanaryTrustV1,
} from "../shared/public-rollout-intent-canary.ts";
import {
  MAXIMUM_STAGING_MONTHLY_COST_USD,
} from "../shared/release-evidence-constants.ts";
import {
  railwayStagingBootstrapConfiguration,
  type RailwayStagingBootstrapConfiguration,
} from "./staging-bootstrap.ts";

export const RELEASE_DEPLOYMENT_PHASES = [
  "bootstrap",
  "bridge",
  "expand",
  "activate",
  "redeploy_native",
  "rollout",
] as const;
export type ReleaseDeploymentPhase = typeof RELEASE_DEPLOYMENT_PHASES[number];
type PromotionReleaseDeploymentPhase = Exclude<
  ReleaseDeploymentPhase,
  "bootstrap"
>;
export type ReleaseEnvironment = "staging" | "production";

export const EXPANDED_DATABASE_SCHEMA_VERSION = "20";
export { MAXIMUM_STAGING_MONTHLY_COST_USD };

const SHA256 = /^[0-9a-f]{64}$/u;
const DATABASE_SCHEMA = /^(?:1[3-9]|20)$/u;

export interface StagingReleaseControls {
  monthlyCostLimitUsd: number;
  musicKitOrigin: string;
  providerSecretVersionHash: string;
  productionProviderSecretVersionHash: string;
  appleSecretVersionHash: string;
  productionAppleSecretVersionHash: string;
  appleAccountSeparationEvidenceHash: string;
  musicKitOriginRegistrationEvidenceHash: string;
  controlHash: string;
}

export interface RailwayPromotionPhaseConfiguration {
  environment: ReleaseEnvironment;
  phase: PromotionReleaseDeploymentPhase;
  expectedDatabaseSchemaVersion: string;
  verifiedCandidateEvidenceHash: string | null;
  bridgeConvergenceEvidenceHash: string | null;
  expandConvergenceEvidenceHash: string | null;
  activationRollout: ActivationRolloutConfiguration | null;
  publicRolloutEvidenceHash: string | null;
  publicRolloutStage: string | null;
  publicRolloutConfiguration: PublicRolloutConfiguration | null;
  publicRolloutOperation: "advance" | "rollback_to_zero" | null;
  publicRolloutIntentGroup: string | null;
  publicRolloutFromPercent: string | null;
  publicRolloutToPercent: string | null;
  previousPublicRolloutEvidenceHash: string | null;
  publicRolloutEvidenceEnvelopeBase64: string | null;
  publicRolloutIntentCanaryHash: string | null;
  publicRolloutIntentCanaryEnvelopeBase64: string | null;
  publicRolloutIntentCanaryVerificationKeyBase64: string | null;
  publicRolloutIntentCanaryProducerKeyId: string | null;
  publicRolloutIntentCanaryProducerKeySha256: string | null;
  publicRolloutIntentCanaryAuthorityPolicySha256: string | null;
  publicRolloutRollbackWarrantHash: string | null;
  publicRolloutRollbackWarrantEnvelopeBase64: string | null;
  publicRolloutVerificationKeyBase64: string | null;
  staging: StagingReleaseControls | null;
}

export type RailwayReleasePhaseConfiguration =
  | RailwayStagingBootstrapConfiguration
  | RailwayPromotionPhaseConfiguration;

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name).toLowerCase();
  if (!SHA256.test(value)) throw new Error(`${name} must be a SHA-256 digest`);
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function releaseVerificationKey(environment: NodeJS.ProcessEnv): Buffer {
  const verificationKeyPath = required(
    environment,
    "GENIO_RELEASE_VERIFICATION_KEY_FILE",
  );
  let verificationKey: Buffer;
  try {
    verificationKey = readFileSync(verificationKeyPath);
  } catch {
    throw new Error("release verification key could not be read");
  }
  const expectedKeyHash = sha256(
    environment,
    "GENIO_RELEASE_VERIFICATION_KEY_SHA256",
  );
  const observedKeyHash = createHash("sha256").update(verificationKey).digest("hex");
  if (observedKeyHash !== expectedKeyHash) {
    throw new Error("release verification key does not match its pinned digest");
  }
  return verificationKey;
}

function signedCandidateEvidenceHash(
  environment: NodeJS.ProcessEnv,
): string {
  const evidencePath = required(
    environment,
    "GENIO_VERIFIED_CANDIDATE_EVIDENCE_FILE",
  );
  let envelopeValue: unknown;
  try {
    envelopeValue = JSON.parse(readFileSync(evidencePath, "utf8")) as unknown;
  } catch {
    throw new Error("verified candidate evidence could not be read");
  }
  const verificationKey = releaseVerificationKey(environment);
  const releaseImage = required(environment, "GENIO_RELEASE_IMAGE");
  const expectedImageDigest = /@(sha256:[0-9a-f]{64})$/u.exec(releaseImage)?.[1] ?? "";
  const payload = verifyReleaseEvidence(envelopeValue, verificationKey, {
    expectedKind: "candidate",
    expectedRevision: required(
      environment,
      "GENIO_RELEASE_REVISION",
    ).toLowerCase(),
    expectedImageDigest,
    expectedTag: required(environment, "GENIO_RELEASE_RC_TAG"),
    expectedConfigurationHash: sha256(
      environment,
      "GENIO_CANDIDATE_CONFIGURATION_HASH",
    ),
    expectedRuntimeHash: sha256(
      environment,
      "GENIO_CANDIDATE_RUNTIME_HASH",
    ),
  });
  if (payload.candidate.version !== required(environment, "GENIO_RELEASE_VERSION")) {
    throw new Error("signed candidate evidence version does not match the promoted artifact");
  }
  const envelope = envelopeValue as { payloadHash: unknown };
  const payloadHash = typeof envelope.payloadHash === "string"
    ? envelope.payloadHash
    : "";
  const configuredHash = sha256(
    environment,
    "GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH",
  );
  if (configuredHash !== payloadHash) {
    throw new Error(
      "GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH does not match the verified envelope",
    );
  }
  return payloadHash;
}

function releaseEvidenceEnvelope(
  environment: NodeJS.ProcessEnv,
  name: string,
): { value: unknown; payloadHash: string } {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(required(environment, name), "utf8")) as unknown;
  } catch {
    throw new Error(`${name} could not be read`);
  }
  const payloadHash = (
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { payloadHash?: unknown }).payloadHash === "string"
  )
    ? (value as { payloadHash: string }).payloadHash
    : "";
  return { value, payloadHash };
}

function signedProductionPromotionEvidence(
  environment: NodeJS.ProcessEnv,
  allowExpired = false,
): {
  value: unknown;
  payload: ReleaseEvidencePayloadV1;
  payloadHash: string;
  configurationHash: string;
  runtimeHash: string;
  productionCanaryEvidenceHash: string;
  latestProductionCanaryCompletedAt: string;
} {
  const envelope = releaseEvidenceEnvelope(
    environment,
    "GENIO_PRODUCTION_PROMOTION_EVIDENCE_FILE",
  );
  const releaseImage = required(environment, "GENIO_RELEASE_IMAGE");
  const expectedImageDigest =
    /@(sha256:[0-9a-f]{64})$/u.exec(releaseImage)?.[1] ?? "";
  const generatedAt = (
    envelope.value
    && typeof envelope.value === "object"
    && !Array.isArray(envelope.value)
    && (envelope.value as { payload?: unknown }).payload
    && typeof (envelope.value as { payload: unknown }).payload === "object"
    && !Array.isArray((envelope.value as { payload: unknown }).payload)
  )
    ? (
        (envelope.value as { payload: { generatedAt?: unknown } })
          .payload.generatedAt
      )
    : null;
  const payload = verifyReleaseEvidence(
    envelope.value,
    releaseVerificationKey(environment),
    {
      expectedKind: "promotion",
      expectedRevision: required(
        environment,
        "GENIO_RELEASE_REVISION",
      ).toLowerCase(),
      expectedImageDigest,
      expectedTag: required(environment, "GENIO_RELEASE_RC_TAG"),
      ...(allowExpired && typeof generatedAt === "string"
        ? { now: generatedAt }
        : {}),
    },
  );
  if (payload.candidate.version !== required(environment, "GENIO_RELEASE_VERSION")) {
    throw new Error(
      "signed production promotion evidence version does not match the promoted artifact",
    );
  }
  if (!SHA256.test(envelope.payloadHash)) {
    throw new Error("signed production promotion evidence payload hash is invalid");
  }
  return {
    value: envelope.value,
    payload,
    payloadHash: envelope.payloadHash,
    configurationHash: releaseEvidenceConfigurationHash(payload),
    runtimeHash: releaseEvidenceRuntimeHash(payload),
    productionCanaryEvidenceHash:
      publicRolloutProductionCanaryEvidenceHash(payload.gates),
    latestProductionCanaryCompletedAt:
      publicRolloutLatestProductionCanaryCompletedAt(payload.gates),
  };
}

function claimedPreviousPublicRolloutHash(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = (value as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const transition = (payload as { transition?: unknown }).transition;
  if (!transition || typeof transition !== "object" || Array.isArray(transition)) {
    return null;
  }
  const claimed = (
    transition as { previousRolloutEvidenceHash?: unknown }
  ).previousRolloutEvidenceHash;
  return typeof claimed === "string" && SHA256.test(claimed) ? claimed : null;
}

function claimedPublicRolloutOperation(
  value: unknown,
): "advance" | "rollback_to_zero" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = (value as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const transition = (payload as { transition?: unknown }).transition;
  if (!transition || typeof transition !== "object" || Array.isArray(transition)) {
    return null;
  }
  const operation = (transition as { operation?: unknown }).operation;
  return operation === "advance" || operation === "rollback_to_zero"
    ? operation
    : null;
}

export function railwayPublicRolloutIntentCanaryInput(
  environment: NodeJS.ProcessEnv,
  operation: "advance" | "rollback_to_zero",
): { value: unknown; payloadHash: string } | null {
  if (operation === "rollback_to_zero") {
    if (
      environment.GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_FILE?.trim()
      || environment.GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_HASH?.trim()
    ) {
      throw new Error(
        "public rollout rollback must preserve lineage without a fresh intent canary",
      );
    }
    return null;
  }
  required(environment, "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_FILE");
  const envelope = releaseEvidenceEnvelope(
    environment,
    "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_FILE",
  );
  if (
    envelope.payloadHash
      !== sha256(environment, "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_HASH")
  ) {
    throw new Error(
      "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_HASH does not match its signed envelope",
    );
  }
  return envelope;
}

export function railwayPublicRolloutIntentCanaryTrustInput(
  environment: NodeJS.ProcessEnv,
  operation: "advance" | "rollback_to_zero",
): {
  verificationKey: Buffer;
  trust: PublicRolloutIntentCanaryTrustV1;
  authorityPolicyHash: string;
} | null {
  if (operation === "rollback_to_zero") return null;
  const keyPath = required(
    environment,
    "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_VERIFICATION_KEY_FILE",
  );
  let verificationKey: Buffer;
  try {
    verificationKey = readFileSync(keyPath);
    if (createPublicKey(verificationKey).asymmetricKeyType !== "ed25519") {
      throw new Error("wrong key type");
    }
  } catch {
    throw new Error(
      "public rollout intent canary verification key could not be read as Ed25519",
    );
  }
  const trust = {
    producerKeyId: required(
      environment,
      "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_ID",
    ),
    producerKeySha256: sha256(
      environment,
      "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_SHA256",
    ),
  };
  const authorityPolicyHash = sha256(
    environment,
    "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256",
  );
  if (
    !/^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u.test(trust.producerKeyId)
    || publicRolloutIntentCanaryKeyFingerprint(verificationKey)
      !== trust.producerKeySha256
  ) {
    throw new Error(
      "public rollout intent canary verification key does not match protected trust",
    );
  }
  if (
    publicRolloutIntentCanaryKeyFingerprint(
      releaseVerificationKey(environment),
    ) === trust.producerKeySha256
  ) {
    throw new Error(
      "intent-canary producer key must be independent from the release key",
    );
  }
  return { verificationKey, trust, authorityPolicyHash };
}

function signedPublicRollout(input: {
  environment: NodeJS.ProcessEnv;
  promotion: ReturnType<typeof signedProductionPromotionEvidence>;
  activationRollout: ActivationRolloutConfiguration;
}): {
  payloadHash: string;
  stage: string;
  configuration: PublicRolloutConfiguration;
  operation: "advance" | "rollback_to_zero";
  intentGroup: string;
  fromPercent: string;
  toPercent: string;
  previousEvidenceHash: string | null;
  evidenceEnvelopeBase64: string;
  intentCanaryHash: string;
  intentCanaryEnvelopeBase64: string | null;
  intentCanaryVerificationKeyBase64: string | null;
  intentCanaryProducerKeyId: string | null;
  intentCanaryProducerKeySha256: string | null;
  intentCanaryAuthorityPolicySha256: string;
  rollbackWarrantHash: string;
  rollbackWarrantEnvelopeBase64: string;
  verificationKeyBase64: string;
} {
  const current = releaseEvidenceEnvelope(
    input.environment,
    "GENIO_PUBLIC_ROLLOUT_EVIDENCE_FILE",
  );
  const operation = claimedPublicRolloutOperation(current.value);
  if (!operation) {
    throw new Error(
      "GENIO_PUBLIC_ROLLOUT_EVIDENCE_FILE has no governed transition operation",
    );
  }
  const intentCanaryEnvelope =
    railwayPublicRolloutIntentCanaryInput(input.environment, operation);
  const intentCanaryTrust =
    railwayPublicRolloutIntentCanaryTrustInput(input.environment, operation);
  const rollbackWarrantEnvelope = releaseEvidenceEnvelope(
    input.environment,
    "GENIO_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_FILE",
  );
  const claimedPreviousHash = claimedPreviousPublicRolloutHash(current.value);
  let previous:
    | ReturnType<typeof verifyPublicRolloutEvidence>
    | null = null;
  if (claimedPreviousHash) {
    const previousEnvelope = releaseEvidenceEnvelope(
      input.environment,
      "GENIO_PREVIOUS_PUBLIC_ROLLOUT_EVIDENCE_FILE",
    );
    previous = verifyPreviousPublicRolloutLineage(
      previousEnvelope.value,
      releaseVerificationKey(input.environment),
      {
        expectedTag: required(input.environment, "GENIO_RELEASE_RC_TAG"),
        expectedVersion: required(input.environment, "GENIO_RELEASE_VERSION"),
        expectedRevision: required(
          input.environment,
          "GENIO_RELEASE_REVISION",
        ).toLowerCase(),
        expectedImageDigest:
          /@(sha256:[0-9a-f]{64})$/u.exec(
            required(input.environment, "GENIO_RELEASE_IMAGE"),
          )?.[1] ?? "",
        expectedOwnerCanaryGroups:
          input.activationRollout.PIPELINE_V3_OWNER_CANARY_GROUPS,
        expectedOwnerCanaryMaximumTracks:
          input.activationRollout.PIPELINE_V3_OWNER_CANARY_MAX_TRACKS,
      },
    );
    if (
      previous.payloadHash !== claimedPreviousHash
      || previousEnvelope.payloadHash !== claimedPreviousHash
    ) {
      throw new Error(
        "GENIO_PREVIOUS_PUBLIC_ROLLOUT_EVIDENCE_FILE does not match the signed transition lineage",
      );
    }
  } else if (input.environment.GENIO_PREVIOUS_PUBLIC_ROLLOUT_EVIDENCE_FILE?.trim()) {
    throw new Error(
      "the first public rollout transition must not receive previous rollout evidence",
    );
  }
  const verified = verifyPublicRolloutEvidence(
    current.value,
    releaseVerificationKey(input.environment),
    {
      expectedTag: required(input.environment, "GENIO_RELEASE_RC_TAG"),
      expectedVersion: required(input.environment, "GENIO_RELEASE_VERSION"),
      expectedRevision: required(
        input.environment,
        "GENIO_RELEASE_REVISION",
      ).toLowerCase(),
      expectedImageDigest:
        /@(sha256:[0-9a-f]{64})$/u.exec(
          required(input.environment, "GENIO_RELEASE_IMAGE"),
        )?.[1] ?? "",
      expectedPromotionEvidenceHash: input.promotion.payloadHash,
      expectedPromotionConfigurationHash: input.promotion.configurationHash,
      expectedPromotionRuntimeHash: input.promotion.runtimeHash,
      expectedProductionCanaryEvidenceHash:
        input.promotion.productionCanaryEvidenceHash,
      expectedOwnerCanaryGroups:
        input.activationRollout.PIPELINE_V3_OWNER_CANARY_GROUPS,
      expectedOwnerCanaryMaximumTracks:
        input.activationRollout.PIPELINE_V3_OWNER_CANARY_MAX_TRACKS,
      expectedPreviousRolloutEvidenceHash: previous?.payloadHash ?? null,
      expectedPreviousRolloutStage: previous
        ? `${previous.intentGroup}:${previous.fromPercent}->${previous.toPercent}`
        : null,
      expectedPreviousTargetPercentages: previous
        ? publicRolloutPercentages(previous.targetConfiguration)
        : null,
      minimumSoakStartedAt: new Date(Math.max(
        Date.parse(previous?.generatedAt ?? "1970-01-01T00:00:00.000Z"),
        Date.parse(input.promotion.latestProductionCanaryCompletedAt),
      )).toISOString(),
      ...(claimedPublicRolloutOperation(current.value) === "rollback_to_zero"
        ? { rollbackWarrant: rollbackWarrantEnvelope.value }
        : {
          intentCanary: intentCanaryEnvelope!.value,
          intentCanaryVerificationKey:
            intentCanaryTrust!.verificationKey,
          intentCanaryTrust: intentCanaryTrust!.trust,
          intentCanaryAuthorityPolicyHash:
            intentCanaryTrust!.authorityPolicyHash,
        }),
    },
  );
  if (current.payloadHash !== verified.payloadHash) {
    throw new Error(
      "GENIO_PUBLIC_ROLLOUT_EVIDENCE_FILE payload hash does not match its verified envelope",
    );
  }
  const verifiedWarrant = verifyPublicRolloutRollbackWarrant(
    rollbackWarrantEnvelope.value,
    releaseVerificationKey(input.environment),
    {
      expectedTag: required(input.environment, "GENIO_RELEASE_RC_TAG"),
      expectedVersion: required(input.environment, "GENIO_RELEASE_VERSION"),
      expectedRevision: required(
        input.environment,
        "GENIO_RELEASE_REVISION",
      ).toLowerCase(),
      expectedImageDigest:
        /@(sha256:[0-9a-f]{64})$/u.exec(
          required(input.environment, "GENIO_RELEASE_IMAGE"),
        )?.[1] ?? "",
      expectedPromotionEvidenceHash: input.promotion.payloadHash,
      expectedPromotionConfigurationHash: input.promotion.configurationHash,
      expectedPromotionRuntimeHash: input.promotion.runtimeHash,
      expectedProductionCanaryEvidenceHash:
        input.promotion.productionCanaryEvidenceHash,
      expectedSitesVersion:
        input.promotion.payload.environmentSnapshots.production!.sitesVersion,
      expectedSitesRevision:
        input.promotion.payload.environmentSnapshots.production!
          .sitesSourceRevision,
      ...(verified.operation === "advance"
        ? { expectedAdvance: verified }
        : { expectedRollback: verified }),
    },
  );
  if (rollbackWarrantEnvelope.payloadHash !== verifiedWarrant.payloadHash) {
    throw new Error(
      "GENIO_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_FILE payload hash does not match its verified envelope",
    );
  }
  return {
    payloadHash: verified.payloadHash,
    stage: `${verified.intentGroup}:${verified.fromPercent}->${verified.toPercent}`,
    configuration: verified.targetConfiguration,
    operation: verified.operation,
    intentGroup: verified.intentGroup,
    fromPercent: verified.fromPercent,
    toPercent: verified.toPercent,
    previousEvidenceHash: verified.previousRolloutEvidenceHash,
    evidenceEnvelopeBase64: Buffer.from(
      JSON.stringify(current.value),
      "utf8",
    ).toString("base64"),
    intentCanaryHash: verified.intentCanaryHash,
    intentCanaryEnvelopeBase64: intentCanaryEnvelope
      ? Buffer.from(
          JSON.stringify(intentCanaryEnvelope.value),
          "utf8",
        ).toString("base64")
      : null,
    intentCanaryVerificationKeyBase64:
      intentCanaryTrust?.verificationKey.toString("base64") ?? null,
    intentCanaryProducerKeyId:
      intentCanaryTrust?.trust.producerKeyId ?? null,
    intentCanaryProducerKeySha256:
      intentCanaryTrust?.trust.producerKeySha256 ?? null,
    intentCanaryAuthorityPolicySha256: sha256(
      input.environment,
      "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256",
    ),
    rollbackWarrantHash: verifiedWarrant.payloadHash,
    rollbackWarrantEnvelopeBase64: Buffer.from(
      JSON.stringify(rollbackWarrantEnvelope.value),
      "utf8",
    ).toString("base64"),
    verificationKeyBase64:
      releaseVerificationKey(input.environment).toString("base64"),
  };
}

function optionalDatabaseCapabilityVersion(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | null {
  const value = required(environment, name);
  if (value === "none") return null;
  if (!/^[1-9]\d{0,15}$/u.test(value)) {
    throw new Error(`${name} must be none or a positive integer`);
  }
  return value;
}

function signedPromotionPhaseEvidence(input: {
  environment: NodeJS.ProcessEnv;
  fileEnvironmentName: string;
  expectedPhase: "bridge" | "expand";
  expectedDatabaseSchemaVersion: string;
  expectedDatabaseCapabilityVersion: string | null;
  expectedReleaseManifestCanaryGuardsVersion: string | null;
  expectedCanonicalExecutionHardeningVersion: string | null;
  expectedDatabaseIdentityHash: string | null;
  expectedCandidateEvidenceHash: string;
  expectedConfigurationHash: string;
}): {
  payloadHash: string;
  activationRollout: ActivationRolloutConfiguration | null;
} {
  const evidencePath = required(input.environment, input.fileEnvironmentName);
  let envelopeValue: unknown;
  try {
    envelopeValue = JSON.parse(readFileSync(evidencePath, "utf8")) as unknown;
  } catch {
    throw new Error(`${input.fileEnvironmentName} could not be read`);
  }
  const releaseImage = required(input.environment, "GENIO_RELEASE_IMAGE");
  const expectedImageDigest =
    /@(sha256:[0-9a-f]{64})$/u.exec(releaseImage)?.[1] ?? "";
  const evidence = verifyPromotionPhaseEvidence(
    envelopeValue,
    releaseVerificationKey(input.environment),
    {
      expectedPhase: input.expectedPhase,
      expectedTag: required(input.environment, "GENIO_RELEASE_RC_TAG"),
      expectedVersion: required(input.environment, "GENIO_RELEASE_VERSION"),
      expectedRevision: required(
        input.environment,
        "GENIO_RELEASE_REVISION",
      ).toLowerCase(),
      expectedImageDigest,
      expectedCandidateEvidenceHash: input.expectedCandidateEvidenceHash,
      expectedConfigurationHash: input.expectedConfigurationHash,
      expectedDatabaseSchemaVersion: input.expectedDatabaseSchemaVersion,
      expectedDatabaseCapabilityVersion:
        input.expectedDatabaseCapabilityVersion,
      expectedReleaseManifestCanaryGuardsVersion:
        input.expectedReleaseManifestCanaryGuardsVersion,
      expectedCanonicalExecutionHardeningVersion:
        input.expectedCanonicalExecutionHardeningVersion,
      expectedProofArchitectureVersion:
        input.expectedPhase === "expand" ? "1" : null,
      expectedProofArchitectureAuthority:
        input.expectedPhase === "expand" ? "shadow" : null,
      expectedDatabaseIdentityHash: input.expectedDatabaseIdentityHash,
    },
  );
  return {
    payloadHash: evidence.payloadHash,
    activationRollout: evidence.activationRollout,
  };
}

function stagingOrigin(environment: NodeJS.ProcessEnv): string {
  const value = required(environment, "GENIO_STAGING_MUSICKIT_ORIGIN");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("GENIO_STAGING_MUSICKIT_ORIGIN must be a valid HTTPS origin");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.hostname === "9enio.com"
    || parsed.hostname === "www.9enio.com"
  ) {
    throw new Error(
      "GENIO_STAGING_MUSICKIT_ORIGIN must be a dedicated non-production HTTPS origin",
    );
  }
  return parsed.origin;
}

function stagingControls(environment: NodeJS.ProcessEnv): StagingReleaseControls {
  const monthlyCostLimitUsd = Number(
    required(environment, "GENIO_STAGING_MONTHLY_COST_LIMIT_USD"),
  );
  if (
    !Number.isFinite(monthlyCostLimitUsd)
    || monthlyCostLimitUsd <= 0
    || monthlyCostLimitUsd > MAXIMUM_STAGING_MONTHLY_COST_USD
  ) {
    throw new Error(
      `GENIO_STAGING_MONTHLY_COST_LIMIT_USD must be greater than 0 and no more than ${MAXIMUM_STAGING_MONTHLY_COST_USD}`,
    );
  }
  const controls = {
    monthlyCostLimitUsd,
    musicKitOrigin: stagingOrigin(environment),
    providerSecretVersionHash: sha256(environment, "GENIO_STAGING_PROVIDER_SECRET_VERSION_HASH"),
    productionProviderSecretVersionHash: sha256(
      environment,
      "GENIO_PRODUCTION_PROVIDER_SECRET_VERSION_HASH",
    ),
    appleSecretVersionHash: sha256(environment, "GENIO_STAGING_APPLE_SECRET_VERSION_HASH"),
    productionAppleSecretVersionHash: sha256(
      environment,
      "GENIO_PRODUCTION_APPLE_SECRET_VERSION_HASH",
    ),
    appleAccountSeparationEvidenceHash: sha256(
      environment,
      "GENIO_STAGING_APPLE_ACCOUNT_SEPARATION_EVIDENCE_HASH",
    ),
    musicKitOriginRegistrationEvidenceHash: sha256(
      environment,
      "GENIO_STAGING_MUSICKIT_ORIGIN_REGISTRATION_EVIDENCE_HASH",
    ),
  };
  if (controls.providerSecretVersionHash === controls.productionProviderSecretVersionHash) {
    throw new Error("staging and production provider secret versions must be different");
  }
  if (controls.appleSecretVersionHash === controls.productionAppleSecretVersionHash) {
    throw new Error("staging and production Apple secret versions must be different");
  }
  return Object.freeze({
    ...controls,
    controlHash: createHash("sha256").update(stableJson(controls)).digest("hex"),
  });
}

/**
 * Parse the explicit Railway promotion phase. The plan is intentionally
 * impossible to evaluate without this contract: a missing phase must not
 * inherit the old API pre-deploy migration behavior.
 */
export function railwayReleasePhaseConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): RailwayReleasePhaseConfiguration {
  const bootstrap = railwayStagingBootstrapConfiguration(environment);
  if (bootstrap) return bootstrap;
  const releaseEnvironment = required(environment, "GENIO_RELEASE_ENVIRONMENT");
  if (releaseEnvironment !== "staging" && releaseEnvironment !== "production") {
    throw new Error("GENIO_RELEASE_ENVIRONMENT must be staging or production");
  }
  const phaseValue = required(environment, "GENIO_RELEASE_PHASE");
  if (!(RELEASE_DEPLOYMENT_PHASES as readonly string[]).includes(phaseValue)) {
    throw new Error(
      "GENIO_RELEASE_PHASE must be bootstrap, bridge, expand, activate, redeploy_native, or rollout",
    );
  }
  const phase = phaseValue as PromotionReleaseDeploymentPhase;
  if (releaseEnvironment === "staging" && phase === "rollout") {
    throw new Error("public rollout is production-only");
  }
  if (phase === "redeploy_native" && releaseEnvironment !== "production") {
    throw new Error("redeploy_native is accepted only for production");
  }
  const verifiedCandidateEvidenceHash = releaseEnvironment === "production"
    ? signedCandidateEvidenceHash(environment)
    : null;
  const expectedDatabaseSchemaVersion = required(
    environment,
    "GENIO_EXPECTED_DATABASE_SCHEMA_VERSION",
  );
  if (!DATABASE_SCHEMA.test(expectedDatabaseSchemaVersion)) {
    throw new Error("GENIO_EXPECTED_DATABASE_SCHEMA_VERSION must be an integer from 13 through 20");
  }
  if (
    (
      phase === "expand"
      || phase === "activate"
      || phase === "redeploy_native"
      || phase === "rollout"
    )
    && expectedDatabaseSchemaVersion !== EXPANDED_DATABASE_SCHEMA_VERSION
  ) {
    throw new Error(
      `${phase} requires GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=${EXPANDED_DATABASE_SCHEMA_VERSION}`,
    );
  }
  let bridgeConvergenceEvidenceHash: string | null = null;
  let expandConvergenceEvidenceHash: string | null = null;
  let activationRollout: ActivationRolloutConfiguration | null = null;
  let publicRolloutEvidenceHash: string | null = null;
  let publicRolloutStage: string | null = null;
  let publicRolloutConfiguration: PublicRolloutConfiguration | null = null;
  let publicRolloutOperation: "advance" | "rollback_to_zero" | null = null;
  let publicRolloutIntentGroup: string | null = null;
  let publicRolloutFromPercent: string | null = null;
  let publicRolloutToPercent: string | null = null;
  let previousPublicRolloutEvidenceHash: string | null = null;
  let publicRolloutEvidenceEnvelopeBase64: string | null = null;
  let publicRolloutIntentCanaryHash: string | null = null;
  let publicRolloutIntentCanaryEnvelopeBase64: string | null = null;
  let publicRolloutIntentCanaryVerificationKeyBase64: string | null = null;
  let publicRolloutIntentCanaryProducerKeyId: string | null = null;
  let publicRolloutIntentCanaryProducerKeySha256: string | null = null;
  let publicRolloutIntentCanaryAuthorityPolicySha256: string | null = null;
  let publicRolloutRollbackWarrantHash: string | null = null;
  let publicRolloutRollbackWarrantEnvelopeBase64: string | null = null;
  let publicRolloutVerificationKeyBase64: string | null = null;
  if (
    releaseEnvironment === "production"
    && phase !== "bridge"
    && phase !== "redeploy_native"
  ) {
    const bridgeEvidence = signedPromotionPhaseEvidence({
      environment,
      fileEnvironmentName: "GENIO_BRIDGE_CONVERGENCE_EVIDENCE_FILE",
      expectedPhase: "bridge",
      expectedDatabaseSchemaVersion: required(
        environment,
        "GENIO_BRIDGE_DATABASE_SCHEMA_VERSION",
      ),
      expectedDatabaseCapabilityVersion: optionalDatabaseCapabilityVersion(
        environment,
        "GENIO_BRIDGE_DATABASE_CAPABILITY_VERSION",
      ),
      expectedReleaseManifestCanaryGuardsVersion:
        optionalDatabaseCapabilityVersion(
          environment,
          "GENIO_BRIDGE_MANIFEST_CANARY_GUARDS_VERSION",
        ),
      expectedCanonicalExecutionHardeningVersion:
        optionalDatabaseCapabilityVersion(
          environment,
          "GENIO_BRIDGE_CANONICAL_EXECUTION_HARDENING_VERSION",
        ),
      expectedDatabaseIdentityHash: null,
      expectedCandidateEvidenceHash: verifiedCandidateEvidenceHash!,
      expectedConfigurationHash: sha256(
        environment,
        "GENIO_BRIDGE_CONFIGURATION_HASH",
      ),
    });
    bridgeConvergenceEvidenceHash = bridgeEvidence.payloadHash;
  }
  if (
    releaseEnvironment === "production"
    && (phase === "activate" || phase === "rollout")
  ) {
    const expandEvidence = signedPromotionPhaseEvidence({
      environment,
      fileEnvironmentName: "GENIO_EXPAND_CONVERGENCE_EVIDENCE_FILE",
      expectedPhase: "expand",
      expectedDatabaseSchemaVersion: EXPANDED_DATABASE_SCHEMA_VERSION,
      expectedDatabaseCapabilityVersion: "2",
      expectedReleaseManifestCanaryGuardsVersion: "1",
      expectedCanonicalExecutionHardeningVersion: "1",
      expectedDatabaseIdentityHash: sha256(
        environment,
        "GENIO_PRODUCTION_DATABASE_IDENTITY_HASH",
      ),
      expectedCandidateEvidenceHash: verifiedCandidateEvidenceHash!,
      expectedConfigurationHash: sha256(
        environment,
        "GENIO_EXPAND_CONFIGURATION_HASH",
      ),
    });
    expandConvergenceEvidenceHash = expandEvidence.payloadHash;
    activationRollout = expandEvidence.activationRollout;
    if (!activationRollout) {
      throw new Error(
        "activation requires an authoritative expand preflight with an owner-only candidate route",
      );
    }
  }
  if (releaseEnvironment === "production" && phase === "rollout") {
    const rolloutEnvelope = releaseEvidenceEnvelope(
      environment,
      "GENIO_PUBLIC_ROLLOUT_EVIDENCE_FILE",
    );
    const allowExpiredPromotion =
      claimedPublicRolloutOperation(rolloutEnvelope.value) === "rollback_to_zero";
    const promotion = signedProductionPromotionEvidence(
      environment,
      allowExpiredPromotion,
    );
    const rollout = signedPublicRollout({
      environment,
      promotion,
      activationRollout: activationRollout!,
    });
    publicRolloutEvidenceHash = rollout.payloadHash;
    publicRolloutStage = rollout.stage;
    publicRolloutConfiguration = rollout.configuration;
    publicRolloutOperation = rollout.operation;
    publicRolloutIntentGroup = rollout.intentGroup;
    publicRolloutFromPercent = rollout.fromPercent;
    publicRolloutToPercent = rollout.toPercent;
    previousPublicRolloutEvidenceHash = rollout.previousEvidenceHash;
    publicRolloutEvidenceEnvelopeBase64 = rollout.evidenceEnvelopeBase64;
    publicRolloutIntentCanaryHash = rollout.intentCanaryHash;
    publicRolloutIntentCanaryEnvelopeBase64 =
      rollout.intentCanaryEnvelopeBase64;
    publicRolloutIntentCanaryVerificationKeyBase64 =
      rollout.intentCanaryVerificationKeyBase64;
    publicRolloutIntentCanaryProducerKeyId =
      rollout.intentCanaryProducerKeyId;
    publicRolloutIntentCanaryProducerKeySha256 =
      rollout.intentCanaryProducerKeySha256;
    publicRolloutIntentCanaryAuthorityPolicySha256 =
      rollout.intentCanaryAuthorityPolicySha256;
    publicRolloutRollbackWarrantHash = rollout.rollbackWarrantHash;
    publicRolloutRollbackWarrantEnvelopeBase64 =
      rollout.rollbackWarrantEnvelopeBase64;
    publicRolloutVerificationKeyBase64 = rollout.verificationKeyBase64;
    if (allowExpiredPromotion && rollout.operation !== "rollback_to_zero") {
      throw new Error("expired promotion evidence is accepted only for rollback to zero");
    }
  }

  return Object.freeze({
    environment: releaseEnvironment,
    phase,
    expectedDatabaseSchemaVersion,
    verifiedCandidateEvidenceHash,
    bridgeConvergenceEvidenceHash,
    expandConvergenceEvidenceHash,
    activationRollout,
    publicRolloutEvidenceHash,
    publicRolloutStage,
    publicRolloutConfiguration,
    publicRolloutOperation,
    publicRolloutIntentGroup,
    publicRolloutFromPercent,
    publicRolloutToPercent,
    previousPublicRolloutEvidenceHash,
    publicRolloutEvidenceEnvelopeBase64,
    publicRolloutIntentCanaryHash,
    publicRolloutIntentCanaryEnvelopeBase64,
    publicRolloutIntentCanaryVerificationKeyBase64,
    publicRolloutIntentCanaryProducerKeyId,
    publicRolloutIntentCanaryProducerKeySha256,
    publicRolloutIntentCanaryAuthorityPolicySha256,
    publicRolloutRollbackWarrantHash,
    publicRolloutRollbackWarrantEnvelopeBase64,
    publicRolloutVerificationKeyBase64,
    staging: releaseEnvironment === "staging" ? stagingControls(environment) : null,
  });
}

export function releasePhasePreDeployCommand(
  configuration: Pick<RailwayReleasePhaseConfiguration, "phase">,
): string | undefined {
  return configuration.phase === "rollout"
    ? "pnpm run release:rollout:apply"
    : undefined;
}
