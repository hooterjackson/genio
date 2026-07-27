import {
  createHash,
  generateKeyPairSync,
} from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  controlPlaneReceiptKeyFingerprint,
} from "../shared/staging-control-plane-receipts.ts";
import { createStrictSignedEnvelope } from "../shared/signed-artifact.ts";
import {
  APPLE_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1,
  PROVIDER_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1,
  QA_BUDGET_LEDGER_AUTHORITY_SOURCE_SCHEMA_V1,
  SIGNED_APPLE_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1,
  SIGNED_PROVIDER_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1,
  SIGNED_QA_BUDGET_LEDGER_AUTHORITY_SOURCE_SCHEMA_V1,
  parseControlPlaneReceiptProducerArgs,
  produceControlPlaneReceipt,
  type ControlPlaneReceiptProducerArgs,
  type ControlPlaneReceiptProducerKind,
} from "../scripts/control-plane-receipt-producer.ts";
import {
  buildReleaseRuntimeSnapshot,
  REQUIRED_RELEASE_SECRET_VERSION_NAMES,
} from "../scripts/release-runtime-snapshot.ts";

const generatedAt = "2026-07-24T12:00:00.000Z";
const revision = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const imageReference = `ghcr.io/hooterjackson/genio@${imageDigest}`;
const stagingOrigin = "https://staging-9enio.example";
const semanticExecutionConfigurationHash =
  createHash("sha256").update("semantic-execution").digest("hex");

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function live(environment: "staging" | "production") {
  const build = {
    identifier: `2.4.0+${revision.slice(0, 12)}`,
    version: "2.4.0",
    revision,
  };
  const configurationHash = digest(`${environment}:api`);
  return {
    ok: true,
    build,
    api: {
      schemaVersion: "genio-api-runtime-identity/v1",
      replicaIdentityHash: digest(`${environment}:live-api-replica`),
      build,
      configurationHash,
      semanticExecutionConfigurationHash,
    },
    configurationHash,
    runtime: {
      semanticExecutionConfigurationHash,
      publicRolloutEvidenceHash: null,
      publicRolloutStage: null,
      ownerAllowlistVersion: "owner-allowlist-v1",
      releaseEnvironment: environment,
      deploymentPhase: "activate",
      workerProtocol: "playlist-pipeline-v10",
      briefContractVersion: "3",
      queryPlanSchemaVersion: "5",
      briefProviderModelId: "gpt-5.4-mini",
      baselineProviderModelId: "gpt-5.6-luna",
      escalationProviderModelId: "gpt-5.6-terra",
      guidancePolicyVersion: "adaptive_guidance_v3",
      evidencePolicyVersion: "governed_evidence_v2",
      queryPlanPolicyVersion: "query_plan_v3_4",
      selectionPlanVersion: "selection_plan_v3",
      semanticScopePolicyVersion: "scope_gate_v2_1_2",
      musicConceptPolicyVersion: "music_concepts_v3_2_0",
      pipelinePolicyVersion: "corpus_first_v3",
      promptVersion: "grounded_recovery_v3_1_prompt_v1",
    },
  };
}

function system(environment: "staging" | "production") {
  const lane = (name: string) => ({
    status: "healthy",
    protocolVersion: "playlist-pipeline-v10",
    compatibleCapacity: 1,
    eligibleWorkerCount: 1,
    eligibleIdentityCount: 1,
    candidateExecutorIdentityReady: true,
    eligibleRevisions: [revision],
    eligibleConfigurationHashes: [digest(`${environment}:${name}`)],
    eligibleSemanticExecutionConfigurationHashes: [
      semanticExecutionConfigurationHash,
    ],
  });
  return {
    ok: true,
    activationReady: true,
    database: "ready",
      schemaVersion: "18",
      releaseManifestCanaryGuardsVersion: "1",
      canonicalExecutionHardeningVersion: "1",
      canonicalExecutorReleaseIdentityFencingVersion: "1",
      executorFencing: {
        ready: true,
        incompleteJobs: 0,
        mismatchedActiveAttempts: 0,
        uncoveredJobs: 0,
        requirements: [],
      },
      api: {
        schemaVersion: "genio-api-runtime-identity/v1",
        replicaIdentityHash: digest(`${environment}:system-api-replica`),
        build: {
          identifier: `2.4.0+${revision.slice(0, 12)}`,
          version: "2.4.0",
          revision,
        },
        configurationHash: digest(`${environment}:api`),
        semanticExecutionConfigurationHash,
      },
      publicRollout: {
      active: false,
      databaseAuthorized: true,
      evidenceHash: null,
      stage: null,
      targetConfigurationHash: null,
    },
    paused: false,
    workerLanes: {
      interactive: lane("interactive"),
      deep: lane("deep"),
    },
  };
}

function secretVersions(environment: "staging" | "production") {
  return {
    schemaVersion: "genio-release-secret-versions/v2",
    environment,
    versions: Object.fromEntries(
      REQUIRED_RELEASE_SECRET_VERSION_NAMES.map((name) => [
        name,
        digest(`${environment}:${name}`),
      ]),
    ),
  };
}

function runtimeSnapshot(
  environment: "staging" | "production",
  phase: "candidate" | "promotion" | "finalization",
) {
  const finalSites = environment === "staging" || phase === "finalization";
  return buildReleaseRuntimeSnapshot({
    origin: environment === "staging" ? stagingOrigin : "https://9enio.com",
    environment,
    scope: finalSites ? "full" : "backend",
    expectedRevision: revision,
    expectedVersion: "2.4.0",
    sitesHtml: finalSites
      ? `<html data-build-version="2.4.0" data-build-revision="${revision}">`
      : `<html data-build-version="2.3.9" data-build-revision="${"c".repeat(40)}">`,
    sitesConfigurationHashes:
      Array(3).fill(digest(`${environment}:sites`)),
    sitesOwnerAllowlistVersions: Array(3).fill(
      finalSites ? "owner-allowlist-v1" : "owner-allowlist-v0",
    ),
    livePayload: live(environment),
    systemPayload: system(environment),
    systemHttpStatus: 200,
    secretVersions: secretVersions(environment),
    generatedAt,
  });
}

function authorityInput(
  kind: ControlPlaneReceiptProducerKind,
  phase: "candidate" | "promotion" | "finalization",
  staging: ReturnType<typeof runtimeSnapshot>,
  production: ReturnType<typeof runtimeSnapshot>,
) {
  const common = {
    issuer: `${kind}-source-authority-v1`,
    generatedAt,
    expiresAt: "2026-07-24T12:30:00.000Z",
    phase,
    candidate: {
      version: "2.4.0",
      sourceRevision: revision,
      imageDigest,
      imageReference,
    },
    runtimeSnapshots: {
      staging: staging.snapshotHash,
      production: phase === "candidate" ? null : production.snapshotHash,
    },
  };
  if (kind === "apple") {
    return {
      schemaVersion: APPLE_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1,
      ...common,
      authority: {
        stagingAppleQaVerifierCredentialIdentityHash: digest("staging-qa"),
        productionAppleQaVerifierCredentialIdentityHash: digest("production-qa"),
        stagingAppleAccountIdHash: digest("staging-apple-account"),
        productionAppleAccountIdHash: digest("production-apple-account"),
        productionAppleCredentialVersionHash:
          production.credentialVersionHashes.apple,
        productionAppleQaVerifierCredentialVersionHash:
          production.credentialVersionHashes.appleQaVerifier,
        musicKitOriginRegistered: true,
        musicKitOriginRegistrationEvidenceHash:
          digest("staging-musickit-registration"),
      },
    };
  }
  if (kind === "provider") {
    return {
      schemaVersion: PROVIDER_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1,
      ...common,
      authority: {
        stagingProviderProjectIdentityHash: digest("staging-provider-project"),
        productionProviderProjectIdentityHash:
          digest("production-provider-project"),
        productionProviderCredentialVersionHash:
          production.credentialVersionHashes.provider,
      },
    };
  }
  return {
    schemaVersion: QA_BUDGET_LEDGER_AUTHORITY_SOURCE_SCHEMA_V1,
    ...common,
    authority: {
      ledgerScope: "staging_release_qa",
      currency: "USD",
      monthlyCostLimitUsd: 10,
      spentUsd: 2,
      reservedForRequiredGatesUsd: 4,
      asOf: generatedAt,
    },
  };
}

async function setup(
  kind: ControlPlaneReceiptProducerKind,
  phase: "candidate" | "promotion" | "finalization",
) {
  const directory = await mkdtemp(join(tmpdir(), "genio-receipt-producer-"));
  const keys = {
    control: generateKeyPairSync("ed25519"),
    apple: generateKeyPairSync("ed25519"),
    provider: generateKeyPairSync("ed25519"),
    budget: generateKeyPairSync("ed25519"),
    appleSource: generateKeyPairSync("ed25519"),
    providerSource: generateKeyPairSync("ed25519"),
    budgetSource: generateKeyPairSync("ed25519"),
    candidate: generateKeyPairSync("ed25519"),
  };
  const keyForKind = kind === "apple"
    ? keys.apple
    : kind === "provider"
      ? keys.provider
      : keys.budget;
  const staging = runtimeSnapshot("staging", phase);
  const production = runtimeSnapshot("production", phase);
  const sourceKeys = kind === "apple"
    ? keys.appleSource
    : kind === "provider"
      ? keys.providerSource
      : keys.budgetSource;
  const sourcePayload = authorityInput(kind, phase, staging, production);
  const sourceEnvelopeSchema = kind === "apple"
    ? SIGNED_APPLE_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1
    : kind === "provider"
      ? SIGNED_PROVIDER_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1
      : SIGNED_QA_BUDGET_LEDGER_AUTHORITY_SOURCE_SCHEMA_V1;
  const sourceEnvelope = createStrictSignedEnvelope({
    envelopeSchemaVersion: sourceEnvelopeSchema,
    payload: sourcePayload,
    signingKey: sourceKeys.privateKey,
    keyId: `${kind}-source-authority-key-v1`,
  });
  const paths = {
    staging: join(directory, "staging.json"),
    production: join(directory, "production.json"),
    authoritySource: join(directory, "authority-source.json"),
    authoritySourceKey: join(directory, "authority-source-public.pem"),
    signingKey: join(directory, "signing-key.pem"),
    output: join(directory, "receipt.json"),
    verificationKey: join(directory, "receipt-public.pem"),
  };
  await Promise.all([
    writeFile(paths.staging, JSON.stringify(staging)),
    writeFile(paths.production, JSON.stringify(production)),
    writeFile(paths.authoritySource, JSON.stringify(sourceEnvelope)),
    writeFile(paths.authoritySourceKey, sourceKeys.publicKey.export({
      format: "pem",
      type: "spki",
    })),
    writeFile(paths.signingKey, keyForKind.privateKey.export({
      format: "pem",
      type: "pkcs8",
    })),
  ]);
  const fingerprints = {
    control: controlPlaneReceiptKeyFingerprint(keys.control.publicKey),
    apple: controlPlaneReceiptKeyFingerprint(keys.apple.publicKey),
    provider: controlPlaneReceiptKeyFingerprint(keys.provider.publicKey),
    budget: controlPlaneReceiptKeyFingerprint(keys.budget.publicKey),
    appleSource:
      controlPlaneReceiptKeyFingerprint(keys.appleSource.publicKey),
    providerSource:
      controlPlaneReceiptKeyFingerprint(keys.providerSource.publicKey),
    budgetSource:
      controlPlaneReceiptKeyFingerprint(keys.budgetSource.publicKey),
    candidate: controlPlaneReceiptKeyFingerprint(keys.candidate.publicKey),
  };
  const args: ControlPlaneReceiptProducerArgs = {
    kind,
    phase,
    candidateImageDigest: imageDigest,
    candidateImageReference: imageReference,
    stagingRuntimeSnapshotPath: paths.staging,
    productionRuntimeSnapshotPath:
      phase === "candidate" ? null : paths.production,
    authoritySourcePath: paths.authoritySource,
    authoritySourceVerificationKeyPath: paths.authoritySourceKey,
    signingKeyPath: paths.signingKey,
    outputPath: paths.output,
    verificationKeyOutputPath: paths.verificationKey,
    issuer: `${kind}-authority-v1`,
    keyId: `${kind}-authority-key-v1`,
    keySha256: fingerprints[
      kind === "qa-budget" ? "budget" : kind
    ],
    sourceIssuer: `${kind}-source-authority-v1`,
    sourceKeyId: `${kind}-source-authority-key-v1`,
    sourceKeySha256: kind === "apple"
      ? fingerprints.appleSource
      : kind === "provider"
        ? fingerprints.providerSource
        : fingerprints.budgetSource,
    stagingOrigin,
    protectedKeyFingerprints: [
      fingerprints.control,
      fingerprints.apple,
      fingerprints.provider,
      fingerprints.budget,
      fingerprints.appleSource,
      fingerprints.providerSource,
      fingerprints.budgetSource,
      ...(phase === "candidate" ? [] : [fingerprints.candidate]),
    ],
  };
  return {
    args,
    paths,
    fingerprints,
    sourceEnvelope,
    sourceKeys,
    staging,
    production,
  };
}

describe("authority-side control-plane receipt producer", () => {
  test.each([
    ["apple", "candidate"],
    ["provider", "candidate"],
    ["qa-budget", "candidate"],
    ["apple", "promotion"],
    ["provider", "promotion"],
    ["qa-budget", "promotion"],
    ["apple", "finalization"],
    ["provider", "finalization"],
    ["qa-budget", "finalization"],
  ] as const)("self-verifies %s evidence for %s", async (kind, phase) => {
    const value = await setup(kind, phase);
    const produced = await produceControlPlaneReceipt({
      args: value.args,
      now: generatedAt,
    });
    expect(produced.envelope.payload).toMatchObject({
      phase,
      candidate: {
        sourceRevision: revision,
        imageDigest,
        imageReference,
      },
    });
    expect(JSON.parse(await readFile(value.paths.output, "utf8")))
      .toEqual(produced.envelope);
    expect(await readFile(value.paths.verificationKey, "utf8"))
      .toContain("BEGIN PUBLIC KEY");
    if (phase === "finalization") {
      expect(value.production).toMatchObject({
        scope: "full",
        sitesObservation: { candidateMatched: true },
      });
    }
  });

  test("takes trust pins from the protected authority environment", async () => {
    const value = await setup("apple", "finalization");
    const environment: NodeJS.ProcessEnv = {
      RELEASE_CANDIDATE_IMAGE_REFERENCE: imageReference,
      RELEASE_STAGING_ORIGIN: stagingOrigin,
      RELEASE_STAGING_CONTROL_PLANE_KEY_SHA256:
        value.fingerprints.control,
      RELEASE_APPLE_CONTROL_PLANE_ISSUER: value.args.issuer,
      RELEASE_APPLE_CONTROL_PLANE_KEY_ID: value.args.keyId,
      RELEASE_APPLE_CONTROL_PLANE_KEY_SHA256: value.fingerprints.apple,
      RELEASE_PROVIDER_CONTROL_PLANE_KEY_SHA256:
        value.fingerprints.provider,
      RELEASE_QA_BUDGET_LEDGER_KEY_SHA256: value.fingerprints.budget,
      RELEASE_APPLE_CONTROL_PLANE_SOURCE_KEY_SHA256:
        value.fingerprints.appleSource,
      RELEASE_PROVIDER_CONTROL_PLANE_SOURCE_KEY_SHA256:
        value.fingerprints.providerSource,
      RELEASE_QA_BUDGET_LEDGER_SOURCE_KEY_SHA256:
        value.fingerprints.budgetSource,
      RELEASE_APPLE_CONTROL_PLANE_SOURCE_ISSUER:
        value.args.sourceIssuer,
      RELEASE_APPLE_CONTROL_PLANE_SOURCE_KEY_ID:
        value.args.sourceKeyId,
      RELEASE_CANDIDATE_EVIDENCE_KEY_SHA256:
        value.fingerprints.candidate,
    };
    expect(parseControlPlaneReceiptProducerArgs("apple", [
      "--phase", "finalization",
      "--candidate-image-digest", imageDigest,
      "--staging-runtime-snapshot", value.paths.staging,
      "--production-runtime-snapshot", value.paths.production,
      "--authority-source", value.paths.authoritySource,
      "--authority-source-verification-key",
      value.paths.authoritySourceKey,
      "--signing-key", value.paths.signingKey,
      "--output", value.paths.output,
      "--verification-key-output", value.paths.verificationKey,
    ], environment)).toMatchObject({
      kind: "apple",
      phase: "finalization",
      keySha256: value.fingerprints.apple,
    });
    environment.RELEASE_PROVIDER_CONTROL_PLANE_KEY_SHA256 =
      value.fingerprints.apple;
    expect(() => parseControlPlaneReceiptProducerArgs("apple", [
      "--phase", "finalization",
      "--candidate-image-digest", imageDigest,
      "--staging-runtime-snapshot", value.paths.staging,
      "--production-runtime-snapshot", value.paths.production,
      "--authority-source", value.paths.authoritySource,
      "--authority-source-verification-key",
      value.paths.authoritySourceKey,
      "--signing-key", value.paths.signingKey,
      "--output", value.paths.output,
      "--verification-key-output", value.paths.verificationKey,
    ], environment)).toThrow(/must be distinct/u);
  });

  test("unsigned operator JSON cannot mint a receipt", async () => {
    const value = await setup("provider", "promotion");
    const unsigned = value.sourceEnvelope.payload;
    await writeFile(value.paths.authoritySource, JSON.stringify(unsigned));
    await expect(produceControlPlaneReceipt({
      args: value.args,
      now: generatedAt,
    })).rejects.toThrow(/signed|envelope|unapproved fields/u);
  });

  test("rejects signed unapproved fields and output reuse", async () => {
    const value = await setup("provider", "promotion");
    const mutatedPayload = {
      ...value.sourceEnvelope.payload,
      authority: {
        ...(value.sourceEnvelope.payload.authority as Record<string, unknown>),
        rawSecret: "must-not-enter-receipt-producer",
      },
    };
    const mutated = createStrictSignedEnvelope({
      envelopeSchemaVersion:
        SIGNED_PROVIDER_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1,
      payload: mutatedPayload,
      signingKey: value.sourceKeys.privateKey,
      keyId: value.args.sourceKeyId,
    });
    await writeFile(value.paths.authoritySource, JSON.stringify(mutated));
    await expect(produceControlPlaneReceipt({
      args: value.args,
      now: generatedAt,
    })).rejects.toThrow(/unapproved fields/u);
    await writeFile(
      value.paths.authoritySource,
      JSON.stringify(value.sourceEnvelope),
    );
    await produceControlPlaneReceipt({
      args: value.args,
      now: generatedAt,
    });
    await expect(produceControlPlaneReceipt({
      args: value.args,
      now: generatedAt,
    })).rejects.toThrow(/already exists/u);
  });
});
