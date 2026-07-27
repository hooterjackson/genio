import {
  generateKeyPairSync,
} from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  HISTORICAL_REPLAY_CORPUS_COMMITMENT_SHA256,
  HISTORICAL_REPLAY_REQUIRED_CANARY_RESERVE_USD,
  HISTORICAL_REPLAY_SUBMISSION_COUNT,
  HistoricalReplayGateError,
  assertHistoricalReplayBudget,
  assertHistoricalReplayEvidenceIsSanitized,
  classifyHistoricalReplayPreRunArtistState,
  classifyHistoricalReplayRunState,
  createHistoricalReplayEvidencePayload,
  historicalReplayTaggedRequestBody,
  parseHistoricalReplayArgs,
  parseHistoricalReplayCorpus,
  runHistoricalReplayCorpus,
  signHistoricalReplayEvidence,
  validateHistoricalReplayEvidencePayload,
  verifyHistoricalReplayEvidence,
  type HistoricalReplayBrowserDriver,
  type HistoricalReplayCandidate,
  type HistoricalReplayResult,
  type HistoricalReplaySafeRunObservation,
} from "../scripts/historical-browser-replay.ts";
import {
  createReleaseGateArtifactFromSources,
  validateReleaseGateArtifact,
} from "../scripts/release-fixtures.ts";
import {
  releaseGateProducerKeyFingerprint,
  releaseGateProducerTrustPolicyV1,
  type LoadedRuntimeSnapshotV1,
} from "../scripts/release-evidence.ts";
import {
  verifyReleaseCanaryMetadata,
} from "../server/release-canary-metadata.ts";
import {
  MAXIMUM_STAGING_MONTHLY_COST_USD,
} from "../shared/release-evidence-constants.ts";

const origin = "https://staging.9enio.example";
const candidate: HistoricalReplayCandidate = {
  tag: "v2.4.0-rc.2",
  version: "2.4.0",
  sourceRevision: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
};
const hash = (character: string) => character.repeat(64);

function retainedCounts(): number[] {
  return [
    3,
    ...Array.from({ length: 38 }, () => 25),
    29,
    49,
    ...Array.from({ length: 28 }, () => 50),
    69,
    69,
    100,
    176,
  ];
}

function corpusValue() {
  const counts = retainedCounts();
  return {
    generatedAt: "2026-07-24T00:00:00.000Z",
    submissionCount: counts.length,
    windowDays: 7,
    scenarios: counts.map((requestedTrackCount, index) => ({
      id: `private-scenario-${String(index + 1).padStart(3, "0")}`,
      runId: index % 2 === 0
        ? `private-run-${String(index + 1).padStart(3, "0")}`
        : null,
      prompt: index < 2
        ? "Repeated private regression request"
        : `Private historical request ${String(index + 1).padStart(3, "0")}`,
      requestedTrackCount,
      answers: null,
      questions: null,
    })),
  };
}

function runtimeSnapshot(): LoadedRuntimeSnapshotV1 {
  return {
    schemaVersion: "genio-release-runtime-snapshot/v2",
    generatedAt: "2026-07-24T12:00:00.000Z",
    origin,
    environment: "staging",
    scope: "full",
    candidate: {
      version: candidate.version,
      sourceRevision: candidate.sourceRevision,
    },
    sitesObservation: {
      version: candidate.version,
      sourceRevision: candidate.sourceRevision,
      configurationHash: hash("1"),
      ownerAllowlistVersion: "owners-v1",
      candidateMatched: true,
    },
    configuration: {
      apiHash: hash("2"),
      interactiveWorkerHash: hash("3"),
      deepWorkerHash: hash("4"),
      sitesHash: hash("1"),
      secretVersionsHash: hash("5"),
    },
    runtime: {
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
        brief: "brief-model",
        baseline: "baseline-model",
        escalation: "escalation-model",
      },
      policyVersions: {
        guidance: "adaptive_guidance_v3",
        evidence: "governed_evidence_v2",
        queryPlan: "query-plan-v5",
        selection: "selection-v3",
        semanticScope: "scope-v1",
        musicConcept: "concept-v1",
        pipeline: "pipeline-v3",
        prompt: "prompt-v1",
      },
    },
    credentialVersionHashes: {
      provider: hash("6"),
      apple: hash("7"),
      appleQaVerifier: hash("8"),
    },
    configurationHash: hash("9"),
    runtimeHash: hash("a"),
    snapshotHash: hash("b"),
  };
}

function replayResults(
  outcome: HistoricalReplayResult["outcome"] = "exact_original",
): HistoricalReplayResult[] {
  return Array.from(
    { length: HISTORICAL_REPLAY_SUBMISSION_COUNT },
    (_, index) => ({
      ordinal: index + 1,
      targetTrackCount: retainedCounts()[index]!,
      outcome,
      guidanceSubmissionCount:
        outcome === "exact_after_guidance" ? 1 : 0,
      briefMarkerCount: 1,
      runMarkerCount: 1,
      freshRunCount: 1,
      countIntegrityCheckCount:
        outcome === "exact_original" || outcome === "exact_after_guidance"
          ? 1
          : 0,
      transcriptCommitment: hash(
        "0123456789abcdef"[(index % 16)]!,
      ),
    }),
  );
}

function safeRun(
  overrides: Partial<HistoricalReplaySafeRunObservation> = {},
): HistoricalReplaySafeRunObservation {
  return {
    status: "researching",
    phase: "source_discovery",
    errorPresent: false,
    targetTrackCount: 50,
    publishedTrackCount: 0,
    appendedTrackCount: 0,
    resolution: {
      state: "executing",
      nextAction: "none",
      terminal: false,
      blockerKind: "",
      nextRetryAt: null,
      automaticRetryUntil: null,
    },
    guidanceAction: null,
    partialActionPresent: false,
    decisionActionPresent: false,
    ...overrides,
  };
}

function runArgs(originValue = origin): string[] {
  return [
    "run",
    "--confirm-staging-writes",
    "--origin", originValue,
    "--corpus", "/private/tmp/private-corpus.json",
    "--runtime-snapshot", "/private/tmp/runtime.json",
    "--staging-control-plane-evidence", "/private/tmp/control.json",
    "--staging-control-plane-verification-key", "/private/tmp/control.pub",
    "--staging-control-plane-trust-policy", "/private/tmp/control-trust.json",
    "--canary-hmac-key", "/private/tmp/canary.key",
    "--output", "/private/tmp/replay-evidence.json",
    "--producer-signing-key", "/private/tmp/producer.key",
    "--producer-key-id", "release-producer-v1",
    "--candidate-tag", candidate.tag,
    "--expected-version", candidate.version,
    "--expected-revision", candidate.sourceRevision,
    "--image-digest", candidate.imageDigest,
    "--max-concurrency", "4",
    "--per-run-budget-cap-usd", "3",
  ];
}

describe("historical browser replay gate", () => {
  test("retains all 73 submissions, including duplicate prompts, and reserves exact tier ceilings", () => {
    const corpus = parseHistoricalReplayCorpus(corpusValue());
    expect(corpus.submissionCount).toBe(73);
    expect(corpus.scenarios).toHaveLength(73);
    expect(corpus.scenarios[0]!.prompt).toBe(corpus.scenarios[1]!.prompt);
    expect(corpus.maximumResearchBudgetUsd).toBe(59.25);
    expect(HISTORICAL_REPLAY_REQUIRED_CANARY_RESERVE_USD).toBe(3);
    expect(corpus.requiredBudgetReservationUsd).toBe(62.25);
    expect(MAXIMUM_STAGING_MONTHLY_COST_USD).toBe(75);
  });

  test("rejects a sampled or malformed corpus instead of silently weakening the gate", () => {
    const sampled = corpusValue();
    sampled.scenarios.pop();
    sampled.submissionCount = sampled.scenarios.length;
    expect(() => parseHistoricalReplayCorpus(sampled)).toThrow(
      /requires all 73 submissions/u,
    );
    const changed = corpusValue();
    changed.scenarios[0]!.prompt = " altered wording ";
    expect(() => parseHistoricalReplayCorpus(changed)).toThrow(
      /invalid prompt/u,
    );
  });

  test("refuses production, requires exact staging origin, confirmation, and bounded concurrency", () => {
    expect(parseHistoricalReplayArgs(runArgs(), {
      RELEASE_STAGING_ORIGIN: origin,
      RELEASE_PRODUCTION_ORIGIN: "https://9enio.com",
    })).toMatchObject({
      mode: "run",
      origin,
      maximumConcurrency: 4,
      perRunBudgetCapUsd: 3,
      confirmStagingWrites: true,
    });
    expect(() => parseHistoricalReplayArgs(
      runArgs("https://9enio.com"),
      {
        RELEASE_STAGING_ORIGIN: "https://9enio.com",
        RELEASE_PRODUCTION_ORIGIN: "https://9enio.com",
      },
    )).toThrow(/production host/u);
    expect(() => parseHistoricalReplayArgs(
      runArgs("https://other-staging.example"),
      { RELEASE_STAGING_ORIGIN: origin },
    )).toThrow(/exactly match/u);
    expect(() => parseHistoricalReplayArgs(
      runArgs().filter((value) => value !== "--confirm-staging-writes"),
      { RELEASE_STAGING_ORIGIN: origin },
    )).toThrow(/confirm-staging-writes/u);
    const excessive = runArgs();
    excessive[excessive.indexOf("--max-concurrency") + 1] = "5";
    expect(() => parseHistoricalReplayArgs(
      excessive,
      { RELEASE_STAGING_ORIGIN: origin },
    )).toThrow(/1 through 4/u);
  });

  test("requires the signed ledger to reserve the corpus and existing canaries", () => {
    const corpus = parseHistoricalReplayCorpus(corpusValue());
    expect(() => assertHistoricalReplayBudget({
      corpus,
      perRunBudgetCapUsd: 3,
      budgetRemainingUsd: 62.25,
      reservedForRequiredGatesUsd: 62.25,
    })).not.toThrow();
    expect(() => assertHistoricalReplayBudget({
      corpus,
      perRunBudgetCapUsd: 3,
      budgetRemainingUsd: 62.249999,
      reservedForRequiredGatesUsd: 62.25,
    })).toThrow(/cannot reserve/u);
    expect(() => assertHistoricalReplayBudget({
      corpus,
      perRunBudgetCapUsd: 1.5,
      budgetRemainingUsd: 75,
      reservedForRequiredGatesUsd: 75,
    })).toThrow(/per-run cap/u);
  });

  test("adds signed reuse-disabled markers while preserving prompt bytes and count", () => {
    const secret = "release-canary-secret-that-is-at-least-thirty-two-bytes";
    const prompt = "Exact punctuation and wording: keep it!";
    const tagged = historicalReplayTaggedRequestBody({
      operation: "brief",
      body: {
        prompt,
        targetTrackCount: 50,
        idempotencyKey: "browser-owned-key",
      },
      expectedPrompt: prompt,
      expectedTrackCount: 50,
      canaryId: "hist-private-001",
      origin,
      sourceRevision: candidate.sourceRevision,
      secret,
    });
    expect(tagged.prompt).toBe(prompt);
    expect(tagged.targetTrackCount).toBe(50);
    expect(verifyReleaseCanaryMetadata(tagged.releaseCanary, {
      secret,
      expectedEnvironment: "staging",
      expectedAudience: origin,
      expectedOperation: "brief",
      expectedSourceRevision: candidate.sourceRevision,
    })).toMatchObject({
      canaryId: "hist-private-001",
      cacheMode: "reuse_disabled",
    });
    expect(() => historicalReplayTaggedRequestBody({
      operation: "brief",
      body: {
        prompt: `${prompt} changed`,
        targetTrackCount: 50,
      },
      expectedPrompt: prompt,
      expectedTrackCount: 50,
      canaryId: "hist-private-001",
      origin,
      sourceRevision: candidate.sourceRevision,
      secret,
    })).toThrow(/changed the historical prompt/u);
  });

  test("classifies only visible actionable decisions or bounded retries and rejects integrity failures", () => {
    expect(classifyHistoricalReplayRunState({
      run: safeRun({
        status: "needs_decision",
        resolution: {
          state: "needs_decision",
          nextAction: "review_contract",
          terminal: false,
          blockerKind: "",
          nextRetryAt: null,
          automaticRetryUntil: null,
        },
        decisionActionPresent: true,
      }),
      expectedTrackCount: 50,
      actionableDecisionVisible: true,
      dependencyRetryVisible: false,
    })).toBe("actionable_decision");
    expect(classifyHistoricalReplayRunState({
      run: safeRun({
        status: "failed_system",
        resolution: {
          state: "blocked_dependency",
          nextAction: "wait_for_dependency",
          terminal: false,
          blockerKind: "provider",
          nextRetryAt: "2026-07-24T12:05:00.000Z",
          automaticRetryUntil: "2026-07-25T12:00:00.000Z",
        },
      }),
      expectedTrackCount: 50,
      actionableDecisionVisible: false,
      dependencyRetryVisible: true,
      now: "2026-07-24T12:00:00.000Z",
    })).toBe("visible_retry");
    expect(() => classifyHistoricalReplayRunState({
      run: safeRun({
        status: "failed_system",
        resolution: {
          state: "blocked_dependency",
          nextAction: "wait_for_dependency",
          terminal: false,
          blockerKind: "provider",
          nextRetryAt: null,
          automaticRetryUntil: null,
        },
      }),
      expectedTrackCount: 50,
      actionableDecisionVisible: false,
      dependencyRetryVisible: true,
      now: "2026-07-24T12:00:00.000Z",
    })).toThrow(/no authoritative bounded retry metadata/u);
    for (const resolution of [
      {
        state: "blocked_dependency",
        nextAction: "wait_for_dependency",
        terminal: false,
        blockerKind: "provider",
        nextRetryAt: "2026-07-25T12:00:00.000Z",
        automaticRetryUntil: "2026-07-26T12:00:00.000Z",
      },
      {
        state: "blocked_dependency",
        nextAction: "wait_for_dependency",
        terminal: false,
        blockerKind: "provider",
        nextRetryAt: "2026-07-24T13:00:00.000Z",
        automaticRetryUntil: "2026-07-24T12:30:00.000Z",
      },
      {
        state: "blocked_dependency",
        nextAction: "wait_for_dependency",
        terminal: true,
        blockerKind: "provider",
        nextRetryAt: "2026-07-24T12:05:00.000Z",
        automaticRetryUntil: "2026-07-25T12:00:00.000Z",
      },
    ]) {
      expect(() => classifyHistoricalReplayRunState({
        run: safeRun({ status: "failed_system", resolution }),
        expectedTrackCount: 50,
        actionableDecisionVisible: false,
        dependencyRetryVisible: true,
        now: "2026-07-24T12:00:00.000Z",
      })).toThrow(/no authoritative bounded retry metadata/u);
    }
    expect(() => classifyHistoricalReplayRunState({
      run: safeRun({ targetTrackCount: 49 }),
      expectedTrackCount: 50,
      actionableDecisionVisible: false,
      dependencyRetryVisible: false,
    })).toThrow(/changed the original exact count/u);
    expect(() => classifyHistoricalReplayRunState({
      run: safeRun({
        status: "partial",
        publishedTrackCount: 42,
        appendedTrackCount: 42,
        resolution: {
          state: "needs_decision",
          nextAction: "decide_verified_partial",
          terminal: false,
          blockerKind: "",
          nextRetryAt: null,
          automaticRetryUntil: null,
        },
      }),
      expectedTrackCount: 50,
      actionableDecisionVisible: true,
      dependencyRetryVisible: false,
    })).toThrow(/already contains published tracks/u);
    expect(() => classifyHistoricalReplayRunState({
      run: safeRun({
        status: "failed_integrity",
        resolution: {
          state: "quarantined",
          nextAction: "contact_support",
          terminal: true,
          blockerKind: "integrity",
          nextRetryAt: null,
          automaticRetryUntil: null,
        },
      }),
      expectedTrackCount: 50,
      actionableDecisionVisible: true,
      dependencyRetryVisible: false,
    })).toThrow(/technical or integrity quarantine/u);
  });

  test("does not relabel transient or misconfigured artist lookup as a valid user outcome", () => {
    expect(() => classifyHistoricalReplayPreRunArtistState({
      apiCode: "artist_identity_resolution_configuration",
      retryAlreadyAttempted: false,
      editableInputVisible: true,
      typedIdentityOptionsVisible: false,
    })).toThrow(/not configured/u);
    expect(classifyHistoricalReplayPreRunArtistState({
      apiCode: "artist_identity_resolution_retryable",
      retryAlreadyAttempted: false,
      editableInputVisible: false,
      typedIdentityOptionsVisible: false,
    })).toBe("retry_once");
    expect(() => classifyHistoricalReplayPreRunArtistState({
      apiCode: "artist_identity_resolution_retryable",
      retryAlreadyAttempted: true,
      editableInputVisible: false,
      typedIdentityOptionsVisible: false,
    })).toThrow(/did not become a durable dependency blocker/u);
    expect(classifyHistoricalReplayPreRunArtistState({
      apiCode: "exact_artist_identity_clarification_required",
      retryAlreadyAttempted: false,
      editableInputVisible: true,
      typedIdentityOptionsVisible: false,
    })).toBe("actionable_decision");
    expect(classifyHistoricalReplayPreRunArtistState({
      apiCode: "exact_artist_identity_clarification_required",
      retryAlreadyAttempted: false,
      editableInputVisible: false,
      typedIdentityOptionsVisible: true,
    })).toBe("actionable_decision");
    expect(() => classifyHistoricalReplayPreRunArtistState({
      apiCode: "exact_artist_identity_clarification_required",
      retryAlreadyAttempted: false,
      editableInputVisible: false,
      typedIdentityOptionsVisible: false,
    })).toThrow(/no editable input or typed identity choice/u);
  });

  test("runs every submission without de-duplicating and honors concurrency", async () => {
    const corpus = parseHistoricalReplayCorpus(corpusValue());
    let active = 0;
    let maximumActive = 0;
    const seen: number[] = [];
    const driver: HistoricalReplayBrowserDriver = {
      async runScenario(scenario, ordinal) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        seen.push(ordinal);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return {
          ordinal,
          targetTrackCount: scenario.targetTrackCount,
          outcome: ordinal % 3 === 0
            ? "actionable_decision"
            : "exact_original",
          guidanceSubmissionCount: 0,
          briefMarkerCount: 1,
          runMarkerCount: 1,
          freshRunCount: 1,
          countIntegrityCheckCount: ordinal % 3 === 0 ? 0 : 1,
          transcriptCommitment: hash(
            "0123456789abcdef"[ordinal % 16]!,
          ),
        };
      },
      async close() {},
    };
    const results = await runHistoricalReplayCorpus({
      corpus,
      driver,
      maximumConcurrency: 4,
    });
    expect(results).toHaveLength(73);
    expect(new Set(seen).size).toBe(73);
    expect(seen).toContain(1);
    expect(seen).toContain(2);
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(4);
  });

  test("emits only aggregate hash/count evidence and verifies the protected producer", () => {
    const corpus = parseHistoricalReplayCorpus(corpusValue());
    const results = replayResults("exact_after_guidance");
    const payload = createHistoricalReplayEvidencePayload({
      candidate,
      origin,
      runtimeSnapshot: runtimeSnapshot(),
      controlPlaneEvidenceHash: hash("c"),
      serviceInventoryHash: hash("d"),
      corpus,
      results,
      maximumConcurrency: 4,
      perRunBudgetCapUsd: 3,
      generatedAt: "2026-07-24T13:00:00.000Z",
    });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = signHistoricalReplayEvidence({
      payload,
      signingKey: privateKey,
      keyId: "release-producer-v1",
    });
    const serialized = JSON.stringify(signed);
    expect(serialized).not.toContain("Repeated private regression request");
    expect(serialized).not.toContain("private-run-001");
    expect(serialized).not.toContain('"prompt"');
    expect(serialized).not.toContain('"runId"');
    expect(payload.outcomes).toMatchObject({
      completedSubmissionCount: 73,
      exactAfterGuidanceCount: 73,
      unexplainedTerminalCount: 0,
      countViolationCount: 0,
      integrityViolationCount: 0,
      budgetExhaustionCount: 0,
    });
    expect(verifyHistoricalReplayEvidence({
      value: signed,
      verificationKey: publicKey,
      trustPolicy: releaseGateProducerTrustPolicyV1({
        approvedKeyId: "release-producer-v1",
        approvedKeySha256: releaseGateProducerKeyFingerprint(publicKey),
      }),
      expectedCandidate: candidate,
      origin,
      runtimeSnapshot: runtimeSnapshot(),
      controlPlaneEvidenceHash: hash("c"),
      serviceInventoryHash: hash("d"),
      now: "2026-07-24T13:01:00.000Z",
    })).toEqual(payload);
    expect(() => assertHistoricalReplayEvidenceIsSanitized(
      { prompt: "private material" },
      [],
    )).toThrow(/private field/u);
  });

  test("rejects weakened, artifact-bearing, incomplete, or stale evidence", () => {
    const corpus = parseHistoricalReplayCorpus(corpusValue());
    const payload = createHistoricalReplayEvidencePayload({
      candidate,
      origin,
      runtimeSnapshot: runtimeSnapshot(),
      controlPlaneEvidenceHash: hash("c"),
      serviceInventoryHash: hash("d"),
      corpus,
      results: replayResults(),
      maximumConcurrency: 4,
      perRunBudgetCapUsd: 3,
      generatedAt: "2026-07-24T13:00:00.000Z",
    });
    const artifacts = structuredClone(payload);
    artifacts.browser.screenshotCount = 1 as 0;
    expect(() => validateHistoricalReplayEvidencePayload(artifacts))
      .toThrow(/browser proof/u);
    const incomplete = structuredClone(payload);
    incomplete.outcomes.completedSubmissionCount = 72;
    expect(() => validateHistoricalReplayEvidencePayload(incomplete))
      .toThrow(/outcomes are incomplete/u);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = signHistoricalReplayEvidence({
      payload,
      signingKey: privateKey,
      keyId: "release-producer-v1",
    });
    expect(() => verifyHistoricalReplayEvidence({
      value: signed,
      verificationKey: publicKey,
      trustPolicy: releaseGateProducerTrustPolicyV1({
        approvedKeyId: "release-producer-v1",
        approvedKeySha256: releaseGateProducerKeyFingerprint(publicKey),
      }),
      expectedCandidate: candidate,
      origin,
      runtimeSnapshot: runtimeSnapshot(),
      controlPlaneEvidenceHash: hash("c"),
      serviceInventoryHash: hash("d"),
      now: "2026-07-25T13:00:00.000Z",
    })).toThrow(/expired/u);
  });

  test("makes the exact signed 73-query aggregate a mandatory typed release gate", () => {
    const corpus = parseHistoricalReplayCorpus(corpusValue());
    const snapshot = runtimeSnapshot();
    const payload = createHistoricalReplayEvidencePayload({
      candidate,
      origin,
      runtimeSnapshot: snapshot,
      controlPlaneEvidenceHash: hash("c"),
      serviceInventoryHash: hash("d"),
      corpus,
      results: replayResults(),
      maximumConcurrency: 4,
      perRunBudgetCapUsd: 3,
      generatedAt: "2026-07-24T13:00:00.000Z",
    });
    payload.corpus.commitmentHash =
      HISTORICAL_REPLAY_CORPUS_COMMITMENT_SHA256;
    const innerKeys = generateKeyPairSync("ed25519");
    const signed = signHistoricalReplayEvidence({
      payload,
      signingKey: innerKeys.privateKey,
      keyId: "historical-replay-test-v1",
    });
    const publicKeyPem = innerKeys.publicKey.export({
      format: "pem",
      type: "spki",
    }).toString();
    const gateCandidate = {
      ...candidate,
      sitesSourceRevision: candidate.sourceRevision,
    };
    const sources = {
      historicalReplay: signed,
      historicalReplayVerificationKey: {
        schemaVersion:
          "genio-historical-browser-replay-verification-key/v1",
        algorithm: "Ed25519",
        keyId: "historical-replay-test-v1",
        publicKeyPem,
        publicKeySha256:
          releaseGateProducerKeyFingerprint(innerKeys.publicKey),
      },
      historicalReplayTrust: releaseGateProducerTrustPolicyV1({
        approvedKeyId: "historical-replay-test-v1",
        approvedKeySha256:
          releaseGateProducerKeyFingerprint(innerKeys.publicKey),
      }),
    };
    const artifact = createReleaseGateArtifactFromSources({
      gate: "staging_historical_replay",
      completedAt: payload.generatedAt,
      candidate: gateCandidate,
      configurationHash: snapshot.configurationHash,
      runtimeHash: snapshot.runtimeHash,
      fixtures: [],
      sources,
    });
    expect(validateReleaseGateArtifact(artifact)).toEqual(artifact);
    expect(artifact.proof.assertions).toEqual({
      all_historical_submissions_replayed: true,
      original_prompt_and_count_unchanged: true,
      no_unexplained_dead_ends: true,
      result_reuse_disabled: true,
      privacy_safe_aggregate_only: true,
      qa_budget_reserved: true,
      exact_candidate_runtime_configuration: true,
    });
    expect(JSON.stringify(artifact)).not.toContain(
      "Repeated private regression request",
    );
    expect(() => createReleaseGateArtifactFromSources({
      gate: "staging_historical_replay",
      completedAt: payload.generatedAt,
      candidate: gateCandidate,
      configurationHash: "0".repeat(64),
      runtimeHash: snapshot.runtimeHash,
      fixtures: [],
      sources,
    })).toThrow(/runtime configuration/u);
  });

  test("uses typed fail-closed errors without requiring raw query text", () => {
    try {
      parseHistoricalReplayCorpus({ submissionCount: 0, scenarios: [] });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HistoricalReplayGateError);
      expect((error as HistoricalReplayGateError).code)
        .toBe("corpus_submission_count_mismatch");
      expect((error as Error).message).not.toContain(
        "Repeated private regression request",
      );
    }
  });
});
