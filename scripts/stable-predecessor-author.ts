import {
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  SEMANTIC_RANKING_PROTECTED_BASELINE_SCHEMA_V1,
  semanticRankingProtectedBaselineMetadataSha256,
  validateSemanticRankingProtectedBaselineMetadataV1,
} from "../lib/semantic-ranking-review.ts";
import {
  sitesControlPlaneTrustPolicyV1,
} from "../shared/sites-control-plane-attestation.ts";
import {
  exactObject,
  sha256Digest,
  signedArtifactSha256,
  stableSignedArtifactJson,
  verifyStrictSignedEnvelope,
  type JsonRecord,
} from "../shared/signed-artifact.ts";
import {
  SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V2,
  authorizeStablePredecessorBootstrap,
  createStablePredecessorBootstrapEvidence,
  createStablePredecessorBootstrapImageAttestationV2,
  isSignedStablePredecessorBootstrapAuthorization,
  isSignedStablePredecessorBootstrapEvidence,
  stablePredecessorBootstrapKeyFingerprint,
  validateStablePredecessorBootstrapEvidencePayloadV2,
  validateStablePredecessorBootstrapImageAttestationV2,
  validateStablePredecessorBootstrapPublicationWindow,
  validateStablePredecessorRecoveredRailwayObservationV1,
  verifyHistoricalStablePredecessorBootstrapLineage,
  type StablePredecessorBootstrapSourceBytesV1,
} from "./stable-predecessor-bootstrap.ts";
import {
  canonicalJsonBytes,
  jsonRecord,
  parseCreateOnlyCliOptions,
  readBoundedJsonFile,
  readBoundedRegularFile,
  readProtectedEd25519PrivateKey,
  requiredProtectedEnvironment,
  writeCanonicalJsonCreateOnly,
} from "./release-authoring-io.ts";

export const STABLE_PREDECESSOR_BOOTSTRAP_DISPATCH_EVENT =
  "genio-stable-predecessor-bootstrap-v2-3-4";
const GITHUB_CLIENT_PAYLOAD_MAX_BYTES = 64 * 1024;
const GITHUB_CLIENT_PAYLOAD_MAX_TOP_LEVEL_KEYS = 10;
const BOOTSTRAP_INPUT_MAX_BYTES = 18_000;
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export async function readGithubAttestationVerificationFile(
  path: string,
): Promise<unknown> {
  const bytes = await readBoundedRegularFile(
    path,
    "GitHub attestation verification",
  );
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object") {
      throw new Error("not structured JSON");
    }
    return value;
  } catch {
    throw new Error(
      "GitHub attestation verification must contain structured JSON",
    );
  }
}

function protectedAuthority(
  environment: NodeJS.ProcessEnv = process.env,
): {
  releaseKeyId: string;
  releaseKeySha256: string;
  authorizerKeyId: string;
  authorizerKeySha256: string;
  producerKeyId: string;
  producerKeySha256: string;
  sitesKeyId: string;
  sitesKeySha256: string;
} {
  const value = (
    name: string,
    pattern: RegExp,
    label: string,
  ): string => requiredProtectedEnvironment(
    name,
    pattern,
    label,
    environment,
  );
  const authority = {
    releaseKeyId: value(
      "RELEASE_VERIFICATION_KEY_ID",
      KEY_ID,
      "bootstrap release key ID",
    ),
    releaseKeySha256: value(
      "RELEASE_VERIFICATION_KEY_SHA256",
      SHA256,
      "bootstrap release key fingerprint",
    ),
    authorizerKeyId: value(
      "RELEASE_STABLE_AUTHORIZER_KEY_ID",
      KEY_ID,
      "bootstrap authorizer key ID",
    ),
    authorizerKeySha256: value(
      "RELEASE_STABLE_AUTHORIZER_KEY_SHA256",
      SHA256,
      "bootstrap authorizer key fingerprint",
    ),
    producerKeyId: value(
      "RELEASE_GATE_PRODUCER_KEY_ID",
      KEY_ID,
      "bootstrap gate producer key ID",
    ),
    producerKeySha256: value(
      "RELEASE_GATE_PRODUCER_KEY_SHA256",
      SHA256,
      "bootstrap gate producer key fingerprint",
    ),
    sitesKeyId: value(
      "RELEASE_SITES_CONTROL_PLANE_KEY_ID",
      KEY_ID,
      "bootstrap Sites key ID",
    ),
    sitesKeySha256: value(
      "RELEASE_SITES_CONTROL_PLANE_KEY_SHA256",
      SHA256,
      "bootstrap Sites key fingerprint",
    ),
  };
  if (
    new Set([
      authority.releaseKeySha256,
      authority.authorizerKeySha256,
      authority.producerKeySha256,
      authority.sitesKeySha256,
    ]).size !== 4
  ) {
    throw new Error(
      "bootstrap release, authorizer, producer, and Sites keys "
      + "must be distinct protected authorities",
    );
  }
  return authority;
}

function currentWindow(payload: JsonRecord, label: string, now?: string): void {
  const generatedAt = String(payload.generatedAt ?? "");
  const expiresAt = String(payload.expiresAt ?? "");
  const generatedMs = Date.parse(generatedAt);
  const expiresMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now ?? new Date().toISOString());
  if (
    !Number.isFinite(generatedMs)
    || !Number.isFinite(expiresMs)
    || !Number.isFinite(nowMs)
    || new Date(generatedMs).toISOString() !== generatedAt
    || new Date(expiresMs).toISOString() !== expiresAt
    || nowMs < generatedMs
    || nowMs >= expiresMs
  ) {
    throw new Error(`${label} is outside its canonical validity window`);
  }
}

export function verifyAuthoredStablePredecessorBootstrapEvidence(input: {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  approvedKeyId: string;
  approvedKeySha256: string;
  expectedRepository: string;
  expectedDefaultBranch: string;
  expectedControllerRevision?: string;
  expectedImageReference?: string;
  now?: string;
}): ReturnType<typeof verifyStrictSignedEnvelope> {
  if (
    !KEY_ID.test(input.approvedKeyId)
    || stablePredecessorBootstrapKeyFingerprint(input.verificationKey)
      !== sha256Digest(
        input.approvedKeySha256,
        "approved bootstrap release key fingerprint",
      )
  ) {
    throw new Error("bootstrap evidence does not use the protected release key");
  }
  const verified = verifyStrictSignedEnvelope({
    value: input.value,
    verificationKey: input.verificationKey,
    envelopeSchemaVersion:
      SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V2,
    payloadLabel: "stable predecessor bootstrap evidence",
    validatePayload: (value) => {
      const payload =
        validateStablePredecessorBootstrapEvidencePayloadV2(
          value,
          input.expectedRepository,
          input.expectedDefaultBranch,
        );
      const candidate = jsonRecord(
        payload.candidate,
        "stable predecessor bootstrap candidate",
      );
      const controller = jsonRecord(
        payload.controller,
        "stable predecessor bootstrap controller",
      );
      if (
        (
          input.expectedControllerRevision
          && controller.sourceRevision !== input.expectedControllerRevision
        )
        || (
          input.expectedImageReference
          && candidate.imageReference !== input.expectedImageReference
        )
      ) {
        throw new Error(
          "stable predecessor bootstrap evidence identity is invalid",
        );
      }
      return payload;
    },
  });
  if (verified.keyId !== input.approvedKeyId) {
    throw new Error("bootstrap evidence key ID is not protected");
  }
  currentWindow(verified.payload, "bootstrap evidence", input.now);
  return verified;
}

export function createStablePredecessorProtectedBaselineMetadata(input: {
  bootstrapEvidence: unknown;
  releaseVerificationKey: string | Buffer | KeyObject;
  approvedReleaseKeyId: string;
  approvedReleaseKeySha256: string;
  expectedRepository: string;
  expectedDefaultBranch: string;
  now?: string;
}): ReturnType<typeof validateSemanticRankingProtectedBaselineMetadataV1> {
  const verified = verifyAuthoredStablePredecessorBootstrapEvidence({
    value: input.bootstrapEvidence,
    verificationKey: input.releaseVerificationKey,
    approvedKeyId: input.approvedReleaseKeyId,
    approvedKeySha256: input.approvedReleaseKeySha256,
    expectedRepository: input.expectedRepository,
    expectedDefaultBranch: input.expectedDefaultBranch,
    now: input.now,
  });
  const candidate = jsonRecord(
    verified.payload.candidate,
    "bootstrap evidence candidate",
  );
  const gates = Array.isArray(verified.payload.gates)
    ? verified.payload.gates.map((value, index) =>
      jsonRecord(value, `bootstrap evidence gate ${index}`)
    )
    : [];
  const finalBrowser = gates.find(
    ({ name }) => name === "final_custom_domain_browser",
  );
  if (!finalBrowser) {
    throw new Error("bootstrap evidence has no final browser gate");
  }
  const metadata = validateSemanticRankingProtectedBaselineMetadataV1({
    schemaVersion: SEMANTIC_RANKING_PROTECTED_BASELINE_SCHEMA_V1,
    rcTag: candidate.compatibilityRcTag,
    stableTag: candidate.stableTag,
    version: candidate.version,
    sourceRevision: candidate.sourceRevision,
    imageDigest: candidate.imageDigest,
    imageReference: candidate.imageReference,
    finalizationEvidencePayloadHash: verified.payloadHash,
    finalBrowserGateEvidenceHash: finalBrowser.evidenceHash,
    fixtures: verified.payload.fixtures,
  });
  const canonical = validateSemanticRankingProtectedBaselineMetadataV1(
    JSON.parse(stableSignedArtifactJson(metadata)),
  );
  if (
    semanticRankingProtectedBaselineMetadataSha256(canonical)
      !== semanticRankingProtectedBaselineMetadataSha256(metadata)
  ) {
    throw new Error("bootstrap protected baseline is not canonical");
  }
  return metadata;
}

async function sourceBytes(
  options: Record<string, string>,
): Promise<StablePredecessorBootstrapSourceBytesV1> {
  const [
    controllerWorkflowBytes,
    tagObjectBytes,
    sourceCommitBytes,
    sourceTreeObjectBytes,
  ] = await Promise.all([
    readBoundedRegularFile(
      options["--controller-workflow-bytes"]!,
      "bootstrap controller workflow bytes",
      2 * 1024 * 1024,
    ),
    readBoundedRegularFile(
      options["--tag-object-bytes"]!,
      "bootstrap tag object bytes",
      2 * 1024 * 1024,
    ),
    readBoundedRegularFile(
      options["--source-commit-bytes"]!,
      "bootstrap source commit bytes",
      2 * 1024 * 1024,
    ),
    readBoundedRegularFile(
      options["--source-tree-object-bytes"]!,
      "bootstrap source tree object bytes",
      4 * 1024 * 1024,
    ),
  ]);
  return {
    controllerWorkflowBytes,
    tagObjectBytes,
    sourceCommitBytes,
    sourceTreeObjectBytes,
  };
}

function canonicalBoundedArtifact(
  value: unknown,
  label: string,
): Buffer {
  const bytes = canonicalJsonBytes(value);
  if (bytes.length <= 1 || bytes.length > BOOTSTRAP_INPUT_MAX_BYTES) {
    throw new Error(`${label} is empty or exceeds 18,000 canonical bytes`);
  }
  return bytes;
}

export function buildStablePredecessorBootstrapDispatchRequest(input: {
  imageDigest: string;
  bootstrapEvidence: unknown;
  protectedBaselineMetadata: unknown;
  recoveredRailwayObservation: unknown;
  stableAuthorization: unknown;
}): {
  event_type: typeof STABLE_PREDECESSOR_BOOTSTRAP_DISPATCH_EVENT;
  client_payload: {
    image_digest: string;
    finalization_evidence_b64url: string;
    protected_baseline_metadata_b64url: string;
    recovered_railway_observation_b64url: string;
    stable_authorization_b64url: string;
  };
} {
  if (!IMAGE_DIGEST.test(input.imageDigest)) {
    throw new Error("bootstrap dispatch image digest is invalid");
  }
  if (!isSignedStablePredecessorBootstrapEvidence(input.bootstrapEvidence)) {
    throw new Error("bootstrap dispatch evidence schema is invalid");
  }
  if (
    !isSignedStablePredecessorBootstrapAuthorization(
      input.stableAuthorization,
    )
  ) {
    throw new Error("bootstrap dispatch authorization schema is invalid");
  }
  const metadata = validateSemanticRankingProtectedBaselineMetadataV1(
    input.protectedBaselineMetadata,
  );
  const recovered = validateStablePredecessorRecoveredRailwayObservationV1(
    input.recoveredRailwayObservation,
  );
  const evidenceEnvelope = exactObject(input.bootstrapEvidence, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "bootstrap dispatch evidence");
  const evidencePayload = jsonRecord(
    evidenceEnvelope.payload,
    "bootstrap dispatch evidence payload",
  );
  const evidenceCandidate = jsonRecord(
    evidencePayload.candidate,
    "bootstrap dispatch evidence candidate",
  );
  const evidenceProvenance = jsonRecord(
    evidencePayload.provenance,
    "bootstrap dispatch evidence provenance",
  );
  const authorizationEnvelope = exactObject(input.stableAuthorization, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "bootstrap dispatch authorization");
  const authorization = jsonRecord(
    authorizationEnvelope.payload,
    "bootstrap dispatch authorization payload",
  );
  const authorizationCandidate = jsonRecord(
    authorization.candidate,
    "bootstrap dispatch authorization candidate",
  );
  if (
    evidenceCandidate.imageDigest !== input.imageDigest
    || metadata.imageDigest !== input.imageDigest
    || authorizationCandidate.imageDigest !== input.imageDigest
    || metadata.finalizationEvidencePayloadHash
      !== evidenceEnvelope.payloadHash
    || authorization.bootstrapEvidencePayloadHash
      !== evidenceEnvelope.payloadHash
    || evidenceProvenance.recoveredRailwayObservationHash
      !== signedArtifactSha256(recovered)
    || authorization.recoveredRailwayObservationHash
      !== evidenceProvenance.recoveredRailwayObservationHash
    || authorization.protectedBaselineMetadataHash
      !== semanticRankingProtectedBaselineMetadataSha256(metadata)
    || authorization.historicalArtifactEquivalence !== "not_claimed"
    || authorization.historicalArtifactIdentity !== null
  ) {
    throw new Error(
      "bootstrap dispatch artifacts do not bind one exact reduced-claim target",
    );
  }
  const clientPayload = {
    image_digest: input.imageDigest,
    finalization_evidence_b64url:
      canonicalBoundedArtifact(
        input.bootstrapEvidence,
        "bootstrap evidence",
      ).toString("base64url"),
    protected_baseline_metadata_b64url:
      canonicalBoundedArtifact(
        metadata,
        "protected baseline metadata",
      ).toString("base64url"),
    recovered_railway_observation_b64url:
      canonicalBoundedArtifact(
        recovered,
        "recovered production provenance",
      ).toString("base64url"),
    stable_authorization_b64url:
      canonicalBoundedArtifact(
        input.stableAuthorization,
        "bootstrap authorization",
      ).toString("base64url"),
  };
  const keys = Object.keys(clientPayload);
  const bytes = Buffer.byteLength(JSON.stringify(clientPayload), "utf8");
  if (
    keys.length > GITHUB_CLIENT_PAYLOAD_MAX_TOP_LEVEL_KEYS
    || bytes >= GITHUB_CLIENT_PAYLOAD_MAX_BYTES
  ) {
    throw new Error(
      `bootstrap client_payload is ${bytes} bytes across ${keys.length} keys; `
      + "GitHub requires fewer than 65,536 bytes and at most 10 keys",
    );
  }
  const request = {
    event_type: STABLE_PREDECESSOR_BOOTSTRAP_DISPATCH_EVENT,
    client_payload: clientPayload,
  } as const;
  for (const [name, encoded] of Object.entries(clientPayload)) {
    if (name === "image_digest") continue;
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) {
      throw new Error(`bootstrap dispatch ${name} is not canonical base64url`);
    }
    JSON.parse(decoded.toString("utf8"));
  }
  return request;
}

async function imageAttestationCommand(
  options: Record<string, string>,
): Promise<void> {
  const [recoveredRailwayObservation, githubAttestationVerification] =
    await Promise.all([
      readBoundedJsonFile(
        options["--recovered-railway-observation"]!,
        "recovered Railway observation",
      ),
      readGithubAttestationVerificationFile(
        options["--github-attestation-verification"]!,
      ),
    ]);
  const value = createStablePredecessorBootstrapImageAttestationV2({
    repository: options["--repository"]!,
    defaultBranch: options["--default-branch"]!,
    controllerSourceRevision:
      options["--controller-source-revision"]!.toLowerCase(),
    imageReference: options["--image-reference"]!.toLowerCase(),
    recoveredRailwayObservation,
    githubAttestationVerification,
  });
  const verified = validateStablePredecessorBootstrapImageAttestationV2(
    JSON.parse(stableSignedArtifactJson(value)),
    options["--repository"]!,
    options["--default-branch"]!,
  );
  if (stableSignedArtifactJson(value) !== stableSignedArtifactJson(verified)) {
    throw new Error("bootstrap image attestation failed canonical verification");
  }
  await writeCanonicalJsonCreateOnly(options["--output"]!, value);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "image-attestation",
    imageAttestationHash: signedArtifactSha256(value),
    output: options["--output"],
  })}\n`);
}

async function bootstrapEvidenceCommand(
  options: Record<string, string>,
): Promise<void> {
  const authority = protectedAuthority();
  const signingKey = await readProtectedEd25519PrivateKey({
    cliPath: options["--release-signing-key-file"],
    environmentName: "RELEASE_SIGNING_KEY_FILE",
    label: "bootstrap release signing key",
  });
  if (
    stablePredecessorBootstrapKeyFingerprint(signingKey)
      !== authority.releaseKeySha256
  ) {
    throw new Error(
      "bootstrap signing key does not match the protected release key",
    );
  }
  const [
    imageAttestation,
    recoveredRailwayObservation,
    independentEvidence,
    exactSourceBytes,
  ] = await Promise.all([
    readBoundedJsonFile(
      options["--image-attestation"]!,
      "bootstrap image attestation",
    ),
    readBoundedJsonFile(
      options["--recovered-railway-observation"]!,
      "recovered Railway observation",
    ),
    readBoundedJsonFile(
      options["--independent-evidence"]!,
      "bootstrap independent evidence",
    ),
    sourceBytes(options),
  ]);
  const evidence = createStablePredecessorBootstrapEvidence({
    repository: options["--repository"]!,
    defaultBranch: options["--default-branch"]!,
    controllerSourceRevision:
      options["--controller-source-revision"]!.toLowerCase(),
    imageReference: options["--image-reference"]!.toLowerCase(),
    imageAttestation,
    recoveredRailwayObservation,
    independentEvidence,
    ...exactSourceBytes,
    signingKey,
    keyId: authority.releaseKeyId,
  });
  const verified = verifyAuthoredStablePredecessorBootstrapEvidence({
    value: evidence,
    verificationKey: createPublicKey(signingKey),
    approvedKeyId: authority.releaseKeyId,
    approvedKeySha256: authority.releaseKeySha256,
    expectedRepository: options["--repository"]!,
    expectedDefaultBranch: options["--default-branch"]!,
    expectedControllerRevision:
      options["--controller-source-revision"]!.toLowerCase(),
    expectedImageReference: options["--image-reference"]!.toLowerCase(),
    now: String(evidence.payload.generatedAt),
  });
  await writeCanonicalJsonCreateOnly(options["--output"]!, evidence);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "bootstrap-evidence",
    payloadHash: verified.payloadHash,
    keyId: verified.keyId,
    output: options["--output"],
  })}\n`);
}

async function protectedBaselineCommand(
  options: Record<string, string>,
): Promise<void> {
  const authority = protectedAuthority();
  const [bootstrapEvidence, releaseVerificationKey] = await Promise.all([
    readBoundedJsonFile(
      options["--bootstrap-evidence"]!,
      "bootstrap evidence",
    ),
    readBoundedRegularFile(
      options["--release-verification-key"]!,
      "bootstrap release verification key",
      16 * 1024,
    ),
  ]);
  const metadata = createStablePredecessorProtectedBaselineMetadata({
    bootstrapEvidence,
    releaseVerificationKey,
    approvedReleaseKeyId: authority.releaseKeyId,
    approvedReleaseKeySha256: authority.releaseKeySha256,
    expectedRepository: options["--repository"]!,
    expectedDefaultBranch: options["--default-branch"]!,
  });
  await writeCanonicalJsonCreateOnly(options["--output"]!, metadata);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "protected-baseline",
    metadataHash:
      semanticRankingProtectedBaselineMetadataSha256(metadata),
    output: options["--output"],
  })}\n`);
}

async function bootstrapAuthorizationCommand(
  options: Record<string, string>,
): Promise<void> {
  const authority = protectedAuthority();
  const authorizerSigningKey = await readProtectedEd25519PrivateKey({
    cliPath: options["--authorizer-signing-key-file"],
    environmentName: "RELEASE_STABLE_AUTHORIZER_SIGNING_KEY_FILE",
    label: "bootstrap authorizer signing key",
  });
  if (
    stablePredecessorBootstrapKeyFingerprint(authorizerSigningKey)
      !== authority.authorizerKeySha256
  ) {
    throw new Error(
      "bootstrap authorizer signing key does not match its protected key",
    );
  }
  const [
    bootstrapEvidence,
    protectedBaselineMetadata,
    imageAttestation,
    releaseVerificationKey,
    sitesControlPlaneVerificationKey,
    exactSourceBytes,
  ] = await Promise.all([
    readBoundedJsonFile(
      options["--bootstrap-evidence"]!,
      "bootstrap evidence",
    ),
    readBoundedJsonFile(
      options["--protected-baseline-metadata"]!,
      "protected baseline metadata",
    ),
    readBoundedJsonFile(
      options["--image-attestation"]!,
      "bootstrap image attestation",
    ),
    readBoundedRegularFile(
      options["--release-verification-key"]!,
      "bootstrap release verification key",
      16 * 1024,
    ),
    readBoundedJsonFile(
      options["--sites-control-plane-verification-key"]!,
      "Sites control-plane verification key",
    ),
    sourceBytes(options),
  ]);
  if (
    stablePredecessorBootstrapKeyFingerprint(releaseVerificationKey)
      !== authority.releaseKeySha256
  ) {
    throw new Error(
      "bootstrap release verification key does not match its protected key",
    );
  }
  const sitesTrustPolicy = sitesControlPlaneTrustPolicyV1({
    approvedKeyId: authority.sitesKeyId,
    approvedKeySha256: authority.sitesKeySha256,
  });
  const authorization = authorizeStablePredecessorBootstrap({
    bootstrapEvidence,
    protectedBaselineMetadata,
    imageAttestation,
    sourceBytes: exactSourceBytes,
    releaseVerificationKey,
    approvedReleaseKeyId: authority.releaseKeyId,
    approvedReleaseKeySha256: authority.releaseKeySha256,
    approvedProducerKeyId: authority.producerKeyId,
    approvedProducerKeySha256: authority.producerKeySha256,
    approvedSitesControlPlaneVerificationKey:
      sitesControlPlaneVerificationKey,
    approvedSitesControlPlaneTrustPolicy: sitesTrustPolicy,
    authorizerSigningKey,
    approvedAuthorizerKeyId: authority.authorizerKeyId,
    approvedAuthorizerKeySha256: authority.authorizerKeySha256,
    expectedRepository: options["--repository"]!,
    expectedDefaultBranch: options["--default-branch"]!,
  });
  const metadata = validateSemanticRankingProtectedBaselineMetadataV1(
    protectedBaselineMetadata,
  );
  const lineage = verifyHistoricalStablePredecessorBootstrapLineage({
    bootstrapEvidence,
    protectedBaselineMetadata: metadata,
    releaseVerificationKey,
    approvedReleaseKeySha256: authority.releaseKeySha256,
    stableAuthorization: authorization,
    stableAuthorizationVerificationKey:
      createPublicKey(authorizerSigningKey),
    approvedStableAuthorizerKeyId: authority.authorizerKeyId,
    approvedStableAuthorizerKeySha256: authority.authorizerKeySha256,
    expectedRcTag: metadata.rcTag,
    expectedVersion: metadata.version,
    expectedRevision: metadata.sourceRevision,
    expectedImageDigest: metadata.imageDigest,
    expectedImageReference: metadata.imageReference,
    expectedRepository: options["--repository"]!,
    expectedDefaultBranch: options["--default-branch"]!,
    now: String(authorization.payload.generatedAt),
  });
  validateStablePredecessorBootstrapPublicationWindow({
    bootstrapEvidence,
    stableAuthorization: authorization,
    now: String(authorization.payload.generatedAt),
  });
  await writeCanonicalJsonCreateOnly(options["--output"]!, authorization);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "bootstrap-authorization",
    stableTag: lineage.candidate.stableTag,
    authorizationPayloadHash: authorization.payloadHash,
    output: options["--output"],
  })}\n`);
}

async function dispatchCommand(
  options: Record<string, string>,
): Promise<void> {
  const authority = protectedAuthority();
  const [
    bootstrapEvidence,
    protectedBaselineMetadata,
    recoveredRailwayObservation,
    stableAuthorization,
    releaseVerificationKey,
    stableAuthorizationVerificationKey,
  ] = await Promise.all([
    readBoundedJsonFile(
      options["--bootstrap-evidence"]!,
      "bootstrap evidence",
    ),
    readBoundedJsonFile(
      options["--protected-baseline-metadata"]!,
      "protected baseline metadata",
    ),
    readBoundedJsonFile(
      options["--recovered-railway-observation"]!,
      "recovered Railway observation",
    ),
    readBoundedJsonFile(
      options["--stable-authorization"]!,
      "bootstrap stable authorization",
    ),
    readBoundedRegularFile(
      options["--release-verification-key"]!,
      "bootstrap release verification key",
      16 * 1024,
    ),
    readBoundedRegularFile(
      options["--stable-authorization-verification-key"]!,
      "bootstrap stable authorization verification key",
      16 * 1024,
    ),
  ]);
  const metadata = validateSemanticRankingProtectedBaselineMetadataV1(
    protectedBaselineMetadata,
  );
  verifyHistoricalStablePredecessorBootstrapLineage({
    bootstrapEvidence,
    protectedBaselineMetadata: metadata,
    releaseVerificationKey,
    approvedReleaseKeySha256: authority.releaseKeySha256,
    stableAuthorization,
    stableAuthorizationVerificationKey,
    approvedStableAuthorizerKeyId: authority.authorizerKeyId,
    approvedStableAuthorizerKeySha256: authority.authorizerKeySha256,
    expectedRcTag: metadata.rcTag,
    expectedVersion: metadata.version,
    expectedRevision: metadata.sourceRevision,
    expectedImageDigest: metadata.imageDigest,
    expectedImageReference: metadata.imageReference,
    expectedRepository: options["--repository"]!,
    expectedDefaultBranch: options["--default-branch"]!,
  });
  validateStablePredecessorBootstrapPublicationWindow({
    bootstrapEvidence,
    stableAuthorization,
  });
  const request = buildStablePredecessorBootstrapDispatchRequest({
    imageDigest: options["--image-digest"]!.toLowerCase(),
    bootstrapEvidence,
    protectedBaselineMetadata,
    recoveredRailwayObservation,
    stableAuthorization,
  });
  await writeCanonicalJsonCreateOnly(options["--output"]!, request);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "dispatch",
    eventType: request.event_type,
    clientPayloadBytes: Buffer.byteLength(
      JSON.stringify(request.client_payload),
      "utf8",
    ),
    output: options["--output"],
  })}\n`);
}

const SOURCE_BYTE_OPTIONS = [
  "--controller-workflow-bytes",
  "--tag-object-bytes",
  "--source-commit-bytes",
  "--source-tree-object-bytes",
] as const;

export function parseStablePredecessorAuthorArgs(
  argv: readonly string[],
): {
  command:
    | "image-attestation"
    | "bootstrap-evidence"
    | "protected-baseline"
    | "bootstrap-authorization"
    | "dispatch";
  options: Record<string, string>;
} {
  const [command, ...args] = argv;
  if (command === "image-attestation") {
    return {
      command,
      options: parseCreateOnlyCliOptions(args, {
        required: [
          "--repository",
          "--default-branch",
          "--controller-source-revision",
          "--image-reference",
          "--recovered-railway-observation",
          "--github-attestation-verification",
          "--output",
        ],
      }),
    };
  }
  if (command === "bootstrap-evidence") {
    return {
      command,
      options: parseCreateOnlyCliOptions(args, {
        required: [
          "--repository",
          "--default-branch",
          "--controller-source-revision",
          "--image-reference",
          "--image-attestation",
          "--recovered-railway-observation",
          "--independent-evidence",
          ...SOURCE_BYTE_OPTIONS,
          "--output",
        ],
        optional: ["--release-signing-key-file"],
      }),
    };
  }
  if (command === "protected-baseline") {
    return {
      command,
      options: parseCreateOnlyCliOptions(args, {
        required: [
          "--repository",
          "--default-branch",
          "--bootstrap-evidence",
          "--release-verification-key",
          "--output",
        ],
      }),
    };
  }
  if (command === "bootstrap-authorization") {
    return {
      command,
      options: parseCreateOnlyCliOptions(args, {
        required: [
          "--repository",
          "--default-branch",
          "--bootstrap-evidence",
          "--protected-baseline-metadata",
          "--image-attestation",
          "--release-verification-key",
          "--sites-control-plane-verification-key",
          ...SOURCE_BYTE_OPTIONS,
          "--output",
        ],
        optional: ["--authorizer-signing-key-file"],
      }),
    };
  }
  if (command === "dispatch") {
    return {
      command,
      options: parseCreateOnlyCliOptions(args, {
        required: [
          "--repository",
          "--default-branch",
          "--image-digest",
          "--bootstrap-evidence",
          "--protected-baseline-metadata",
          "--recovered-railway-observation",
          "--stable-authorization",
          "--release-verification-key",
          "--stable-authorization-verification-key",
          "--output",
        ],
      }),
    };
  }
  throw new Error(
    "Usage: stable-predecessor-author "
    + "<image-attestation|bootstrap-evidence|protected-baseline|"
    + "bootstrap-authorization|dispatch> ...",
  );
}

export async function runStablePredecessorAuthorCli(
  argv: readonly string[],
): Promise<void> {
  const parsed = parseStablePredecessorAuthorArgs(argv);
  if (parsed.command === "image-attestation") {
    await imageAttestationCommand(parsed.options);
    return;
  }
  if (parsed.command === "bootstrap-evidence") {
    await bootstrapEvidenceCommand(parsed.options);
    return;
  }
  if (parsed.command === "protected-baseline") {
    await protectedBaselineCommand(parsed.options);
    return;
  }
  if (parsed.command === "bootstrap-authorization") {
    await bootstrapAuthorizationCommand(parsed.options);
    return;
  }
  await dispatchCommand(parsed.options);
}

async function main(): Promise<void> {
  await runStablePredecessorAuthorCli(process.argv.slice(2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "stable_predecessor_authoring_failed",
      message: error instanceof Error ? error.message : "unknown error",
    })}\n`);
    process.exitCode = 1;
  });
}
