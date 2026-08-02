import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  assertRailwayBehaviorManifest,
  assertExistingReleaseServices,
  assertNativeSchema20Preflight,
  assertWorkerHeartbeatFence,
  buildNativeV254BehaviorManifest,
  candidateRuntimeHashes,
  legacyExecutionRouteDrainInventoryCommandArgs,
  nativeReleaseIdentityVariables,
  nativeV254RouteSwitchVariablesV1,
  parseLegacyExecutionRouteDrainInventoryResult,
  parseRailwayVariableInventory,
  parseSchema20EvidenceRecoveryResult,
  parseNativeSchema20ReleaseArgs,
  redactNativeSchema20PromotionCommandStderr,
  schema20EvidenceRecoveryCommandArgs,
  validateV254ContainmentReceipt,
  validateExactShaImageReceipt,
  verifyNativeCandidateEvidence,
} from "../scripts/promote-native-schema20-release.ts";
import {
  createNativeV254CandidateEvidence,
  nativeV254EvidenceHash,
} from "../scripts/native-v254-candidate-evidence.ts";
import {
  nativeSchema20FinalizationReceiptHash,
  parseNativeSchema20FinalizationArgs,
  validateNativeSchema20FinalizationReceiptV1,
  validateNativeSchema20PromotionReceipt,
} from "../scripts/finalize-native-schema20-release.ts";
import {
  createNativeSchema20StableReleasePlan,
  parseNativeSchema20StableReleaseArgs,
} from "../scripts/prepare-native-schema20-stable-release.ts";
import { releaseFixtureSha256 } from "../scripts/release-fixtures.ts";

const revision = "a".repeat(40);
const keyHash = "b".repeat(64);
const imageDigest = `sha256:${"c".repeat(64)}`;
const imageRepository = "ghcr.io/hooterjackson/genio";
const interactiveService = "11111111-1111-4111-8111-111111111111";
const deepService = "22222222-2222-4222-8222-222222222222";
const apiService = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const unsafeCliStderrSamples = [
  "railway_token_abcdefghijklmnopqrstuvwxyz0123456789",
  "postgresql://needle:p@ss.word/short@db.example.test:5432/needle",
  "Authorization: Bearer ab.cd+ef/gh==",
  "RAILWAY_TOKEN=rwy_short.value",
  '{"password":"tiny","token":"YWJjLmRlZg=="}',
  "unknown future credential syntax: secret·value",
];

function exactShaReceipt() {
  return {
    schemaVersion: "genio-exact-sha-image/v1",
    sourceRevision: revision,
    version: "2.5.4",
    imageReference: `${imageRepository}@${imageDigest}`,
    imageDigest,
    controllerRevision: "d".repeat(40),
    checksRunId: "12345",
    ciReceiptSha256: "e".repeat(64),
    releaseVerificationKeySha256: keyHash,
    publicRolloutIntentCanaryAuthorityPolicySha256: "f".repeat(64),
    runUrl: "https://github.com/hooterjackson/genio/actions/runs/12346",
    createdAt: "2026-08-02T00:00:00.000Z",
  };
}

function nativeFinalizationReceipt() {
  const unsigned = {
    schemaVersion: "genio-native-schema20-finalization/v2" as const,
    candidate: {
      tag: "v2.5.4-rc.1",
      version: "2.5.4",
      sourceRevision: revision,
      imageDigest,
      sitesSourceRevision: revision,
    },
    backendPromotionReceiptHash: "1".repeat(64),
    semanticBehaviorManifestHash: "2".repeat(64),
    semanticExecutionConfigurationHash: "3".repeat(64),
    containmentReceiptHash: "4".repeat(64),
    guidanceCheckpointMigrationReceiptHash: "b".repeat(64),
    legacyExecutionRouteDrainInventoryReceiptHash: "0".repeat(64),
    schema20EvidenceRecoveryReceiptHash: "5".repeat(64),
    directExposure: {
      authorityPayloadHash: "6".repeat(64),
      authorityArtifactHash: "7".repeat(64),
      rollbackWarrantPayloadHash: "8".repeat(64),
      rollbackWarrantArtifactHash: "9".repeat(64),
      preconditionsHash: "a".repeat(64),
      rollbackPlanHash: "b".repeat(64),
      targetConfigurationHash: "c".repeat(64),
      preExposureSemanticConfigurationHash: "2".repeat(64),
      postExposureSemanticConfigurationHash: "3".repeat(64),
      rollbackSemanticConfigurationHash: "2".repeat(64),
      preExposureRuntimeTupleHash: "d".repeat(64),
      postExposureRuntimeTupleHash: "e".repeat(64),
      rollbackRuntimeTupleHash: "f".repeat(64),
      databaseActivateReceiptHash: "1".repeat(64),
      runtimeTransitionReceiptHash: "2".repeat(64),
      ownerAppleGateEvidenceHash: "8".repeat(64),
      preExposureCleanGateEvidenceHash: "4".repeat(64),
      databaseRouteReceiptHash: "5".repeat(64),
      exposureClass: "fully_exposed_unproven" as const,
      organicReliabilityProven: false as const,
    },
    gateEvidenceHashes: {
      release_convergence: "6".repeat(64),
      final_custom_domain_browser: "7".repeat(64),
      production_fixed_three_track: "a".repeat(64),
      production_affected_regression: "8".repeat(64),
    },
    burnInReceiptHash: "9".repeat(64),
    burnInCompletedAt: "2026-08-03T00:00:00.000Z",
    sites: {
      projectId: "appgprj_6a5565cf7d6c8191ab9f2084e8eda856",
      versionId: "sites-version-v254",
      deploymentId: "sites-deployment-v254",
      archiveSha256: "a".repeat(64),
      controlPlaneEvidenceHash: "b".repeat(64),
    },
    completedAt: "2026-08-03T00:01:00.000Z",
  };
  return {
    ...unsigned,
    receiptHash: nativeSchema20FinalizationReceiptHash(unsigned),
  };
}

function nativePromotionReceipt() {
  const semantic = "6".repeat(64);
  const unsigned = {
    schemaVersion: "genio-native-schema20-promotion/v1" as const,
    sourceRevision: revision,
    version: "2.5.4",
    imageReference: `${imageRepository}@${imageDigest}`,
    imageDigest,
    candidateEvidenceHash: "1".repeat(64),
    exactShaImageReceiptHash: "2".repeat(64),
    semanticBehaviorManifestHash: "3".repeat(64),
    semanticExecutionConfigurationHash: semantic,
    containmentReceiptHash: "4".repeat(64),
    guidanceCheckpointMigrationReceiptHash: "b".repeat(64),
    legacyExecutionRouteDrainInventoryReceiptHash: "5".repeat(64),
    schema20EvidenceRecoveryReceiptHash: "7".repeat(64),
    projectId,
    environment: "production" as const,
    services: {
      interactive: {
        serviceId: interactiveService,
        deploymentId: "55555555-5555-4555-8555-555555555555",
      },
      deep: {
        serviceId: deepService,
        deploymentId: "66666666-6666-4666-8666-666666666666",
      },
      api: {
        serviceId: apiService,
        deploymentId: "77777777-7777-4777-8777-777777777777",
      },
    },
    rollbackServices: {
      interactive: {
        serviceId: interactiveService,
        deploymentId: "88888888-8888-4888-8888-888888888888",
        imageReference:
          `ghcr.io/hooterjackson/genio@sha256:${"8".repeat(64)}`,
        imageDigest: `sha256:${"8".repeat(64)}`,
      },
      deep: {
        serviceId: deepService,
        deploymentId: "99999999-9999-4999-8999-999999999999",
        imageReference:
          `ghcr.io/hooterjackson/genio@sha256:${"9".repeat(64)}`,
        imageDigest: `sha256:${"9".repeat(64)}`,
      },
      api: {
        serviceId: apiService,
        deploymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        imageReference:
          `ghcr.io/hooterjackson/genio@sha256:${"a".repeat(64)}`,
        imageDigest: `sha256:${"a".repeat(64)}`,
      },
    },
    promotedRuntimeConfigurationHashes: {
      api: "b".repeat(64),
      interactive: "c".repeat(64),
      deep: "d".repeat(64),
      semantic,
    },
    backendConvergenceEvidenceHash: "e".repeat(64),
    completedAt: "2026-08-02T00:02:00.000Z",
  };
  return {
    ...unsigned,
    receiptHash: releaseFixtureSha256(unsigned),
  };
}

function containmentMutationProof(
  applied: boolean,
  ownerReviewPromotionProof = {
    candidateCount: 0,
    candidateSetHash: "a".repeat(64),
    dispositionCount: 0,
    dispositionSetHash: "b".repeat(64),
    undispositionedCount: 0,
    unresolvedExecutableWorkCount: 0,
    unresolvedPublicationWorkCount: 0,
    promotionSafe: true,
  },
) {
  const counts = applied
    ? {
        jobsCancelled: 0,
        blockerResolved: 1,
        transitionInserted: 1,
        resolutionUpdated: 1,
        outboxInserted: 1,
        runUpdated: 1,
        auditInserted: 1,
        pausesCleared: 2,
      }
    : {
        jobsCancelled: 0,
        blockerResolved: 0,
        transitionInserted: 0,
        resolutionUpdated: 0,
        outboxInserted: 0,
        runUpdated: 0,
        auditInserted: 0,
        pausesCleared: 2,
      };
  const countsHash = releaseFixtureSha256(counts);
  return {
    affectedRunSetHash: "8".repeat(64),
    observedCountsHash: "9".repeat(64),
    ownerReviewCandidateCount: ownerReviewPromotionProof.candidateCount,
    ownerReviewCandidateSetHash: ownerReviewPromotionProof.candidateSetHash,
    ownerReviewDispositionCount: ownerReviewPromotionProof.dispositionCount,
    ownerReviewDispositionSetHash:
      ownerReviewPromotionProof.dispositionSetHash,
    ownerReviewUndispositionedCount:
      ownerReviewPromotionProof.undispositionedCount,
    ownerReviewUnresolvedExecutableWorkCount:
      ownerReviewPromotionProof.unresolvedExecutableWorkCount,
    ownerReviewUnresolvedPublicationWorkCount:
      ownerReviewPromotionProof.unresolvedPublicationWorkCount,
    ownerReviewPromotionSafe: ownerReviewPromotionProof.promotionSafe,
    ownerReviewPromotionProof,
    ownerReviewPromotionProofHash:
      releaseFixtureSha256(ownerReviewPromotionProof),
    expectedMutationCounts: counts,
    expectedMutationCountsHash: countsHash,
    actualMutationCounts: counts,
    actualMutationCountsHash: countsHash,
    mutationCounts: counts,
    mutationCountsHash: countsHash,
  };
}

function cliArgs(): string[] {
  return [
    "--exact-sha-image-receipt", "/tmp/exact.json",
    "--candidate-evidence", "/tmp/candidate.json",
    "--containment-receipt", "/tmp/containment.json",
    "--guidance-migration-receipt", "/tmp/guidance-migration.json",
    "--release-verification-key-sha256", keyHash,
    "--candidate-tag", "v2.5.4-rc.1",
    "--source-revision", revision,
    "--version", "2.5.4",
    "--secret-versions-hash", "1".repeat(64),
    "--expected-image-repository", imageRepository,
    "--origin", "https://9enio.com",
    "--prior-sites-revision", "2".repeat(40),
    "--prior-sites-version", "2.5.3",
    "--project-id", projectId,
    "--environment", "production",
    "--interactive-service", interactiveService,
    "--deep-service", deepService,
    "--api-service", apiService,
    "--output", "/tmp/promotion.json",
    "--deployment-timeout-seconds", "600",
    "--poll-interval-seconds", "10",
  ];
}

function systemHealth() {
  const apiConfiguration = "3".repeat(64);
  const interactiveConfiguration = "4".repeat(64);
  const deepConfiguration = "5".repeat(64);
  const semantic = "6".repeat(64);
  return {
    ok: true,
    activationReady: true,
    schemaVersion: "20",
    proofArchitectureVersion: "1",
    proofArchitectureAuthority: "native",
    workerProtocol: {
      actual: "playlist-pipeline-v12",
    },
    executorFencing: {
      ready: true,
      uncoveredJobs: 0,
      incompleteJobs: 0,
    },
    queue: {
      queued: 0,
      leased: 0,
    },
    publicRollout: {
      active: false,
      databaseAuthorized: true,
    },
    api: {
      build: {
        version: "2.5.4",
        revision,
      },
      configurationHash: apiConfiguration,
      semanticExecutionConfigurationHash: semantic,
    },
    workerLanes: {
      interactive: {
        status: "healthy",
        protocolVersion: "playlist-pipeline-v12",
        eligibleIdentityCount: 1,
        eligibleRevisions: [revision],
        eligibleConfigurationHashes: [interactiveConfiguration],
        eligibleSemanticExecutionConfigurationHashes: [semantic],
      },
      deep: {
        status: "healthy",
        protocolVersion: "playlist-pipeline-v12",
        eligibleIdentityCount: 1,
        eligibleRevisions: [revision],
        eligibleConfigurationHashes: [deepConfiguration],
        eligibleSemanticExecutionConfigurationHashes: [semantic],
      },
    },
  };
}

describe("native schema-20 point release", () => {
  test("promotion command errors never disclose provider stderr", () => {
    for (const secret of unsafeCliStderrSamples) {
      const redacted = redactNativeSchema20PromotionCommandStderr(
        `request failed for ${secret}: permission denied`,
      );
      expect(redacted).toBe("[redacted Railway stderr]");
      expect(redacted).not.toContain(secret);
      expect(redacted).not.toContain("permission denied");
    }
    expect(redactNativeSchema20PromotionCommandStderr(" \n\t"))
      .toBe("[no Railway stderr]");
  });

  test("accepts only an exact image receipt bound to the release and protected key", () => {
    expect(validateExactShaImageReceipt(exactShaReceipt(), {
      sourceRevision: revision,
      version: "2.5.4",
      imageRepository,
      releaseVerificationKeySha256: keyHash,
    })).toMatchObject({
      imageReference: `${imageRepository}@${imageDigest}`,
      imageDigest,
      sourceRevision: revision,
      version: "2.5.4",
    });

    expect(() => validateExactShaImageReceipt({
      ...exactShaReceipt(),
      sourceRevision: "9".repeat(40),
    }, {
      sourceRevision: revision,
      version: "2.5.4",
      imageRepository,
      releaseVerificationKeySha256: keyHash,
    })).toThrow(/does not bind the requested release/u);
    expect(() => validateExactShaImageReceipt({
      ...exactShaReceipt(),
      releaseVerificationKeySha256: "9".repeat(64),
    }, {
      sourceRevision: revision,
      version: "2.5.4",
      imageRepository,
      releaseVerificationKeySha256: keyHash,
    })).toThrow(/protected release key/u);
  });

  test("derives candidate authority from the exact-SHA workflow receipt", () => {
    const receipt = validateExactShaImageReceipt(exactShaReceipt(), {
      sourceRevision: revision,
      version: "2.5.4",
      imageRepository,
      releaseVerificationKeySha256: keyHash,
    });
    const evidence = createNativeV254CandidateEvidence({
      exactShaImageReceipt: receipt,
      candidateTag: "v2.5.4-rc.1",
      generatedAt: "2026-08-02T00:01:00.000Z",
    });
    expect(verifyNativeCandidateEvidence({
      value: evidence,
      exactShaReceipt: receipt,
      expectedTag: "v2.5.4-rc.1",
      expectedVersion: "2.5.4",
      expectedRevision: revision,
      expectedImageDigest: imageDigest,
    })).toMatchObject({
      payloadHash: evidence.payloadHash,
      payload: {
        requiredRuntime: {
          databaseSchemaVersion: "20",
          workerProtocol: "playlist-pipeline-v12",
          guidancePolicyVersion: "adaptive_guidance_v5",
        },
      },
    });
    expect(evidence.exactShaImageReceiptHash).toBe(
      nativeV254EvidenceHash(receipt),
    );
    expect(() => verifyNativeCandidateEvidence({
      value: { ...evidence, sourceRevision: "9".repeat(40) },
      exactShaReceipt: receipt,
      expectedTag: "v2.5.4-rc.1",
      expectedVersion: "2.5.4",
      expectedRevision: revision,
      expectedImageDigest: imageDigest,
    })).toThrow(/payload hash is invalid/u);
  });

  test("requires exact production selectors and three distinct existing service IDs", () => {
    const parsed = parseNativeSchema20ReleaseArgs(cliArgs());
    expect(parsed).toMatchObject({
      sourceRevision: revision,
      version: "2.5.4",
      environment: "production",
      services: {
        interactive: interactiveService,
        deep: deepService,
        api: apiService,
      },
    });
    expect(() => parseNativeSchema20ReleaseArgs(
      cliArgs().map((value) => (
        value === "https://9enio.com" ? "https://9enio.com/owner" : value
      )),
    )).toThrow(/exactly https:\/\/9enio.com/u);
    const duplicate = cliArgs();
    duplicate[duplicate.indexOf("--deep-service") + 1] = interactiveService;
    expect(() => parseNativeSchema20ReleaseArgs(duplicate)).toThrow(
      /three distinct existing IDs/u,
    );
  });

  test("stages only non-secret release identity and retains activated runtime semantics", () => {
    const variables = nativeReleaseIdentityVariables({
      version: "2.5.4",
      sourceRevision: revision,
      secretVersionsHash: "7".repeat(64),
      candidateEvidenceHash: "8".repeat(64),
    });
    expect(variables).toEqual([
      "APP_VERSION=2.5.4",
      `SOURCE_COMMIT_SHA=${revision}`,
      "RELEASE_ENVIRONMENT=production",
      "RELEASE_DEPLOYMENT_PHASE=activate",
      "RELEASE_EXECUTION_ENABLED=true",
      "RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION=20",
      `RELEASE_SECRET_VERSIONS_HASH=${"7".repeat(64)}`,
      `RELEASE_VERIFIED_CANDIDATE_EVIDENCE_HASH=${"8".repeat(64)}`,
    ]);
    expect(variables.join("\n")).not.toMatch(
      /TOKEN|PRIVATE|PASSWORD|HMAC_SECRET/u,
    );
  });

  test("builds one complete behavior manifest and rejects cross-lane drift", () => {
    const shared = {
      APPLE_STOREFRONT: "us",
      OPENAI_BRIEF_MODEL: "gpt-5.4-mini",
      PIPELINE_V3_BASELINE_MODEL_ID: "gpt-5.4",
      PIPELINE_V3_ESCALATION_MODEL_ID: "gpt-5.4",
      PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT: "2026-08-01T00:00:00.000Z",
    };
    const manifest = buildNativeV254BehaviorManifest([
      shared,
      { ...shared },
      { ...shared },
    ]);
    expect(manifest.schemaVersion).toBe("genio-v254-behavior-manifest/v1");
    expect(manifest.values).toMatchObject({
      GUIDANCE_V5_ENABLED: "true",
      GUIDANCE_CONTRACT_V3_OWNER_CANARY: "false",
      PIPELINE_V3_OWNER_CANARY: "true",
      PIPELINE_V3_OWNER_CANARY_GROUPS: "editorial_influence",
      PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT: "0",
      PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
      PIPELINE_V2_CURATED_PERCENT: "100",
    });
    expect(manifest.semanticExecutionConfigurationHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.manifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => assertRailwayBehaviorManifest({
      ...shared,
      ...nativeV254RouteSwitchVariablesV1(),
    }, manifest)).not.toThrow();
    expect(() => assertRailwayBehaviorManifest({
      ...shared,
      ...nativeV254RouteSwitchVariablesV1(),
      GUIDANCE_V5_ENABLED: "false",
    }, manifest)).toThrow(/GUIDANCE_V5_ENABLED/u);
    expect(() => buildNativeV254BehaviorManifest([
      shared,
      { ...shared, APPLE_STOREFRONT: "gb" },
      shared,
    ])).toThrow(/APPLE_STOREFRONT differs/u);
  });

  test("parses Railway variable inventories without weakening their values", () => {
    expect(parseRailwayVariableInventory(JSON.stringify({
      variables: {
        GUIDANCE_V5_ENABLED: "true",
        PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
      },
    }))).toEqual({
      GUIDANCE_V5_ENABLED: "true",
      PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
    });
    expect(() => parseRailwayVariableInventory(JSON.stringify({
      variables: { malformed: true },
    }))).toThrow(/malformed entry/u);
  });

  test("binds schema-20 recovery activation to the fenced worker identity", () => {
    const args = parseNativeSchema20ReleaseArgs(cliArgs());
    const semantic = "6".repeat(64);
    const dryRun = schema20EvidenceRecoveryCommandArgs({
      args,
      sourceRevision: revision,
      semanticExecutionConfigurationHash: semantic,
      mode: "dry-run",
    });
    expect(dryRun.join(" ")).toContain(
      `EXPECTED_RELEASE_REVISION=${revision}`,
    );
    expect(dryRun.join(" ")).toContain(
      `EXPECTED_SEMANTIC_CONFIGURATION_HASH=${semantic}`,
    );
    expect(dryRun).toContain("WORKER_STALE_SECONDS=90");
    expect(dryRun.at(-1)).toBe("dry-run");
    expect(parseSchema20EvidenceRecoveryResult(JSON.stringify({
      mode: "dry-run",
      safeToApply: true,
      receiptHash: "7".repeat(64),
    }), "dry-run")).toEqual({ receiptHash: "7".repeat(64) });
    expect(parseSchema20EvidenceRecoveryResult(JSON.stringify({
      mode: "apply",
      applied: true,
      ...containmentMutationProof(true),
      receiptHash: "7".repeat(64),
      constraint: "playlist_qualification_candidate_required_v1",
      constraintValidated: false,
      routeTrigger: "contract3_execution_route_receipt_required_v1",
      legacyUnboundImmutabilityTrigger:
        "legacy_unbound_qualification_immutable_v1",
    }), "apply")).toEqual({ receiptHash: "7".repeat(64) });
    expect(() => parseSchema20EvidenceRecoveryResult(JSON.stringify({
      mode: "apply",
      applied: true,
      receiptHash: "7".repeat(64),
      constraint: "wrong",
      constraintValidated: false,
    }), "apply")).toThrow(/did not prove activation/u);
    expect(() => parseSchema20EvidenceRecoveryResult(JSON.stringify({
      mode: "apply",
      applied: true,
      receiptHash: "7".repeat(64),
      constraint: "playlist_qualification_candidate_required_v1",
      constraintValidated: false,
      routeTrigger: "contract3_execution_route_receipt_required_v1",
      legacyUnboundImmutabilityTrigger: "wrong",
    }), "apply")).toThrow(/did not prove activation/u);
  });

  test("inventories the exact pre-cutover route drain before worker promotion", () => {
    const args = parseNativeSchema20ReleaseArgs(cliArgs());
    const semantic = "6".repeat(64);
    const cutoff = "2026-08-02T20:00:00.000Z";
    const command = legacyExecutionRouteDrainInventoryCommandArgs({
      args,
      sourceRevision: revision,
      semanticExecutionConfigurationHash: semantic,
      acceptedBefore: cutoff,
      inventoriedAt: cutoff,
      mode: "apply",
      receiptHash: "7".repeat(64),
    });
    expect(command.join(" ")).toContain(
      `EXPECTED_RELEASE_REVISION=${revision}`,
    );
    expect(command.join(" ")).toContain(
      `EXPECTED_SEMANTIC_CONFIGURATION_HASH=${semantic}`,
    );
    expect(command.join(" ")).toContain(
      `LEGACY_ROUTE_DRAIN_ACCEPTED_BEFORE=${cutoff}`,
    );
    expect(command.join(" ")).toContain(
      "scripts/inventory-legacy-execution-route-drain.ts apply",
    );
    expect(parseLegacyExecutionRouteDrainInventoryResult(JSON.stringify({
      mode: "dry-run",
      safeToApply: true,
      receiptHash: "7".repeat(64),
      runCount: 1,
      jobCount: 2,
    }), "dry-run")).toEqual({
      receiptHash: "7".repeat(64),
      jobCount: 2,
      drained: null,
    });
    expect(parseLegacyExecutionRouteDrainInventoryResult(JSON.stringify({
      mode: "status",
      receiptHash: "7".repeat(64),
      inventoryIntact: true,
      jobCount: 2,
      activeJobCount: 0,
      unreceiptedJobCount: 0,
      drained: true,
    }), "status")).toEqual({
      receiptHash: "7".repeat(64),
      jobCount: 2,
      drained: true,
    });
  });

  test("requires an applied or idempotently retained editorial containment receipt", () => {
    expect(validateV254ContainmentReceipt({
      mode: "contain-apply",
      applied: true,
      ...containmentMutationProof(true),
      receiptHash: "7".repeat(64),
      incidentReference: "v254-irish-influence-evidence-persistence",
      affectedRunCount: 2,
      hardSwitchRemainsEngaged: true,
      intentPublicPauseRemainsEngaged: true,
      safeRoutesResumed: true,
    })).toEqual({
      receiptHash: "7".repeat(64),
      affectedRunCount: 2,
    });
    expect(validateV254ContainmentReceipt({
      mode: "contain-apply",
      applied: false,
      ...containmentMutationProof(false),
      receiptHash: "7".repeat(64),
      incidentReference: "v254-irish-influence-evidence-persistence",
      affectedRunCount: 2,
      hardSwitchRemainsEngaged: true,
      intentPublicPauseRemainsEngaged: true,
      safeRoutesResumed: true,
    })).toEqual({
      receiptHash: "7".repeat(64),
      affectedRunCount: 2,
    });
    expect(() => validateV254ContainmentReceipt({
      mode: "contain-apply",
      applied: true,
      receiptHash: "7".repeat(64),
      incidentReference: "v254-irish-influence-evidence-persistence",
      affectedRunCount: 0,
      hardSwitchRemainsEngaged: true,
      intentPublicPauseRemainsEngaged: true,
      safeRoutesResumed: true,
    })).toThrow(/no affected runs/u);

    const safelyDispositioned = {
      candidateCount: 2,
      candidateSetHash: "a".repeat(64),
      dispositionCount: 2,
      dispositionSetHash: "b".repeat(64),
      undispositionedCount: 0,
      unresolvedExecutableWorkCount: 0,
      unresolvedPublicationWorkCount: 0,
      promotionSafe: true,
    };
    expect(() => validateV254ContainmentReceipt({
      mode: "contain-apply",
      applied: true,
      ...containmentMutationProof(true, safelyDispositioned),
      receiptHash: "7".repeat(64),
      incidentReference: "v254-irish-influence-evidence-persistence",
      affectedRunCount: 1,
      hardSwitchRemainsEngaged: true,
      intentPublicPauseRemainsEngaged: true,
      safeRoutesResumed: true,
    })).not.toThrow();

    const unresolvedInventory = {
      ...safelyDispositioned,
      dispositionCount: 1,
      undispositionedCount: 1,
      promotionSafe: false,
    };
    expect(() => validateV254ContainmentReceipt({
      mode: "contain-apply",
      applied: true,
      ...containmentMutationProof(true, unresolvedInventory),
      receiptHash: "7".repeat(64),
      incidentReference: "v254-irish-influence-evidence-persistence",
      affectedRunCount: 1,
      hardSwitchRemainsEngaged: true,
      intentPublicPauseRemainsEngaged: true,
      safeRoutesResumed: true,
    })).toThrow(/owner-review inventory is not safely dispositioned/u);
  });

  test("refuses unknown, stopped, or renamed Railway targets", () => {
    const expected = {
      interactive: interactiveService,
      deep: deepService,
      api: apiService,
    };
    const inventory = [
      {
        id: interactiveService,
        name: "needle-worker",
        deploymentId: "55555555-5555-4555-8555-555555555555",
        status: "SUCCESS",
        stopped: false,
      },
      {
        id: deepService,
        name: "needle-deep-worker",
        deploymentId: "66666666-6666-4666-8666-666666666666",
        status: "SUCCESS",
        stopped: false,
      },
      {
        id: apiService,
        name: "needle-api",
        deploymentId: "77777777-7777-4777-8777-777777777777",
        status: "SUCCESS",
        stopped: false,
      },
    ];
    expect(() => assertExistingReleaseServices(inventory, expected)).not.toThrow();
    expect(() => assertExistingReleaseServices([
      ...inventory.slice(0, 2),
      { ...inventory[2]!, name: "new-api" },
    ], expected)).toThrow(/expected running needle-api/u);
  });

  test("requires quiescent native schema-20 state and converged candidate identities", () => {
    const value = systemHealth();
    expect(() => assertNativeSchema20Preflight(value)).not.toThrow();
    expect(candidateRuntimeHashes(value, {
      sourceRevision: revision,
      version: "2.5.4",
    })).toEqual({
      api: "3".repeat(64),
      interactive: "4".repeat(64),
      deep: "5".repeat(64),
      semantic: "6".repeat(64),
    });
    expect(() => assertNativeSchema20Preflight({
      ...value,
      queue: { queued: 1, leased: 0 },
    })).toThrow(/not quiescent/u);
    expect(() => candidateRuntimeHashes({
      ...value,
      workerLanes: {
        ...value.workerLanes,
        deep: {
          ...value.workerLanes.deep,
          eligibleRevisions: ["9".repeat(40)],
        },
      },
    }, {
      sourceRevision: revision,
      version: "2.5.4",
    })).toThrow(/deep worker lane is not exclusively ready/u);
  });

  test("requires the same exclusive worker identities to advance before API activation", () => {
    const semantic = "6".repeat(64);
    const first = [
      {
        workerId: "interactive-worker-v254",
        queueClass: "interactive" as const,
        revision,
        protocolVersion: "playlist-pipeline-v12" as const,
        semanticExecutionConfigurationHash: semantic,
        lastSeenAt: "2026-08-02T00:00:00.000Z",
      },
      {
        workerId: "deep-worker-v254",
        queueClass: "deep" as const,
        revision,
        protocolVersion: "playlist-pipeline-v12" as const,
        semanticExecutionConfigurationHash: semantic,
        lastSeenAt: "2026-08-02T00:00:01.000Z",
      },
    ];
    const second = first.map((row) => ({
      ...row,
      lastSeenAt: "2026-08-02T00:00:31.000Z",
    }));
    expect(() => assertWorkerHeartbeatFence({
      first,
      second,
      sourceRevision: revision,
      semanticExecutionConfigurationHash: semantic,
    })).not.toThrow();
    expect(() => assertWorkerHeartbeatFence({
      first: [
        ...first,
        { ...first[0]!, workerId: "eligible-old-worker" },
      ],
      second,
      sourceRevision: revision,
      semanticExecutionConfigurationHash: semantic,
    })).toThrow(/interactive heartbeat fence did not advance exclusively/u);
    expect(() => assertWorkerHeartbeatFence({
      first,
      second: second.map((row) => (
        row.queueClass === "deep"
          ? { ...row, workerId: "replacement-deep-worker" }
          : row
      )),
      sourceRevision: revision,
      semanticExecutionConfigurationHash: semantic,
    })).toThrow(/deep heartbeat fence did not advance exclusively/u);
  });

  test("workflow never uploads source, creates services, or uses source rebuilds", async () => {
    const [workflow, promoter] = await Promise.all([
      readFile(
        new URL("../.github/workflows/native-schema20-release.yml", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../scripts/promote-native-schema20-release.ts", import.meta.url),
        "utf8",
      ),
    ]);
    expect(workflow).toContain("native schema20 point release");
    expect(workflow).toContain("release:v254:contain -- pause");
    expect(workflow).toContain(
      'DATABASE_URL="$DATABASE_PUBLIC_URL" PGSSLMODE=no-verify pnpm db:migrate',
    );
    expect(workflow).toContain(
      'test -n "${DATABASE_PUBLIC_URL:-}"',
    );
    expect(workflow.indexOf("PGSSLMODE=no-verify pnpm db:migrate"))
      .toBeLessThan(workflow.indexOf("release:v254:contain -- pause"));
    expect(workflow).toContain("release:v254:contain -- contain-dry-run");
    expect(workflow).toContain("release:v254:contain -- contain-apply");
    expect(workflow).toContain(
      "V254_IRISH_INFLUENCE_INCIDENT_BINDING_BASE64: ${{ secrets.V254_IRISH_INFLUENCE_INCIDENT_BINDING_BASE64 }}",
    );
    expect(workflow).toContain(
      'test -n "$V254_IRISH_INFLUENCE_INCIDENT_BINDING_BASE64"',
    );
    expect(workflow).toContain(
      ".expectedMutationCounts == .actualMutationCounts",
    );
    expect(workflow).toContain(
      ".actualMutationCounts == .mutationCounts",
    );
    expect(workflow).toContain(
      ".ownerReviewCandidateCount == 0",
    );
    expect(workflow).toContain(
      ".ownerReviewDispositionCount",
    );
    expect(workflow).toContain(
      ".ownerReviewUnresolvedExecutableWorkCount == 0",
    );
    expect(workflow).toContain(
      ".ownerReviewUnresolvedPublicationWorkCount == 0",
    );
    expect(workflow).toContain(
      ".ownerReviewPromotionProofHash",
    );
    expect(workflow).toContain('(has("receipt") | not)');
    expect(workflow).toContain('. == "run_id"');
    expect(workflow).toContain('. == "accessId"');
    expect(workflow).toContain('. == "executionAttemptId"');
    expect(workflow).toContain("--containment-receipt");
    expect(workflow).toContain("release:native:promote");
    expect(promoter).toContain("activate-schema20-evidence-recovery.ts");
    expect(promoter).toContain(
      "scripts/inventory-legacy-execution-route-drain.ts",
    );
    expect(promoter.lastIndexOf(
      "await inventoryLegacyExecutionRouteDrain({",
    )).toBeLessThan(promoter.indexOf(
      "const interactivePromotion",
    ));
    expect(promoter.indexOf("assertWorkerHeartbeatFence"))
      .toBeLessThan(promoter.indexOf("serviceId: args.services.api"));
    expect(promoter.indexOf("serviceId: args.services.api"))
      .toBeLessThan(promoter.lastIndexOf("phase: \"before_schema20_recovery\""));
    expect(promoter.lastIndexOf("phase: \"before_schema20_recovery\""))
      .toBeLessThan(promoter.indexOf("activateSchema20EvidenceRecovery({"));
    expect(promoter.indexOf("activateSchema20EvidenceRecovery({"))
      .toBeLessThan(promoter.lastIndexOf("phase: \"after_schema20_recovery\""));
    expect(workflow).toContain("exact-sha-image-${{ inputs.source_revision }}");
    expect(workflow).toContain("native-v254-candidate-evidence.json");
    expect(workflow).toContain("v254-containment-dry-run.json");
    expect(workflow).not.toContain("candidate_evidence_run_id");
    expect(workflow).not.toContain("RELEASE_VERIFICATION_PUBLIC_KEY_BASE64");
    expect(workflow).toContain("@railway/cli@4.65.0");
    expect(workflow).not.toContain("railway up");
    expect(workflow).not.toContain("--from-source");
    expect(workflow).not.toContain("railway service create");
    expect(workflow).not.toContain("docker build");
  });

  test("finalization requires Sites, browser, Apple, and completed burn-in gates", async () => {
    const parsed = parseNativeSchema20FinalizationArgs([
      "--candidate-tag", "v2.5.4-rc.1",
      "--source-revision", revision,
      "--version", "2.5.4",
      "--backend-promotion", "/tmp/backend.json",
      "--direct-exposure-authority", "/tmp/direct-authority.json",
      "--direct-exposure-rollback-warrant", "/tmp/direct-warrant.json",
      "--direct-exposure-database-activate-receipt", "/tmp/activate.json",
      "--direct-exposure-runtime-receipt", "/tmp/runtime.json",
      "--direct-exposure-verification-key", "/tmp/direct-public.pem",
      "--direct-exposure-key-id", "direct-exposure-v1",
      "--direct-exposure-key-sha256", "7".repeat(64),
      "--producer-verification-key", "/tmp/producer.pem",
      "--producer-key-id", "release-gate-v1",
      "--producer-key-sha256", "8".repeat(64),
      "--release-convergence-artifact", "/tmp/convergence.json",
      "--release-convergence-attestation", "/tmp/convergence-attestation.json",
      "--final-browser-artifact", "/tmp/browser.json",
      "--final-browser-attestation", "/tmp/browser-attestation.json",
      "--fixed-three-artifact", "/tmp/fixed-three.json",
      "--fixed-three-attestation", "/tmp/fixed-three-attestation.json",
      "--apple-artifact", "/tmp/apple.json",
      "--apple-attestation", "/tmp/apple-attestation.json",
      "--burn-in-receipt", "/tmp/burn-in.json",
      "--output", "/tmp/finalization.json",
    ]);
    expect(parsed.gates).toEqual({
      release_convergence: {
        artifactPath: "/tmp/convergence.json",
        attestationPath: "/tmp/convergence-attestation.json",
      },
      final_custom_domain_browser: {
        artifactPath: "/tmp/browser.json",
        attestationPath: "/tmp/browser-attestation.json",
      },
      production_fixed_three_track: {
        artifactPath: "/tmp/fixed-three.json",
        attestationPath: "/tmp/fixed-three-attestation.json",
      },
      production_affected_regression: {
        artifactPath: "/tmp/apple.json",
        attestationPath: "/tmp/apple-attestation.json",
      },
    });
    expect(parsed.burnInReceiptPath).toBe("/tmp/burn-in.json");
    expect(parsed.directExposureAuthorityPath).toBe(
      "/tmp/direct-authority.json",
    );
    expect(parsed.directExposureRuntimeReceiptPath).toBe("/tmp/runtime.json");
    expect(validateNativeSchema20PromotionReceipt(
      nativePromotionReceipt(),
      {
        sourceRevision: revision,
        version: "2.5.4",
      },
    )).toMatchObject({
      rollbackServices: {
        interactive: {
          deploymentId: "88888888-8888-4888-8888-888888888888",
        },
        deep: {
          deploymentId: "99999999-9999-4999-8999-999999999999",
        },
        api: {
          deploymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      },
      promotedRuntimeConfigurationHashes: {
        semantic: "6".repeat(64),
      },
    });
    expect(() => validateNativeSchema20PromotionReceipt({
      schemaVersion: "genio-native-schema20-promotion/v1",
      sourceRevision: revision,
      version: "2.5.4",
    }, {
      sourceRevision: revision,
      version: "2.5.4",
    })).toThrow(/unexpected fields/u);

    const finalizer = await readFile(
      new URL(
        "../.github/workflows/native-schema20-release-finalize.yml",
        import.meta.url,
      ),
      "utf8",
    );
    expect(finalizer).toContain("release-convergence.gate.json");
    expect(finalizer).toContain("final-custom-domain-browser.gate.json");
    expect(finalizer).toContain("production-affected-regression.gate.json");
    expect(finalizer).toContain("production-fixed-three-track.gate.json");
    expect(finalizer).toContain(
      "production-fixed-three-track.attestation.json",
    );
    expect(finalizer).toContain("v254-production-burn-in.json");
    expect(finalizer).toContain("v254-direct-exposure-authority.json");
    expect(finalizer).toContain(
      ".github/workflows/v254-editorial-direct-exposure.yml",
    );
    expect(finalizer).toContain(
      'test "$PROOF_ARTIFACT" = "v254-production-proof-$SOURCE_REVISION"',
    );
    expect(finalizer).toContain("direct-exposure-database-activate.json");
    expect(finalizer).toContain("direct-exposure-runtime-apply.json");
    expect(finalizer).toContain(".github/workflows/v254-production-burn-in.yml");
    expect(finalizer).toContain("release:native:finalize");
    expect(finalizer).toContain("release:native:prepare-stable");
    expect(finalizer).toContain("native-schema20-promotion-${{ inputs.source_revision }}");
    expect(finalizer).toContain("Create or verify the exact annotated stable tag");
    expect(finalizer).toContain(
      "a newer stable tag or GitHub Release already exists",
    );
    expect(finalizer).toContain('gh release create "$STABLE_TAG"');
    expect(finalizer).toContain("native-schema20-finalization.json");
    expect(finalizer).toContain("native-schema20-stable-release.json");
    expect(finalizer).toContain("release:check:native-stable");
    expect(finalizer).toContain("contents: write");
    expect(finalizer).not.toContain("create_site");
    expect(finalizer).not.toContain("railway up");
    expect(finalizer).not.toContain("git tag");
  });

  test("prepares one evidence-bound stable publication on the immutable RC SHA", () => {
    const receipt = validateNativeSchema20FinalizationReceiptV1(
      nativeFinalizationReceipt(),
      {
        candidateTag: "v2.5.4-rc.1",
        sourceRevision: revision,
        version: "2.5.4",
      },
    );
    expect(receipt.gateEvidenceHashes).toMatchObject({
      production_fixed_three_track: "a".repeat(64),
      production_affected_regression: "8".repeat(64),
    });
    const withoutFixedControl = nativeFinalizationReceipt();
    delete (
      withoutFixedControl.gateEvidenceHashes as Partial<
        typeof withoutFixedControl.gateEvidenceHashes
      >
    ).production_fixed_three_track;
    expect(() => validateNativeSchema20FinalizationReceiptV1(
      withoutFixedControl,
      {
        candidateTag: "v2.5.4-rc.1",
        sourceRevision: revision,
        version: "2.5.4",
      },
    )).toThrow(/gate evidence has unexpected fields/u);
    const plan = createNativeSchema20StableReleasePlan({
      finalizationReceipt: receipt,
      packageVersion: "2.5.4",
      currentRelease: {
        version: "2.5.4",
        status: "candidate",
        releasedAt: null,
      },
    });
    expect(plan).toMatchObject({
      schemaVersion: "genio-native-schema20-stable-release/v1",
      candidate: {
        rcTag: "v2.5.4-rc.1",
        stableTag: "v2.5.4",
        version: "2.5.4",
        sourceRevision: revision,
        imageDigest,
      },
      finalizationReceiptHash: receipt.receiptHash,
      burnInReceiptHash: receipt.burnInReceiptHash,
      sourceMetadataStatus: "candidate",
      releaseTitle: "v2.5.4",
    });
    expect(plan.releaseNotes).toContain(
      `Native-Finalization-SHA256: ${receipt.receiptHash}`,
    );
    expect(plan.releaseNotes).toContain(
      `Burn-In-Completed-At: ${receipt.burnInCompletedAt}`,
    );
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => createNativeSchema20StableReleasePlan({
      finalizationReceipt: receipt,
      packageVersion: "2.5.4",
      currentRelease: {
        version: "2.5.4",
        releasedAt: "2026-08-03",
      },
    })).toThrow(/immutable candidate metadata/u);
  });

  test("rejects a forged native finalization and unconfirmed stable preparation", () => {
    expect(() => validateNativeSchema20FinalizationReceiptV1({
      ...nativeFinalizationReceipt(),
      burnInReceiptHash: "f".repeat(64),
    }, {
      candidateTag: "v2.5.4-rc.1",
      sourceRevision: revision,
      version: "2.5.4",
    })).toThrow(/receipt hash is invalid/u);

    expect(() => parseNativeSchema20StableReleaseArgs([
      "--finalization-receipt", "/tmp/finalization.json",
      "--candidate-tag", "v2.5.4-rc.1",
      "--source-revision", revision,
      "--version", "2.5.4",
      "--output", "/tmp/stable.json",
      "--notes-output", "/tmp/notes.txt",
    ])).toThrow(/--confirm-native-stable-release/u);
    expect(parseNativeSchema20StableReleaseArgs([
      "--confirm-native-stable-release",
      "--finalization-receipt", "/tmp/finalization.json",
      "--candidate-tag", "v2.5.4-rc.1",
      "--source-revision", revision,
      "--version", "2.5.4",
      "--output", "/tmp/stable.json",
      "--notes-output", "/tmp/notes.txt",
    ])).toMatchObject({
      candidateTag: "v2.5.4-rc.1",
      sourceRevision: revision,
      version: "2.5.4",
    });
  });
});
