import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  MAXIMUM_STAGING_MONTHLY_COST_USD,
  railwayPublicRolloutIntentCanaryInput,
  railwayPublicRolloutIntentCanaryTrustInput,
  railwayReleasePhaseConfiguration,
} from "../.railway/release-phase.ts";
import {
  releaseEvidenceConfigurationHash,
  releaseEvidenceRuntimeHash,
} from "../scripts/release-evidence.ts";
import {
  RELEASE_GATE_ARTIFACT_SCHEMA_V1,
  releaseFixtureBindingsForGate,
  type ReleaseGateName,
} from "../scripts/release-fixtures.ts";
import {
  ACTIVATION_COHORT_INVENTORY_QUERY_HASH_V1,
  PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION,
  SIGNED_PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION,
} from "../shared/promotion-phase-evidence.ts";
import {
  REQUIRED_ACTIVATION_EXECUTION_CONTROLS,
} from "../shared/release-activation-contract.ts";
import {
  signedArtifactSha256,
  stableSignedArtifactJson,
} from "../shared/signed-artifact.ts";
import { semanticBehaviorHashV1 } from "../shared/semantic-release-evidence.ts";
import {
  publicRolloutIntentCanaryKeyFingerprint,
} from "../shared/public-rollout-intent-canary.ts";
import {
  DATABASE_SCHEMA_SUPPORT,
  isDatabaseSchemaVersionCompatible,
} from "../db/index.ts";
import {
  canonicalContractActivationReady,
  runtimeReleaseDeploymentPhase,
} from "../server/release-deployment-phase.ts";

const releaseImage = `ghcr.io/example/genio@sha256:${"a".repeat(64)}`;
const releaseRevision = "b".repeat(40);
const releaseVersion = "2.4.0";
const releaseTag = "v2.4.0-rc.2";
const hash = (character: string) => character.repeat(64);
const productionDatabaseIdentityHash = hash("9");
let verifiedCandidateEvidenceHash = "";
let evidenceDirectory = "";
let evidencePath = "";
let bridgeEvidencePath = "";
let expandEvidencePath = "";
let intentCanaryPath = "";
let publicKeyPath = "";
let publicKeyHash = "";
let candidateConfigurationHash = "";
let candidateRuntimeHash = "";
let bridgeEvidenceHash = "";
let expandEvidenceHash = "";
const phaseServiceConfigurationHashes = (phase: "bridge" | "expand") => ({
  apiHash: hash(phase === "bridge" ? "a" : "d"),
  interactiveWorkerHash: hash(phase === "bridge" ? "b" : "e"),
  deepWorkerHash: hash(phase === "bridge" ? "c" : "f"),
});
const bridgeConfigurationHash = signedArtifactSha256(
  phaseServiceConfigurationHashes("bridge"),
);
const expandConfigurationHash = signedArtifactSha256(
  phaseServiceConfigurationHashes("expand"),
);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

beforeAll(() => {
  evidenceDirectory = mkdtempSync(join(tmpdir(), "genio-railway-evidence-"));
  evidencePath = join(evidenceDirectory, "candidate-evidence.json");
  bridgeEvidencePath = join(evidenceDirectory, "bridge-evidence.json");
  expandEvidencePath = join(evidenceDirectory, "expand-evidence.json");
  intentCanaryPath = join(evidenceDirectory, "intent-canary.json");
  publicKeyPath = join(evidenceDirectory, "release-key.pub.pem");
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "pem", type: "spki" });
  writeFileSync(publicKeyPath, publicKey, { mode: 0o600 });
  writeFileSync(intentCanaryPath, JSON.stringify({
    payloadHash: hash("e"),
  }), { mode: 0o600 });
  publicKeyHash = createHash("sha256").update(publicKey).digest("hex");
  const generatedAt = new Date().toISOString();
  const configuration = {
    apiHash: hash("1"),
    interactiveWorkerHash: hash("2"),
    deepWorkerHash: hash("3"),
    sitesHash: hash("4"),
    secretVersionsHash: hash("5"),
  };
  const runtime = {
    semanticExecutionConfigurationHash: hash("0"),
    releaseEnvironment: "staging",
    deploymentPhase: "activate",
    databaseSchemaVersion: "18",
    databaseCapabilityVersion: "2",
    releaseManifestCanaryGuardsVersion: "1",
    canonicalExecutionHardeningVersion: "1",
    workerProtocol: "playlist-pipeline-v10",
    briefContractVersion: "3",
    queryPlanSchemaVersion: "5",
    modelIds: {
      brief: "gpt-5.4-mini",
      baseline: "gpt-5.6-luna",
      escalation: "gpt-5.6-terra",
    },
    policyVersions: {
      guidance: "adaptive_guidance_v3",
      evidence: "governed_evidence_v2",
      queryPlan: "query_plan_v3_4",
      selection: "selection_plan_v3",
      semanticScope: "scope_gate_v2_1_2",
      musicConcept: "music_concepts_v3_2_0",
      pipeline: "corpus_first_v3",
      prompt: "grounded_recovery_v3_1_prompt_v1",
    },
  };
  candidateConfigurationHash = releaseEvidenceConfigurationHash({ configuration });
  candidateRuntimeHash = releaseEvidenceRuntimeHash({ runtime } as any);
  const gate = (name: ReleaseGateName, environment: "offline" | "staging") => ({
    name,
    environment,
    passed: true,
    completedAt: generatedAt,
    evidenceHash: hash("6"),
    artifactSchemaVersion: RELEASE_GATE_ARTIFACT_SCHEMA_V1,
    configurationHash: candidateConfigurationHash,
    runtimeHash: candidateRuntimeHash,
    fixtures: releaseFixtureBindingsForGate(name, {
      "smooth-reggaeton-heat-50-v1": hash("7"),
      "french-jazz-guided-constraint-25-v1": hash("8"),
    }),
    cacheMode: environment === "offline" ? "not_applicable" : "reuse_disabled",
    budgetStatus: environment === "staging" ? "within_cap" : "not_applicable",
  });
  const payload = {
    schemaVersion: "genio-release-evidence/v3",
    kind: "candidate",
    generatedAt,
    expiresAt: new Date(Date.parse(generatedAt) + 60 * 60_000).toISOString(),
    candidate: {
      tag: releaseTag,
      version: releaseVersion,
      sourceRevision: releaseRevision,
      imageDigest: `sha256:${"a".repeat(64)}`,
      sitesSourceRevision: releaseRevision,
    },
    lineage: {
      candidateEvidencePayloadHash: null,
      candidateEvidenceGeneratedAt: null,
      promotionEvidencePayloadHash: null,
      promotionEvidenceGeneratedAt: null,
      publicRolloutEvidencePayloadHash: null,
      publicRolloutCompletedAt: null,
      publicRolloutIntentGroup: null,
      publicRolloutFromPercent: null,
      publicRolloutToPercent: null,
      publicRolloutTargetConfigurationHash: null,
    },
    configuration,
    stagingControls: {
      controlPlanePhase: "candidate",
      candidateEvidencePayloadHash: null,
      candidateSourceRevision: releaseRevision,
      candidateImageDigest: `sha256:${"a".repeat(64)}`,
      candidateImageReference: releaseImage,
      monthlyCostLimitUsd: 10,
      budgetRemainingUsd: 6,
      reservedForRequiredGatesUsd: 4,
      budgetStatus: "available",
      musicKitOrigin: "https://staging-9enio.example",
      providerSecretVersionHash: hash("1"),
      productionProviderSecretVersionHash: hash("2"),
      appleSecretVersionHash: hash("3"),
      productionAppleSecretVersionHash: hash("4"),
      appleQaVerifierSecretVersionHash: hash("a"),
      productionAppleQaVerifierSecretVersionHash: hash("b"),
      appleQaVerifierCredentialIdentityHash: hash("c"),
      productionAppleQaVerifierCredentialIdentityHash: hash("d"),
      providerProjectIdentityHash: hash("e"),
      productionProviderProjectIdentityHash: hash("f"),
      stagingRuntimeSnapshotHash: hash("9"),
      productionRuntimeSnapshotHash: null,
      stagingConfigurationHash: candidateConfigurationHash,
      productionConfigurationHash: null,
      stagingSecretVersionsHash: configuration.secretVersionsHash,
      productionSecretVersionsHash: hash("6"),
      stagingRailwayServiceInventoryHash: hash("7"),
      productionRailwayServiceInventoryHash: hash("8"),
      appleReceiptPayloadHash: hash("9"),
      providerReceiptPayloadHash: hash("a"),
      qaBudgetReceiptPayloadHash: hash("b"),
      appleAccountSeparationEvidenceHash: hash("5"),
      musicKitOriginRegistrationEvidenceHash: hash("6"),
      controlPlaneEvidenceHash: hash("7"),
      controlPlaneKeyId: "staging-control-plane-test-v1",
      controlPlaneKeyFingerprint: hash("8"),
    },
    runtime,
    semanticReview: {
      schemaVersion: "genio-release-semantic-review/v1",
      gateEvidenceHash: hash("6"),
      reviewedAt: generatedAt,
      semanticBehaviorHash: semanticBehaviorHashV1(runtime),
      fixtures: [
        "fixed-three-track-control-v1",
        "smooth-reggaeton-heat-50-v1",
        "french-jazz-guided-constraint-25-v1",
      ].map((fixtureId, index) => ({
        fixtureId,
        orderedManifestHash: ["6", "7", "8"][index]!.repeat(64),
        outputHash: ["9", "a", "b"][index]!.repeat(64),
      })),
    },
    environmentSnapshots: {
      staging: {
        scope: "full",
        generatedAt,
        snapshotHash: hash("9"),
        sitesObservationHash: hash("8"),
        sitesVersion: releaseVersion,
        sitesSourceRevision: releaseRevision,
        sitesCandidateMatched: true,
        configurationHash: candidateConfigurationHash,
        secretVersionsHash: configuration.secretVersionsHash,
        runtimeHash: candidateRuntimeHash,
        providerCredentialVersionHash: hash("1"),
        appleCredentialVersionHash: hash("3"),
        appleQaVerifierCredentialVersionHash: hash("a"),
        publicRollout: {
          active: false,
          databaseAuthorized: true,
          evidenceHash: null,
          stage: null,
          targetConfigurationHash: null,
        },
      },
      production: null,
    },
    gates: [
      gate("offline_suite", "offline"),
      gate("staging_provider_manifest", "staging"),
      gate("staging_historical_replay", "staging"),
      gate("staging_fixed_three_track", "staging"),
      gate("staging_affected_regression", "staging"),
      gate("staging_guided_constraint", "staging"),
      gate("semantic_ranking_blinded_review", "staging"),
    ],
  };
  verifiedCandidateEvidenceHash = createHash("sha256")
    .update(stableJson(payload))
    .digest("hex");
  const keyId = "release-test-v1";
  const signature = sign(
    null,
    Buffer.from(stableJson({
      algorithm: "Ed25519",
      keyId,
      payload,
    })),
    keys.privateKey,
  ).toString("base64url");
  writeFileSync(evidencePath, JSON.stringify({
    schemaVersion: "genio-signed-release-evidence/v3",
    payload,
    payloadHash: verifiedCandidateEvidenceHash,
    signature: {
      algorithm: "Ed25519",
      keyId,
      value: signature,
    },
  }), { mode: 0o600 });

  const writePhaseEvidence = (phase: "bridge" | "expand", path: string) => {
    const phaseConfiguration = phaseServiceConfigurationHashes(phase);
    const affectedCohorts = [{
      cohortKey: "catalog-first-global-pre-activation",
      route: "catalog_first_v2",
      intentGroup: null,
      disabled: true,
      reasonCode: "candidate_activation_preflight",
      changedAt: generatedAt,
    }];
    const phasePayload = {
      schemaVersion: PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION,
      generatedAt,
      expiresAt: new Date(Date.parse(generatedAt) + 60 * 60_000).toISOString(),
      environment: "production",
      phase,
      candidate: {
        tag: releaseTag,
        version: releaseVersion,
        sourceRevision: releaseRevision,
        imageDigest: `sha256:${"a".repeat(64)}`,
        candidateEvidenceHash: verifiedCandidateEvidenceHash,
      },
      runtime: {
        releaseEnvironment: "production",
        deploymentPhase: phase,
        databaseSchemaVersion: phase === "bridge" ? "16" : "18",
        databaseCapabilityVersion: phase === "bridge" ? null : "2",
        releaseManifestCanaryGuardsVersion:
          phase === "bridge" ? null : "1",
        canonicalExecutionHardeningVersion:
          phase === "bridge" ? null : "1",
        workerProtocol: "playlist-pipeline-v10",
        configurationHash: phase === "bridge"
          ? bridgeConfigurationHash
          : expandConfigurationHash,
        apiConfigurationHash: phaseConfiguration.apiHash,
        interactiveWorkerConfigurationHash:
          phaseConfiguration.interactiveWorkerHash,
        deepWorkerConfigurationHash: phaseConfiguration.deepWorkerHash,
      },
      convergence: {
        passed: true,
        sampleCount: 2,
        observationsHash: hash("d"),
        freshWorkerHeartbeatsPerLane: 2,
        eligibleOldWorkerCount: 0,
      },
      activationPreflight: phase === "expand" ? {
        capturedAt: generatedAt,
        databaseIdentityHash: productionDatabaseIdentityHash,
        databaseSnapshotId: "pg-snapshot-test-1",
        cohortQueryHash: ACTIVATION_COHORT_INVENTORY_QUERY_HASH_V1,
        cohortInventoryHash: signedArtifactSha256(affectedCohorts),
        inventoryComplete: true,
        affectedCohorts,
        rolloutFlags: {
          PIPELINE_V2_OWNER_CANARY: "false",
          PIPELINE_V2_CURATED_PERCENT: "0",
          PIPELINE_V2_SIMILARITY_PERCENT: "0",
          PIPELINE_V2_FACTUAL_OWNER_CANARY: "false",
          PIPELINE_V2_FACTUAL_PERCENT: "0",
          PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
          PIPELINE_V3_OWNER_CANARY: "true",
          PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
          PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
          PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "0",
          PIPELINE_V3_SIMILARITY_PERCENT: "0",
          PIPELINE_V3_ARTIST_CATALOGUE_PERCENT: "0",
          PIPELINE_V3_FIXED_CONTAINER_PERCENT: "0",
          PIPELINE_V3_FACTUAL_PERCENT: "0",
          PIPELINE_V3_EXHAUSTIVE_PERCENT: "0",
          GUIDANCE_CONTRACT_V3_ENABLED: "false",
          GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
          GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
        },
        ownerCandidateRoute: {
          route: "corpus_first_v3",
          groups: ["genre_scene"],
          maximumTrackCount: 50,
        },
        activationConfiguration: {
          ...REQUIRED_ACTIVATION_EXECUTION_CONTROLS,
          PIPELINE_V2_OWNER_CANARY: "false",
          PIPELINE_V2_CURATED_PERCENT: "0",
          PIPELINE_V2_SIMILARITY_PERCENT: "0",
          PIPELINE_V2_FACTUAL_OWNER_CANARY: "false",
          PIPELINE_V2_FACTUAL_PERCENT: "0",
          PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
          PIPELINE_V3_OWNER_CANARY: "true",
          PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
          PIPELINE_V3_OWNER_CANARY_GROUPS: "genre_scene",
          PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: "50",
          PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
          PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "0",
          PIPELINE_V3_SIMILARITY_PERCENT: "0",
          PIPELINE_V3_ARTIST_CATALOGUE_PERCENT: "0",
          PIPELINE_V3_FIXED_CONTAINER_PERCENT: "0",
          PIPELINE_V3_FACTUAL_PERCENT: "0",
          PIPELINE_V3_EXHAUSTIVE_PERCENT: "0",
          GUIDANCE_CONTRACT_V3_ENABLED: "false",
          GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
          GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
        },
      } : null,
    };
    const keyId = "release-test-v1";
    const phaseSignature = sign(
      null,
      Buffer.from(stableSignedArtifactJson({
        algorithm: "Ed25519",
        keyId,
        payload: phasePayload,
      })),
      keys.privateKey,
    ).toString("base64url");
    const envelope = {
      schemaVersion: SIGNED_PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION,
      payload: phasePayload,
      payloadHash: signedArtifactSha256(phasePayload),
      signature: {
        algorithm: "Ed25519",
        keyId,
        value: phaseSignature,
      },
    };
    writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
    if (phase === "bridge") bridgeEvidenceHash = envelope.payloadHash;
    else expandEvidenceHash = envelope.payloadHash;
  };
  writePhaseEvidence("bridge", bridgeEvidencePath);
  writePhaseEvidence("expand", expandEvidencePath);
});

afterAll(() => {
  rmSync(evidenceDirectory, { recursive: true, force: true });
});

function baseEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GENIO_RELEASE_IMAGE: releaseImage,
    GENIO_RELEASE_REVISION: releaseRevision,
    GENIO_RELEASE_VERSION: releaseVersion,
    GENIO_RELEASE_SECRET_VERSIONS_HASH: hash("5"),
    GENIO_RELEASE_RC_TAG: releaseTag,
    GENIO_RELEASE_ENVIRONMENT: "production",
    GENIO_RELEASE_PHASE: "bridge",
    GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "16",
    GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH: verifiedCandidateEvidenceHash,
    GENIO_VERIFIED_CANDIDATE_EVIDENCE_FILE: evidencePath,
    GENIO_CANDIDATE_CONFIGURATION_HASH: candidateConfigurationHash,
    GENIO_CANDIDATE_RUNTIME_HASH: candidateRuntimeHash,
    GENIO_RELEASE_VERIFICATION_KEY_FILE: publicKeyPath,
    GENIO_RELEASE_VERIFICATION_KEY_SHA256: publicKeyHash,
    GENIO_BRIDGE_CONVERGENCE_EVIDENCE_FILE: bridgeEvidencePath,
    GENIO_BRIDGE_DATABASE_SCHEMA_VERSION: "16",
    GENIO_BRIDGE_DATABASE_CAPABILITY_VERSION: "none",
    GENIO_BRIDGE_MANIFEST_CANARY_GUARDS_VERSION: "none",
    GENIO_BRIDGE_CANONICAL_EXECUTION_HARDENING_VERSION: "none",
    GENIO_BRIDGE_CONFIGURATION_HASH: bridgeConfigurationHash,
    GENIO_EXPAND_CONVERGENCE_EVIDENCE_FILE: expandEvidencePath,
    GENIO_EXPAND_CONFIGURATION_HASH: expandConfigurationHash,
    GENIO_PRODUCTION_DATABASE_IDENTITY_HASH:
      productionDatabaseIdentityHash,
    ...overrides,
  };
}

function stagingEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return baseEnvironment({
    GENIO_RELEASE_ENVIRONMENT: "staging",
    GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH: undefined,
    GENIO_CANDIDATE_CONFIGURATION_HASH: undefined,
    GENIO_CANDIDATE_RUNTIME_HASH: undefined,
    GENIO_BRIDGE_CONVERGENCE_EVIDENCE_FILE: undefined,
    GENIO_EXPAND_CONVERGENCE_EVIDENCE_FILE: undefined,
    GENIO_STAGING_MONTHLY_COST_LIMIT_USD: "7.5",
    GENIO_STAGING_MUSICKIT_ORIGIN: "https://staging-9enio.example",
    GENIO_STAGING_PROVIDER_SECRET_VERSION_HASH: hash("1"),
    GENIO_PRODUCTION_PROVIDER_SECRET_VERSION_HASH: hash("2"),
    GENIO_STAGING_APPLE_SECRET_VERSION_HASH: hash("3"),
    GENIO_PRODUCTION_APPLE_SECRET_VERSION_HASH: hash("4"),
    GENIO_STAGING_APPLE_ACCOUNT_SEPARATION_EVIDENCE_HASH: hash("5"),
    GENIO_STAGING_MUSICKIT_ORIGIN_REGISTRATION_EVIDENCE_HASH: hash("6"),
    ...overrides,
  });
}

type RailwayService = {
  type: string;
  name: string;
  source?: { image?: string; autoUpdates?: { type?: string } };
  deploy?: { preDeployCommand?: string[] };
  variables?: Record<string, unknown>;
};

async function railwayProject(environment: NodeJS.ProcessEnv) {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) vi.stubEnv(name, value);
  }
  vi.resetModules();
  const definition = (await import("../.railway/railway.ts")).default as unknown as (
    context: Record<string, unknown>,
  ) => {
    environments: string[];
    resources: RailwayService[];
  };
  const selectedEnvironment = environment.GENIO_RELEASE_ENVIRONMENT!;
  return definition({
    environment: selectedEnvironment,
    environmentName: selectedEnvironment,
    isEnvironment: (name: string) => name === selectedEnvironment,
    randomString: () => "test",
    shared: {},
  });
}

function service(project: Awaited<ReturnType<typeof railwayProject>>, name: string): RailwayService {
  return project.resources.find((resource) => resource.type === "service" && resource.name === name)!;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Railway immutable bridge-expand-activate release", () => {
  test("requires and hash-pins an advance intent canary but forbids one for rollback", () => {
    expect(() => railwayPublicRolloutIntentCanaryInput(
      {},
      "advance",
    )).toThrow(/GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_FILE is required/u);
    const input = {
      GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_FILE: intentCanaryPath,
      GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_HASH: hash("e"),
    };
    expect(railwayPublicRolloutIntentCanaryInput(
      input,
      "advance",
    )).toMatchObject({ payloadHash: hash("e") });
    expect(() => railwayPublicRolloutIntentCanaryInput(
      {
        ...input,
        GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_HASH: hash("f"),
      },
      "advance",
    )).toThrow(/does not match its signed envelope/u);
    expect(() => railwayPublicRolloutIntentCanaryInput(
      input,
      "rollback_to_zero",
    )).toThrow(/without a fresh intent canary/u);
    expect(railwayPublicRolloutIntentCanaryInput(
      {},
      "rollback_to_zero",
    )).toBeNull();
  });

  test("requires a distinct protected intent-canary producer key for advance", () => {
    const canaryKeys = generateKeyPairSync("ed25519");
    const canaryKeyPath = join(evidenceDirectory, "intent-canary-key.pub.pem");
    writeFileSync(
      canaryKeyPath,
      canaryKeys.publicKey.export({ format: "pem", type: "spki" }),
      { mode: 0o600 },
    );
    const environment = baseEnvironment({
      GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_VERIFICATION_KEY_FILE:
        canaryKeyPath,
      GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_ID:
        "public-rollout-intent-canary-v1",
      GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_SHA256:
        publicRolloutIntentCanaryKeyFingerprint(canaryKeys.publicKey),
      GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256:
        hash("9"),
    });
    expect(railwayPublicRolloutIntentCanaryTrustInput(
      environment,
      "advance",
    )).toMatchObject({
      trust: {
        producerKeyId: "public-rollout-intent-canary-v1",
      },
    });
    expect(() => railwayPublicRolloutIntentCanaryTrustInput({
      ...environment,
      GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_SHA256: hash("0"),
    }, "advance")).toThrow(/does not match protected trust/u);
    expect(() => railwayPublicRolloutIntentCanaryTrustInput({
      ...environment,
      GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_VERIFICATION_KEY_FILE: publicKeyPath,
      GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_SHA256:
        publicRolloutIntentCanaryKeyFingerprint(readFileSync(publicKeyPath)),
    }, "advance")).toThrow(/independent from the release key/u);
    expect(railwayPublicRolloutIntentCanaryTrustInput(
      {},
      "rollback_to_zero",
    )).toBeNull();
  });

  test("fails the plan closed when the phase is missing or invalid", () => {
    expect(() => railwayReleasePhaseConfiguration(baseEnvironment({
      GENIO_RELEASE_PHASE: undefined,
    }))).toThrow(/GENIO_RELEASE_PHASE is required/u);
    expect(() => railwayReleasePhaseConfiguration(baseEnvironment({
      GENIO_RELEASE_PHASE: "migrate-and-hope",
    }))).toThrow(/bridge, expand, activate, or rollout/u);
  });

  test("requires verified candidate evidence for production but not staging", () => {
    expect(() => railwayReleasePhaseConfiguration(baseEnvironment({
      GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH: undefined,
    }))).toThrow(/GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH is required/u);
    expect(() => railwayReleasePhaseConfiguration(baseEnvironment({
      GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH: "verified-but-not-a-hash",
    }))).toThrow(/must be a SHA-256 digest/u);
    expect(() => railwayReleasePhaseConfiguration(baseEnvironment({
      GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH: hash("8"),
    }))).toThrow(/does not match the verified envelope/u);
    expect(() => railwayReleasePhaseConfiguration(baseEnvironment({
      GENIO_VERIFIED_CANDIDATE_EVIDENCE_FILE: "/missing/candidate-evidence.json",
    }))).toThrow(/could not be read/u);
    expect(() => railwayReleasePhaseConfiguration(baseEnvironment({
      GENIO_RELEASE_VERIFICATION_KEY_SHA256: hash("8"),
    }))).toThrow(/does not match its pinned digest/u);
    expect(() => railwayReleasePhaseConfiguration(baseEnvironment({
      GENIO_CANDIDATE_CONFIGURATION_HASH: hash("8"),
    }))).toThrow(/configuration does not match/u);
    expect(() => railwayReleasePhaseConfiguration(baseEnvironment({
      GENIO_CANDIDATE_RUNTIME_HASH: hash("8"),
    }))).toThrow(/runtime does not match/u);
    const incompletePath = join(evidenceDirectory, "incomplete-candidate.json");
    const incomplete = JSON.parse(readFileSync(evidencePath, "utf8"));
    incomplete.payload = {
      schemaVersion: "genio-release-evidence/v3",
      kind: "candidate",
      generatedAt: incomplete.payload.generatedAt,
      expiresAt: incomplete.payload.expiresAt,
      candidate: incomplete.payload.candidate,
    };
    writeFileSync(incompletePath, JSON.stringify(incomplete), { mode: 0o600 });
    expect(() => railwayReleasePhaseConfiguration(baseEnvironment({
      GENIO_VERIFIED_CANDIDATE_EVIDENCE_FILE: incompletePath,
    }))).toThrow(/missing or unapproved fields/u);
    expect(
      railwayReleasePhaseConfiguration(stagingEnvironment())
        .verifiedCandidateEvidenceHash,
    ).toBeNull();
  });

  test("deploys one immutable bridge artifact to API and both worker lanes with no migration", async () => {
    const project = await railwayProject(baseEnvironment());
    expect(project.environments).toEqual(["production"]);
    const services = project.resources.filter((resource) => resource.type === "service");
    expect(services.map(({ name }) => name).sort()).toEqual([
      "needle-api",
      "needle-deep-worker",
      "needle-worker",
    ]);
    for (const current of services) {
      expect(current.source).toMatchObject({
        image: releaseImage,
        autoUpdates: { type: "disabled" },
      });
      expect(current.variables).toMatchObject({
        APP_VERSION: { type: "literal", value: releaseVersion },
        SOURCE_COMMIT_SHA: { type: "literal", value: releaseRevision },
        RELEASE_ENVIRONMENT: { type: "literal", value: "production" },
        RELEASE_DEPLOYMENT_PHASE: { type: "literal", value: "bridge" },
        RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: { type: "literal", value: "16" },
        RELEASE_SECRET_VERSIONS_HASH: {
          type: "literal",
          value: hash("5"),
        },
        RELEASE_VERIFIED_CANDIDATE_EVIDENCE_HASH: {
          type: "literal",
          value: verifiedCandidateEvidenceHash,
        },
      });
    }
    expect(service(project, "needle-api").deploy?.preDeployCommand).toBeUndefined();
    expect(service(project, "needle-api").variables).toMatchObject({
      CAPABILITY_PEPPER: { type: "preserve" },
      CAPABILITY_PEPPER_VERSION: { type: "preserve" },
      CAPABILITY_PREVIOUS_PEPPER: { type: "preserve" },
      CAPABILITY_PREVIOUS_PEPPER_VERSION: { type: "preserve" },
      CAPABILITY_PREVIOUS_PEPPER_EXPIRES_AT: { type: "preserve" },
    });
    expect(service(project, "needle-worker").variables).not.toHaveProperty(
      "CAPABILITY_PREVIOUS_PEPPER",
    );
    for (const current of [service(project, "needle-api"), service(project, "needle-worker")]) {
      expect(current.variables!.PIPELINE_V3_ASSIGNMENT_ENABLED).toEqual({ type: "preserve" });
      expect(current.variables!.GUIDANCE_CONTRACT_V3_ENABLED).toEqual({ type: "preserve" });
      expect(current.variables!.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION).toEqual({ type: "preserve" });
    }
  });

  test("runs the expand-only migration only after bridge convergence evidence exists", async () => {
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "expand",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GENIO_BRIDGE_CONVERGENCE_EVIDENCE_FILE: undefined,
    }))).rejects.toThrow(/GENIO_BRIDGE_CONVERGENCE_EVIDENCE_FILE is required/u);

    const project = await railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "expand",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
    }));
    expect(service(project, "needle-api").deploy?.preDeployCommand).toEqual([
      "pnpm run db:migrate",
    ]);
    expect(service(project, "needle-api").variables).toMatchObject({
      RELEASE_DEPLOYMENT_PHASE: { type: "literal", value: "expand" },
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: { type: "literal", value: "18" },
      RELEASE_BRIDGE_CONVERGENCE_EVIDENCE_HASH: {
        type: "literal",
        value: bridgeEvidenceHash,
      },
    });
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "expand",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GENIO_BRIDGE_CONFIGURATION_HASH: hash("0"),
    }))).rejects.toThrow(
      /configuration, schema, composite capability, and authoritative markers/u,
    );
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "expand",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GENIO_BRIDGE_DATABASE_SCHEMA_VERSION: "15",
    }))).rejects.toThrow(
      /configuration, schema, composite capability, and authoritative markers/u,
    );
  });

  test("activation has no migration and requires both bridge and schema-18 evidence", async () => {
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "activate",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GENIO_EXPAND_CONVERGENCE_EVIDENCE_FILE: undefined,
    }))).rejects.toThrow(/GENIO_EXPAND_CONVERGENCE_EVIDENCE_FILE is required/u);

    const project = await railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "activate",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
    }));
    expect(service(project, "needle-api").deploy?.preDeployCommand).toBeUndefined();
    expect(service(project, "needle-api").variables).toMatchObject({
      RELEASE_DEPLOYMENT_PHASE: { type: "literal", value: "activate" },
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: { type: "literal", value: "18" },
      RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: {
        type: "literal",
        value: "2",
      },
      RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: {
        type: "literal",
        value: "1",
      },
      RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: {
        type: "literal",
        value: "1",
      },
      RELEASE_BRIDGE_CONVERGENCE_EVIDENCE_HASH: {
        type: "literal",
        value: bridgeEvidenceHash,
      },
      RELEASE_EXPAND_CONVERGENCE_EVIDENCE_HASH: {
        type: "literal",
        value: expandEvidenceHash,
      },
      PIPELINE_V2_CURATED_PERCENT: { type: "literal", value: "0" },
      PIPELINE_V2_SIMILARITY_PERCENT: { type: "literal", value: "0" },
      PIPELINE_V2_FACTUAL_PERCENT: { type: "literal", value: "0" },
      PIPELINE_V3_ASSIGNMENT_ENABLED: { type: "literal", value: "true" },
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: {
        type: "literal",
        value: "5",
      },
      PIPELINE_V3_OWNER_CANARY: { type: "literal", value: "true" },
      PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: {
        type: "literal",
        value: "true",
      },
      PIPELINE_V3_OWNER_CANARY_GROUPS: { type: "literal", value: "genre_scene" },
      PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: { type: "literal", value: "50" },
      PIPELINE_V3_GENRE_SCENE_PERCENT: { type: "literal", value: "0" },
      GUIDANCE_CONTRACT_V3_ENABLED: { type: "literal", value: "false" },
      GUIDANCE_CONTRACT_V3_OWNER_CANARY: { type: "literal", value: "true" },
    });
    expect(service(project, "needle-worker").variables).toMatchObject({
      PIPELINE_V2_CURATED_PERCENT: { type: "literal", value: "0" },
      PIPELINE_V2_SIMILARITY_PERCENT: { type: "literal", value: "0" },
      PIPELINE_V2_FACTUAL_PERCENT: { type: "literal", value: "0" },
      PIPELINE_V3_ASSIGNMENT_ENABLED: { type: "literal", value: "true" },
      RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: {
        type: "literal",
        value: "2",
      },
      RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: {
        type: "literal",
        value: "1",
      },
      RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: {
        type: "literal",
        value: "1",
      },
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: {
        type: "literal",
        value: "5",
      },
      PIPELINE_V3_OWNER_CANARY: { type: "literal", value: "true" },
      PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: {
        type: "literal",
        value: "true",
      },
      PIPELINE_V3_OWNER_CANARY_GROUPS: { type: "literal", value: "genre_scene" },
      PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: { type: "literal", value: "50" },
      PIPELINE_V3_GENRE_SCENE_PERCENT: { type: "literal", value: "0" },
      GUIDANCE_CONTRACT_V3_ENABLED: { type: "literal", value: "false" },
      GUIDANCE_CONTRACT_V3_OWNER_CANARY: { type: "literal", value: "true" },
    });
    expect(service(project, "needle-deep-worker").variables).toMatchObject({
      RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: {
        type: "literal",
        value: "2",
      },
      RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: {
        type: "literal",
        value: "1",
      },
      RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: {
        type: "literal",
        value: "1",
      },
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: {
        type: "literal",
        value: "5",
      },
    });
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "activate",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "17",
    }))).rejects.toThrow(/requires GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=18/u);
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "activate",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GENIO_EXPAND_CONFIGURATION_HASH: hash("0"),
    }))).rejects.toThrow(
      /configuration, schema, composite capability, and authoritative markers/u,
    );
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "activate",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GENIO_PRODUCTION_DATABASE_IDENTITY_HASH: hash("0"),
    }))).rejects.toThrow(/selected production database/u);
  });

  test("staging is capped and bound to separate provider, Apple, account, and MusicKit controls", async () => {
    const project = await railwayProject(stagingEnvironment());
    expect(project.environments).toEqual(["staging"]);
    const api = service(project, "needle-api");
    const worker = service(project, "needle-worker");
    expect(api.variables).toMatchObject({
      RELEASE_ENVIRONMENT: { type: "literal", value: "staging" },
      APP_ORIGIN: { type: "literal", value: "https://staging-9enio.example" },
      APP_MONTHLY_COST_LIMIT_USD: { type: "literal", value: "7.5" },
      QA_STAGING_CONTROL_HASH: {
        type: "literal",
        value: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    expect(worker.variables!.APP_MONTHLY_COST_LIMIT_USD).toEqual({
      type: "literal",
      value: "7.5",
    });
    expect(api.variables).not.toHaveProperty(
      "RELEASE_VERIFIED_CANDIDATE_EVIDENCE_HASH",
    );

    expect(() => railwayReleasePhaseConfiguration(stagingEnvironment({
      GENIO_STAGING_MONTHLY_COST_LIMIT_USD: String(MAXIMUM_STAGING_MONTHLY_COST_USD + 0.01),
    }))).toThrow(/no more than/u);
    expect(() => railwayReleasePhaseConfiguration(stagingEnvironment({
      GENIO_PRODUCTION_PROVIDER_SECRET_VERSION_HASH: hash("1"),
    }))).toThrow(/provider secret versions must be different/u);
    expect(() => railwayReleasePhaseConfiguration(stagingEnvironment({
      GENIO_PRODUCTION_APPLE_SECRET_VERSION_HASH: hash("3"),
    }))).toThrow(/Apple secret versions must be different/u);
    expect(() => railwayReleasePhaseConfiguration(stagingEnvironment({
      GENIO_STAGING_MUSICKIT_ORIGIN: "https://9enio.com",
    }))).toThrow(/dedicated non-production HTTPS origin/u);
  });

  test("rejects planning one environment with another environment's controls", async () => {
    vi.unstubAllEnvs();
    for (const [name, value] of Object.entries(baseEnvironment())) {
      if (value !== undefined) vi.stubEnv(name, value);
    }
    vi.resetModules();
    const definition = (await import("../.railway/railway.ts")).default as unknown as (
      context: Record<string, unknown>,
    ) => unknown;
    expect(() => definition({
      environment: "staging",
      environmentName: "staging",
      isEnvironment: () => false,
      randomString: () => "test",
      shared: {},
    })).toThrow(/does not match the selected Railway environment/u);
  });

  test("rollback after schema-18 writes means the same bridge artifact, never a schema-16 binary", async () => {
    expect(DATABASE_SCHEMA_SUPPORT).toEqual({
      minimum: "13",
      maximum: "18",
      preferred: "18",
    });
    expect(isDatabaseSchemaVersionCompatible("18", DATABASE_SCHEMA_SUPPORT)).toBe(true);
    const project = await railwayProject(baseEnvironment({
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
    }));
    expect(service(project, "needle-api").deploy?.preDeployCommand).toBeUndefined();
    expect(runtimeReleaseDeploymentPhase({
      RELEASE_DEPLOYMENT_PHASE: "bridge",
    })).toBe("bridge");
    expect(canonicalContractActivationReady({
      environment: {
        RELEASE_DEPLOYMENT_PHASE: "bridge",
        RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
        GUIDANCE_CONTRACT_V3_ENABLED: "true",
      },
      observedDatabaseSchemaVersion: "18",
      observedDatabaseCapabilityVersion: "1",
    })).toBe(false);
  });
});
