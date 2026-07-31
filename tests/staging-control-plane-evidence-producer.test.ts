import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  SIGNED_STAGING_CONTROL_PLANE_EVIDENCE_SCHEMA_V1,
  stagingControlPlaneKeyFingerprint,
  stagingControlPlaneTrustPolicyV1,
  verifyStagingControlPlaneEvidence,
} from "../shared/staging-control-plane-evidence.ts";
import {
  APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
  QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1,
  PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
  SIGNED_APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
  SIGNED_QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1,
  SIGNED_PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
  controlPlaneReceiptKeyFingerprint,
  controlPlaneReceiptTrustPolicyV1,
  verifyAppleControlPlaneReceipt,
  verifyProviderControlPlaneReceipt,
  verifyQaBudgetLedgerReceipt,
} from "../shared/staging-control-plane-receipts.ts";
import {
  createStrictSignedEnvelope,
  signedArtifactSha256,
} from "../shared/signed-artifact.ts";
import {
  releaseEvidenceConfigurationHash,
  releaseEvidenceRuntimeHash,
} from "../scripts/release-evidence.ts";
import {
  parseStagingControlPlaneEvidenceProducerArgs,
  produceStagingControlPlaneEvidence,
  validateRailwayStatusMetadata,
  type RailwayControlPlaneQueryAdapter,
  type CandidateReleaseEvidenceVerifier,
  type RailwayEnvironmentSelectorV1,
  type StagingControlPlaneEvidenceProducerArgs,
} from "../scripts/staging-control-plane-evidence-producer.ts";

const generatedAt = "2026-07-24T12:00:00.000Z";
const appleExpiresAt = "2026-07-25T12:00:00.000Z";
const budgetExpiresAt = "2026-07-24T12:45:00.000Z";
const revision = "a".repeat(40);
const candidateImageDigest = `sha256:${"a".repeat(64)}`;
const candidateImageReference =
  `ghcr.io/genio/release@${candidateImageDigest}`;
const currentProductionRevision = "b".repeat(40);
const currentProductionImageDigest = `sha256:${"b".repeat(64)}`;
const stagingOrigin = "https://staging-9enio.example";
const productionOrigin = "https://9enio.com";
const stagingProjectId = "11111111-1111-4111-8111-111111111111";
const productionProjectId = "22222222-2222-4222-8222-222222222222";
const stagingEnvironmentId = "33333333-3333-4333-8333-333333333333";
const productionEnvironmentId = "44444444-4444-4444-8444-444444444444";
const stagingServices = [
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
  "99999999-9999-4999-8999-999999999999",
];
const productionServices = [
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
];

function runtime(environment: "staging" | "production") {
  return {
    semanticExecutionConfigurationHash: "f".repeat(64),
    releaseEnvironment: environment,
    deploymentPhase: "activate" as const,
    databaseSchemaVersion: "20",
    databaseCapabilityVersion: "2" as const,
    releaseManifestCanaryGuardsVersion: "1" as const,
    canonicalExecutionHardeningVersion: "1" as const,
    proofArchitectureMode: "native" as const,
    proofArchitectureVersion: "1" as const,
    proofArchitectureAuthority: "native" as const,
    workerProtocol: "playlist-pipeline-v12",
    briefContractVersion: "3",
    queryPlanSchemaVersion: "6",
    modelIds: {
      brief: "gpt-5.4-mini",
      baseline: "gpt-5.6-luna",
      escalation: "gpt-5.6-terra",
    },
    policyVersions: {
      guidance: "adaptive_guidance_v4",
      evidence: "governed_evidence_v2",
      queryPlan: "query_plan_v3_4",
      selection: "selection_plan_v3",
      semanticScope: "scope_gate_v2_1_2",
      musicConcept: "music_concepts_v3_2_0",
      pipeline: "corpus_first_v3",
      prompt: "grounded_recovery_v3_1_prompt_v1",
    },
  };
}

function runtimeSnapshot(
  environment: "staging" | "production",
  phase: "candidate" | "promotion" | "finalization" = "promotion",
) {
  const hashes = environment === "staging"
    ? ["1", "2", "3", "4", "5"]
    : ["6", "7", "8", "9", "a"];
  const candidateMatched =
    environment === "staging" || phase === "finalization";
  const sitesObservation = candidateMatched
    ? {
      version: "2.4.0",
      sourceRevision: revision,
      configurationHash: hashes[3]!.repeat(64),
      ownerAllowlistVersion: "owner-allowlist-v1",
      candidateMatched: true,
    }
    : {
      version: "2.3.9",
      sourceRevision: currentProductionRevision,
      configurationHash: hashes[3]!.repeat(64),
      ownerAllowlistVersion: "owner-allowlist-v0",
      candidateMatched: false,
    };
  const configuration = {
    apiHash: hashes[0]!.repeat(64),
    interactiveWorkerHash: hashes[1]!.repeat(64),
    deepWorkerHash: hashes[2]!.repeat(64),
    sitesHash: signedArtifactSha256({
      buildIdentity: {
        version: sitesObservation.version,
        sourceRevision: sitesObservation.sourceRevision,
      },
      gatewayConfigurationHash: sitesObservation.configurationHash,
    }),
    secretVersionsHash: hashes[4]!.repeat(64),
  };
  const runtimeValue = runtime(environment);
  const unsigned = {
    schemaVersion: "genio-release-runtime-snapshot/v3" as const,
    generatedAt,
    origin: environment === "staging" ? stagingOrigin : productionOrigin,
    environment,
    scope: environment === "staging" || phase === "finalization"
      ? "full" as const
      : "backend" as const,
    candidate: {
      version: "2.4.0",
      sourceRevision: revision,
    },
    sitesObservation,
    apiObservations: {
      liveReplicaIdentityHash: "8".repeat(64),
      systemReplicaIdentityHash: "9".repeat(64),
    },
    executorFencing: {
      version: "1",
      ready: true,
      incompleteJobs: 0,
      mismatchedActiveAttempts: 0,
      uncoveredJobs: 0,
      requirementsHash: "a".repeat(64),
    },
    configuration,
    runtime: runtimeValue,
    publicRollout: {
      active: false,
      databaseAuthorized: true,
      evidenceHash: null,
      stage: null,
      targetConfigurationHash: null,
    },
    credentialVersionHashes: {
      provider: environment === "staging"
        ? "b".repeat(64)
        : "c".repeat(64),
      apple: environment === "staging"
        ? "d".repeat(64)
        : "e".repeat(64),
      appleQaVerifier: environment === "staging"
        ? "f".repeat(64)
        : "0".repeat(64),
    },
    configurationHash: releaseEvidenceConfigurationHash({ configuration }),
    runtimeHash: releaseEvidenceRuntimeHash({ runtime: runtimeValue }),
  };
  return {
    ...unsigned,
    snapshotHash: signedArtifactSha256(unsigned),
  };
}

function railwayStatus(
  projectId: string,
  environmentId: string,
  services: readonly string[],
  status: "SUCCESS" | "FAILED" = "SUCCESS",
  artifact: {
    sourceRevision: string | null;
    imageDigest: string;
    imageReference?: string | null;
  } = {
    sourceRevision: revision,
    imageDigest: candidateImageDigest,
  },
) {
  return {
    id: projectId,
    name: "not-retained",
    environments: {
      edges: [{
        node: {
          id: environmentId,
          canAccess: true,
          deletedAt: null,
          serviceInstances: {
            edges: services.map((serviceId) => ({
              node: {
                id: `instance-${serviceId}`,
                serviceId,
                environmentId,
                latestDeployment: {
                  status,
                  instances: [{ status: "RUNNING" }],
                  meta: {
                    commitHash: artifact.sourceRevision,
                    image: artifact.imageReference ?? null,
                    imageDigest: artifact.imageDigest,
                    ignored: "producer does not retain unapproved deployment metadata",
                  },
                },
              },
            })),
          },
        },
      }],
    },
    variables: {
      ignored: "the projection never reads or signs variable values",
    },
  };
}

function railwayAdapter(
  phase: "candidate" | "promotion" | "finalization" = "candidate",
  failedProjectId?: string,
  driftProjectId?: string,
  wrongSecretVersionsProjectId?: string,
): RailwayControlPlaneQueryAdapter {
  return {
    async queryStatus(selector) {
      const staging = selector.projectId === stagingProjectId;
      const shouldUseCandidate = staging || phase !== "candidate";
      return railwayStatus(
        selector.projectId,
        selector.environmentId,
        staging ? stagingServices : productionServices,
        selector.projectId === failedProjectId ? "FAILED" : "SUCCESS",
        selector.projectId === driftProjectId
          ? {
            sourceRevision: currentProductionRevision,
            imageDigest: currentProductionImageDigest,
          }
          : shouldUseCandidate
            ? {
              sourceRevision: revision,
              imageDigest: candidateImageDigest,
            }
            : {
              sourceRevision: currentProductionRevision,
              imageDigest: currentProductionImageDigest,
            },
      );
    },
    async querySecretVersionsHash(input) {
      if (input.projectId === wrongSecretVersionsProjectId) {
        return "c".repeat(64);
      }
      return input.projectId === stagingProjectId
        ? runtimeSnapshot("staging").configuration.secretVersionsHash
        : runtimeSnapshot("production", phase).configuration.secretVersionsHash;
    },
  };
}

async function setup(
  phase: "candidate" | "promotion" | "finalization" = "candidate",
) {
  const directory = await mkdtemp(join(tmpdir(), "genio-control-plane-"));
  const producerKeys = generateKeyPairSync("ed25519");
  const appleKeys = generateKeyPairSync("ed25519");
  const providerKeys = generateKeyPairSync("ed25519");
  const budgetKeys = generateKeyPairSync("ed25519");
  const candidateEvidenceKeys = generateKeyPairSync("ed25519");
  const stagingSnapshot = runtimeSnapshot("staging");
  const productionSnapshot = runtimeSnapshot("production", phase);
  const candidate = {
    ...stagingSnapshot.candidate,
    imageDigest: candidateImageDigest,
    imageReference: candidateImageReference,
  };
  const productionRuntimeSnapshotHash = phase !== "candidate"
    ? productionSnapshot.snapshotHash
    : null;
  const appleTrust = controlPlaneReceiptTrustPolicyV1({
    receiptKind: "apple",
    approvedIssuer: "apple-control-plane-v1",
    approvedKeyId: "apple-control-plane-key-v1",
    approvedKeySha256:
      controlPlaneReceiptKeyFingerprint(appleKeys.publicKey),
  });
  const providerTrust = controlPlaneReceiptTrustPolicyV1({
    receiptKind: "provider",
    approvedIssuer: "provider-control-plane-v1",
    approvedKeyId: "provider-control-plane-key-v1",
    approvedKeySha256:
      controlPlaneReceiptKeyFingerprint(providerKeys.publicKey),
  });
  const budgetTrust = controlPlaneReceiptTrustPolicyV1({
    receiptKind: "qa_budget",
    approvedIssuer: "qa-budget-ledger-v1",
    approvedKeyId: "qa-budget-ledger-key-v1",
    approvedKeySha256:
      controlPlaneReceiptKeyFingerprint(budgetKeys.publicKey),
  });
  const applePayload = {
    schemaVersion: APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
    phase,
    issuer: appleTrust.approvedIssuer,
    generatedAt,
    expiresAt: appleExpiresAt,
    candidate,
    staging: {
      runtimeSnapshotHash: stagingSnapshot.snapshotHash,
      appleCredentialVersionHash:
        stagingSnapshot.credentialVersionHashes.apple,
      appleQaVerifierCredentialVersionHash:
        stagingSnapshot.credentialVersionHashes.appleQaVerifier,
      appleQaVerifierCredentialIdentityHash: "1".repeat(64),
      appleAccountIdHash: "2".repeat(64),
      musicKitOrigin: stagingOrigin,
      musicKitOriginRegistered: true,
      musicKitOriginRegistrationEvidenceHash: "3".repeat(64),
    },
    production: {
      runtimeSnapshotHash: productionRuntimeSnapshotHash,
      appleCredentialVersionHash:
        productionSnapshot.credentialVersionHashes.apple,
      appleQaVerifierCredentialVersionHash:
        productionSnapshot.credentialVersionHashes.appleQaVerifier,
      appleQaVerifierCredentialIdentityHash: "4".repeat(64),
      appleAccountIdHash: "5".repeat(64),
    },
  };
  const providerPayload = {
    schemaVersion: PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
    phase,
    issuer: providerTrust.approvedIssuer,
    generatedAt,
    expiresAt: appleExpiresAt,
    candidate,
    staging: {
      runtimeSnapshotHash: stagingSnapshot.snapshotHash,
      providerCredentialVersionHash:
        stagingSnapshot.credentialVersionHashes.provider,
      providerProjectIdentityHash: "6".repeat(64),
    },
    production: {
      runtimeSnapshotHash: productionRuntimeSnapshotHash,
      providerCredentialVersionHash:
        productionSnapshot.credentialVersionHashes.provider,
      providerProjectIdentityHash: "7".repeat(64),
    },
  };
  const budgetPayload = {
    schemaVersion: QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1,
    phase,
    issuer: budgetTrust.approvedIssuer,
    generatedAt,
    expiresAt: budgetExpiresAt,
    candidate,
    runtimeSnapshots: {
      staging: stagingSnapshot.snapshotHash,
      production: productionRuntimeSnapshotHash,
    },
    ledgerScope: "staging_release_qa",
    currency: "USD",
    monthlyCostLimitUsd: 10,
    spentUsd: 2.25,
    reservedForRequiredGatesUsd: 4,
    asOf: generatedAt,
  };
  const appleReceipt = createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
    payload: applePayload,
    signingKey: appleKeys.privateKey,
    keyId: appleTrust.approvedKeyId,
  });
  const budgetReceipt = createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1,
    payload: budgetPayload,
    signingKey: budgetKeys.privateKey,
    keyId: budgetTrust.approvedKeyId,
  });
  const providerReceipt = createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
    payload: providerPayload,
    signingKey: providerKeys.privateKey,
    keyId: providerTrust.approvedKeyId,
  });
  const paths = {
    stagingSnapshot: join(directory, "runtime-staging.json"),
    productionSnapshot: join(directory, "runtime-production.json"),
    appleReceipt: join(directory, "apple-receipt.json"),
    applePublicKey: join(directory, "apple-public.pem"),
    providerReceipt: join(directory, "provider-receipt.json"),
    providerPublicKey: join(directory, "provider-public.pem"),
    budgetReceipt: join(directory, "budget-receipt.json"),
    budgetPublicKey: join(directory, "budget-public.pem"),
    producerPrivateKey: join(directory, "producer-private.pem"),
    candidateEvidence: join(directory, "candidate-evidence.json"),
    candidateEvidencePublicKey:
      join(directory, "candidate-evidence-public.pem"),
    output: join(directory, "staging-control-plane.json"),
    verificationKeyOutput: join(directory, "staging-control-plane-public.pem"),
  };
  await Promise.all([
    writeFile(paths.stagingSnapshot, JSON.stringify(stagingSnapshot)),
    writeFile(paths.productionSnapshot, JSON.stringify(productionSnapshot)),
    writeFile(paths.appleReceipt, JSON.stringify(appleReceipt)),
    writeFile(paths.applePublicKey, appleKeys.publicKey.export({
      format: "pem",
      type: "spki",
    })),
    writeFile(paths.providerReceipt, JSON.stringify(providerReceipt)),
    writeFile(paths.providerPublicKey, providerKeys.publicKey.export({
      format: "pem",
      type: "spki",
    })),
    writeFile(paths.budgetReceipt, JSON.stringify(budgetReceipt)),
    writeFile(paths.budgetPublicKey, budgetKeys.publicKey.export({
      format: "pem",
      type: "spki",
    })),
    writeFile(paths.producerPrivateKey, producerKeys.privateKey.export({
      format: "pem",
      type: "pkcs8",
    })),
    writeFile(paths.candidateEvidence, JSON.stringify({
      schemaVersion: "test-candidate-release-evidence/v1",
      payloadHash: "8".repeat(64),
    })),
    writeFile(
      paths.candidateEvidencePublicKey,
      candidateEvidenceKeys.publicKey.export({ format: "pem", type: "spki" }),
    ),
  ]);
  const args: StagingControlPlaneEvidenceProducerArgs = {
    phase,
    candidateImageDigest,
    candidateImageReference,
    stagingRuntimeSnapshotPath: paths.stagingSnapshot,
    productionRuntimeSnapshotPath:
      phase !== "candidate" ? paths.productionSnapshot : null,
    candidateEvidencePath:
      phase !== "candidate" ? paths.candidateEvidence : null,
    candidateEvidenceVerificationKeyPath:
      phase !== "candidate" ? paths.candidateEvidencePublicKey : null,
    candidateEvidenceKeySha256:
      phase !== "candidate"
        ? stagingControlPlaneKeyFingerprint(candidateEvidenceKeys.publicKey)
        : null,
    appleReceiptPath: paths.appleReceipt,
    appleReceiptVerificationKeyPath: paths.applePublicKey,
    providerReceiptPath: paths.providerReceipt,
    providerReceiptVerificationKeyPath: paths.providerPublicKey,
    budgetReceiptPath: paths.budgetReceipt,
    budgetReceiptVerificationKeyPath: paths.budgetPublicKey,
    producerSigningKeyPath: paths.producerPrivateKey,
    outputPath: paths.output,
    verificationKeyOutputPath: paths.verificationKeyOutput,
    producerKeyId: "staging-control-plane-v1",
    producerKeySha256:
      stagingControlPlaneKeyFingerprint(producerKeys.publicKey),
    stagingOrigin,
    productionOrigin,
    stagingRailway: {
      projectId: stagingProjectId,
      environmentId: stagingEnvironmentId,
      requiredServiceIds: [...stagingServices],
      candidateServiceIds: [...stagingServices],
    },
    productionRailway: {
      projectId: productionProjectId,
      environmentId: productionEnvironmentId,
      requiredServiceIds: [...productionServices],
      candidateServiceIds: [...productionServices],
    },
    appleReceiptTrust: appleTrust,
    providerReceiptTrust: providerTrust,
    budgetReceiptTrust: budgetTrust,
  };
  return {
    directory,
    producerKeys,
    appleKeys,
    providerKeys,
    budgetKeys,
    candidateEvidenceKeys,
    stagingSnapshot,
    productionSnapshot,
    applePayload,
    providerPayload,
    budgetPayload,
    appleReceipt,
    providerReceipt,
    budgetReceipt,
    paths,
    args,
  };
}

function protectedEnvironment(
  setupValue: Awaited<ReturnType<typeof setup>>,
): NodeJS.ProcessEnv {
  return {
    RELEASE_STAGING_RAILWAY_PROJECT_ID: stagingProjectId,
    RELEASE_STAGING_RAILWAY_ENVIRONMENT_ID: stagingEnvironmentId,
    RELEASE_STAGING_RAILWAY_SERVICE_IDS: stagingServices.join(","),
    RELEASE_STAGING_RAILWAY_CANDIDATE_SERVICE_IDS:
      stagingServices.join(","),
    RELEASE_PRODUCTION_RAILWAY_PROJECT_ID: productionProjectId,
    RELEASE_PRODUCTION_RAILWAY_ENVIRONMENT_ID: productionEnvironmentId,
    RELEASE_PRODUCTION_RAILWAY_SERVICE_IDS: productionServices.join(","),
    RELEASE_PRODUCTION_RAILWAY_CANDIDATE_SERVICE_IDS:
      productionServices.join(","),
    RELEASE_STAGING_CONTROL_PLANE_KEY_ID: setupValue.args.producerKeyId,
    RELEASE_STAGING_CONTROL_PLANE_KEY_SHA256:
      setupValue.args.producerKeySha256,
    RELEASE_STAGING_ORIGIN: stagingOrigin,
    RELEASE_PRODUCTION_ORIGIN: productionOrigin,
    GENIO_STAGING_MUSICKIT_ORIGIN: stagingOrigin,
    RELEASE_CANDIDATE_IMAGE_REFERENCE: candidateImageReference,
    RELEASE_APPLE_CONTROL_PLANE_ISSUER:
      setupValue.args.appleReceiptTrust.approvedIssuer,
    RELEASE_APPLE_CONTROL_PLANE_KEY_ID:
      setupValue.args.appleReceiptTrust.approvedKeyId,
    RELEASE_APPLE_CONTROL_PLANE_KEY_SHA256:
      setupValue.args.appleReceiptTrust.approvedKeySha256,
    RELEASE_PROVIDER_CONTROL_PLANE_ISSUER:
      setupValue.args.providerReceiptTrust.approvedIssuer,
    RELEASE_PROVIDER_CONTROL_PLANE_KEY_ID:
      setupValue.args.providerReceiptTrust.approvedKeyId,
    RELEASE_PROVIDER_CONTROL_PLANE_KEY_SHA256:
      setupValue.args.providerReceiptTrust.approvedKeySha256,
    RELEASE_QA_BUDGET_LEDGER_ISSUER:
      setupValue.args.budgetReceiptTrust.approvedIssuer,
    RELEASE_QA_BUDGET_LEDGER_KEY_ID:
      setupValue.args.budgetReceiptTrust.approvedKeyId,
    RELEASE_QA_BUDGET_LEDGER_KEY_SHA256:
      setupValue.args.budgetReceiptTrust.approvedKeySha256,
    ...(setupValue.args.phase !== "candidate"
      ? {
        RELEASE_CANDIDATE_EVIDENCE_KEY_SHA256:
          setupValue.args.candidateEvidenceKeySha256!,
      }
      : {}),
  };
}

function command(
  setupValue: Awaited<ReturnType<typeof setup>>,
): string[] {
  return [
    "--phase", setupValue.args.phase,
    "--candidate-image-digest", candidateImageDigest,
    "--staging-runtime-snapshot", setupValue.paths.stagingSnapshot,
    ...(setupValue.args.phase !== "candidate"
      ? [
        "--production-runtime-snapshot", setupValue.paths.productionSnapshot,
        "--candidate-evidence", setupValue.paths.candidateEvidence,
        "--candidate-evidence-verification-key",
        setupValue.paths.candidateEvidencePublicKey,
      ]
      : []),
    "--apple-receipt", setupValue.paths.appleReceipt,
    "--apple-receipt-verification-key", setupValue.paths.applePublicKey,
    "--provider-receipt", setupValue.paths.providerReceipt,
    "--provider-receipt-verification-key", setupValue.paths.providerPublicKey,
    "--budget-receipt", setupValue.paths.budgetReceipt,
    "--budget-receipt-verification-key", setupValue.paths.budgetPublicKey,
    "--producer-signing-key", setupValue.paths.producerPrivateKey,
    "--output", setupValue.paths.output,
    "--verification-key-output", setupValue.paths.verificationKeyOutput,
  ];
}

const strictFakeCandidateEvidenceVerifier: CandidateReleaseEvidenceVerifier = {
  verify(input) {
    if (
      input.candidate.sourceRevision !== revision
      || input.candidate.imageDigest !== candidateImageDigest
      || input.candidate.imageReference !== candidateImageReference
      || input.stagingRuntimeSnapshotHash
        !== runtimeSnapshot("staging").snapshotHash
    ) {
      throw new Error("fake verifier rejected candidate evidence binding");
    }
    return {
      payloadHash: "8".repeat(64),
      expiresAt: appleExpiresAt,
    };
  },
};

describe("staging control-plane receipt verification", () => {
  test("pins independent issuers and keys, exact snapshots, origin, and ledger", async () => {
    const value = await setup("promotion");
    expect(verifyAppleControlPlaneReceipt({
      value: value.appleReceipt,
      verificationKey: value.appleKeys.publicKey,
      trustPolicy: value.args.appleReceiptTrust,
      expected: {
        phase: "promotion",
        candidate: value.applePayload.candidate,
        staging: {
          runtimeSnapshotHash: value.stagingSnapshot.snapshotHash,
          appleCredentialVersionHash:
            value.stagingSnapshot.credentialVersionHashes.apple,
          appleQaVerifierCredentialVersionHash:
            value.stagingSnapshot.credentialVersionHashes.appleQaVerifier,
          musicKitOrigin: stagingOrigin,
        },
        production: {
          runtimeSnapshotHash: value.productionSnapshot.snapshotHash,
          appleCredentialVersionHash:
            value.productionSnapshot.credentialVersionHashes.apple,
          appleQaVerifierCredentialVersionHash:
            value.productionSnapshot.credentialVersionHashes.appleQaVerifier,
        },
      },
      now: generatedAt,
    })).toMatchObject({
      stagingAppleAccountIdHash: "2".repeat(64),
      productionAppleAccountIdHash: "5".repeat(64),
      stagingAppleQaVerifierCredentialIdentityHash: "1".repeat(64),
      productionAppleQaVerifierCredentialIdentityHash: "4".repeat(64),
    });
    expect(verifyQaBudgetLedgerReceipt({
      value: value.budgetReceipt,
      verificationKey: value.budgetKeys.publicKey,
      trustPolicy: value.args.budgetReceiptTrust,
      expected: {
        phase: "promotion",
        candidate: value.applePayload.candidate,
        stagingRuntimeSnapshotHash: value.stagingSnapshot.snapshotHash,
        productionRuntimeSnapshotHash: value.productionSnapshot.snapshotHash,
      },
      now: generatedAt,
    })).toMatchObject({
      monthlyCostLimitUsd: 10,
      spentUsd: 2.25,
      budgetRemainingUsd: 7.75,
      reservedForRequiredGatesUsd: 4,
    });
  });

  test("pins the independent provider project receipt", async () => {
    const value = await setup("promotion");
    expect(verifyProviderControlPlaneReceipt({
      value: value.providerReceipt,
      verificationKey: value.providerKeys.publicKey,
      trustPolicy: value.args.providerReceiptTrust,
      expected: {
        phase: "promotion",
        candidate: value.providerPayload.candidate,
        staging: {
          runtimeSnapshotHash: value.stagingSnapshot.snapshotHash,
          providerCredentialVersionHash:
            value.stagingSnapshot.credentialVersionHashes.provider,
        },
        production: {
          runtimeSnapshotHash: value.productionSnapshot.snapshotHash,
          providerCredentialVersionHash:
            value.productionSnapshot.credentialVersionHashes.provider,
        },
      },
      now: generatedAt,
    })).toMatchObject({
      stagingProviderProjectIdentityHash: "6".repeat(64),
      productionProviderProjectIdentityHash: "7".repeat(64),
    });
  });

  test("rejects swapped runtime bindings, stale ledger state, and unapproved keys", async () => {
    const value = await setup("promotion");
    expect(() => verifyAppleControlPlaneReceipt({
      value: value.appleReceipt,
      verificationKey: value.appleKeys.publicKey,
      trustPolicy: value.args.appleReceiptTrust,
      expected: {
        phase: "promotion",
        candidate: value.applePayload.candidate,
        staging: {
          runtimeSnapshotHash: value.productionSnapshot.snapshotHash,
          appleCredentialVersionHash:
            value.stagingSnapshot.credentialVersionHashes.apple,
          appleQaVerifierCredentialVersionHash:
            value.stagingSnapshot.credentialVersionHashes.appleQaVerifier,
          musicKitOrigin: stagingOrigin,
        },
        production: {
          runtimeSnapshotHash: value.productionSnapshot.snapshotHash,
          appleCredentialVersionHash:
            value.productionSnapshot.credentialVersionHashes.apple,
          appleQaVerifierCredentialVersionHash:
            value.productionSnapshot.credentialVersionHashes.appleQaVerifier,
        },
      },
      now: generatedAt,
    })).toThrow(/exact candidate runtime snapshots/u);
    expect(() => verifyQaBudgetLedgerReceipt({
      value: value.budgetReceipt,
      verificationKey: value.budgetKeys.publicKey,
      trustPolicy: value.args.budgetReceiptTrust,
      expected: {
        phase: "promotion",
        candidate: value.applePayload.candidate,
        stagingRuntimeSnapshotHash: value.stagingSnapshot.snapshotHash,
        productionRuntimeSnapshotHash: value.productionSnapshot.snapshotHash,
      },
      now: "2026-07-24T12:16:00.000Z",
    })).toThrow(/stale/u);
    const wrongKeys = generateKeyPairSync("ed25519");
    expect(() => verifyAppleControlPlaneReceipt({
      value: value.appleReceipt,
      verificationKey: wrongKeys.publicKey,
      trustPolicy: value.args.appleReceiptTrust,
      expected: {
        phase: "promotion",
        candidate: value.applePayload.candidate,
        staging: {
          runtimeSnapshotHash: value.stagingSnapshot.snapshotHash,
          appleCredentialVersionHash:
            value.stagingSnapshot.credentialVersionHashes.apple,
          appleQaVerifierCredentialVersionHash:
            value.stagingSnapshot.credentialVersionHashes.appleQaVerifier,
          musicKitOrigin: stagingOrigin,
        },
        production: {
          runtimeSnapshotHash: value.productionSnapshot.snapshotHash,
          appleCredentialVersionHash:
            value.productionSnapshot.credentialVersionHashes.apple,
          appleQaVerifierCredentialVersionHash:
            value.productionSnapshot.credentialVersionHashes.appleQaVerifier,
        },
      },
      now: generatedAt,
    })).toThrow(/protected approved key/u);
  });
});

describe("staging control-plane evidence producer", () => {
  test("takes every truth and trust pin from protected evidence or environment", async () => {
    const value = await setup();
    expect(parseStagingControlPlaneEvidenceProducerArgs(
      command(value),
      protectedEnvironment(value),
    )).toMatchObject({
      producerKeyId: "staging-control-plane-v1",
      stagingOrigin,
      productionOrigin,
      stagingRailway: {
        projectId: stagingProjectId,
        environmentId: stagingEnvironmentId,
        requiredServiceIds: stagingServices,
      },
    });
    expect(() => parseStagingControlPlaneEvidenceProducerArgs([
      ...command(value),
      "--monthly-cost-limit", "10",
    ], protectedEnvironment(value))).toThrow(/Unknown argument/u);
    const unpinned = protectedEnvironment(value);
    delete unpinned.RELEASE_QA_BUDGET_LEDGER_KEY_SHA256;
    expect(() => parseStagingControlPlaneEvidenceProducerArgs(
      command(value),
      unpinned,
    )).toThrow(/RELEASE_QA_BUDGET_LEDGER_KEY_SHA256/u);
    const promotion = await setup("promotion");
    expect(parseStagingControlPlaneEvidenceProducerArgs(
      command(promotion),
      protectedEnvironment(promotion),
    )).toMatchObject({
      phase: "promotion",
      productionRuntimeSnapshotPath: promotion.paths.productionSnapshot,
      candidateEvidencePath: promotion.paths.candidateEvidence,
      candidateEvidenceKeySha256:
        promotion.args.candidateEvidenceKeySha256,
    });
    const finalization = await setup("finalization");
    expect(parseStagingControlPlaneEvidenceProducerArgs(
      command(finalization),
      protectedEnvironment(finalization),
    )).toMatchObject({
      phase: "finalization",
      productionRuntimeSnapshotPath: finalization.paths.productionSnapshot,
      candidateEvidencePath: finalization.paths.candidateEvidence,
      candidateEvidenceKeySha256:
        finalization.args.candidateEvidenceKeySha256,
    });
    const mismatchedImageReference = protectedEnvironment(value);
    mismatchedImageReference.RELEASE_CANDIDATE_IMAGE_REFERENCE =
      `ghcr.io/genio/release@sha256:${"b".repeat(64)}`;
    expect(() => parseStagingControlPlaneEvidenceProducerArgs(
      command(value),
      mismatchedImageReference,
    )).toThrow(/matching the candidate digest/u);
  });

  test("projects safe Railway metadata and rejects unhealthy or unapproved services", () => {
    const selector: RailwayEnvironmentSelectorV1 = {
      projectId: stagingProjectId,
      environmentId: stagingEnvironmentId,
      requiredServiceIds: [...stagingServices],
      candidateServiceIds: [...stagingServices],
    };
    expect(validateRailwayStatusMetadata({
      value: railwayStatus(
        stagingProjectId,
        stagingEnvironmentId,
        stagingServices,
      ),
      selector,
      expectedCandidate: {
        sourceRevision: revision,
        imageDigest: candidateImageDigest,
        imageReference: candidateImageReference,
      },
      forbiddenCandidate: null,
    })).toEqual({
      railwayProjectIdHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      railwayEnvironmentIdHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      railwayServiceInventoryHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(validateRailwayStatusMetadata({
      value: railwayStatus(
        stagingProjectId,
        stagingEnvironmentId,
        stagingServices,
        "SUCCESS",
        {
          sourceRevision: null,
          imageDigest: candidateImageDigest,
          imageReference: candidateImageReference,
        },
      ),
      selector,
      expectedCandidate: {
        sourceRevision: revision,
        imageDigest: candidateImageDigest,
        imageReference: candidateImageReference,
      },
      forbiddenCandidate: null,
    })).toMatchObject({
      railwayServiceInventoryHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(() => validateRailwayStatusMetadata({
      value: railwayStatus(
        stagingProjectId,
        stagingEnvironmentId,
        stagingServices,
        "SUCCESS",
        {
          sourceRevision: null,
          imageDigest: candidateImageDigest,
          imageReference: null,
        },
      ),
      selector,
      expectedCandidate: {
        sourceRevision: revision,
        imageDigest: candidateImageDigest,
        imageReference: candidateImageReference,
      },
      forbiddenCandidate: null,
    })).toThrow(/artifact does not match/u);
    expect(() => validateRailwayStatusMetadata({
      value: railwayStatus(
        stagingProjectId,
        stagingEnvironmentId,
        stagingServices,
        "FAILED",
      ),
      selector,
      expectedCandidate: {
        sourceRevision: revision,
        imageDigest: candidateImageDigest,
        imageReference: candidateImageReference,
      },
      forbiddenCandidate: null,
    })).toThrow(/not successful/u);
    expect(() => validateRailwayStatusMetadata({
      value: railwayStatus(
        stagingProjectId,
        stagingEnvironmentId,
        [stagingServices[0]!],
      ),
      selector,
      expectedCandidate: {
        sourceRevision: revision,
        imageDigest: candidateImageDigest,
        imageReference: candidateImageReference,
      },
      forbiddenCandidate: null,
    })).toThrow(/protected allowlist/u);
    expect(() => validateRailwayStatusMetadata({
      value: railwayStatus(
        stagingProjectId,
        stagingEnvironmentId,
        stagingServices,
        "SUCCESS",
        {
          sourceRevision: currentProductionRevision,
          imageDigest: currentProductionImageDigest,
        },
      ),
      selector,
      expectedCandidate: {
        sourceRevision: revision,
        imageDigest: candidateImageDigest,
        imageReference: candidateImageReference,
      },
      forbiddenCandidate: null,
    })).toThrow(/artifact does not match/u);
  });

  test("aggregates live, signed proof and emits immutable secret-free evidence", async () => {
    const value = await setup();
    const produced = await produceStagingControlPlaneEvidence({
      args: value.args,
      railway: railwayAdapter(),
      now: generatedAt,
    });
    expect(produced.envelope.schemaVersion)
      .toBe(SIGNED_STAGING_CONTROL_PLANE_EVIDENCE_SCHEMA_V1);
    const verified = verifyStagingControlPlaneEvidence({
      value: produced.envelope,
      verificationKey: value.producerKeys.publicKey,
      trustPolicy: stagingControlPlaneTrustPolicyV1({
        approvedKeyId: value.args.producerKeyId,
        approvedKeySha256: value.args.producerKeySha256,
      }),
      now: generatedAt,
    });
    expect(verified.derivedControls).toMatchObject({
      controlPlanePhase: "candidate",
      candidateEvidencePayloadHash: null,
      candidateSourceRevision: revision,
      candidateImageDigest,
      candidateImageReference,
      monthlyCostLimitUsd: 10,
      budgetRemainingUsd: 7.75,
      reservedForRequiredGatesUsd: 4,
      providerSecretVersionHash:
        value.stagingSnapshot.credentialVersionHashes.provider,
      productionProviderSecretVersionHash:
        value.productionSnapshot.credentialVersionHashes.provider,
      appleQaVerifierSecretVersionHash:
        value.stagingSnapshot.credentialVersionHashes.appleQaVerifier,
      productionAppleQaVerifierSecretVersionHash:
        value.productionSnapshot.credentialVersionHashes.appleQaVerifier,
      appleQaVerifierCredentialIdentityHash: "1".repeat(64),
      productionAppleQaVerifierCredentialIdentityHash: "4".repeat(64),
      providerProjectIdentityHash: "6".repeat(64),
      productionProviderProjectIdentityHash: "7".repeat(64),
      stagingRuntimeSnapshotHash: value.stagingSnapshot.snapshotHash,
      productionRuntimeSnapshotHash: null,
      stagingSecretVersionsHash:
        value.stagingSnapshot.configuration.secretVersionsHash,
      productionSecretVersionsHash:
        value.productionSnapshot.configuration.secretVersionsHash,
      stagingRailwayServiceInventoryHash:
        expect.stringMatching(/^[0-9a-f]{64}$/u),
      productionRailwayServiceInventoryHash:
        expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const serialized = await readFile(value.paths.output, "utf8");
    for (const rawIdentifier of [
      stagingProjectId,
      productionProjectId,
      stagingEnvironmentId,
      productionEnvironmentId,
      ...stagingServices,
      ...productionServices,
    ]) {
      expect(serialized).not.toContain(rawIdentifier);
    }
    await expect(produceStagingControlPlaneEvidence({
      args: value.args,
      railway: railwayAdapter(),
      now: generatedAt,
    })).rejects.toThrow(/already exists/u);
  });

  test("requires same-candidate production proof and prior candidate evidence for promotion", async () => {
    const value = await setup("promotion");
    const produced = await produceStagingControlPlaneEvidence({
      args: value.args,
      railway: railwayAdapter("promotion"),
      candidateEvidenceVerifier: strictFakeCandidateEvidenceVerifier,
      now: generatedAt,
    });
    const verified = verifyStagingControlPlaneEvidence({
      value: produced.envelope,
      verificationKey: value.producerKeys.publicKey,
      trustPolicy: stagingControlPlaneTrustPolicyV1({
        approvedKeyId: value.args.producerKeyId,
        approvedKeySha256: value.args.producerKeySha256,
      }),
      now: generatedAt,
    });
    expect(verified.derivedControls).toMatchObject({
      controlPlanePhase: "promotion",
      candidateEvidencePayloadHash: "8".repeat(64),
      productionRuntimeSnapshotHash: value.productionSnapshot.snapshotHash,
      productionConfigurationHash:
        value.productionSnapshot.configurationHash,
      productionSecretVersionsHash:
        value.productionSnapshot.configuration.secretVersionsHash,
    });
  });

  test("re-attests a fresh full post-Sites production snapshot for finalization", async () => {
    const value = await setup("finalization");
    expect(value.productionSnapshot).toMatchObject({
      scope: "full",
      sitesObservation: {
        candidateMatched: true,
        sourceRevision: revision,
        version: "2.4.0",
      },
    });
    const produced = await produceStagingControlPlaneEvidence({
      args: value.args,
      railway: railwayAdapter("finalization"),
      candidateEvidenceVerifier: strictFakeCandidateEvidenceVerifier,
      now: generatedAt,
    });
    const verified = verifyStagingControlPlaneEvidence({
      value: produced.envelope,
      verificationKey: value.producerKeys.publicKey,
      trustPolicy: stagingControlPlaneTrustPolicyV1({
        approvedKeyId: value.args.producerKeyId,
        approvedKeySha256: value.args.producerKeySha256,
      }),
      now: generatedAt,
    });
    expect(verified.derivedControls).toMatchObject({
      controlPlanePhase: "finalization",
      candidateEvidencePayloadHash: "8".repeat(64),
      productionRuntimeSnapshotHash: value.productionSnapshot.snapshotHash,
      productionConfigurationHash:
        value.productionSnapshot.configurationHash,
    });
  });

  test("fails closed before signing on Railway health or protected-key drift", async () => {
    const failedRailway = await setup();
    await expect(produceStagingControlPlaneEvidence({
      args: failedRailway.args,
      railway: railwayAdapter("candidate", stagingProjectId),
      now: generatedAt,
    })).rejects.toThrow(/not successful/u);
    const artifactDrift = await setup();
    await expect(produceStagingControlPlaneEvidence({
      args: artifactDrift.args,
      railway: railwayAdapter(
        "candidate",
        undefined,
        stagingProjectId,
      ),
      now: generatedAt,
    })).rejects.toThrow(/artifact does not match/u);
    const candidateAlreadyInProduction = await setup();
    await expect(produceStagingControlPlaneEvidence({
      args: candidateAlreadyInProduction.args,
      railway: railwayAdapter("promotion"),
      now: generatedAt,
    })).rejects.toThrow(/candidate reaches production/u);
    const secretVersionDrift = await setup();
    await expect(produceStagingControlPlaneEvidence({
      args: secretVersionDrift.args,
      railway: railwayAdapter(
        "candidate",
        undefined,
        undefined,
        stagingProjectId,
      ),
      now: generatedAt,
    })).rejects.toThrow(/secret-version identity/u);
    const forgedSnapshot = await setup();
    const forged = JSON.parse(
      await readFile(forgedSnapshot.paths.stagingSnapshot, "utf8"),
    );
    forged.configuration.apiHash = "c".repeat(64);
    forged.configurationHash = releaseEvidenceConfigurationHash({
      configuration: forged.configuration,
    });
    const forgedUnsigned = { ...forged };
    delete forgedUnsigned.snapshotHash;
    forged.snapshotHash = signedArtifactSha256(forgedUnsigned);
    await writeFile(
      forgedSnapshot.paths.stagingSnapshot,
      JSON.stringify(forged),
    );
    await expect(produceStagingControlPlaneEvidence({
      args: forgedSnapshot.args,
      railway: railwayAdapter(),
      now: generatedAt,
    })).rejects.toThrow(/exact candidate runtime snapshots/u);
    const productionArtifactDrift = await setup("promotion");
    await expect(produceStagingControlPlaneEvidence({
      args: productionArtifactDrift.args,
      railway: railwayAdapter(
        "promotion",
        undefined,
        productionProjectId,
      ),
      candidateEvidenceVerifier: strictFakeCandidateEvidenceVerifier,
      now: generatedAt,
    })).rejects.toThrow(/artifact does not match/u);
    const collapsedCandidateTrust = await setup("promotion");
    await writeFile(
      collapsedCandidateTrust.paths.candidateEvidencePublicKey,
      collapsedCandidateTrust.producerKeys.publicKey.export({
        format: "pem",
        type: "spki",
      }),
    );
    collapsedCandidateTrust.args.candidateEvidenceKeySha256 =
      collapsedCandidateTrust.args.producerKeySha256;
    await expect(produceStagingControlPlaneEvidence({
      args: collapsedCandidateTrust.args,
      railway: railwayAdapter("promotion"),
      candidateEvidenceVerifier: strictFakeCandidateEvidenceVerifier,
      now: generatedAt,
    })).rejects.toThrow(/independent signing keys/u);
    const wrongProducer = await setup();
    wrongProducer.args.producerKeySha256 = "9".repeat(64);
    await expect(produceStagingControlPlaneEvidence({
      args: wrongProducer.args,
      railway: railwayAdapter(),
      now: generatedAt,
    })).rejects.toThrow(/protected approved key/u);
  });
});
