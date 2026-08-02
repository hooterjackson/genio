import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  V254_BURN_IN_MAX_OBSERVATION_GAP_MS,
  V254_BURN_IN_REQUIRED_DURATION_MS,
  isValidV254RouteReceiptV1,
  isValidV254RunDecisionV1,
  isValidV254ScarcityProofV2,
  isValidV254WorkerConsumptionReceiptV5,
  runV254BurnInSegment,
  persistV254BurnInTripV1,
  redactV254ProductionBurnInCommandStderr,
  validateV254BurnInBindingV1,
  validateV254BurnInDatabaseSnapshotV1,
  validateV254ProductionBurnInReceiptV1,
  type V254BurnInDatabaseSnapshotV1,
  type V254BurnInRuntime,
  type V254ProductionBurnInReceiptV1,
} from "../scripts/v254-production-burn-in.ts";
import { releaseFixtureSha256 } from "../scripts/release-fixtures.ts";
import {
  createExecutionRouteReceiptV1,
  EXECUTION_ROUTE_RECEIPT_VERSION_V1,
} from "../server/execution-route-receipt-v1.ts";
import {
  auditSemanticCollapseV2,
} from "../server/semantic-collapse-audit-v2.ts";

const revision = "1".repeat(40);
const digest = (value: string) => value.repeat(64).slice(0, 64);
const imageDigest = `sha256:${digest("2")}`;
const semanticHash = digest("3");
const unsafeCliStderrSamples = [
  "railway_token_abcdefghijklmnopqrstuvwxyz0123456789",
  "postgresql://needle:p@ss.word/short@db.example.test:5432/needle",
  "Authorization: Bearer ab.cd+ef/gh==",
  "RAILWAY_TOKEN=rwy_short.value",
  '{"password":"tiny","token":"YWJjLmRlZg=="}',
  "unknown future credential syntax: secret·value",
];

function validRunDecision(
  coverageHash = digest("6"),
  auditHash = digest("7"),
) {
  const body = {
    schemaVersion: "genio-run-decision/v1",
    contractRevisionId: "contract:successor",
    contractSemanticHash: digest("4"),
    reason: "frontier_exhausted_under_policy",
    targetTrackCount: 25,
    verifiedTrackCount: 0,
    remainingStrategyCount: 0,
    consumedActiveComputeMs: 10_000,
    activeComputeLimitMs: 900_000,
    activeComputeExtensionsUsed: 0,
    namedPredicates: [{
      clauseId: "clause:historical-influence",
      label: "documented influence",
    }],
    interpretationSummary: {
      mustHave: ["Irish music"],
      prefer: ["documented influence"],
      avoid: [],
      flow: [],
      count: 25,
    },
    actions: {
      anotherBoundedPass: false,
      reviseNamedPredicate: true,
      reduceCount: false,
      publishVerifiedPartial: false,
      pause: true,
      resumeLater: false,
      cancel: true,
    },
    reachedAt: "2026-08-02T00:00:00.000Z",
  };
  return {
    ...body,
    decisionHash: releaseFixtureSha256(body),
    reasonCode: "frontier_exhausted_under_policy",
    coverageHash,
    auditHash,
    limitingObligationIds: ["historical_influence"],
    independentDependencyRootIds: ["independent-a", "independent-b"],
    advancingActions: [{
      kind: "review_named_constraint",
      clauseIds: ["clause:historical-influence"],
      options: ["keep_request", "broaden_named_constraint"],
    }],
  };
}

function validScarcityProof() {
  const coverageBody = {
    version: "semantic_collapse_coverage_v2",
    queryPlanHash: digest("1"),
    observationCount: 77,
    nullCandidateQualificationCount: 0,
    databaseFactsHash: digest("2"),
    telemetryDivergenceCodes: [],
    requestedTrackCount: 25,
    uniqueLeadCount: 77,
    materializedCandidateCount: 77,
    uniqueRecordingFamilyCount: 77,
    storefrontPlayableCount: 73,
    evidenceQualifiedCount: 0,
    obligations: [{
      obligationId: "historical_influence",
      required: true,
      pass: 0,
      fail: 77,
      unknown: 0,
      acquisitionAttemptCount: 2,
      capableProducerFamilies: ["editorial-a", "editorial-b"],
      attemptedProducerFamilies: ["editorial-a", "editorial-b"],
      attemptedProducerRoots: [{
        producerFamily: "editorial-a",
        dependencyRootId: "independent-a",
      }, {
        producerFamily: "editorial-b",
        dependencyRootId: "independent-b",
      }],
      malformedEvidenceCount: 0,
      wrongAxisEvidenceCount: 0,
    }],
    producers: [{
      producerFamily: "editorial-a",
      dependencyRootId: "independent-a",
      health: "healthy" as const,
      retryAfterAt: null,
    }, {
      producerFamily: "editorial-b",
      dependencyRootId: "independent-b",
      health: "healthy" as const,
      retryAfterAt: null,
    }],
    unresolvedUserSemanticClauseIds: [],
    frontierExhausted: true,
    localBudgetExhausted: false,
    capturedAt: "2026-08-02T00:00:00.000Z",
  };
  const coverage = {
    ...coverageBody,
    coverageHash: releaseFixtureSha256(coverageBody),
  };
  const computedAudit = auditSemanticCollapseV2(coverage);
  const audit = {
    ...computedAudit,
    coverageHash: coverage.coverageHash,
    queryPlanHash: coverage.queryPlanHash,
    queryPlanRevisionId: "query-plan:successor",
    recordedAt: "2026-08-02T00:00:01.000Z",
  };
  return {
    coverage,
    audit,
    decision: validRunDecision(
      coverage.coverageHash,
      computedAudit.auditHash,
    ),
  };
}

function validWorkerConsumption() {
  const deterministic = {
    schemaVersion: "genio-guidance-v5-worker-consumption/v1",
    kind: "worker_consumption",
    status: "consumed",
    authorityHash: digest("1"),
    questionSetHash: digest("2"),
    questionHash: digest("3"),
    selectedOptionId: "balanced_influence",
    axis: "influence_scope",
    beforeQueryPlanHash: digest("4"),
    afterQueryPlanHash: digest("5"),
    queryPlanHash: digest("5"),
    queryPlanRevisionId: "query-plan:successor",
    contractRevisionId: "contract:successor",
    contractSemanticHash: digest("6"),
    capabilitySnapshotHash: digest("7"),
    semanticConfigurationHash: semanticHash,
    executionField: "rankingObjectives",
    effectHash: digest("8"),
    consumerId: "selection-plan-v3:ranking-objectives",
    beforeConsumerResultHash: digest("9"),
    afterConsumerResultHash: digest("a"),
    resultEffectHash: digest("b"),
    workerProjectionHash: digest("c"),
  };
  return {
    ...deterministic,
    receiptHash: releaseFixtureSha256(deterministic),
    consumedAt: "2026-08-02T00:00:00.000Z",
    jobId: "job:successor",
    workerId: "worker:interactive",
    leaseEpoch: 1,
  };
}

function binding() {
  const unsigned = {
    schemaVersion: "genio-v254-production-burn-in-binding/v2" as const,
    candidate: {
      tag: "v2.5.4-rc.1",
      version: "2.5.4",
      sourceRevision: revision,
      imageReference: `ghcr.io/hooterjackson/genio@${imageDigest}`,
      imageDigest,
    },
    backend: {
      promotionReceiptHash: digest("4"),
      semanticBehaviorManifestHash: digest("5"),
      semanticExecutionConfigurationHash: semanticHash,
      containmentReceiptHash: digest("7"),
      guidanceCheckpointMigrationReceiptHash: digest("8"),
      legacyExecutionRouteDrainInventoryReceiptHash: digest("0"),
      schema20EvidenceRecoveryReceiptHash: digest("6"),
      railwayProjectId: "11111111-1111-4111-8111-111111111111",
      services: {
        interactive: {
          serviceId: "22222222-2222-4222-8222-222222222222",
          deploymentId: "33333333-3333-4333-8333-333333333333",
        },
        deep: {
          serviceId: "44444444-4444-4444-8444-444444444444",
          deploymentId: "55555555-5555-4555-8555-555555555555",
        },
        api: {
          serviceId: "66666666-6666-4666-8666-666666666666",
          deploymentId: "77777777-7777-4777-8777-777777777777",
        },
      },
    },
    sites: {
      projectId: "appgprj_6a5565cf7d6c8191ab9f2084e8eda856",
      versionId: "sites-version-v254",
      deploymentId: "sites-deployment-v254",
      archiveSha256: digest("8"),
      controlPlaneEvidenceHash: digest("9"),
      sourceRevision: revision,
    },
    route: {
      executionRoute: "corpus_first_v3" as const,
      intentGroup: "editorial_influence" as const,
      contractVersion: 3 as const,
      guidanceVersion: "adaptive_guidance_v5" as const,
      queryPlanSchema: 6 as const,
      directExposureAuthorityPayloadHash: digest("a"),
      directExposureAuthorityArtifactHash: digest("b"),
      rollbackWarrantPayloadHash: digest("c"),
      rollbackWarrantArtifactHash: digest("d"),
      preconditionsHash: digest("e"),
      rollbackPlanHash: digest("f"),
      targetConfigurationHash: digest("0"),
      preExposureSemanticConfigurationHash: digest("2"),
      postExposureSemanticConfigurationHash: semanticHash,
      rollbackSemanticConfigurationHash: digest("2"),
      preExposureRuntimeTupleHash: digest("4"),
      postExposureRuntimeTupleHash: digest("5"),
      rollbackRuntimeTupleHash: digest("6"),
      databaseActivateReceiptHash: digest("7"),
      runtimeTransitionReceiptHash: digest("8"),
      directExposureStage:
        "editorial_influence:0->100:fully_exposed_unproven" as const,
      exposureClass: "fully_exposed_unproven" as const,
      organicReliabilityProven: false as const,
      directAssignmentHash: digest("9"),
      publicQuestionSetHash: digest("c"),
      publicQuestionHash: digest("d"),
      ownerAppleGateEvidenceHash: digest("2"),
      preExposureCleanGateEvidenceHash: digest("3"),
      databaseRouteReceiptHash: digest("4"),
    },
    evidence: {
      finalBrowserEvidenceHash: digest("e"),
      finalBrowserConfigurationHash: digest("f"),
      finalBrowserRuntimeHash: digest("0"),
      finalBrowserCompletedAt: "2026-07-20T00:00:00.000Z",
    },
  };
  return validateV254BurnInBindingV1({
    ...unsigned,
    bindingHash: releaseFixtureSha256(unsigned),
  });
}

function systemHealth() {
  const apiConfiguration = digest("1");
  const interactiveConfiguration = digest("2");
  const deepConfiguration = digest("3");
  return {
    ok: true,
    activationReady: true,
    schemaVersion: "20",
    proofArchitectureVersion: "1",
    proofArchitectureAuthority: "native",
    workerProtocol: { actual: "playlist-pipeline-v12" },
    executorFencing: {
      ready: true,
      uncoveredJobs: 0,
      incompleteJobs: 0,
    },
    queue: { queued: 0, leased: 0 },
    publicRollout: {
      active: false,
      databaseAuthorized: true,
      evidenceHash: null,
      stage: null,
      targetConfigurationHash: null,
    },
    directExposure: {
      active: true,
      state: "active",
      databaseAuthorized: true,
      authorityPayloadHash: digest("a"),
      rollbackWarrantPayloadHash: digest("c"),
      stage: "editorial_influence:0->100:fully_exposed_unproven",
      targetConfigurationHash: digest("0"),
      exposureClass: "fully_exposed_unproven",
      organicReliabilityProven: false,
    },
    api: {
      build: { version: "2.5.4", revision },
      configurationHash: apiConfiguration,
      semanticExecutionConfigurationHash: semanticHash,
    },
    workerLanes: {
      interactive: {
        status: "healthy",
        protocolVersion: "playlist-pipeline-v12",
        eligibleIdentityCount: 1,
        eligibleRevisions: [revision],
        eligibleConfigurationHashes: [interactiveConfiguration],
        eligibleSemanticExecutionConfigurationHashes: [semanticHash],
      },
      deep: {
        status: "healthy",
        protocolVersion: "playlist-pipeline-v12",
        eligibleIdentityCount: 1,
        eligibleRevisions: [revision],
        eligibleConfigurationHashes: [deepConfiguration],
        eligibleSemanticExecutionConfigurationHashes: [semanticHash],
      },
    },
  };
}

function snapshot(
  observedAt: string,
  windowStartedAt: string,
  runs: number,
  violations: Partial<V254BurnInDatabaseSnapshotV1["violations"]> = {},
): V254BurnInDatabaseSnapshotV1 {
  const allViolations = {
    nullCandidateQualifications: 0,
    falseScarcity: 0,
    counterDivergence: 0,
    actionlessDecisions: 0,
    unchangedSemanticRetries: 0,
    falseLiveStates: 0,
    newAppleOrphans: 0,
    appleOrderedIdMismatches: 0,
    ownerPublicRouteDivergence: 0,
    ...violations,
  };
  const tripped = Object.values(allViolations).some((value) => value !== 0);
  const unsigned = {
    schemaVersion: "genio-v254-burn-in-database-snapshot/v1" as const,
    observedAt,
    windowStartedAt,
    sourceRevision: revision,
    semanticExecutionConfigurationHash: semanticHash,
    traffic: {
      publicOrganic: { briefs: runs, runs },
      ownerCanary: { briefs: 0, runs: 0 },
      synthetic: { briefs: 1, runs: 1 },
      replay: { briefs: 0, runs: 0 },
      cleanNonOwnerEditorialInfluence: {
        briefs: runs > 0 ? 1 : 0,
        runs: runs > 0 ? 1 : 0,
      },
    },
    violations: allViolations,
    trip: tripped ? {
      incidentSignature: digest("e"),
      route: "corpus_first_v3" as const,
      intentGroup: "editorial_influence" as const,
      reasonCode: "v254_burn_in_invariant_trip" as const,
    } : null,
  };
  return {
    ...unsigned,
    snapshotHash: releaseFixtureSha256(unsigned),
  };
}

function runtime(startedAt: string): V254BurnInRuntime & { advance(ms: number): void } {
  let now = Date.parse(startedAt);
  let runs = 0;
  return {
    now: () => now,
    advance(ms) { now += ms; },
    async wait(ms) { now += ms; },
    async fetchText() {
      return {
        status: 200,
        value: `<html data-build-version="2.5.4" data-build-revision="${revision}"></html>`,
      };
    },
    async fetchJson(url) {
      if (url.endsWith("/health/live")) {
        return { status: 200, value: { version: "2.5.4", revision } };
      }
      if (url.endsWith("/health/ready")) return { status: 200, value: {} };
      return { status: 200, value: systemHealth() };
    },
    async databaseSnapshot(input) {
      runs += 1;
      return snapshot(new Date(now).toISOString(), input.windowStartedAt, runs);
    },
  };
}

const producer = {
  repository: "hooterjackson/genio",
  workflow: ".github/workflows/v254-production-burn-in.yml" as const,
  runId: "12345",
  runAttempt: 1,
  headSha: revision,
};

describe("v2.5.4 production burn-in", () => {
  test("burn-in command errors never disclose provider stderr", () => {
    for (const secret of unsafeCliStderrSamples) {
      const redacted = redactV254ProductionBurnInCommandStderr(
        `request failed for ${secret}: permission denied`,
      );
      expect(redacted).toBe("[redacted Railway stderr]");
      expect(redacted).not.toContain(secret);
      expect(redacted).not.toContain("permission denied");
    }
    expect(redactV254ProductionBurnInCommandStderr(" \n\t"))
      .toBe("[no Railway stderr]");
  });

  test("workflow chains bounded segments and cannot silently finalize", async () => {
    const workflow = await readFile(new URL(
      "../.github/workflows/v254-production-burn-in.yml",
      import.meta.url,
    ), "utf8");
    expect(workflow).toContain("timeout-minutes: 345");
    expect(workflow).toContain("--segment-seconds 19200");
    expect(workflow).toContain("--poll-interval-seconds 300");
    expect(workflow).toContain("prior_burn_in_run_id");
    expect(workflow).toContain("--prior-receipt");
    expect(workflow).toContain("direct_exposure_run_id");
    expect(workflow).toContain("--direct-exposure-authority");
    expect(workflow).toContain("v254-direct-exposure-authority.json");
    expect(workflow).toContain("--direct-exposure-rollback-warrant");
    expect(workflow).toContain("--direct-exposure-database-activate-receipt");
    expect(workflow).toContain("--direct-exposure-runtime-receipt");
    expect(workflow).toContain("production_proof_run_id");
    expect(workflow).toContain("final-custom-domain-browser.gate.json");
    expect(workflow).toContain(
      ".github/workflows/v254-editorial-direct-exposure.yml",
    );
    expect(workflow).toContain(".github/workflows/v254-production-proof.yml");
    expect(workflow).toContain("RELEASE_VERIFICATION_PUBLIC_KEY_BASE64");
    expect(workflow).toContain("RELEASE_VERIFICATION_KEY_ID");
    expect(workflow).toContain("RELEASE_VERIFICATION_KEY_SHA256");
    expect(workflow).toContain("gh workflow run v254-production-burn-in.yml");
    expect(workflow).not.toContain("railway up");
    expect(workflow).not.toContain("variable set");
    expect(workflow).not.toContain("route_authority_run_id");
    expect(workflow).not.toContain("v254-editorial-route-control.yml");
  });

  test("database evidence is route-scoped and proves real V5 worker effect", async () => {
    const source = await readFile(new URL(
      "../scripts/v254-production-burn-in.ts",
      import.meta.url,
    ), "utf8");
    expect(source).toContain("cleanNonOwnerEditorialInfluence");
    expect(source).toContain("fresh_clean_public");
    expect(source).toContain("parity_valid_runs");
    expect(source).toContain("signed_public_direct_exposure");
    expect(source).toContain("signed_public_direct_exposure_v1");
    expect(source).toContain("genio-final-custom-domain-browser/v8");
    expect(source).toContain("fully_exposed_unproven");
    expect(source).toContain("organicReliabilityProven");
    expect(source).toContain("directExposureAuthorityPayloadHash");
    expect(source).toContain("rollbackWarrantPayloadHash");
    expect(source).toContain("preExposureRuntimeTupleHash");
    expect(source).toContain("postExposureRuntimeTupleHash");
    expect(source).toContain("rollbackRuntimeTupleHash");
    expect(source).toContain("databaseActivateReceiptHash");
    expect(source).toContain("runtimeTransitionReceiptHash");
    expect(source).toContain("worker-consumption:");
    expect(source).toContain("beforeConsumerResultHash");
    expect(source).toContain("afterConsumerResultHash");
    expect(source).toContain("history.entry->>'errorSignature'");
    expect(source).toContain("history.entry->>'attemptStrategyHash'");
    expect(source).not.toContain(
      "checkpoint.state_json->>'repeated'='true'",
    );
    expect(source).toContain("JOIN affected_runs affected");
    expect(source).toContain("FROM orphan_playlists orphan");
    expect(source).toContain("playlist_publication_reconciliations");
  });

  test("recomputes route and worker-consumption receipts instead of trusting hash-shaped strings", () => {
    const route = createExecutionRouteReceiptV1({
      version: EXECUTION_ROUTE_RECEIPT_VERSION_V1,
      briefId: "brief:public-irish",
      rootLineageId: "contract:public-irish",
      trafficClass: "public",
      contractVersion: 3,
      guidanceVersion: "adaptive_guidance_v5",
      assignmentAuthority: {
        kind: "signed_public_direct_exposure",
        receiptHash: digest("d"),
        intentGroup: "editorial_influence",
        assignmentReason: "public_editorial_influence",
      },
      briefSelectionPipelineVersion: "catalog_first_v2",
      executionRoute: "corpus_first_v3",
      queryPlanSchema: 6,
      queryPlanHash: digest("5"),
      capabilitySnapshotHash: digest("7"),
      releaseRevision: revision,
      executorConfigurationHash: semanticHash,
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    expect(isValidV254RouteReceiptV1({
      receipt: route,
      sourceRevision: revision,
      semanticExecutionConfigurationHash: semanticHash,
    })).toBe(true);
    expect(isValidV254RouteReceiptV1({
      receipt: {
        ...route,
        assignmentAuthority: {
          ...route.assignmentAuthority,
          intentGroup: "genre_scene",
        },
      },
      sourceRevision: revision,
      semanticExecutionConfigurationHash: semanticHash,
    })).toBe(false);
    const stagedRollout = createExecutionRouteReceiptV1({
      version: EXECUTION_ROUTE_RECEIPT_VERSION_V1,
      briefId: "brief:legacy-staged",
      rootLineageId: "contract:legacy-staged",
      trafficClass: "public",
      contractVersion: 3,
      guidanceVersion: "adaptive_guidance_v5",
      assignmentAuthority: {
        kind: "signed_public_rollout",
        receiptHash: digest("e"),
        intentGroup: "editorial_influence",
        assignmentReason: "legacy_staged_rollout",
      },
      briefSelectionPipelineVersion: "catalog_first_v2",
      executionRoute: "corpus_first_v3",
      queryPlanSchema: 6,
      queryPlanHash: digest("5"),
      capabilitySnapshotHash: digest("7"),
      releaseRevision: revision,
      executorConfigurationHash: semanticHash,
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    expect(isValidV254RouteReceiptV1({
      receipt: stagedRollout,
      sourceRevision: revision,
      semanticExecutionConfigurationHash: semanticHash,
    })).toBe(false);

    const consumption = validWorkerConsumption();
    expect(isValidV254WorkerConsumptionReceiptV5(consumption)).toBe(true);
    expect(isValidV254WorkerConsumptionReceiptV5({
      ...consumption,
      effectHash: digest("f"),
    })).toBe(false);
  });

  test("accepts only independently healthy frontier-exhaustion scarcity proof", () => {
    const proof = validScarcityProof();
    expect(isValidV254ScarcityProofV2({
      ...proof,
      contractRevisionId: "contract:successor",
      contractSemanticHash: digest("4"),
    })).toBe(true);
    expect(isValidV254ScarcityProofV2({
      ...proof,
      audit: {
        ...proof.audit,
        reasonCode: "local_budget_exhausted",
      },
      contractRevisionId: "contract:successor",
      contractSemanticHash: digest("4"),
    })).toBe(false);
    expect(isValidV254ScarcityProofV2({
      ...proof,
      coverage: {
        ...proof.coverage,
        telemetryDivergenceCodes: ["clause_disposition_mismatch"],
      },
      contractRevisionId: "contract:successor",
      contractSemanticHash: digest("4"),
    })).toBe(false);
  });

  test("rejects malformed or unbound needs-decision companions", () => {
    const decision = validRunDecision();
    expect(isValidV254RunDecisionV1(decision, {
      contractRevisionId: "contract:successor",
      contractSemanticHash: digest("4"),
    })).toBe(true);
    expect(isValidV254RunDecisionV1({
      ...decision,
      advancingActions: [{
        kind: "review_named_constraint",
        clauseIds: [],
        options: ["keep_request"],
      }],
      actions: {
        ...(decision.actions as Record<string, unknown>),
        reviseNamedPredicate: false,
      },
    }, {
      contractRevisionId: "contract:successor",
      contractSemanticHash: digest("4"),
    })).toBe(false);
    expect(isValidV254RunDecisionV1(decision, {
      contractRevisionId: "contract:other",
      contractSemanticHash: digest("4"),
    })).toBe(false);
  });

  test("burn-in SQL separates global Apple faults and real attempt identity", async () => {
    const source = await readFile(new URL(
      "../scripts/v254-production-burn-in.ts",
      import.meta.url,
    ), "utf8");
    expect(source).toContain("FROM orphan_playlists orphan");
    expect(source).not.toContain(
      "FROM orphan_playlists orphan\\n         JOIN affected_runs",
    );
    expect(source).toContain("count(DISTINCT attempt.id)>1");
    expect(source).toContain(
      "attempt.id::text=history.entry->>'attemptId'",
    );
    expect(source).toContain("scarcity_claims AS");
    expect(source).toContain("resolution.decision_json->>'reason'");
    expect(source).toContain("decision.phase='run_decision'");
    expect(source).toContain("blocker.state_json->>'reasonCode'");
  });

  test("cannot complete before 24 continuous hours", async () => {
    const clock = runtime("2026-07-20T00:00:00.000Z");
    const receipt = await runV254BurnInSegment({
      binding: binding(),
      priorReceipt: null,
      producer,
      segmentDurationMs: 60 * 60_000,
      pollIntervalMs: 5 * 60_000,
      runtime: clock,
    });
    expect(receipt.status).toBe("monitoring");
    expect(receipt.window.elapsedMs).toBeLessThan(
      V254_BURN_IN_REQUIRED_DURATION_MS,
    );
    expect(() => validateV254ProductionBurnInReceiptV1(receipt, {
      candidateTag: "v2.5.4-rc.1",
      version: "2.5.4",
      sourceRevision: revision,
      imageDigest,
      semanticBehaviorManifestHash: digest("5"),
      semanticExecutionConfigurationHash: semanticHash,
      sitesProjectId: binding().sites.projectId,
      sitesVersionId: binding().sites.versionId,
      sitesDeploymentId: binding().sites.deploymentId,
      finalBrowserEvidenceHash: digest("e"),
    })).toThrow(/not complete/u);
  });

  test("chains bounded segments and completes only after 24 hours", async () => {
    const clock = runtime("2026-07-20T00:00:00.000Z");
    let receipt: V254ProductionBurnInReceiptV1 | null = null;
    for (let segment = 0; segment < 5; segment += 1) {
      receipt = await runV254BurnInSegment({
        binding: binding(),
        priorReceipt: receipt,
        producer: { ...producer, runId: String(12345 + segment) },
        segmentDurationMs: 5 * 60 * 60_000,
        pollIntervalMs: 5 * 60_000,
        runtime: clock,
      });
      if (segment < 4) clock.advance(60_000);
    }
    expect(receipt).not.toBeNull();
    expect(receipt!.status).toBe("complete");
    expect(receipt!.window.elapsedMs).toBeGreaterThanOrEqual(
      V254_BURN_IN_REQUIRED_DURATION_MS,
    );
    expect(receipt!.monitoring.sampleCount).toBeGreaterThanOrEqual(97);
    expect(receipt!.monitoring.maximumObservationGapMs).toBeLessThanOrEqual(
      V254_BURN_IN_MAX_OBSERVATION_GAP_MS,
    );
    expect(receipt!.monitoring.traffic.publicOrganic.runs).toBeGreaterThan(0);
    expect(
      receipt!.monitoring.traffic.cleanNonOwnerEditorialInfluence.runs,
    ).toBe(1);
    expect(receipt!.monitoring.traffic.synthetic.runs).toBeGreaterThan(0);

    const unsignedWithoutCleanPublic = {
      ...receipt!,
      monitoring: {
        ...receipt!.monitoring,
        traffic: {
          ...receipt!.monitoring.traffic,
          cleanNonOwnerEditorialInfluence: { briefs: 0, runs: 0 },
        },
      },
      receiptHash: undefined,
    };
    delete (unsignedWithoutCleanPublic as { receiptHash?: unknown }).receiptHash;
    expect(() => validateV254ProductionBurnInReceiptV1({
      ...unsignedWithoutCleanPublic,
      receiptHash: releaseFixtureSha256(unsignedWithoutCleanPublic),
    }, {
      candidateTag: "v2.5.4-rc.1",
      version: "2.5.4",
      sourceRevision: revision,
      imageDigest,
      semanticBehaviorManifestHash: digest("5"),
      semanticExecutionConfigurationHash: semanticHash,
      sitesProjectId: binding().sites.projectId,
      sitesVersionId: binding().sites.versionId,
      sitesDeploymentId: binding().sites.deploymentId,
      finalBrowserEvidenceHash: digest("e"),
      observedNow: receipt!.window.observedThrough,
    })).toThrow(/fresh clean non-owner/u);
  });

  test("fails closed on candidate drift, invariant trips, gaps, and restart edits", async () => {
    expect(() => validateV254BurnInBindingV1({
      ...binding(),
      sites: { ...binding().sites, sourceRevision: "9".repeat(40) },
    })).toThrow(/Sites source/u);

    const brokenRuntime = runtime("2026-07-20T00:00:00.000Z");
    brokenRuntime.databaseSnapshot = async (input) => snapshot(
      new Date(brokenRuntime.now()).toISOString(),
      input.windowStartedAt,
      1,
      { nullCandidateQualifications: 1 },
    );
    await expect(runV254BurnInSegment({
      binding: binding(),
      priorReceipt: null,
      producer,
      segmentDurationMs: 60_000,
      pollIntervalMs: 30_000,
      runtime: brokenRuntime,
    })).rejects.toThrow(/tripped/u);

    const clock = runtime("2026-07-20T00:00:00.000Z");
    const first = await runV254BurnInSegment({
      binding: binding(),
      priorReceipt: null,
      producer,
      segmentDurationMs: 60_000,
      pollIntervalMs: 30_000,
      runtime: clock,
    });
    clock.advance(V254_BURN_IN_MAX_OBSERVATION_GAP_MS + 1);
    await expect(runV254BurnInSegment({
      binding: binding(),
      priorReceipt: first,
      producer: { ...producer, runId: "12346" },
      segmentDurationMs: 60_000,
      pollIntervalMs: 30_000,
      runtime: clock,
    })).rejects.toThrow(/gap/u);

    expect(() => validateV254ProductionBurnInReceiptV1({
      ...first,
      window: {
        ...first.window,
        startedAt: "2026-07-19T00:00:00.000Z",
        elapsedMs: V254_BURN_IN_REQUIRED_DURATION_MS,
      },
    }, undefined)).toThrow(/hash|window|finalized/u);
  });

  test("fails closed if direct authority is not active or staged rollout authority reappears", async () => {
    for (const system of [{
      ...systemHealth(),
      directExposure: {
        ...systemHealth().directExposure,
        active: false,
        state: "armed",
      },
    }, {
      ...systemHealth(),
      publicRollout: {
        active: true,
        databaseAuthorized: true,
        evidenceHash: digest("f"),
        stage: "editorial_influence:50->100",
        targetConfigurationHash: digest("e"),
      },
    }]) {
      const clock = runtime("2026-07-20T00:00:00.000Z");
      const baseFetch = clock.fetchJson.bind(clock);
      clock.fetchJson = async (url) => (
        url.includes("/health/system")
          ? { status: 200, value: system }
          : baseFetch(url)
      );
      await expect(runV254BurnInSegment({
        binding: binding(),
        priorReceipt: null,
        producer,
        segmentDurationMs: 60_000,
        pollIntervalMs: 30_000,
        runtime: clock,
      })).rejects.toThrow(/direct-exposure|identity/u);
    }
  });

  test("records an idempotent incident and kill switch before surfacing a trip", async () => {
    const queries: string[] = [];
    const client = {
      async query<T>(sql: string): Promise<{ rows: T[] }> {
        queries.push(sql);
        if (sql.includes("incident_recorded")) {
          return {
            rows: [{
              incident_recorded: true,
              kill_switch_engaged: true,
            } as T],
          };
        }
        return { rows: [] };
      },
    };
    const violations = snapshot(
      "2026-08-02T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
      1,
      { falseScarcity: 1 },
    ).violations;
    const trip = await persistV254BurnInTripV1(client as never, {
      windowStartedAt: "2026-08-02T00:00:00.000Z",
      sourceRevision: revision,
      semanticExecutionConfigurationHash: semanticHash,
      violations,
    });
    expect(trip).toMatchObject({
      route: "corpus_first_v3",
      intentGroup: "editorial_influence",
      reasonCode: "v254_burn_in_invariant_trip",
    });
    expect(queries[0]).toContain("quality_incident_groups");
    expect(queries[1]).toContain("pipeline_cohort_kill_switches");
    expect(queries[2]).toContain("incident_recorded");
    expect(() => validateV254BurnInDatabaseSnapshotV1({
      ...snapshot(
        "2026-08-02T00:00:00.000Z",
        "2026-08-02T00:00:00.000Z",
        1,
        { falseScarcity: 1 },
      ),
      trip,
    }, {
      windowStartedAt: "2026-08-02T00:00:00.000Z",
      sourceRevision: revision,
      semanticExecutionConfigurationHash: semanticHash,
    })).toThrow(/tripped/u);
  });
});
