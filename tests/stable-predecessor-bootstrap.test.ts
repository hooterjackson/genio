import {
  createHash,
  generateKeyPairSync,
} from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  authorizeStablePredecessorBootstrap,
  captureStablePredecessorRecoveredRailwayObservation,
  compressStablePredecessorBootstrapIndependentEvidenceV1,
  createStablePredecessorBootstrapImageAttestationV2,
  createStablePredecessorBootstrapEvidence,
  parseStablePredecessorBootstrapCliArgs,
  runStablePredecessorBootstrapCli,
  SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V2,
  SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V2,
  stablePredecessorBootstrapKeyFingerprint,
  stablePredecessorBootstrapFixtureRegistryHash,
  stablePredecessorRailwayObservationBytes,
  stablePredecessorRecoveredRailwayObservationV1,
  STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
  STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
  STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE,
  STABLE_PREDECESSOR_BOOTSTRAP_TAG,
  STABLE_PREDECESSOR_BOOTSTRAP_TAG_OBJECT,
  validateStablePredecessorBootstrapPublicationWindow,
  validateStablePredecessorRecoveredRailwayObservationV1,
  verifyHistoricalStablePredecessorBootstrapLineage,
  verifyStablePredecessorBootstrapBundle,
} from "../scripts/stable-predecessor-bootstrap.ts";
import {
  verifyHistoricalStablePredecessor,
} from "../scripts/historical-stable-predecessor.ts";
import {
  attestReleaseGateArtifact,
  createReleaseGateArtifactFromSources,
} from "../scripts/release-fixtures.ts";
import {
  createStableBootstrapIndependentEvidenceFixture,
  stableBootstrapSourceBytesFixture,
} from "./helpers/stable-bootstrap-independent-evidence.ts";

const repository = "hooterjackson/genio";
const defaultBranch = "main";
const controllerRevision = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const imageReference = `ghcr.io/hooterjackson/genio@${imageDigest}`;
const generatedAt = "2026-07-26T10:00:00.000Z";
const authorizedAt = "2026-07-26T10:05:00.000Z";
const recoveredDirectory = new URL(
  "../.artifacts/v2.3.4-railway-observation/",
  import.meta.url,
);

function fixture(input?: { generatedAt?: string; authorizedAt?: string }) {
  const evidenceGeneratedAt = input?.generatedAt ?? generatedAt;
  const authorizationGeneratedAt = input?.authorizedAt ?? authorizedAt;
  const release = generateKeyPairSync("ed25519");
  const authorizer = generateKeyPairSync("ed25519");
  const releaseKeySha256 =
    stablePredecessorBootstrapKeyFingerprint(release.publicKey);
  const authorizerKeySha256 =
    stablePredecessorBootstrapKeyFingerprint(authorizer.publicKey);
  const sourceBytes = stableBootstrapSourceBytesFixture();
  const recoveredRailwayObservation =
    stablePredecessorRecoveredRailwayObservationV1();
  const githubAttestationVerification = {
    verificationResult: "verified",
    subjectDigest: imageDigest,
  };
  const imageAttestation =
    createStablePredecessorBootstrapImageAttestationV2({
    repository,
    defaultBranch,
    controllerSourceRevision: controllerRevision,
    imageReference,
    recoveredRailwayObservation,
    githubAttestationVerification,
  });
  const independent = createStableBootstrapIndependentEvidenceFixture({
    candidate: {
      tag: STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
      version: "2.3.4",
      sourceRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
      imageDigest,
      sitesSourceRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
    },
    completedAt: evidenceGeneratedAt,
  });
  const finalBrowserSources = independent.bundle.sources.at(-1)!.artifact
    .sources;
  const evidence = createStablePredecessorBootstrapEvidence({
    repository,
    defaultBranch,
    controllerSourceRevision: controllerRevision,
    ...sourceBytes,
    imageReference,
    imageAttestation,
    recoveredRailwayObservation,
    independentEvidence: independent.bundle,
    generatedAt: evidenceGeneratedAt,
    signingKey: release.privateKey,
    keyId: "bootstrap-evidence-v1",
  });
  const finalBrowserHash = (evidence.payload.gates as Array<{
    name: string;
    evidenceHash: string;
  }>).find(
    ({ name }: { name: string }) => name === "final_custom_domain_browser",
  )!.evidenceHash;
  const fixtures = evidence.payload.fixtures as Array<{
    fixtureId: string;
    orderedManifestHash: string;
    outputHash: string;
  }>;
  const metadata = {
    schemaVersion: "genio-semantic-ranking-protected-baseline/v2",
    rcTag: STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
    stableTag: STABLE_PREDECESSOR_BOOTSTRAP_TAG,
    version: "2.3.4",
    sourceRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
    imageDigest,
    imageReference,
    finalizationEvidencePayloadHash: evidence.payloadHash,
    finalBrowserGateEvidenceHash: finalBrowserHash,
    fixtures,
  };
  const authorization = authorizeStablePredecessorBootstrap({
    bootstrapEvidence: evidence,
    protectedBaselineMetadata: metadata,
    imageAttestation,
    sourceBytes,
    releaseVerificationKey: release.publicKey,
    approvedReleaseKeyId: "bootstrap-evidence-v1",
    approvedReleaseKeySha256: releaseKeySha256,
    approvedProducerKeyId: independent.producerKeyId,
    approvedProducerKeySha256: independent.producerKeySha256,
    approvedSitesControlPlaneVerificationKey:
      finalBrowserSources.sitesControlPlaneVerificationKey,
    approvedSitesControlPlaneTrustPolicy:
      finalBrowserSources.sitesControlPlaneTrustPolicy,
    authorizerSigningKey: authorizer.privateKey,
    approvedAuthorizerKeyId: "bootstrap-authorizer-v1",
    approvedAuthorizerKeySha256: authorizerKeySha256,
    expectedRepository: repository,
    expectedDefaultBranch: defaultBranch,
    generatedAt: authorizationGeneratedAt,
  });
  const lineage = verifyHistoricalStablePredecessorBootstrapLineage({
    bootstrapEvidence: evidence,
    protectedBaselineMetadata: metadata,
    releaseVerificationKey: release.publicKey,
    approvedReleaseKeySha256: releaseKeySha256,
    stableAuthorization: authorization,
    stableAuthorizationVerificationKey: authorizer.publicKey,
    approvedStableAuthorizerKeyId: "bootstrap-authorizer-v1",
    approvedStableAuthorizerKeySha256: authorizerKeySha256,
    expectedRcTag: STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
    expectedVersion: "2.3.4",
    expectedRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
    expectedImageDigest: imageDigest,
    expectedImageReference: imageReference,
    expectedRepository: repository,
    expectedDefaultBranch: defaultBranch,
    now: new Date(
      Date.parse(authorizationGeneratedAt) + 60_000,
    ).toISOString(),
  });
  const storedConsumer = { ...lineage } as Record<string, unknown>;
  delete storedConsumer.bootstrap;
  return {
    release,
    authorizer,
    releaseKeySha256,
    authorizerKeySha256,
    independent,
    sitesControlPlaneVerificationKey:
      finalBrowserSources.sitesControlPlaneVerificationKey,
    sitesControlPlaneTrustPolicy:
      finalBrowserSources.sitesControlPlaneTrustPolicy,
    sourceBytes,
    imageAttestation,
    recoveredRailwayObservation,
    githubAttestationVerification,
    evidence,
    metadata,
    authorization,
    storedConsumer,
    evidenceGeneratedAt,
  };
}

function recreateEvidence(
  value: ReturnType<typeof fixture>,
  independentEvidence: unknown,
) {
  return createStablePredecessorBootstrapEvidence({
    repository,
    defaultBranch,
    controllerSourceRevision: controllerRevision,
    ...value.sourceBytes,
    imageReference,
    imageAttestation: value.imageAttestation,
    recoveredRailwayObservation: value.recoveredRailwayObservation,
    independentEvidence,
    generatedAt: value.evidenceGeneratedAt,
    signingKey: value.release.privateKey,
    keyId: "bootstrap-evidence-v1",
  });
}

function protectedExternalAuthorities(value: ReturnType<typeof fixture>) {
  return {
    approvedSitesControlPlaneVerificationKey:
      value.sitesControlPlaneVerificationKey,
    approvedSitesControlPlaneTrustPolicy:
      value.sitesControlPlaneTrustPolicy,
  };
}

describe("one-time stable predecessor bootstrap", () => {
  test("compresses reordered evidence into one canonical commitment", () => {
    const left = compressStablePredecessorBootstrapIndependentEvidenceV1({
      z: { b: 2, a: 1 },
      a: true,
    });
    const right = compressStablePredecessorBootstrapIndependentEvidenceV1({
      a: true,
      z: { a: 1, b: 2 },
    });
    expect(left).toEqual(right);
  });

  test("pins all three recovered Railway lanes as observations, never attestations", () => {
    const observation = stablePredecessorRecoveredRailwayObservationV1();
    expect(validateStablePredecessorRecoveredRailwayObservationV1(
      observation,
    )).toEqual(observation);
    expect(observation).toMatchObject({
      kind:
        "authenticated_platform_observation_not_supply_chain_attestation",
      capture: {
        railwaySigned: false,
        manifestBytesRecovered: false,
        supplyChainAttestationRecovered: false,
      },
    });
    expect((observation.lanes as unknown[])).toHaveLength(3);
    expect(stablePredecessorRailwayObservationBytes({ b: 1, a: 2 }))
      .toEqual(Buffer.from('{\n  "a": 2,\n  "b": 1\n}\n'));

    const tampered = structuredClone(observation);
    (tampered.lanes as Array<Record<string, unknown>>)[1]!
      .railwayMetaImageDigest = `sha256:${"0".repeat(64)}`;
    expect(() =>
      validateStablePredecessorRecoveredRailwayObservationV1(tampered)
    ).toThrow(/not the exact v2\.3\.4 record/u);
  });

  test.skipIf(!existsSync(recoveredDirectory))(
    "recaptures the preserved six Railway responses with the one canonical algorithm",
    async () => {
      const captured =
        await captureStablePredecessorRecoveredRailwayObservation({
          apiDeploymentPath: new URL(
            "api-deployment.json",
            recoveredDirectory,
          ).pathname,
          apiBuildLogPath: new URL(
            "api-build-log.json",
            recoveredDirectory,
          ).pathname,
          workerDeploymentPath: new URL(
            "worker-deployment.json",
            recoveredDirectory,
          ).pathname,
          workerBuildLogPath: new URL(
            "worker-build-log.json",
            recoveredDirectory,
          ).pathname,
          deepDeploymentPath: new URL(
            "deep-deployment.json",
            recoveredDirectory,
          ).pathname,
          deepBuildLogPath: new URL(
            "deep-build-log.json",
            recoveredDirectory,
          ).pathname,
        });
      expect(captured).toEqual(
        stablePredecessorRecoveredRailwayObservationV1(),
      );
    },
  );

  test("derives the existing consumer only from the exact wrapper-bound v2.3.4 bundle", () => {
    const value = fixture();
    const verified = verifyStablePredecessorBootstrapBundle({
      bootstrapEvidence: value.evidence,
      protectedBaselineMetadata: value.metadata,
      releaseVerificationKey: value.release.publicKey,
      approvedReleaseKeySha256: value.releaseKeySha256,
      stableAuthorization: value.authorization,
      stableAuthorizationVerificationKey: value.authorizer.publicKey,
      approvedStableAuthorizerKeyId: "bootstrap-authorizer-v1",
      approvedStableAuthorizerKeySha256: value.authorizerKeySha256,
      imageAttestation: value.imageAttestation,
      storedConsumer: value.storedConsumer,
      expectedSuccessorRcTag: "v2.4.0-rc.2",
      expectedSuccessorSourceRevision: "8".repeat(40),
      expectedRepository: repository,
      expectedDefaultBranch: defaultBranch,
      now: "2026-07-26T11:00:00.000Z",
    });
    expect(value.evidence.schemaVersion).toBe(
      SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V2,
    );
    expect(value.authorization.schemaVersion).toBe(
      SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V2,
    );
    expect(verified.bootstrap).toMatchObject({
      tagObject: STABLE_PREDECESSOR_BOOTSTRAP_TAG_OBJECT,
      sourceTree: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE,
      controllerSourceRevision: controllerRevision,
      controllerRepository: repository,
      controllerDefaultBranch: defaultBranch,
    });
  });

  test("dispatches only the exact bootstrap schema pair and rechecks fresh GitHub provenance", () => {
    const value = fixture();
    const input = {
      evidence: value.evidence,
      protectedBaselineMetadata: value.metadata,
      releaseVerificationKey: value.release.publicKey,
      approvedReleaseKeySha256: value.releaseKeySha256,
      authorization: value.authorization,
      stableAuthorizationVerificationKey: value.authorizer.publicKey,
      approvedStableAuthorizerKeyId: "bootstrap-authorizer-v1",
      approvedStableAuthorizerKeySha256: value.authorizerKeySha256,
      imageAttestation: value.imageAttestation,
      storedConsumer: value.storedConsumer,
      githubAttestationVerification:
        value.githubAttestationVerification,
      expectedPredecessorRcTag:
        STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
      expectedPredecessorVersion: "2.3.4",
      expectedPredecessorRevision:
        STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
      expectedPredecessorImageDigest: imageDigest,
      expectedPredecessorImageReference: imageReference,
      expectedSuccessorRcTag: "v2.4.0-rc.2",
      expectedSuccessorSourceRevision: "8".repeat(40),
      expectedRepository: repository,
      expectedDefaultBranch: defaultBranch,
      expectedControllerSourceRevision: controllerRevision,
      now: "2026-07-26T11:00:00.000Z",
    };
    expect(verifyHistoricalStablePredecessor(input)).toMatchObject({
      mode: "bootstrap",
      lineage: {
        bootstrap: {
          controllerSourceRevision: controllerRevision,
        },
      },
    });
    expect(() => verifyHistoricalStablePredecessor({
      ...input,
      githubAttestationVerification: {
        ...value.githubAttestationVerification,
        subjectDigest: `sha256:${"0".repeat(64)}`,
      },
    })).toThrow(/fresh external GitHub verification/u);
    expect(() => verifyHistoricalStablePredecessor({
      ...input,
      expectedControllerSourceRevision: "9".repeat(40),
    })).toThrow(/externally approved controller revision/u);
    const mixedAuthorization = structuredClone(value.authorization);
    mixedAuthorization.schemaVersion =
      "genio-signed-stable-release-authorization/v2";
    mixedAuthorization.payload.schemaVersion =
      "genio-stable-release-authorization/v2";
    expect(() => verifyHistoricalStablePredecessor({
      ...input,
      authorization: mixedAuthorization,
    })).toThrow(/schemas are mixed or unsupported/u);

    const retiredEvidence = structuredClone(value.evidence);
    retiredEvidence.schemaVersion =
      "genio-signed-stable-predecessor-bootstrap-evidence/v1";
    retiredEvidence.payload.schemaVersion =
      "genio-stable-predecessor-bootstrap-evidence/v1";
    const retiredAuthorization = structuredClone(value.authorization);
    retiredAuthorization.schemaVersion =
      "genio-signed-stable-predecessor-bootstrap-authorization/v1";
    retiredAuthorization.payload.schemaVersion =
      "genio-stable-predecessor-bootstrap-authorization/v1";
    expect(() => verifyHistoricalStablePredecessor({
      ...input,
      evidence: retiredEvidence,
      authorization: retiredAuthorization,
    })).toThrow(/schemas are mixed or unsupported/u);
  });

  test("labels the compatibility rcTag synthetic instead of claiming a historical ref", () => {
    const value = fixture();
    expect(value.evidence.payload.candidate).toMatchObject({
      compatibilityRcTag:
        STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
      compatibilityRcTagIsSynthetic: true,
    });
    const tampered = structuredClone(value.evidence);
    (tampered.payload.candidate as Record<string, unknown>)
      .compatibilityRcTagIsSynthetic = false;
    expect(() => authorizeStablePredecessorBootstrap({
      bootstrapEvidence: tampered,
      protectedBaselineMetadata: value.metadata,
      imageAttestation: value.imageAttestation,
      sourceBytes: value.sourceBytes,
      releaseVerificationKey: value.release.publicKey,
      approvedReleaseKeyId: "bootstrap-evidence-v1",
      approvedReleaseKeySha256: value.releaseKeySha256,
      approvedProducerKeyId: value.independent.producerKeyId,
      approvedProducerKeySha256: value.independent.producerKeySha256,
      ...protectedExternalAuthorities(value),
      authorizerSigningKey: value.authorizer.privateKey,
      approvedAuthorizerKeyId: "bootstrap-authorizer-v1",
      approvedAuthorizerKeySha256: value.authorizerKeySha256,
      expectedRepository: repository,
      expectedDefaultBranch: defaultBranch,
      generatedAt: authorizedAt,
    })).toThrow(/not the exact v2\.3\.4 bootstrap target|signature/u);
  });

  test.each([
    "v2.3.4-rc.1",
    "v2.4.0",
    "v2.5.0-rc.1",
    "v2.4.1-rc.1",
  ])("rejects successor %s outside the sole v2.4.0 RC family", (rcTag) => {
    const value = fixture();
    expect(() => verifyStablePredecessorBootstrapBundle({
      bootstrapEvidence: value.evidence,
      protectedBaselineMetadata: value.metadata,
      releaseVerificationKey: value.release.publicKey,
      approvedReleaseKeySha256: value.releaseKeySha256,
      stableAuthorization: value.authorization,
      stableAuthorizationVerificationKey: value.authorizer.publicKey,
      approvedStableAuthorizerKeyId: "bootstrap-authorizer-v1",
      approvedStableAuthorizerKeySha256: value.authorizerKeySha256,
      imageAttestation: value.imageAttestation,
      storedConsumer: value.storedConsumer,
      expectedSuccessorRcTag: rcTag,
      expectedSuccessorSourceRevision: "8".repeat(40),
      expectedRepository: repository,
      expectedDefaultBranch: defaultBranch,
    })).toThrow(/only by a v2\.4\.0-rc\.N successor/u);
  });

  test("rejects a forked repository/controller replay", () => {
    const value = fixture();
    expect(() => verifyStablePredecessorBootstrapBundle({
      bootstrapEvidence: value.evidence,
      protectedBaselineMetadata: value.metadata,
      releaseVerificationKey: value.release.publicKey,
      approvedReleaseKeySha256: value.releaseKeySha256,
      stableAuthorization: value.authorization,
      stableAuthorizationVerificationKey: value.authorizer.publicKey,
      approvedStableAuthorizerKeyId: "bootstrap-authorizer-v1",
      approvedStableAuthorizerKeySha256: value.authorizerKeySha256,
      imageAttestation: value.imageAttestation,
      storedConsumer: value.storedConsumer,
      expectedSuccessorRcTag: "v2.4.0-rc.2",
      expectedSuccessorSourceRevision: "8".repeat(40),
      expectedRepository: "attacker/genio",
      expectedDefaultBranch: defaultBranch,
    })).toThrow(/protected repository controller/u);
  });

  test("rejects substituted image evidence and stored consumer bytes", () => {
    const value = fixture();
    const image = {
      ...value.imageAttestation,
      controllerRecipeSha256: "9".repeat(64),
    };
    expect(() => verifyStablePredecessorBootstrapBundle({
      bootstrapEvidence: value.evidence,
      protectedBaselineMetadata: value.metadata,
      releaseVerificationKey: value.release.publicKey,
      approvedReleaseKeySha256: value.releaseKeySha256,
      stableAuthorization: value.authorization,
      stableAuthorizationVerificationKey: value.authorizer.publicKey,
      approvedStableAuthorizerKeyId: "bootstrap-authorizer-v1",
      approvedStableAuthorizerKeySha256: value.authorizerKeySha256,
      imageAttestation: image,
      storedConsumer: value.storedConsumer,
      expectedSuccessorRcTag: "v2.4.0-rc.2",
      expectedSuccessorSourceRevision: "8".repeat(40),
      expectedRepository: repository,
      expectedDefaultBranch: defaultBranch,
    })).toThrow(/image attestation|image provenance/u);

    expect(() => verifyStablePredecessorBootstrapBundle({
      bootstrapEvidence: value.evidence,
      protectedBaselineMetadata: value.metadata,
      releaseVerificationKey: value.release.publicKey,
      approvedReleaseKeySha256: value.releaseKeySha256,
      stableAuthorization: value.authorization,
      stableAuthorizationVerificationKey: value.authorizer.publicKey,
      approvedStableAuthorizerKeyId: "bootstrap-authorizer-v1",
      approvedStableAuthorizerKeySha256: value.authorizerKeySha256,
      imageAttestation: value.imageAttestation,
      storedConsumer: {
        ...value.storedConsumer,
        finalBrowserGateEvidenceHash: "9".repeat(64),
      },
      expectedSuccessorRcTag: "v2.4.0-rc.2",
      expectedSuccessorSourceRevision: "8".repeat(40),
      expectedRepository: repository,
      expectedDefaultBranch: defaultBranch,
    })).toThrow(/stored bootstrap consumer/u);
  });

  test("rejects reused role keys and future-dated historical verification", () => {
    const value = fixture();
    expect(() => authorizeStablePredecessorBootstrap({
      bootstrapEvidence: value.evidence,
      protectedBaselineMetadata: value.metadata,
      imageAttestation: value.imageAttestation,
      sourceBytes: value.sourceBytes,
      releaseVerificationKey: value.release.publicKey,
      approvedReleaseKeyId: "bootstrap-evidence-v1",
      approvedReleaseKeySha256: value.releaseKeySha256,
      approvedProducerKeyId: value.independent.producerKeyId,
      approvedProducerKeySha256: value.independent.producerKeySha256,
      ...protectedExternalAuthorities(value),
      authorizerSigningKey: value.release.privateKey,
      approvedAuthorizerKeyId: "bootstrap-authorizer-v1",
      approvedAuthorizerKeySha256: value.releaseKeySha256,
      expectedRepository: repository,
      expectedDefaultBranch: defaultBranch,
      generatedAt: authorizedAt,
    })).toThrow(/distinct protected key/u);
    expect(() => verifyHistoricalStablePredecessorBootstrapLineage({
      bootstrapEvidence: value.evidence,
      protectedBaselineMetadata: value.metadata,
      releaseVerificationKey: value.release.publicKey,
      approvedReleaseKeySha256: value.releaseKeySha256,
      stableAuthorization: value.authorization,
      stableAuthorizationVerificationKey: value.authorizer.publicKey,
      approvedStableAuthorizerKeyId: "bootstrap-authorizer-v1",
      approvedStableAuthorizerKeySha256: value.authorizerKeySha256,
      expectedRcTag: STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
      expectedVersion: "2.3.4",
      expectedRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
      expectedImageDigest: imageDigest,
      expectedImageReference: imageReference,
      expectedRepository: repository,
      expectedDefaultBranch: defaultBranch,
      now: "2026-07-26T10:01:00.000Z",
    })).toThrow(/time window/u);
    expect(() => validateStablePredecessorBootstrapPublicationWindow({
      bootstrapEvidence: value.evidence,
      stableAuthorization: value.authorization,
      now: "2026-07-28T10:00:00.000Z",
    })).toThrow(/outside the publication window/u);
  });

  test("authorizes only the reduced provenance claim and rejects substituted Sites trust", () => {
    const value = fixture();
    expect(value.authorization.payload).toMatchObject({
      railwayObservationKind:
        "authenticated_platform_observation_not_supply_chain_attestation",
      wrapperReconstructionMode:
        "controller_recipe_wrapper_not_historical_railway_artifact",
      wrapperImageDigest: imageDigest,
      historicalArtifactEquivalence: "not_claimed",
      historicalArtifactIdentity: null,
    });
    expect(value.authorization.payload).not.toHaveProperty(
      "originalRailwayImageDigest",
    );
    expect(value.authorization.payload).not.toHaveProperty(
      "originalRailwayProvenanceArtifactHash",
    );

    const substitutedSites = fixture();
    expect(() => authorizeStablePredecessorBootstrap({
      bootstrapEvidence: value.evidence,
      protectedBaselineMetadata: value.metadata,
      imageAttestation: value.imageAttestation,
      sourceBytes: value.sourceBytes,
      releaseVerificationKey: value.release.publicKey,
      approvedReleaseKeyId: "bootstrap-evidence-v1",
      approvedReleaseKeySha256: value.releaseKeySha256,
      approvedProducerKeyId: value.independent.producerKeyId,
      approvedProducerKeySha256: value.independent.producerKeySha256,
      ...protectedExternalAuthorities(value),
      approvedSitesControlPlaneVerificationKey:
        substitutedSites.sitesControlPlaneVerificationKey,
      approvedSitesControlPlaneTrustPolicy:
        substitutedSites.sitesControlPlaneTrustPolicy,
      authorizerSigningKey: value.authorizer.privateKey,
      approvedAuthorizerKeyId: "bootstrap-authorizer-v1",
      approvedAuthorizerKeySha256: value.authorizerKeySha256,
      expectedRepository: repository,
      expectedDefaultBranch: defaultBranch,
      generatedAt: authorizedAt,
    })).toThrow(/externally protected key|substituted/u);
  });

  test("derives the fixture registry and rejects split-brain protected fixtures", () => {
    const value = fixture();
    expect(value.evidence.payload.fixtureRegistryHash).toBe(
      stablePredecessorBootstrapFixtureRegistryHash(
        value.evidence.payload.fixtures,
      ),
    );
    const metadata = structuredClone(value.metadata);
    metadata.fixtures[0]!.outputHash = "9".repeat(64);
    expect(() => authorizeStablePredecessorBootstrap({
      bootstrapEvidence: value.evidence,
      protectedBaselineMetadata: metadata,
      imageAttestation: value.imageAttestation,
      sourceBytes: value.sourceBytes,
      releaseVerificationKey: value.release.publicKey,
      approvedReleaseKeyId: "bootstrap-evidence-v1",
      approvedReleaseKeySha256: value.releaseKeySha256,
      approvedProducerKeyId: value.independent.producerKeyId,
      approvedProducerKeySha256: value.independent.producerKeySha256,
      ...protectedExternalAuthorities(value),
      authorizerSigningKey: value.authorizer.privateKey,
      approvedAuthorizerKeyId: "bootstrap-authorizer-v1",
      approvedAuthorizerKeySha256: value.authorizerKeySha256,
      expectedRepository: repository,
      expectedDefaultBranch: defaultBranch,
      generatedAt: authorizedAt,
    })).toThrow(/metadata does not bind the signed evidence/u);
  });

  test("derives wrapper-only fixture claims from exact detached source artifacts", () => {
    const value = fixture();
    expect(value.evidence.payload.productionObservation).toMatchObject({
      semanticBaselineScope:
        "reconstruction_wrapper_only_not_historical_production_equivalence",
      wrapperFixtureEvidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(value.evidence.payload.limitations).toContain(
      "wrapper_fixture_evidence_does_not_prove_historical_production_output_equivalence",
    );
    expect((value.evidence.payload.gates as unknown[])).toHaveLength(4);
    expect(Buffer.byteLength(JSON.stringify(value.evidence), "utf8"))
      .toBeLessThanOrEqual(18_000);
  });

  test("rejects fake or repeated fixture hash summaries even when an attacker re-signs", () => {
    const value = fixture();
    const fake = structuredClone(value.independent.bundle);
    const fakeSource = fake.sources[0]!;
    const fakeHosted = fakeSource.artifact.sources
      .hostedPublication as Record<string, unknown>;
    fakeHosted.manifestContentHash = "0".repeat(64);
    expect(() => recreateEvidence(value, fake))
      .toThrow(/hash does not match its contents/u);

    const repeated = structuredClone(value.independent.bundle);
    const source = repeated.sources[1]!;
    const firstHosted = repeated.sources[0]!.artifact.sources
      .hostedPublication as Record<string, unknown>;
    const repeatedManifest = firstHosted.manifestContentHash;
    const sources = structuredClone(
      source.artifact.sources,
    ) as Record<string, unknown>;
    const hosted = sources.hostedPublication as Record<string, unknown>;
    hosted.manifestContentHash = repeatedManifest;
    const hostedUnsigned = { ...hosted };
    delete hostedUnsigned.evidenceHash;
    hosted.evidenceHash = createHash("sha256")
      .update(JSON.stringify(hostedUnsigned))
      .digest("hex");
    const artifact = createReleaseGateArtifactFromSources({
      gate: source.gate,
      completedAt: source.artifact.completedAt,
      candidate: source.artifact.candidate,
      configurationHash: source.artifact.configurationHash,
      runtimeHash: source.artifact.runtimeHash,
      fixtures: source.artifact.fixtures,
      sources,
    });
    source.artifact = artifact;
    source.attestation = attestReleaseGateArtifact(
      artifact,
      value.independent.producerKeys.privateKey,
      value.independent.producerKeyId,
    );
    expect(() => recreateEvidence(value, repeated))
      .toThrow(/repeated manifest or output hashes/u);
  });

  test("rejects producer key reuse and operator-supplied workflow bytes", () => {
    const value = fixture();
    const reused = structuredClone(value.independent.bundle);
    const reusedKeyId = "bootstrap-reused-release-key-v1";
    reused.producerVerificationKey = {
      schemaVersion:
        "genio-stable-predecessor-bootstrap-producer-verification-key/v1",
      algorithm: "Ed25519",
      keyId: reusedKeyId,
      publicKeyPem: value.release.publicKey.export({
        format: "pem",
        type: "spki",
      }).toString(),
      publicKeySha256: value.releaseKeySha256,
    };
    reused.producerTrustPolicy = {
      schemaVersion: "genio-release-gate-producer-trust-policy/v1",
      approvedKeyId: reusedKeyId,
      approvedKeySha256: value.releaseKeySha256,
    };
    for (const source of reused.sources) {
      source.attestation = attestReleaseGateArtifact(
        source.artifact,
        value.release.privateKey,
        reusedKeyId,
      );
    }
    expect(() => recreateEvidence(value, reused))
      .toThrow(/must be distinct/u);

    expect(() => authorizeStablePredecessorBootstrap({
      bootstrapEvidence: value.evidence,
      protectedBaselineMetadata: value.metadata,
      imageAttestation: value.imageAttestation,
      sourceBytes: {
        ...value.sourceBytes,
        controllerWorkflowBytes:
          Buffer.concat([
            Buffer.from(value.sourceBytes.controllerWorkflowBytes),
            Buffer.from("# substituted\n"),
          ]),
      },
      releaseVerificationKey: value.release.publicKey,
      approvedReleaseKeyId: "bootstrap-evidence-v1",
      approvedReleaseKeySha256: value.releaseKeySha256,
      approvedProducerKeyId: value.independent.producerKeyId,
      approvedProducerKeySha256: value.independent.producerKeySha256,
      ...protectedExternalAuthorities(value),
      authorizerSigningKey: value.authorizer.privateKey,
      approvedAuthorizerKeyId: "bootstrap-authorizer-v1",
      approvedAuthorizerKeySha256: value.authorizerKeySha256,
      expectedRepository: repository,
      expectedDefaultBranch: defaultBranch,
      generatedAt: authorizedAt,
    })).toThrow(/not derived from the supplied exact bytes/u);
  });

  test("parses executable produce and verify commands and rejects CLI ambiguity", () => {
    const produce = [
      "produce",
      "--confirm-v2-3-4-stable-predecessor-bootstrap",
      "--bootstrap-evidence", "evidence.json",
      "--protected-baseline-metadata", "metadata.json",
      "--bootstrap-authorization", "authorization.json",
      "--release-verification-key", "release.pem",
      "--stable-authorization-verification-key", "authorizer.pem",
      "--recovered-railway-observation", "railway.json",
      "--sites-control-plane-verification-key", "sites-key.json",
      "--sites-control-plane-trust-policy", "sites-policy.json",
      "--github-attestation-verification", "github.json",
      "--controller-workflow-bytes", "controller.yml",
      "--tag-object-bytes", "tag-object",
      "--source-commit-bytes", "source-commit",
      "--source-tree-object-bytes", "source-tree",
      "--expected-image-digest", imageDigest,
      "--bootstrap-controller-revision", controllerRevision,
      "--expected-repository", repository,
      "--expected-default-branch", defaultBranch,
      "--output-image-attestation", "image.json",
      "--output-consumer", "consumer.json",
    ];
    expect(parseStablePredecessorBootstrapCliArgs(produce).command)
      .toBe("produce");
    const verify = [
      "verify",
      "--confirm-v2-3-4-stable-predecessor-bootstrap",
      "--assets-directory", ".",
      "--release-verification-key", "release.pem",
      "--stable-authorization-verification-key", "authorizer.pem",
      "--sites-control-plane-verification-key", "sites-key.json",
      "--sites-control-plane-trust-policy", "sites-policy.json",
      "--github-attestation-verification", "github.json",
      "--controller-workflow-bytes", "controller.yml",
      "--tag-object-bytes", "tag-object",
      "--source-commit-bytes", "source-commit",
      "--source-tree-object-bytes", "source-tree",
      "--expected-image-digest", imageDigest,
      "--bootstrap-controller-revision", controllerRevision,
      "--expected-repository", repository,
      "--expected-default-branch", defaultBranch,
      "--output", "verification.json",
    ];
    expect(parseStablePredecessorBootstrapCliArgs(verify).command)
      .toBe("verify");
    expect(() => parseStablePredecessorBootstrapCliArgs([
      ...verify,
      "--output",
      "other.json",
    ])).toThrow(/Duplicate argument/u);
    expect(() => parseStablePredecessorBootstrapCliArgs([
      ...verify,
      "--untrusted-option",
      "value",
    ])).toThrow(/Unknown argument/u);
  });

  test("executes produce and verify against the exact five-asset bundle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "genio-bootstrap-cli-"));
    const now = Date.now();
    const value = fixture({
      generatedAt: new Date(now - 5 * 60_000).toISOString(),
      authorizedAt: new Date(now - 4 * 60_000).toISOString(),
    });
    const paths = {
      evidence: join(directory, "finalization-evidence.json"),
      metadata: join(directory, "protected-semantic-baseline.json"),
      authorization: join(directory, "stable-authorization.json"),
      recovered: join(directory, "recovered-railway-observation.json"),
      sitesKey: join(directory, "sites-key.json"),
      sitesPolicy: join(directory, "sites-policy.json"),
      github: join(directory, "wrapper-attestation-verification.json"),
      releaseKey: join(directory, "release.pem"),
      authorizerKey: join(directory, "authorizer.pem"),
      controller: join(directory, "controller.yml"),
      tagObject: join(directory, "tag-object"),
      sourceCommit: join(directory, "source-commit"),
      sourceTree: join(directory, "source-tree"),
      image: join(directory, "stable-image-attestation.json"),
      consumer: join(directory, "stable-release-consumer.json"),
      verification: join(directory, "verification.json"),
    };
    const prior = {
      releaseKeyId: process.env.RELEASE_VERIFICATION_KEY_ID,
      releaseKeyHash: process.env.RELEASE_VERIFICATION_KEY_SHA256,
      authorizerKeyId: process.env.RELEASE_STABLE_AUTHORIZER_KEY_ID,
      authorizerKeyHash:
        process.env.RELEASE_STABLE_AUTHORIZER_KEY_SHA256,
      producerKeyId: process.env.RELEASE_GATE_PRODUCER_KEY_ID,
      producerKeyHash: process.env.RELEASE_GATE_PRODUCER_KEY_SHA256,
      sitesKeyId: process.env.RELEASE_SITES_CONTROL_PLANE_KEY_ID,
      sitesKeyHash: process.env.RELEASE_SITES_CONTROL_PLANE_KEY_SHA256,
    };
    try {
      await Promise.all([
        writeFile(paths.evidence, JSON.stringify(value.evidence)),
        writeFile(paths.metadata, JSON.stringify(value.metadata)),
        writeFile(paths.authorization, JSON.stringify(value.authorization)),
        writeFile(
          paths.recovered,
          JSON.stringify(stablePredecessorRecoveredRailwayObservationV1()),
        ),
        writeFile(
          paths.sitesKey,
          JSON.stringify(value.sitesControlPlaneVerificationKey),
        ),
        writeFile(
          paths.sitesPolicy,
          JSON.stringify(value.sitesControlPlaneTrustPolicy),
        ),
        writeFile(
          paths.github,
          JSON.stringify(value.githubAttestationVerification),
        ),
        writeFile(
          paths.releaseKey,
          value.release.publicKey.export({ type: "spki", format: "pem" }),
        ),
        writeFile(
          paths.authorizerKey,
          value.authorizer.publicKey.export({ type: "spki", format: "pem" }),
        ),
        writeFile(
          paths.controller,
          value.sourceBytes.controllerWorkflowBytes,
        ),
        writeFile(paths.tagObject, value.sourceBytes.tagObjectBytes),
        writeFile(paths.sourceCommit, value.sourceBytes.sourceCommitBytes),
        writeFile(paths.sourceTree, value.sourceBytes.sourceTreeObjectBytes),
      ]);
      process.env.RELEASE_VERIFICATION_KEY_ID = "bootstrap-evidence-v1";
      process.env.RELEASE_VERIFICATION_KEY_SHA256 =
        value.releaseKeySha256;
      process.env.RELEASE_STABLE_AUTHORIZER_KEY_ID =
        "bootstrap-authorizer-v1";
      process.env.RELEASE_STABLE_AUTHORIZER_KEY_SHA256 =
        value.authorizerKeySha256;
      process.env.RELEASE_GATE_PRODUCER_KEY_ID =
        value.independent.producerKeyId;
      process.env.RELEASE_GATE_PRODUCER_KEY_SHA256 =
        value.independent.producerKeySha256;
      process.env.RELEASE_SITES_CONTROL_PLANE_KEY_ID =
        String((value.sitesControlPlaneTrustPolicy as Record<string, unknown>)
          .approvedKeyId);
      process.env.RELEASE_SITES_CONTROL_PLANE_KEY_SHA256 =
        String((value.sitesControlPlaneTrustPolicy as Record<string, unknown>)
          .approvedKeySha256);
      await runStablePredecessorBootstrapCli([
        "produce",
        "--confirm-v2-3-4-stable-predecessor-bootstrap",
        "--bootstrap-evidence", paths.evidence,
        "--protected-baseline-metadata", paths.metadata,
        "--bootstrap-authorization", paths.authorization,
        "--release-verification-key", paths.releaseKey,
        "--stable-authorization-verification-key", paths.authorizerKey,
        "--recovered-railway-observation", paths.recovered,
        "--sites-control-plane-verification-key", paths.sitesKey,
        "--sites-control-plane-trust-policy", paths.sitesPolicy,
        "--github-attestation-verification", paths.github,
        "--controller-workflow-bytes", paths.controller,
        "--tag-object-bytes", paths.tagObject,
        "--source-commit-bytes", paths.sourceCommit,
        "--source-tree-object-bytes", paths.sourceTree,
        "--expected-image-digest", imageDigest,
        "--bootstrap-controller-revision", controllerRevision,
        "--expected-repository", repository,
        "--expected-default-branch", defaultBranch,
        "--output-image-attestation", paths.image,
        "--output-consumer", paths.consumer,
      ]);
      await runStablePredecessorBootstrapCli([
        "verify",
        "--confirm-v2-3-4-stable-predecessor-bootstrap",
        "--assets-directory", directory,
        "--release-verification-key", paths.releaseKey,
        "--stable-authorization-verification-key", paths.authorizerKey,
        "--sites-control-plane-verification-key", paths.sitesKey,
        "--sites-control-plane-trust-policy", paths.sitesPolicy,
        "--github-attestation-verification", paths.github,
        "--controller-workflow-bytes", paths.controller,
        "--tag-object-bytes", paths.tagObject,
        "--source-commit-bytes", paths.sourceCommit,
        "--source-tree-object-bytes", paths.sourceTree,
        "--expected-image-digest", imageDigest,
        "--bootstrap-controller-revision", controllerRevision,
        "--expected-repository", repository,
        "--expected-default-branch", defaultBranch,
        "--output", paths.verification,
      ]);
      expect(JSON.parse(await readFile(paths.verification, "utf8")))
        .toMatchObject({
          schemaVersion:
            "genio-stable-predecessor-bootstrap-verification/v1",
          verified: true,
          candidate: {
            stableTag: STABLE_PREDECESSOR_BOOTSTRAP_TAG,
            imageDigest,
          },
        });
      await writeFile(
        paths.github,
        JSON.stringify({ verificationResult: "substituted" }),
      );
      await expect(runStablePredecessorBootstrapCli([
        "verify",
        "--confirm-v2-3-4-stable-predecessor-bootstrap",
        "--assets-directory", directory,
        "--release-verification-key", paths.releaseKey,
        "--stable-authorization-verification-key", paths.authorizerKey,
        "--sites-control-plane-verification-key", paths.sitesKey,
        "--sites-control-plane-trust-policy", paths.sitesPolicy,
        "--github-attestation-verification", paths.github,
        "--controller-workflow-bytes", paths.controller,
        "--tag-object-bytes", paths.tagObject,
        "--source-commit-bytes", paths.sourceCommit,
        "--source-tree-object-bytes", paths.sourceTree,
        "--expected-image-digest", imageDigest,
        "--bootstrap-controller-revision", controllerRevision,
        "--expected-repository", repository,
        "--expected-default-branch", defaultBranch,
        "--output", join(directory, "tampered-verification.json"),
      ])).rejects.toThrow(/fresh GitHub verification/u);
    } finally {
      if (prior.releaseKeyId === undefined) {
        delete process.env.RELEASE_VERIFICATION_KEY_ID;
      } else {
        process.env.RELEASE_VERIFICATION_KEY_ID = prior.releaseKeyId;
      }
      if (prior.releaseKeyHash === undefined) {
        delete process.env.RELEASE_VERIFICATION_KEY_SHA256;
      } else {
        process.env.RELEASE_VERIFICATION_KEY_SHA256 = prior.releaseKeyHash;
      }
      if (prior.authorizerKeyId === undefined) {
        delete process.env.RELEASE_STABLE_AUTHORIZER_KEY_ID;
      } else {
        process.env.RELEASE_STABLE_AUTHORIZER_KEY_ID =
          prior.authorizerKeyId;
      }
      if (prior.authorizerKeyHash === undefined) {
        delete process.env.RELEASE_STABLE_AUTHORIZER_KEY_SHA256;
      } else {
        process.env.RELEASE_STABLE_AUTHORIZER_KEY_SHA256 =
          prior.authorizerKeyHash;
      }
      if (prior.producerKeyId === undefined) {
        delete process.env.RELEASE_GATE_PRODUCER_KEY_ID;
      } else {
        process.env.RELEASE_GATE_PRODUCER_KEY_ID = prior.producerKeyId;
      }
      if (prior.producerKeyHash === undefined) {
        delete process.env.RELEASE_GATE_PRODUCER_KEY_SHA256;
      } else {
        process.env.RELEASE_GATE_PRODUCER_KEY_SHA256 =
          prior.producerKeyHash;
      }
      if (prior.sitesKeyId === undefined) {
        delete process.env.RELEASE_SITES_CONTROL_PLANE_KEY_ID;
      } else {
        process.env.RELEASE_SITES_CONTROL_PLANE_KEY_ID =
          prior.sitesKeyId;
      }
      if (prior.sitesKeyHash === undefined) {
        delete process.env.RELEASE_SITES_CONTROL_PLANE_KEY_SHA256;
      } else {
        process.env.RELEASE_SITES_CONTROL_PLANE_KEY_SHA256 =
          prior.sitesKeyHash;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
