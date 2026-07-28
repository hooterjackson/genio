import {
  generateKeyPairSync,
} from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  semanticRankingProtectedBaselineMetadataSha256,
} from "../lib/semantic-ranking-review.ts";
import {
  createStrictSignedEnvelope,
  signedArtifactSha256,
} from "../shared/signed-artifact.ts";
import {
  SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V2,
  SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V2,
  STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V2,
  STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
  STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V2,
  STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
  STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE,
  STABLE_PREDECESSOR_BOOTSTRAP_TAG,
  STABLE_PREDECESSOR_BOOTSTRAP_VERSION,
  createStablePredecessorBootstrapEvidence,
  createStablePredecessorBootstrapImageAttestationV2,
  stablePredecessorBootstrapKeyFingerprint,
  stablePredecessorRecoveredRailwayObservationV1,
} from "../scripts/stable-predecessor-bootstrap.ts";
import {
  STABLE_PREDECESSOR_BOOTSTRAP_DISPATCH_EVENT,
  buildStablePredecessorBootstrapDispatchRequest,
  createStablePredecessorProtectedBaselineMetadata,
  parseStablePredecessorAuthorArgs,
} from "../scripts/stable-predecessor-author.ts";
import {
  createStableBootstrapIndependentEvidenceFixture,
  stableBootstrapSourceBytesFixture,
} from "./helpers/stable-bootstrap-independent-evidence.ts";

const repository = "hooterjackson/genio";
const defaultBranch = "main";
const controllerRevision = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const imageReference = `ghcr.io/hooterjackson/genio@${imageDigest}`;
const fixtures = ["fixture-a", "fixture-b", "fixture-c"].map(
  (fixtureId, index) => ({
    fixtureId,
    orderedManifestHash: String(index + 1).repeat(64),
    outputHash: String(index + 4).repeat(64),
  }),
);

function payload(now = new Date()): Record<string, unknown> {
  return {
    schemaVersion: STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V2,
    issuer: "genio-protected-stable-predecessor-bootstrap-producer",
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    kind: "stable_predecessor_bootstrap",
    mode: "recovered_observation_with_separate_reconstruction_wrapper",
    candidate: {
      compatibilityRcTag:
        STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
      compatibilityRcTagIsSynthetic: true,
      stableTag: STABLE_PREDECESSOR_BOOTSTRAP_TAG,
      version: STABLE_PREDECESSOR_BOOTSTRAP_VERSION,
      sourceRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
      sourceTree: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE,
      imageDigest,
      imageReference,
    },
    anchor: {},
    successorPolicy: {},
    controller: {
      repository,
      defaultBranch,
      sourceRevision: controllerRevision,
      workflow:
        "hooterjackson/genio/.github/workflows/"
        + "bootstrap-stable-predecessor.yml",
      workflowSha256: "c".repeat(64),
    },
    provenance: {
      imageAttestationHash: "d".repeat(64),
      recoveredRailwayObservationHash: "e".repeat(64),
      independentEvidenceHash: "f".repeat(64),
      fixtureRegistryHash: "0".repeat(64),
    },
    independentEvidence: {},
    productionObservation: {},
    fixtures,
    fixtureRegistryHash: "0".repeat(64),
    gates: [{
      name: "final_custom_domain_browser",
      evidenceHash: "9".repeat(64),
    }],
    limitations: [],
  };
}

function validEvidence(
  keys: ReturnType<typeof generateKeyPairSync>,
  now = new Date(),
) {
  const recoveredRailwayObservation =
    stablePredecessorRecoveredRailwayObservationV1();
  const imageAttestation =
    createStablePredecessorBootstrapImageAttestationV2({
      repository,
      defaultBranch,
      controllerSourceRevision: controllerRevision,
      imageReference,
      recoveredRailwayObservation,
      githubAttestationVerification: {
        verificationResult: "verified",
        subjectDigest: imageDigest,
      },
    });
  const independent = createStableBootstrapIndependentEvidenceFixture({
    candidate: {
      tag: STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
      version: STABLE_PREDECESSOR_BOOTSTRAP_VERSION,
      sourceRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
      imageDigest,
      sitesSourceRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
    },
    completedAt: now.toISOString(),
  });
  return createStablePredecessorBootstrapEvidence({
    repository,
    defaultBranch,
    controllerSourceRevision: controllerRevision,
    ...stableBootstrapSourceBytesFixture(),
    imageReference,
    imageAttestation,
    recoveredRailwayObservation,
    independentEvidence: independent.bundle,
    generatedAt: now.toISOString(),
    signingKey: keys.privateKey,
    keyId: "bootstrap-release-test-v1",
  });
}

describe("stable predecessor author", () => {
  test("derives protected baseline metadata from a protected signed envelope", () => {
    const keys = generateKeyPairSync("ed25519");
    const keyId = "bootstrap-release-test-v1";
    const evidence = validEvidence(keys);
    const metadata = createStablePredecessorProtectedBaselineMetadata({
      bootstrapEvidence: evidence,
      releaseVerificationKey: keys.publicKey,
      approvedReleaseKeyId: keyId,
      approvedReleaseKeySha256:
        stablePredecessorBootstrapKeyFingerprint(keys.publicKey),
      expectedRepository: repository,
      expectedDefaultBranch: defaultBranch,
    });
    expect(metadata).toMatchObject({
      rcTag: STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
      stableTag: STABLE_PREDECESSOR_BOOTSTRAP_TAG,
      sourceRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
      imageDigest,
      finalizationEvidencePayloadHash: evidence.payloadHash,
      finalBrowserGateEvidenceHash:
        (evidence.payload.gates as Array<{
          name: string;
          evidenceHash: string;
        }>).find(
          ({ name }) => name === "final_custom_domain_browser",
        )!.evidenceHash,
      fixtures: evidence.payload.fixtures,
    });
  });

  test("rejects shallow-but-signed bootstrap payloads missing full evidence semantics", () => {
    const keys = generateKeyPairSync("ed25519");
    const keyId = "bootstrap-release-test-v1";
    const evidence = createStrictSignedEnvelope({
      envelopeSchemaVersion:
        SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V2,
      payload: payload(),
      signingKey: keys.privateKey,
      keyId,
    });
    expect(() => createStablePredecessorProtectedBaselineMetadata({
      bootstrapEvidence: evidence,
      releaseVerificationKey: keys.publicKey,
      approvedReleaseKeyId: keyId,
      approvedReleaseKeySha256:
        stablePredecessorBootstrapKeyFingerprint(keys.publicKey),
      expectedRepository: repository,
      expectedDefaultBranch: defaultBranch,
    })).toThrow(/anchor|independent evidence|limitations/u);
  });

  test("creates the exact five-key canonical bootstrap dispatch", () => {
    const recovered = stablePredecessorRecoveredRailwayObservationV1();
    const evidencePayload = payload();
    (evidencePayload.provenance as Record<string, unknown>)
      .recoveredRailwayObservationHash = signedArtifactSha256(recovered);
    const evidence = {
      schemaVersion:
        SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V2,
      payload: evidencePayload,
      payloadHash: "7".repeat(64),
      signature: {
        algorithm: "Ed25519",
        keyId: "bootstrap-release-test-v1",
        value: "signature",
      },
    };
    const metadata = {
      schemaVersion: "genio-semantic-ranking-protected-baseline/v2",
      rcTag: STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
      stableTag: STABLE_PREDECESSOR_BOOTSTRAP_TAG,
      version: STABLE_PREDECESSOR_BOOTSTRAP_VERSION,
      sourceRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
      imageDigest,
      imageReference,
      finalizationEvidencePayloadHash: evidence.payloadHash,
      finalBrowserGateEvidenceHash: "9".repeat(64),
      fixtures,
    };
    const authorization = {
      schemaVersion:
        SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V2,
      payload: {
        schemaVersion:
          STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V2,
        candidate: evidencePayload.candidate,
        bootstrapEvidencePayloadHash: evidence.payloadHash,
        protectedBaselineMetadataHash:
          semanticRankingProtectedBaselineMetadataSha256(metadata),
        recoveredRailwayObservationHash:
          signedArtifactSha256(recovered),
        historicalArtifactEquivalence: "not_claimed",
        historicalArtifactIdentity: null,
      },
      payloadHash: "8".repeat(64),
      signature: {
        algorithm: "Ed25519",
        keyId: "bootstrap-authorizer-test-v1",
        value: "signature",
      },
    };
    const request = buildStablePredecessorBootstrapDispatchRequest({
      imageDigest,
      bootstrapEvidence: evidence,
      protectedBaselineMetadata: metadata,
      recoveredRailwayObservation: recovered,
      stableAuthorization: authorization,
    });
    expect(request.event_type)
      .toBe(STABLE_PREDECESSOR_BOOTSTRAP_DISPATCH_EVENT);
    expect(Object.keys(request.client_payload).sort()).toEqual([
      "finalization_evidence_b64url",
      "image_digest",
      "protected_baseline_metadata_b64url",
      "recovered_railway_observation_b64url",
      "stable_authorization_b64url",
    ]);
    for (const [name, value] of Object.entries(request.client_payload)) {
      if (name === "image_digest") continue;
      const decoded = Buffer.from(value, "base64url");
      expect(decoded.toString("base64url")).toBe(value);
      expect(() => JSON.parse(decoded.toString("utf8"))).not.toThrow();
    }
  });

  test("creates and validates an explicit reduced-claim wrapper attestation", () => {
    const attestation = createStablePredecessorBootstrapImageAttestationV2({
      repository,
      defaultBranch,
      controllerSourceRevision: controllerRevision,
      imageReference,
      recoveredRailwayObservation:
        stablePredecessorRecoveredRailwayObservationV1(),
      githubAttestationVerification: {
        verificationResult: "verified",
        subjectDigest: imageDigest,
      },
    });
    expect(attestation).toMatchObject({
      reconstructionMode:
        "controller_recipe_wrapper_not_historical_railway_artifact",
      historicalArtifactEquivalence: "not_claimed",
      historicalArtifactIdentity: null,
      subjectImageDigest: imageDigest,
    });
  });

  test("parses exact authoring commands and rejects dispatch aliases", () => {
    expect(parseStablePredecessorAuthorArgs([
      "dispatch",
      "--repository",
      repository,
      "--default-branch",
      defaultBranch,
      "--image-digest",
      imageDigest,
      "--bootstrap-evidence",
      "evidence.json",
      "--protected-baseline-metadata",
      "metadata.json",
      "--recovered-railway-observation",
      "observation.json",
      "--stable-authorization",
      "authorization.json",
      "--release-verification-key",
      "release-key.pem",
      "--stable-authorization-verification-key",
      "authorizer-key.pem",
      "--output",
      "dispatch.json",
    ])).toMatchObject({ command: "dispatch" });
    expect(() => parseStablePredecessorAuthorArgs([
      "dispatch",
      "--repository",
      repository,
      "--default-branch",
      defaultBranch,
      "--image-digest",
      imageDigest,
      "--bootstrap-evidence",
      "evidence.json",
      "--protected-baseline-metadata",
      "metadata.json",
      "--recovered-production-provenance",
      "observation.json",
      "--stable-authorization",
      "authorization.json",
      "--release-verification-key",
      "release-key.pem",
      "--stable-authorization-verification-key",
      "authorizer-key.pem",
      "--output",
      "dispatch.json",
    ])).toThrow(/Unknown argument/u);
  });
});
