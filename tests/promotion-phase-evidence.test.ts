import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  ACTIVATION_COHORT_INVENTORY_QUERY_HASH_V1,
  PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION,
  SIGNED_PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION,
  verifyPromotionPhaseEvidence,
} from "../shared/promotion-phase-evidence.ts";
import {
  REQUIRED_ACTIVATION_EXECUTION_CONTROLS,
} from "../shared/release-activation-contract.ts";
import {
  signedArtifactSha256,
  stableSignedArtifactJson,
} from "../shared/signed-artifact.ts";

const revision = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const candidateEvidenceHash = "c".repeat(64);
const databaseIdentityHash = "5".repeat(64);
const serviceConfigurationHashes = {
  apiHash: "1".repeat(64),
  interactiveWorkerHash: "2".repeat(64),
  deepWorkerHash: "3".repeat(64),
};
const configurationHash = signedArtifactSha256(serviceConfigurationHashes);
const keys = generateKeyPairSync("ed25519");

function phasePayload(
  phase: "bridge" | "expand",
  overrides: Record<string, unknown> = {},
) {
  const generatedAt = new Date().toISOString();
  const affectedCohorts = [{
    cohortKey: "catalog-first-global-pre-activation",
    route: "catalog_first_v2",
    intentGroup: null,
    disabled: true,
    reasonCode: "candidate_activation_preflight",
    changedAt: generatedAt,
  }];
  const rolloutFlags = {
    PIPELINE_V2_OWNER_CANARY: "false",
    PIPELINE_V2_CURATED_PERCENT: "100",
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
  };
  const payload = {
    schemaVersion: PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION,
    generatedAt,
    expiresAt: new Date(Date.parse(generatedAt) + 60 * 60_000).toISOString(),
    environment: "production",
    phase,
    candidate: {
      tag: "v2.4.0-rc.2",
      version: "2.4.0",
      sourceRevision: revision,
      imageDigest,
      candidateEvidenceHash,
    },
    runtime: {
      releaseEnvironment: "production",
      deploymentPhase: phase,
      databaseSchemaVersion: phase === "bridge" ? "19" : "20",
      databaseCapabilityVersion: "2",
      releaseManifestCanaryGuardsVersion: "1",
      canonicalExecutionHardeningVersion: "1",
      proofArchitectureVersion: phase === "bridge" ? null : "1",
      proofArchitectureAuthority: phase === "bridge" ? null : "shadow",
      workerProtocol: "playlist-pipeline-v12",
      configurationHash,
      apiConfigurationHash: serviceConfigurationHashes.apiHash,
      interactiveWorkerConfigurationHash:
        serviceConfigurationHashes.interactiveWorkerHash,
      deepWorkerConfigurationHash:
        serviceConfigurationHashes.deepWorkerHash,
    },
    convergence: {
      passed: true,
      sampleCount: 2,
      observationsHash: "4".repeat(64),
      freshWorkerHeartbeatsPerLane: 2,
      eligibleOldWorkerCount: 0,
    },
    activationPreflight: phase === "expand" ? {
      capturedAt: generatedAt,
      databaseIdentityHash,
      databaseSnapshotId: "pg-snapshot-20260723-1",
      cohortQueryHash: ACTIVATION_COHORT_INVENTORY_QUERY_HASH_V1,
      cohortInventoryHash: signedArtifactSha256(affectedCohorts),
      inventoryComplete: true,
      affectedCohorts,
      rolloutFlags,
      ownerCandidateRoute: {
        route: "corpus_first_v3",
        groups: ["genre_scene"],
        maximumTrackCount: 50,
      },
      activationConfiguration: {
        ...REQUIRED_ACTIVATION_EXECUTION_CONTROLS,
        ...rolloutFlags,
        PIPELINE_V3_OWNER_CANARY_GROUPS: "genre_scene",
        PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: "50",
      },
    } : null,
    ...overrides,
  };
  return payload;
}

function signedPhase(
  phase: "bridge" | "expand",
  overrides: Record<string, unknown> = {},
) {
  const payload = phasePayload(phase, overrides);
  const keyId = "release-test-2026";
  return {
    schemaVersion: SIGNED_PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION,
    payload,
    payloadHash: signedArtifactSha256(payload),
    signature: {
      algorithm: "Ed25519",
      keyId,
      value: sign(
        null,
        Buffer.from(stableSignedArtifactJson({
          algorithm: "Ed25519",
          keyId,
          payload,
        })),
        keys.privateKey,
      ).toString("base64url"),
    },
  };
}

function options(phase: "bridge" | "expand") {
  return {
    expectedPhase: phase,
    expectedTag: "v2.4.0-rc.2",
    expectedVersion: "2.4.0",
    expectedRevision: revision,
    expectedImageDigest: imageDigest,
    expectedCandidateEvidenceHash: candidateEvidenceHash,
    expectedConfigurationHash: configurationHash,
    expectedDatabaseSchemaVersion: phase === "bridge" ? "19" : "20",
    expectedDatabaseCapabilityVersion: "2",
    expectedReleaseManifestCanaryGuardsVersion: "1",
    expectedCanonicalExecutionHardeningVersion: "1",
    expectedProofArchitectureVersion: phase === "bridge" ? null : "1",
    expectedProofArchitectureAuthority: phase === "bridge" ? null : "shadow",
    expectedDatabaseIdentityHash:
      phase === "bridge" ? null : databaseIdentityHash,
  } as const;
}

describe("signed Railway promotion phase evidence", () => {
  test("binds bridge convergence to the exact candidate, image, config, runtime, and schema", () => {
    expect(
      verifyPromotionPhaseEvidence(
        signedPhase("bridge"),
        keys.publicKey,
        options("bridge"),
      ),
    ).toMatchObject({
      phase: "bridge",
      payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      configurationHash,
      databaseSchemaVersion: "19",
      databaseCapabilityVersion: "2",
      releaseManifestCanaryGuardsVersion: "1",
      canonicalExecutionHardeningVersion: "1",
      proofArchitectureVersion: null,
      proofArchitectureAuthority: null,
      activationRollout: null,
    });
    expect(() => verifyPromotionPhaseEvidence(
      signedPhase("bridge"),
      keys.publicKey,
      { ...options("bridge"), expectedConfigurationHash: "9".repeat(64) },
    )).toThrow(/configuration, schema, composite capability, and authoritative markers/u);
    expect(() => verifyPromotionPhaseEvidence(
      signedPhase("bridge"),
      keys.publicKey,
      { ...options("bridge"), expectedCandidateEvidenceHash: "9".repeat(64) },
    )).toThrow(/exact candidate/u);
    const base = phasePayload("bridge");
    expect(() => verifyPromotionPhaseEvidence(
      signedPhase("bridge", {
        runtime: {
          ...(base.runtime as Record<string, unknown>),
          configurationHash: "9".repeat(64),
        },
      }),
      keys.publicKey,
      options("bridge"),
    )).toThrow(/three deployed services/u);
  });

  test("derives fail-closed activation literals from a complete signed DB preflight", () => {
    const verified = verifyPromotionPhaseEvidence(
      signedPhase("expand"),
      keys.publicKey,
      options("expand"),
    );
    expect(verified.activationRollout).toMatchObject({
      ...REQUIRED_ACTIVATION_EXECUTION_CONTROLS,
      PIPELINE_V2_CURATED_PERCENT: "100",
      PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
      PIPELINE_V3_OWNER_CANARY: "true",
      PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
      PIPELINE_V3_OWNER_CANARY_GROUPS: "genre_scene",
      PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: "50",
      PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
      GUIDANCE_CONTRACT_V3_ENABLED: "false",
      GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
      GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
    });
    const base = phasePayload("expand");
    expect(() => verifyPromotionPhaseEvidence(
      signedPhase("expand", {
        activationPreflight: {
          ...(base.activationPreflight as Record<string, unknown>),
          activationConfiguration: {
            ...(base.activationPreflight as any).activationConfiguration,
            PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "4",
          },
        },
      }),
      keys.publicKey,
      options("expand"),
    )).toThrow(/PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION=6/u);
    expect(() => verifyPromotionPhaseEvidence(
      signedPhase("expand", {
        activationPreflight: {
          ...(base.activationPreflight as Record<string, unknown>),
          activationConfiguration: {
            ...(base.activationPreflight as any).activationConfiguration,
            RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "0",
          },
        },
      }),
      keys.publicKey,
      options("expand"),
    )).toThrow(/RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION=1/u);
  });

  test("rejects incomplete, enabled, non-zero, or owner-blocking activation state", () => {
    const base = phasePayload("expand");
    expect(() => verifyPromotionPhaseEvidence(
      signedPhase("expand", {
        activationPreflight: {
          ...(base.activationPreflight as Record<string, unknown>),
          inventoryComplete: false,
        },
      }),
      keys.publicKey,
      options("expand"),
    )).toThrow(/complete DB cohort inventory/u);

    expect(() => verifyPromotionPhaseEvidence(
      signedPhase("expand", {
        activationPreflight: {
          ...(base.activationPreflight as Record<string, unknown>),
          cohortQueryHash: "9".repeat(64),
        },
      }),
      keys.publicKey,
      options("expand"),
    )).toThrow(/complete cohort-inventory query/u);

    expect(() => verifyPromotionPhaseEvidence(
      signedPhase("expand"),
      keys.publicKey,
      {
        ...options("expand"),
        expectedDatabaseIdentityHash: "9".repeat(64),
      },
    )).toThrow(/selected production database/u);

    const enabledCohorts = [{
      ...((base.activationPreflight as any).affectedCohorts[0]),
      disabled: false,
    }];
    expect(() => verifyPromotionPhaseEvidence(
      signedPhase("expand", {
        activationPreflight: {
          ...(base.activationPreflight as Record<string, unknown>),
          affectedCohorts: enabledCohorts,
          cohortInventoryHash: signedArtifactSha256(enabledCohorts),
        },
      }),
      keys.publicKey,
      options("expand"),
    )).toThrow(/enabled affected DB cohort/u);

    expect(() => verifyPromotionPhaseEvidence(
      signedPhase("expand", {
        activationPreflight: {
          ...(base.activationPreflight as Record<string, unknown>),
          rolloutFlags: {
            ...(base.activationPreflight as any).rolloutFlags,
            PIPELINE_V3_GENRE_SCENE_PERCENT: "1",
          },
        },
      }),
      keys.publicKey,
      options("expand"),
    )).toThrow(/PIPELINE_V3_GENRE_SCENE_PERCENT=0/u);

    const blockedCohorts = [
      ...(base.activationPreflight as any).affectedCohorts,
      {
        cohortKey: "v3-global",
        route: "corpus_first_v3",
        intentGroup: null,
        disabled: true,
        reasonCode: "preflight",
        changedAt: base.generatedAt,
      },
    ];
    expect(() => verifyPromotionPhaseEvidence(
      signedPhase("expand", {
        activationPreflight: {
          ...(base.activationPreflight as Record<string, unknown>),
          affectedCohorts: blockedCohorts,
          cohortInventoryHash: signedArtifactSha256(blockedCohorts),
        },
      }),
      keys.publicKey,
      options("expand"),
    )).toThrow(/block the owner candidate route/u);
  });

  test("rejects tampering, stale evidence, and unknown fields", () => {
    const tampered = signedPhase("bridge");
    tampered.payload.candidate.candidateEvidenceHash = "9".repeat(64);
    expect(() => verifyPromotionPhaseEvidence(
      tampered,
      keys.publicKey,
      options("bridge"),
    )).toThrow(/payload hash/u);

    const generatedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const stale = signedPhase("bridge", {
      generatedAt,
      expiresAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    expect(() => verifyPromotionPhaseEvidence(
      stale,
      keys.publicKey,
      options("bridge"),
    )).toThrow(/expired/u);

    expect(() => verifyPromotionPhaseEvidence(
      signedPhase("bridge", { rawPrompt: "do not retain this" }),
      keys.publicKey,
      options("bridge"),
    )).toThrow(/unapproved fields/u);
  });
});
