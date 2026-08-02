import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { signedArtifactSha256 } from "../shared/signed-artifact.ts";
import {
  V254_DIRECT_EXPOSURE_AUTHORITY_SCHEMA_VERSION,
  V254_DIRECT_EXPOSURE_ROLLBACK_WARRANT_SCHEMA_VERSION,
  createSignedV254DirectExposureAuthorityV1,
  createSignedV254DirectExposureRollbackWarrantV1,
  createV254DirectExposureRuntimeTransitionV1,
  createV254DirectExposureRollbackPlanV1,
  v254DirectExposurePreconditionsHashV1,
  verifyV254DirectExposureAuthorityAndWarrantV1,
  type V254DirectExposureAuthorityPayloadV1,
  type V254DirectExposureConfigurationV1,
  type V254DirectExposureRollbackWarrantPayloadV1,
} from "../shared/v254-direct-exposure-authority.ts";
import {
  parseV254DirectExposureAuthorityProducerArgsV1,
} from "../scripts/v254-direct-exposure-authority-producer.ts";

const keys = generateKeyPairSync("ed25519");
const wrongKeys = generateKeyPairSync("ed25519");
const revision = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;

function configuration(
  editorial: "0" | "100",
): V254DirectExposureConfigurationV1 {
  return {
    PIPELINE_V2_OWNER_CANARY: "false",
    PIPELINE_V2_CURATED_PERCENT: "100",
    PIPELINE_V2_SIMILARITY_PERCENT: "0",
    PIPELINE_V2_FACTUAL_OWNER_CANARY: "false",
    PIPELINE_V2_FACTUAL_PERCENT: "0",
    PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
    PIPELINE_V3_OWNER_CANARY: editorial === "0" ? "true" : "false",
    PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_OWNER_CANARY_GROUPS:
      editorial === "0" ? "editorial_influence" : "",
    PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: "50",
    PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT: editorial,
    PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
    PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "0",
    PIPELINE_V3_SIMILARITY_PERCENT: "0",
    PIPELINE_V3_ARTIST_CATALOGUE_PERCENT: "0",
    PIPELINE_V3_FIXED_CONTAINER_PERCENT: "0",
    PIPELINE_V3_FACTUAL_PERCENT: "0",
    PIPELINE_V3_EXHAUSTIVE_PERCENT: "0",
    PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED: "false",
    PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED: "false",
    RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
    RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
    RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
    RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION: "1",
    PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "native",
    PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
    GUIDANCE_CONTRACT_V3_ENABLED: "false",
    GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
    GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
  };
}

const candidate = {
  tag: "v2.5.4-rc.1",
  version: "2.5.4",
  sourceRevision: revision,
  imageReference: `ghcr.io/hooterjackson/genio@${imageDigest}`,
  imageDigest,
} as const;

function authorityPayload(): V254DirectExposureAuthorityPayloadV1 {
  const currentConfiguration = configuration("0");
  const targetConfiguration = configuration("100");
  const rollbackPlan = createV254DirectExposureRollbackPlanV1({
    candidate,
    targetConfiguration: currentConfiguration,
  });
  const preSemanticHash = "e".repeat(64);
  const postSemanticHash = "6".repeat(64);
  const service = (
    serviceId: string,
    serviceName: "needle-worker" | "needle-deep-worker" | "needle-api",
    deploymentId: string,
  ) => ({
    serviceId,
    serviceName,
    preExposureDeploymentId: deploymentId,
    targetImageReference: candidate.imageReference,
    targetImageDigest: candidate.imageDigest,
    targetSourceRevision: candidate.sourceRevision,
    preExposureSemanticConfigurationHash: preSemanticHash,
    postExposureSemanticConfigurationHash: postSemanticHash,
    rollbackDeploymentId: deploymentId,
    rollbackImageReference: candidate.imageReference,
    rollbackImageDigest: candidate.imageDigest,
    rollbackSourceRevision: candidate.sourceRevision,
    rollbackSemanticConfigurationHash: preSemanticHash,
  });
  const runtimeTransition = createV254DirectExposureRuntimeTransitionV1({
    candidate,
    preExposureSemanticConfigurationHash: preSemanticHash,
    postExposureSemanticConfigurationHash: postSemanticHash,
    services: {
      interactive: service(
        "11111111-1111-4111-8111-111111111111",
        "needle-worker",
        "44444444-4444-4444-8444-444444444444",
      ),
      deep: service(
        "22222222-2222-4222-8222-222222222222",
        "needle-deep-worker",
        "55555555-5555-4555-8555-555555555555",
      ),
      api: service(
        "33333333-3333-4333-8333-333333333333",
        "needle-api",
        "66666666-6666-4666-8666-666666666666",
      ),
    },
  });
  const payload: V254DirectExposureAuthorityPayloadV1 = {
    schemaVersion: V254_DIRECT_EXPOSURE_AUTHORITY_SCHEMA_VERSION,
    generatedAt: "2026-08-02T19:00:00.000Z",
    expiresAt: "2026-08-03T19:00:00.000Z",
    environment: "production",
    candidate,
    promotion: {
      signedNativePromotionAuthorityHash: "c".repeat(64),
      nativePromotionReceiptHash: "d".repeat(64),
      configurationHash: preSemanticHash,
      runtimeHash: "f".repeat(64),
      semanticBehaviorHash: "1".repeat(64),
      nativePromotionCompletedAt: "2026-08-02T17:00:00.000Z",
      sitesProjectId: "appgprj_6a5565cf7d6c8191ab9f2084e8eda856",
      sitesVersionId: "sites-version-v254",
      sitesDeploymentId: "sites-deployment-v254",
      sitesRevision: revision,
      sitesDeployedAt: "2026-08-02T17:30:00.000Z",
      railwayProjectId: "77777777-7777-4777-8777-777777777777",
      runtimeTransition,
    },
    transition: {
      operation: "direct_expose",
      route: "corpus_first_v3",
      intentGroup: "editorial_influence",
      fromPercent: "0",
      toPercent: "100",
      exposureClass: "fully_exposed_unproven",
      organicReliabilityProven: false,
      organicMetricsClaim: null,
      previousDirectExposureHash: null,
    },
    proofs: {
      ownerApple: {
        workflowPath: ".github/workflows/v254-owner-apple-gate.yml",
        gateEvidenceHash: "2".repeat(64),
        attestationPayloadHash: "3".repeat(64),
        manifestHash: "4".repeat(64),
        expectedOrderedAppleIdsHash: "5".repeat(64),
        observedOrderedAppleIdsHash: "5".repeat(64),
        trackCount: 25,
        completedAt: "2026-08-02T18:00:00.000Z",
      },
      cleanNonOwner: {
        workflowPath:
          ".github/workflows/v254-pre-exposure-clean-nonowner.yml",
        gateEvidenceHash: "6".repeat(64),
        attestationPayloadHash: "7".repeat(64),
        assignmentReceiptHash: "8".repeat(64),
        routeReceiptHash: "9".repeat(64),
        successorContractHash: "a".repeat(64),
        queryPlanHash: "b".repeat(64),
        workerConsumptionReceiptHash: "c".repeat(64),
        identityClass: "clean_non_owner",
        assignmentAuthority: "signed_release_canary",
        publicPercentageBypass: true,
        organicAssignment: false,
        manifestOnly: true,
        appleWriteAccess: "forbidden",
        completedAt: "2026-08-02T18:30:00.000Z",
      },
      databaseRouteAuthority: {
        receiptHash: "d".repeat(64),
        phase: "public_canary",
        hardSwitchDisabled: false,
        globalPublicPause: true,
        intentPublicPause: true,
        completedAt: "2026-08-02T18:15:00.000Z",
      },
    },
    currentConfiguration,
    currentConfigurationHash: signedArtifactSha256(currentConfiguration),
    targetConfiguration,
    targetConfigurationHash: signedArtifactSha256(targetConfiguration),
    preconditionsHash: "e".repeat(64),
    rollbackPlanHash: signedArtifactSha256(rollbackPlan),
  };
  return {
    ...payload,
    preconditionsHash: v254DirectExposurePreconditionsHashV1(payload),
  };
}

function signedPair(overrides?: {
  authority?: V254DirectExposureAuthorityPayloadV1;
  warrantMutator?: (
    value: V254DirectExposureRollbackWarrantPayloadV1,
  ) => V254DirectExposureRollbackWarrantPayloadV1;
}) {
  const payload = overrides?.authority ?? authorityPayload();
  const authority = createSignedV254DirectExposureAuthorityV1({
    payload,
    signingKey: keys.privateKey,
    keyId: "v254-direct-rollout-v1",
  });
  const rollback = createV254DirectExposureRollbackPlanV1({
    candidate: payload.candidate,
    targetConfiguration: payload.currentConfiguration,
  });
  let warrantPayload: V254DirectExposureRollbackWarrantPayloadV1 = {
    schemaVersion: V254_DIRECT_EXPOSURE_ROLLBACK_WARRANT_SCHEMA_VERSION,
    generatedAt: payload.generatedAt,
    environment: "production",
    candidate: payload.candidate,
    advance: {
      authorityPayloadHash: authority.payloadHash,
      targetConfigurationHash: payload.targetConfigurationHash,
      ownerAppleProofHash: signedArtifactSha256(payload.proofs.ownerApple),
      cleanNonOwnerProofHash: signedArtifactSha256(
        payload.proofs.cleanNonOwner,
      ),
      routeReceiptHash: payload.proofs.databaseRouteAuthority.receiptHash,
      rollbackPlanHash: payload.rollbackPlanHash,
      preExposureRuntimeTupleHash:
        payload.promotion.runtimeTransition.preExposureRuntimeTupleHash,
      postExposureRuntimeTupleHash:
        payload.promotion.runtimeTransition.postExposureRuntimeTupleHash,
      rollbackRuntimeTupleHash:
        payload.promotion.runtimeTransition.rollbackRuntimeTupleHash,
    },
    rollback,
    promotion: {
      signedNativePromotionAuthorityHash:
        payload.promotion.signedNativePromotionAuthorityHash,
      nativePromotionReceiptHash: payload.promotion.nativePromotionReceiptHash,
      runtimeHash: payload.promotion.runtimeHash,
      sitesRevision: payload.promotion.sitesRevision,
    },
  };
  warrantPayload = overrides?.warrantMutator?.(warrantPayload)
    ?? warrantPayload;
  const warrant = createSignedV254DirectExposureRollbackWarrantV1({
    payload: warrantPayload,
    signingKey: keys.privateKey,
    keyId: "v254-direct-rollout-v1",
  });
  return { authority, warrant, payload };
}

function expected(payload = authorityPayload()) {
  return {
    keyId: "v254-direct-rollout-v1",
    keySha256: createHash("sha256")
      .update(keys.publicKey.export({ format: "der", type: "spki" }))
      .digest("hex"),
    candidate: payload.candidate,
    signedNativePromotionAuthorityHash:
      payload.promotion.signedNativePromotionAuthorityHash,
    nativePromotionReceiptHash: payload.promotion.nativePromotionReceiptHash,
    configurationHash: payload.promotion.configurationHash,
    runtimeHash: payload.promotion.runtimeHash,
    semanticBehaviorHash: payload.promotion.semanticBehaviorHash,
    sites: {
      projectId: payload.promotion.sitesProjectId,
      versionId: payload.promotion.sitesVersionId,
      deploymentId: payload.promotion.sitesDeploymentId,
      revision: payload.promotion.sitesRevision,
    },
    runtimeTransition: payload.promotion.runtimeTransition,
    ownerAppleGateEvidenceHash: payload.proofs.ownerApple.gateEvidenceHash,
    cleanNonOwnerGateEvidenceHash:
      payload.proofs.cleanNonOwner.gateEvidenceHash,
    databaseRouteReceiptHash:
      payload.proofs.databaseRouteAuthority.receiptHash,
    currentConfiguration: payload.currentConfiguration,
    targetConfiguration: payload.targetConfiguration,
    now: "2026-08-02T19:05:00.000Z",
  };
}

describe("v2.5.4 direct exposure authority", () => {
  test("producer CLI binds every protected proof and output exactly once", () => {
    const args = [
      "--promotion-receipt", "/tmp/promotion.json",
      "--native-authority", "/tmp/native-authority.json",
      "--native-verification-key", "/tmp/native-public.pem",
      "--native-key-id", "native-schema20-v1",
      "--native-key-sha256", "1".repeat(64),
      "--sites-control-plane", "/tmp/sites.json",
      "--owner-gate", "/tmp/owner.json",
      "--owner-attestation", "/tmp/owner-attestation.json",
      "--clean-gate", "/tmp/clean.json",
      "--clean-attestation", "/tmp/clean-attestation.json",
      "--gate-verification-key", "/tmp/gate-public.pem",
      "--gate-key-id", "release-gate-v1",
      "--gate-key-sha256", "2".repeat(64),
      "--database-route-receipt", "/tmp/route.json",
      "--candidate-tag", "v2.5.4-rc.1",
      "--source-revision", revision,
      "--version", "2.5.4",
      "--image-digest", imageDigest,
      "--post-semantic-configuration-hash", "3".repeat(64),
      "--signing-key", "/tmp/rollout-private.pem",
      "--signing-key-id", "v254-direct-rollout-v1",
      "--signing-key-sha256", "4".repeat(64),
      "--authority-output", "/tmp/authority.json",
      "--rollback-warrant-output", "/tmp/warrant.json",
    ];
    expect(parseV254DirectExposureAuthorityProducerArgsV1(args)).toMatchObject({
      candidateTag: "v2.5.4-rc.1",
      sourceRevision: revision,
      version: "2.5.4",
      imageDigest,
      postSemanticConfigurationHash: "3".repeat(64),
    });
    expect(() => parseV254DirectExposureAuthorityProducerArgsV1([
      ...args,
      "--authority-output", "/tmp/other.json",
    ])).toThrow(/incomplete/u);
  });

  test("verifies the separate unproven 0 to 100 authority and durable warrant", () => {
    const pair = signedPair();
    const verified = verifyV254DirectExposureAuthorityAndWarrantV1({
      authority: pair.authority,
      rollbackWarrant: pair.warrant,
      verificationKey: keys.publicKey,
      expected: expected(pair.payload),
    });
    expect(verified).toMatchObject({
      exposureClass: "fully_exposed_unproven",
      organicReliabilityProven: false,
      routeReceiptHash: "d".repeat(64),
    });
    expect(verified.authorityPayloadHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(verified.rollbackWarrantPayloadHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("rejects fabricated organic evidence and non-zero unrelated intents", () => {
    const base = authorityPayload();
    expect(() => createSignedV254DirectExposureAuthorityV1({
      payload: {
        ...base,
        transition: {
          ...base.transition,
          organicReliabilityProven: true,
        } as unknown as typeof base.transition,
      },
      signingKey: keys.privateKey,
      keyId: "v254-direct-rollout-v1",
    })).toThrow(/must not claim organic rollout evidence/u);

    expect(() => createSignedV254DirectExposureAuthorityV1({
      payload: {
        ...base,
        targetConfiguration: {
          ...base.targetConfiguration,
          PIPELINE_V3_GENRE_SCENE_PERCENT: "1",
        },
      },
      signingKey: keys.privateKey,
      keyId: "v254-direct-rollout-v1",
    })).toThrow(/unrelated direct-exposure intent percentages/u);
  });

  test("rejects a clean non-owner proof that is organic or Apple-write capable", () => {
    const base = authorityPayload();
    expect(() => createSignedV254DirectExposureAuthorityV1({
      payload: {
        ...base,
        proofs: {
          ...base.proofs,
          cleanNonOwner: {
            ...base.proofs.cleanNonOwner,
            organicAssignment: true,
            appleWriteAccess: "allowed",
          } as unknown as typeof base.proofs.cleanNonOwner,
        },
      },
      signingKey: keys.privateKey,
      keyId: "v254-direct-rollout-v1",
    })).toThrow(/not zero-write/u);
  });

  test("rejects a mismatched warrant, wrong key, and expired authority", () => {
    const mismatched = signedPair({
      warrantMutator: (value) => ({
        ...value,
        advance: {
          ...value.advance,
          routeReceiptHash: "f".repeat(64),
        },
      }),
    });
    expect(() => verifyV254DirectExposureAuthorityAndWarrantV1({
      authority: mismatched.authority,
      rollbackWarrant: mismatched.warrant,
      verificationKey: keys.publicKey,
      expected: expected(mismatched.payload),
    })).toThrow(/warrant does not bind/u);

    const pair = signedPair();
    expect(() => verifyV254DirectExposureAuthorityAndWarrantV1({
      authority: pair.authority,
      rollbackWarrant: pair.warrant,
      verificationKey: wrongKeys.publicKey,
      expected: expected(pair.payload),
    })).toThrow(/protected rollout key/u);
    expect(() => verifyV254DirectExposureAuthorityAndWarrantV1({
      authority: pair.authority,
      rollbackWarrant: pair.warrant,
      verificationKey: keys.publicKey,
      expected: { ...expected(pair.payload), now: pair.payload.expiresAt },
    })).toThrow(/has expired/u);
  });
});
