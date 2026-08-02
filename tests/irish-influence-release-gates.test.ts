import { describe, expect, test } from "vitest";
import {
  guidanceCheckpointV5,
} from "../server/adaptive-guidance-v5.ts";
import {
  publicGuidanceQuestionV5,
} from "../server/adaptive-guidance-contract-bridge.ts";
import {
  compilePlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";
import {
  FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1,
  RELEASE_FIXTURES,
  releaseFixtureBindingsForGate,
  releaseFixturePrompt,
  releaseFixtureSha256,
  validateReleaseFixtureGuidancePayload,
} from "../scripts/release-fixtures.ts";
import {
  validateIrishInfluenceReleaseProofV1,
} from "../scripts/irish-influence-release-proof.ts";
import {
  collectIrishInfluenceReleaseProofV1,
  type IrishInfluenceReleaseProofDatabase,
} from "../scripts/irish-influence-release-proof-producer.ts";
import {
  nativeV254OwnerEditorialGateVariablesV1,
  nativeV254PublicEditorialActivationVariablesV1,
  nativeV254RouteSwitchVariablesV1,
} from "../scripts/promote-native-schema20-release.ts";
import {
  PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
} from "../shared/public-rollout-evidence.ts";
import {
  sha256Hex,
  stableStringify,
} from "../server/security.ts";

const digest = (value: string) => value.repeat(64).slice(0, 64);

function fixtureUuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function qualificationBindings(input: {
  runId: string;
  contractRevisionId: string;
  count: number;
}) {
  return Array.from({ length: input.count }, (_, index) => {
    const qualificationId = fixtureUuid(1_000 + index);
    const leadId = fixtureUuid(2_000 + index);
    const executionAttemptId = fixtureUuid(3_000 + index);
    const candidateId = fixtureUuid(4_000 + index);
    const jobId = fixtureUuid(5_000 + index);
    const queryPlanRevisionId = fixtureUuid(6_000 + index);
    return {
      qualificationId,
      qualificationRunId: input.runId,
      qualificationContractRevisionId: input.contractRevisionId,
      discoveryLeadId: leadId,
      leadId,
      leadRunId: input.runId,
      leadContractRevisionId: input.contractRevisionId,
      leadExecutionAttemptId: executionAttemptId,
      executionAttemptId,
      executionAttemptRunId: input.runId,
      executionAttemptContractRevisionId: input.contractRevisionId,
      executionAttemptJobId: jobId,
      executionAttemptQueryPlanRevisionId: queryPlanRevisionId,
      jobId,
      jobRunId: input.runId,
      jobQueryPlanRevisionId: queryPlanRevisionId,
      jobMinimumWorkerProtocol: 12,
      jobPipelineVersion: "corpus_first_v3",
      candidateId,
      materializedCandidateId: candidateId,
      candidateRunId: input.runId,
      candidatePipelineVersion: "corpus_first_v3",
    };
  });
}

function influenceGuidancePayload() {
  const baseContract = compilePlaylistContractRevisionV1({
    contractId: "release:irish-influence",
    rawPrompt: "Infuential irish music",
    requestedTrackCount: 25,
    locale: "en",
    storefront: "us",
    clauses: [
      {
        id: "membership:origin",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "artist_origin",
        operator: "require",
        values: ["Irish"],
        source: { provenance: "prompt", text: "irish" },
      },
      {
        id: "ranking:influence",
        kind: "ranking_preference",
        scope: "track",
        hardness: "soft",
        axis: "influence",
        operator: "prefer",
        values: ["historical influence"],
        source: { provenance: "prompt", text: "Infuential" },
      },
    ],
    trackPredicate: { op: "clause", clauseId: "membership:origin" },
  });
  const checkpoint = guidanceCheckpointV5({
    prompt: baseContract.rawPrompt,
    baseContract,
    preservedTrackPredicate: baseContract.trackPredicate,
    ambiguousScopeClauseIds: [],
    criticalAmbiguities: [],
    requestShape: "curated",
    capabilitySnapshotHash: digest("a"),
    semanticConfigurationHash: digest("b"),
  });
  expect(checkpoint.decisions).toHaveLength(1);
  return {
    questionSetHash: digest("c"),
    questions: [publicGuidanceQuestionV5(checkpoint.decisions[0]!)],
  };
}

function irishProof() {
  const unsigned = {
    schemaVersion: "genio-irish-influence-release-proof/v1",
    fixtureId: "irish-influence-recovery-25-v1",
    candidate: {
      version: "2.5.4",
      sourceRevision: "1".repeat(40),
      workerConfigurationHash: digest("2"),
    },
    ownerAcceptance: {
      trafficClass: "owner_canary",
      assignmentKind: "signed_owner_canary",
      intentGroup: "editorial_influence",
      executionRoute: "corpus_first_v3",
      contractVersion: 3,
      guidanceVersion: "adaptive_guidance_v5",
      hardMembershipAxis: "geography",
      hardMembershipValue: "Irish",
      influenceKind: "influence",
      assignmentReceiptHash: digest("3"),
      routeReceiptHash: digest("4"),
      questionSetHash: digest("5"),
      questionHash: digest("6"),
      axis: "influence_scope",
      selectedOptionId: "balanced_influence",
      baseContractSemanticHash: digest("7"),
      successorContractSemanticHash: digest("8"),
      queryPlanSchema: 6,
      queryPlanHash: digest("9"),
      queryPlanRevisionHash: digest("a"),
      optionSimulationReceiptHash: digest("b"),
      executionEffectHash: digest("c"),
      workerConsumptionReceiptHash: digest("d"),
      workerConsumptionStatus: "consumed",
    },
    recoveryInjection: {
      discoveryObservationCount: 80,
      uniqueLeadCount: 80,
      qualificationObservationCount: 77,
      candidateBoundQualificationCount: 77,
      legacyUnboundQualificationCount: 0,
      qualificationBindingMismatchCount: 0,
      qualificationBindingSetHash: digest("f"),
      materializedCandidateCount: 77,
      applePlayableCount: 73,
      evidenceQualifiedCount: 0,
      limitingObligationUnknownCount: 77,
      limitingObligationFailCount: 0,
      acquisitionAttemptCount: 0,
      disposition: "quarantined_capability_gap",
      nextActionKind: "replay_after_repair",
      scarcityReported: false,
      actionless: false,
    },
    publication: {
      selectedCount: 25,
      manifestedCount: 25,
      appendedCount: 25,
      reconciledPublishedCount: 25,
      expectedOrderedAppleIdsHash: digest("e"),
      observedOrderedAppleIdsHash: digest("e"),
    },
    observedAt: "2026-08-01T20:00:00.000Z",
  } as const;
  return {
    ...unsigned,
    evidenceHash: releaseFixtureSha256(unsigned),
  };
}

describe("v2.5.4 Irish-influence release gates", () => {
  test("uses the exact typo, count, V5 influence MCQ, and production gate", () => {
    expect(releaseFixturePrompt("irish-influence-recovery-25-v1"))
      .toBe("Infuential irish music");
    expect(RELEASE_FIXTURES["irish-influence-recovery-25-v1"])
      .toMatchObject({ targetTrackCount: 25, guidanceMode: "recommended" });
    expect(releaseFixtureBindingsForGate("production_affected_regression", {
      "irish-influence-recovery-25-v1": digest("f"),
    }).map(({ fixtureId }) => fixtureId)).toEqual([
      "irish-influence-recovery-25-v1",
    ]);
    const validation = validateReleaseFixtureGuidancePayload(
      "irish-influence-recovery-25-v1",
      influenceGuidancePayload(),
    );
    expect(validation).toMatchObject({
      selectedOptionId: "balanced_influence",
      affectedClauseIds: [
        "guidance:v5:influence-scope:balanced_influence",
      ],
    });
  });

  test("binds the signed owner route, worker consumption, recovery, and Apple proof", () => {
    const proof = irishProof();
    expect(validateIrishInfluenceReleaseProofV1(proof, {
      version: "2.5.4",
      sourceRevision: "1".repeat(40),
      workerConfigurationHashes: [digest("2")],
      contractHash: digest("8"),
      questionSetHash: digest("5"),
      questionHash: digest("6"),
      queryPlanRevisionHash: digest("a"),
      orderedAppleIdsHash: digest("e"),
    })).toEqual(proof);
    expect(() => validateIrishInfluenceReleaseProofV1({
      ...proof,
      ownerAcceptance: {
        ...proof.ownerAcceptance,
        assignmentKind: "signed_public_rollout",
      },
      evidenceHash: digest("0"),
    }, {
      version: "2.5.4",
      sourceRevision: "1".repeat(40),
      workerConfigurationHashes: [digest("2")],
      contractHash: digest("8"),
      questionSetHash: digest("5"),
      questionHash: digest("6"),
      queryPlanRevisionHash: digest("a"),
      orderedAppleIdsHash: digest("e"),
    })).toThrow(/signed editorial V5 successor/u);
  });

  test("produces the proof from durable DB rows and independently reread API state", async () => {
    const revision = "1".repeat(40);
    const questionSetHash = digest("5");
    const questionHash = digest("6");
    const baseContractHash = digest("7");
    const successorContractHash = digest("8");
    const queryPlanHash = digest("9");
    const queryPlanRevisionId = "11111111-1111-4111-8111-111111111111";
    const routeReceiptHash = digest("4");
    const assignmentReceiptHash = digest("3");
    const effectHash = digest("c");
    const workerDeterministic = {
      schemaVersion: "genio-guidance-v5-worker-consumption/v1",
      kind: "worker_consumption",
      status: "consumed",
      authorityHash: digest("1"),
      questionSetHash,
      questionHash,
      selectedOptionId: "balanced_influence",
      axis: "influence_scope",
      beforeQueryPlanHash: digest("f"),
      afterQueryPlanHash: queryPlanHash,
      queryPlanHash,
      queryPlanRevisionId,
      contractRevisionId: "22222222-2222-4222-8222-222222222222",
      contractSemanticHash: successorContractHash,
      capabilitySnapshotHash: digest("a"),
      semanticConfigurationHash: digest("b"),
      executionField: "rankingObjectives",
      effectHash,
      consumerId:
        "pipeline_v3_live_adapters:hostedDiscoveryRankingObjectivesV5",
      beforeConsumerResultHash: digest("0"),
      afterConsumerResultHash: digest("d"),
      resultEffectHash: digest("e"),
      workerProjectionHash: digest("d"),
    } as const;
    const workerConsumption = {
      ...workerDeterministic,
      receiptHash: sha256Hex(stableStringify(workerDeterministic)),
      consumedAt: "2026-08-01T20:00:00.000Z",
      jobId: "33333333-3333-4333-8333-333333333333",
      workerId: "irish-release-worker",
      leaseEpoch: 1,
    };
    const routeReceipt = {
      trafficClass: "owner_canary",
      guidanceVersion: "adaptive_guidance_v5",
      executionRoute: "corpus_first_v3",
      contractVersion: 3,
      queryPlanSchema: 6,
      queryPlanHash,
      receiptHash: routeReceiptHash,
      assignmentAuthority: {
        kind: "signed_owner_canary",
        intentGroup: "editorial_influence",
        receiptHash: assignmentReceiptHash,
      },
    };
    const publicationRow = {
      run_id: "44444444-4444-4444-8444-444444444444",
      run_status: "complete",
      requested_track_count: 25,
      question_set_hash: questionSetHash,
      questions_json: [{
        policyVersion: "adaptive_guidance_v5",
        questionHash,
        axis: "influence_scope",
        options: [{
          id: "balanced_influence",
          optionSimulation: {
            valid: true,
            consumerReceipt: { receiptHash: digest("b") },
          },
          executionEffect: { effectHash },
        }],
      }],
      normalized_answers_json: [{
        optionId: "balanced_influence",
      }],
      base_contract_hash: baseContractHash,
      successor_contract_hash: successorContractHash,
      successor_contract_json: {
        clauses: [
          {
            hardness: "hard",
            axis: "geography",
            values: ["Irish"],
          },
          {
            hardness: "soft",
            axis: "influence",
            values: ["balanced"],
          },
        ],
      },
      query_plan_hash: queryPlanHash,
      query_plan_revision_id: queryPlanRevisionId,
      route_receipt: routeReceipt,
      worker_consumption: workerConsumption,
      worker_configuration_hash: digest("2"),
      selected_count: 25,
      manifested_count: 25,
      reconciliation_state: "complete",
      appended_count: 25,
      reconciliation_expected_count: 25,
      expected_ordered_ids_hash: digest("e"),
      observed_ordered_ids_hash: digest("e"),
    };
    const recoveryRunId = "55555555-5555-4555-8555-555555555555";
    const recoveryContractRevisionId =
      "66666666-6666-4666-8666-666666666666";
    const recoveryRow = {
      run_id: recoveryRunId,
      run_status: "quarantined",
      resolution_state: "quarantined",
      resolution_next_action: "contact_support",
      discovery_observation_count: 80,
      lead_count: 80,
      qualification_count: 77,
      legacy_unbound_qualification_count: 0,
      qualification_bindings: qualificationBindings({
        runId: recoveryRunId,
        contractRevisionId: recoveryContractRevisionId,
        count: 77,
      }),
      candidate_count: 77,
      apple_identity_count: 73,
      evidence_qualified_count: 0,
      unknown_count: 77,
      fail_count: 0,
      coverage: {
        obligations: [{
          obligationId: "influence-proof",
          acquisitionAttemptCount: 2,
          malformedEvidenceCount: 0,
          wrongAxisEvidenceCount: 0,
        }],
      },
      audit: {
        limitingObligationIds: ["influence-proof"],
      },
    };
    const databaseForRecovery = (row: typeof recoveryRow) => ({
      async query(text: string) {
        if (text.includes("questions.question_set_hash")) {
          expect(text).toContain("manifest.id=resolution.manifest_id");
          expect(text).toContain(
            "value.manifest_revision_id=selection.manifest_revision_id",
          );
          expect(text).toContain(
            "value.manifest_id=selection.manifest_id",
          );
        }
        return {
          rows: text.includes("questions.question_set_hash")
            ? [publicationRow]
            : [row],
          rowCount: 1,
        };
      },
    }) as unknown as IrishInfluenceReleaseProofDatabase;
    const database = databaseForRecovery(recoveryRow);
    const publicRoute = {
      receiptHash: routeReceiptHash,
      executionRoute: "corpus_first_v3",
    };
    const runtime = {
      async fetchJson(url: string) {
        if (url.endsWith("/health/live")) {
          return {
            status: 200,
            value: { build: { version: "2.5.4", revision } },
          };
        }
        if (url.includes("44444444-4444-4444-8444-444444444444")) {
          return {
            status: 200,
            value: {
              status: "complete",
              executionRouteReceipt: publicRoute,
            },
          };
        }
        return {
          status: 200,
          value: {
            status: "quarantined",
            resolution: {
              state: "quarantined",
              nextAction: "replay_after_repair",
            },
            repairReplayAction: {
              kind: "repair_replay",
              available: true,
            },
            evidenceCoverage: {
              observationCount: 80,
              qualificationObservationCount: 77,
              legacyUnboundQualificationCount: 0,
              uniqueLeadCount: 80,
              candidates: 77,
              storefrontPlayable: 73,
              evidencePassed: 0,
              evidenceUnknown: 77,
              evidenceFailed: 0,
            },
          },
        };
      },
      now: () => new Date("2026-08-01T20:00:00.000Z"),
    };
    const produced = await collectIrishInfluenceReleaseProofV1({
      database,
      runtime,
      origin: "https://9enio.com",
      publicationAccessId:
        "44444444-4444-4444-8444-444444444444",
      publicationCookie: "publication=capability",
      recoveryAccessId:
        "55555555-5555-4555-8555-555555555555",
      recoveryCookie: "recovery=capability",
      expectedVersion: "2.5.4",
      expectedRevision: revision,
    });
    expect(produced).toMatchObject({
      candidate: {
        version: "2.5.4",
        sourceRevision: revision,
        workerConfigurationHash: digest("2"),
      },
      ownerAcceptance: {
        questionSetHash,
        questionHash,
        successorContractSemanticHash: successorContractHash,
        queryPlanHash,
        workerConsumptionStatus: "consumed",
      },
      recoveryInjection: {
        discoveryObservationCount: 80,
        uniqueLeadCount: 80,
        qualificationObservationCount: 77,
        candidateBoundQualificationCount: 77,
        legacyUnboundQualificationCount: 0,
        qualificationBindingMismatchCount: 0,
        materializedCandidateCount: 77,
        applePlayableCount: 73,
        limitingObligationUnknownCount: 77,
        acquisitionAttemptCount: 2,
        disposition: "quarantined_capability_gap",
        nextActionKind: "replay_after_repair",
      },
      publication: {
        selectedCount: 25,
        manifestedCount: 25,
        appendedCount: 25,
        reconciledPublishedCount: 25,
      },
    });
    expect(produced.evidenceHash).toMatch(/^[a-f0-9]{64}$/u);

    await expect(collectIrishInfluenceReleaseProofV1({
      database,
      runtime: {
        ...runtime,
        async fetchJson(url: string) {
          const response = await runtime.fetchJson(url);
          if (url.includes("44444444-4444-4444-8444-444444444444")) {
            return {
              ...response,
              value: {
                status: "complete",
                executionRouteReceipt: {
                  ...publicRoute,
                  receiptHash: digest("0"),
                },
              },
            };
          }
          return response;
        },
      },
      origin: "https://9enio.com",
      publicationAccessId:
        "44444444-4444-4444-8444-444444444444",
      publicationCookie: "publication=capability",
      recoveryAccessId:
        "55555555-5555-4555-8555-555555555555",
      recoveryCookie: "recovery=capability",
      expectedVersion: "2.5.4",
      expectedRevision: revision,
    })).rejects.toThrow(/DB and API|route or API projection diverged/u);

    const nullCandidateBinding = {
      ...recoveryRow,
      legacy_unbound_qualification_count: 1,
      qualification_bindings: recoveryRow.qualification_bindings.map(
        (binding, index) => index === 0
          ? {
              ...binding,
              candidateId: null,
              materializedCandidateId: null,
              candidateRunId: null,
            }
          : binding,
      ),
    } as unknown as typeof recoveryRow;
    await expect(collectIrishInfluenceReleaseProofV1({
      database: databaseForRecovery(nullCandidateBinding),
      runtime,
      origin: "https://9enio.com",
      publicationAccessId:
        "44444444-4444-4444-8444-444444444444",
      publicationCookie: "publication=capability",
      recoveryAccessId:
        "55555555-5555-4555-8555-555555555555",
      recoveryCookie: "recovery=capability",
      expectedVersion: "2.5.4",
      expectedRevision: revision,
    })).rejects.toThrow(/candidate|fully candidate-bound/u);

    const unrelatedCandidateBinding = {
      ...recoveryRow,
      qualification_bindings: recoveryRow.qualification_bindings.map(
        (binding, index) => index === 0
          ? { ...binding, candidateRunId: fixtureUuid(9_999) }
          : binding,
      ),
    };
    await expect(collectIrishInfluenceReleaseProofV1({
      database: databaseForRecovery(unrelatedCandidateBinding),
      runtime,
      origin: "https://9enio.com",
      publicationAccessId:
        "44444444-4444-4444-8444-444444444444",
      publicationCookie: "publication=capability",
      recoveryAccessId:
        "55555555-5555-4555-8555-555555555555",
      recoveryCookie: "recovery=capability",
      expectedVersion: "2.5.4",
      expectedRevision: revision,
    })).rejects.toThrow(/unrelated binding/u);

    await expect(collectIrishInfluenceReleaseProofV1({
      database,
      runtime: {
        ...runtime,
        async fetchJson(url: string) {
          const response = await runtime.fetchJson(url);
          if (url.includes(recoveryRunId)) {
            const value = {
              ...response.value as Record<string, unknown>,
              evidenceCoverage: {
                ...(
                  response.value as {
                    evidenceCoverage: Record<string, unknown>;
                  }
                ).evidenceCoverage,
                legacyUnboundQualificationCount: 1,
              },
            };
            return { ...response, value };
          }
          return response;
        },
      },
      origin: "https://9enio.com",
      publicationAccessId:
        "44444444-4444-4444-8444-444444444444",
      publicationCookie: "publication=capability",
      recoveryAccessId:
        "55555555-5555-4555-8555-555555555555",
      recoveryCookie: "recovery=capability",
      expectedVersion: "2.5.4",
      expectedRevision: revision,
    })).rejects.toThrow(/DB and API counters diverged/u);
  });

  test("keeps owner and public activation editorial-only", () => {
    const base = nativeV254RouteSwitchVariablesV1();
    const owner = nativeV254OwnerEditorialGateVariablesV1();
    const publicActivation = nativeV254PublicEditorialActivationVariablesV1();
    expect(owner.PIPELINE_V3_OWNER_CANARY).toBe("true");
    expect(owner.PIPELINE_V3_OWNER_CANARY_GROUPS).toBe("editorial_influence");
    expect(owner.PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT).toBe("0");
    expect(publicActivation.PIPELINE_V3_OWNER_CANARY).toBe("false");
    expect(publicActivation.PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT).toBe("100");
    for (const [group, flag] of Object.entries(
      PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
    )) {
      if (group === "editorial_influence") continue;
      expect(owner[flag]).toBe(base[flag]);
      expect(publicActivation[flag]).toBe(base[flag]);
      expect(publicActivation[flag]).toBe("0");
    }
    expect(FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1).toEqual([
      expect.objectContaining({
        fixtureId: "final-public-assignment-editorial-influence-typo-v1",
        intentGroup: "editorial_influence",
        prompt: "Infuential irish music",
        targetTrackCount: 25,
      }),
      expect.objectContaining({
        fixtureId: "final-public-assignment-editorial-influence-corrected-v1",
        intentGroup: "editorial_influence",
        prompt: "Influential Irish music",
        targetTrackCount: 25,
      }),
    ]);
  });
});
