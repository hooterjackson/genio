import type { KeyObject } from "node:crypto";
import {
  signedArtifactSha256,
  stableSignedArtifactJson,
  type JsonRecord,
} from "../shared/signed-artifact.ts";
import {
  SIGNED_STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1,
  STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1,
  verifyHistoricalStableReleaseConsumerBundle,
  type StableReleaseConsumerManifestV1,
} from "./authorize-stable-release.ts";
import {
  SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V1,
  SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V1,
  STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V1,
  STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V1,
  validateStablePredecessorBootstrapImageAttestationV1,
  verifyStablePredecessorBootstrapBundle,
} from "./stable-predecessor-bootstrap.ts";

export const HISTORICAL_STABLE_PREDECESSOR_REPOSITORY =
  "hooterjackson/genio" as const;
export const HISTORICAL_STABLE_PREDECESSOR_DEFAULT_BRANCH = "main" as const;
export const SIGNED_NORMAL_RELEASE_EVIDENCE_SCHEMA_V1 =
  "genio-signed-release-evidence/v3" as const;
export const NORMAL_RELEASE_EVIDENCE_SCHEMA_V1 =
  "genio-release-evidence/v3" as const;

type VerificationKey = string | Buffer | KeyObject;

export interface HistoricalStablePredecessorInputV1 {
  evidence: unknown;
  protectedBaselineMetadata: unknown;
  releaseVerificationKey: VerificationKey;
  approvedReleaseKeySha256: string;
  authorization: unknown;
  stableAuthorizationVerificationKey: VerificationKey;
  approvedStableAuthorizerKeyId: string;
  approvedStableAuthorizerKeySha256: string;
  imageAttestation: unknown;
  storedConsumer: unknown;
  githubAttestationVerification: unknown;
  expectedPredecessorRcTag: string;
  expectedPredecessorVersion: string;
  expectedPredecessorRevision: string;
  expectedPredecessorImageDigest: string;
  expectedPredecessorImageReference: string;
  expectedSuccessorRcTag: string;
  expectedSuccessorSourceRevision: string;
  expectedRepository: string;
  expectedDefaultBranch: string;
  expectedControllerSourceRevision: string;
  now?: string;
}

export type HistoricalStablePredecessorVerificationV1 =
  | {
    mode: "normal";
    lineage: StableReleaseConsumerManifestV1;
    imageAttestation: null;
    storedConsumer: unknown;
    githubAttestationVerification: null;
  }
  | {
    mode: "bootstrap";
    lineage: ReturnType<typeof verifyStablePredecessorBootstrapBundle>;
    imageAttestation: JsonRecord;
    storedConsumer: unknown;
    githubAttestationVerification: unknown;
  };

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function schemaPair(
  evidence: unknown,
  authorization: unknown,
): {
  evidenceEnvelope: string;
  evidencePayload: string;
  authorizationEnvelope: string;
  authorizationPayload: string;
} {
  const evidenceEnvelope = record(
    evidence,
    "historical predecessor signed evidence",
  );
  const authorizationEnvelope = record(
    authorization,
    "historical predecessor signed authorization",
  );
  return {
    evidenceEnvelope: String(evidenceEnvelope.schemaVersion ?? ""),
    evidencePayload: String(
      record(
        evidenceEnvelope.payload,
        "historical predecessor evidence payload",
      ).schemaVersion ?? "",
    ),
    authorizationEnvelope: String(
      authorizationEnvelope.schemaVersion ?? "",
    ),
    authorizationPayload: String(
      record(
        authorizationEnvelope.payload,
        "historical predecessor authorization payload",
      ).schemaVersion ?? "",
    ),
  };
}

function isExactNormalPair(
  pair: ReturnType<typeof schemaPair>,
): boolean {
  return pair.evidenceEnvelope === SIGNED_NORMAL_RELEASE_EVIDENCE_SCHEMA_V1
    && pair.evidencePayload === NORMAL_RELEASE_EVIDENCE_SCHEMA_V1
    && pair.authorizationEnvelope
      === SIGNED_STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1
    && pair.authorizationPayload
      === STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1;
}

function isExactBootstrapPair(
  pair: ReturnType<typeof schemaPair>,
): boolean {
  return pair.evidenceEnvelope
      === SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V1
    && pair.evidencePayload
      === STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V1
    && pair.authorizationEnvelope
      === SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V1
    && pair.authorizationPayload
      === STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V1;
}

function assertProtectedController(input: {
  expectedRepository: string;
  expectedDefaultBranch: string;
}): void {
  if (
    input.expectedRepository !== HISTORICAL_STABLE_PREDECESSOR_REPOSITORY
    || input.expectedDefaultBranch
      !== HISTORICAL_STABLE_PREDECESSOR_DEFAULT_BRANCH
  ) {
    throw new Error(
      "historical predecessor verification requires the exact protected repository and default branch",
    );
  }
}

export function verifyHistoricalStablePredecessor(
  input: HistoricalStablePredecessorInputV1,
): HistoricalStablePredecessorVerificationV1 {
  assertProtectedController(input);
  const pair = schemaPair(input.evidence, input.authorization);
  if (isExactNormalPair(pair)) {
    const lineage = verifyHistoricalStableReleaseConsumerBundle({
      finalizationEvidence: input.evidence,
      protectedBaselineMetadata: input.protectedBaselineMetadata,
      releaseVerificationKey: input.releaseVerificationKey,
      approvedReleaseKeySha256: input.approvedReleaseKeySha256,
      stableAuthorization: input.authorization,
      stableAuthorizationVerificationKey:
        input.stableAuthorizationVerificationKey,
      approvedStableAuthorizerKeyId:
        input.approvedStableAuthorizerKeyId,
      approvedStableAuthorizerKeySha256:
        input.approvedStableAuthorizerKeySha256,
      expectedRcTag: input.expectedPredecessorRcTag,
      expectedVersion: input.expectedPredecessorVersion,
      expectedRevision: input.expectedPredecessorRevision,
      expectedImageDigest: input.expectedPredecessorImageDigest,
      expectedImageReference: input.expectedPredecessorImageReference,
      now: input.now,
    });
    if (
      stableSignedArtifactJson(input.storedConsumer)
        !== stableSignedArtifactJson(lineage)
    ) {
      throw new Error(
        "stored normal predecessor consumer is not the rederived signed lineage",
      );
    }
    return {
      mode: "normal",
      lineage,
      imageAttestation: null,
      storedConsumer: input.storedConsumer,
      githubAttestationVerification: null,
    };
  }
  if (!isExactBootstrapPair(pair)) {
    throw new Error(
      "historical predecessor evidence and authorization schemas are mixed or unsupported",
    );
  }
  const imageAttestation =
    validateStablePredecessorBootstrapImageAttestationV1(
      input.imageAttestation,
      input.expectedRepository,
      input.expectedDefaultBranch,
    );
  if (
    !input.githubAttestationVerification
    || typeof input.githubAttestationVerification !== "object"
    || imageAttestation.githubVerificationHash
      !== signedArtifactSha256(input.githubAttestationVerification)
  ) {
    throw new Error(
      "bootstrap image attestation does not bind the fresh external GitHub verification result",
    );
  }
  const lineage = verifyStablePredecessorBootstrapBundle({
    bootstrapEvidence: input.evidence,
    protectedBaselineMetadata: input.protectedBaselineMetadata,
    releaseVerificationKey: input.releaseVerificationKey,
    approvedReleaseKeySha256: input.approvedReleaseKeySha256,
    stableAuthorization: input.authorization,
    stableAuthorizationVerificationKey:
      input.stableAuthorizationVerificationKey,
    approvedStableAuthorizerKeyId: input.approvedStableAuthorizerKeyId,
    approvedStableAuthorizerKeySha256:
      input.approvedStableAuthorizerKeySha256,
    imageAttestation,
    storedConsumer: input.storedConsumer,
    expectedSuccessorRcTag: input.expectedSuccessorRcTag,
    expectedSuccessorSourceRevision:
      input.expectedSuccessorSourceRevision,
    expectedRepository: input.expectedRepository,
    expectedDefaultBranch: input.expectedDefaultBranch,
    now: input.now,
  });
  if (
    lineage.bootstrap.controllerSourceRevision
      !== input.expectedControllerSourceRevision
    || imageAttestation.workflowSourceRevision
      !== input.expectedControllerSourceRevision
  ) {
    throw new Error(
      "bootstrap predecessor does not bind the exact externally approved controller revision",
    );
  }
  return {
    mode: "bootstrap",
    lineage,
    imageAttestation,
    storedConsumer: input.storedConsumer,
    githubAttestationVerification: input.githubAttestationVerification,
  };
}
