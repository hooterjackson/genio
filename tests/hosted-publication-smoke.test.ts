import { describe, expect, test } from "vitest";
import {
  assertHostedCanaryStillExact,
  assertHostedPublication,
  assertHostedRuntime,
  expectedHostedGuidanceExecution,
  hostedGuidanceAnswers,
  hostedGuidanceFixtureForRevision,
  hostedGuidanceSubmission,
  hostedPublicationEvidence,
  parseHostedSmokeArgs as parseHostedSmokeArgsWithOrigins,
  recordNewGuidanceQuestionSet,
  recommendedGuidanceAnswers,
  recommendedGuidanceSubmission,
} from "../scripts/hosted-publication-smoke.ts";

const promotedRevision = "c".repeat(40);
const promotedWorkerConfigurationHash = "e".repeat(64);
const promotedApiConfigurationHash = "f".repeat(64);
const activeQueryPlanRevisionId = "00000000-0000-4000-a000-000000000001";
const releaseOrigins = {
  RELEASE_STAGING_ORIGIN: "https://staging.9enio.example",
  RELEASE_PRODUCTION_ORIGIN: "https://9enio.com",
};

function parseHostedSmokeArgs(argv: readonly string[]) {
  return parseHostedSmokeArgsWithOrigins(argv, releaseOrigins);
}

function hostedProducerArgs(
  fixtureId = "smooth-reggaeton-heat-50-v1",
  environment = "staging",
  origin = environment === "staging"
    ? "https://staging.9enio.example"
    : "https://9enio.com",
): string[] {
  const version = "2.4.0";
  return [
    "--origin", origin,
    "--fixture-id", fixtureId,
    "--candidate-tag", `v${version}-rc.2`,
    "--expected-revision", "a".repeat(40),
    "--expected-version", version,
    "--image-digest", `sha256:${"b".repeat(64)}`,
    "--environment", environment,
    "--cache-mode", "reuse_disabled",
    "--runtime-snapshot", "/tmp/runtime-snapshot.json",
    "--source-output", "/tmp/source.json",
    "--output", "/tmp/gate.json",
    "--attestation-output", "/tmp/gate.attestation.json",
    "--producer-signing-key", "/tmp/producer.pem",
    "--producer-key-id", "release-producer-v1",
  ];
}

function completedResult(trackCount = 3) {
  return {
    status: "complete",
    error: null,
    manifest: {
      id: "manifest-1",
      name: "Hosted smoke",
      contentHash: "a".repeat(64),
      trackCount,
    },
    totalTracks: trackCount,
    completedTracks: trackCount,
    volumes: [{
      index: 1,
      status: "complete",
      trackCount,
      appendedCount: trackCount,
      playlistId: "p.hosted-smoke",
      shareUrl: "https://music.apple.com/us/playlist/hosted-smoke/pl.test",
      startPosition: 0,
      endPosition: trackCount - 1,
      total: 1,
    }],
    executionProof: {
      contractRevision: 1,
      contractHash: "b".repeat(64),
      answerLineageHash: "7".repeat(64),
      queryPlanRevisionId: activeQueryPlanRevisionId,
      guidanceLineage: [] as Array<Record<string, unknown>>,
      attempts: [{
        stage: "research",
        status: "complete",
        executorRevision: promotedRevision,
        executorIdentityHash: "d".repeat(64),
        configurationHash: promotedWorkerConfigurationHash,
        queryPlanRevisionId: activeQueryPlanRevisionId,
        startedAt: "2026-07-23T12:00:00.000Z",
        completedAt: "2026-07-23T12:01:00.000Z",
      }],
      publicationReconciliation: {
        state: "complete",
        expectedCount: trackCount,
        appendedCount: trackCount,
        batchCursor: trackCount,
        expectedOrderedIdsHash: "f".repeat(64),
        observedOrderedIdsHash: "f".repeat(64),
        orderedIdsVerified: true,
        completedAt: "2026-07-23T12:02:00.000Z",
      },
    },
  };
}

describe("hosted publication smoke harness", () => {
  test("parses only a code-owned promotable fixture", () => {
    expect(parseHostedSmokeArgs([
      "--confirm-live-write",
      ...hostedProducerArgs(),
    ])).toMatchObject({
      confirmLiveWrite: true,
      origin: "https://staging.9enio.example",
      fixtureId: "smooth-reggaeton-heat-50-v1",
      gate: "staging_affected_regression",
      targetTrackCount: 50,
      expectedRevision: "a".repeat(40),
      expectedVersion: "2.4.0",
      environment: "staging",
      cacheMode: "reuse_disabled",
    });
  });

  test("rejects caller-owned prompts, counts, and guidance semantics", () => {
    expect(() => parseHostedSmokeArgs([
      "--confirm-live-write",
      ...hostedProducerArgs(),
      "--prompt", "caller controlled",
    ])).toThrow(/Unknown argument/u);
    expect(() => parseHostedSmokeArgs([
      "--confirm-live-write",
      ...hostedProducerArgs(),
      "--count", "49",
    ])).toThrow(/Unknown argument/u);
    expect(() => parseHostedSmokeArgs([
      "--confirm-live-write",
      ...hostedProducerArgs(),
      "--guidance-mode", "alternate",
    ])).toThrow(/Unknown argument/u);
  });

  test("refuses unconfirmed writes, unsafe origins, and unapproved production fixtures", () => {
    expect(() => parseHostedSmokeArgs([])).toThrow(/confirm-live-write/u);
    expect(() => parseHostedSmokeArgs([
      "--confirm-live-write",
      ...hostedProducerArgs(
        "fixed-three-track-control-v1",
        "production",
        "http://9enio.com",
      ),
    ])).toThrow(/HTTPS origin/u);
    expect(() => parseHostedSmokeArgs([
      "--confirm-live-write",
      ...hostedProducerArgs("french-jazz-guided-constraint-25-v1", "production"),
    ])).toThrow(/not an approved production/u);
    expect(() => parseHostedSmokeArgsWithOrigins([
      "--confirm-live-write",
      ...hostedProducerArgs(
        "fixed-three-track-control-v1",
        "production",
        "https://attacker.example",
      ),
    ], releaseOrigins)).toThrow(/exactly match RELEASE_PRODUCTION_ORIGIN/u);
    expect(() => parseHostedSmokeArgsWithOrigins([
      "--confirm-live-write",
      ...hostedProducerArgs("fixed-three-track-control-v1", "production"),
    ], {})).toThrow(/RELEASE_PRODUCTION_ORIGIN is required/u);
  });

  test("selects exactly one server-recommended option per grounded question", () => {
    expect(recommendedGuidanceAnswers({
      questions: [{
        id: "period",
        options: [
          { id: "classic", recommended: false },
          { id: "modern", recommended: true },
          { id: "survey", recommended: false },
        ],
      }],
    })).toEqual([{ questionId: "period", optionId: "modern" }]);
    expect(recommendedGuidanceAnswers({
      questions: [{
        id: "breadth",
        options: [
          { id: "core", recommended: false },
          { id: "adjacent", recommended: true },
        ],
      }],
    })).toEqual([{ questionId: "breadth", optionId: "adjacent" }]);
  });

  test("binds hosted answers to the exact server-owned question-set revision", () => {
    expect(recommendedGuidanceSubmission({
      questionSetHash: "A".repeat(64),
      questions: [{
        id: "period",
        options: [
          { id: "classic", recommended: false },
          { id: "modern", recommended: true },
          { id: "survey", recommended: false },
        ],
      }],
    })).toEqual({
      questionSetHash: "a".repeat(64),
      answers: [{ questionId: "period", optionId: "modern" }],
    });
    expect(() => recommendedGuidanceSubmission({
      questions: [{
        id: "period",
        options: [
          { id: "classic", recommended: false },
          { id: "modern", recommended: true },
          { id: "survey", recommended: false },
        ],
      }],
    })).toThrow(/question-set hash/u);
  });

  test("selects deterministic recommended and alternate server-owned options", () => {
    const payload = {
      questionSetHash: "b".repeat(64),
      questions: [{
        id: "breadth",
        criticality: "required",
        allowCustom: true,
        options: [
          { id: "core", recommended: false },
          { id: "adjacent", recommended: true },
          { id: "broad", recommended: false },
        ],
      }],
    };
    expect(hostedGuidanceSubmission(payload)).toEqual({
      questionSetHash: "b".repeat(64),
      answers: [{ questionId: "breadth", optionId: "adjacent" }],
    });
    expect(hostedGuidanceSubmission(payload, "alternate")).toEqual({
      questionSetHash: "b".repeat(64),
      answers: [{ questionId: "breadth", optionId: "core" }],
    });
  });

  test("supports custom and optional-skip fixtures while failing closed on unsupported semantics", () => {
    const optional = {
      questions: [{
        id: "flow",
        criticality: "optional",
        allowCustom: true,
        options: [
          { id: "smooth", recommended: true },
          { id: "contrast", recommended: false },
        ],
      }],
    };
    expect(hostedGuidanceAnswers(optional, "custom", "Build energy gradually")).toEqual([
      { questionId: "flow", customText: "Build energy gradually" },
    ]);
    expect(() => hostedGuidanceAnswers({
      questions: [
        optional.questions[0],
        { ...optional.questions[0], id: "energy" },
      ],
    }, "custom", "Build energy gradually")).toThrow(/exactly one question axis/u);
    expect(hostedGuidanceAnswers(optional, "skipped")).toEqual([
      { questionId: "flow", skipped: true },
    ]);
    expect(() => hostedGuidanceAnswers({
      questions: [{
        ...optional.questions[0],
        allowCustom: false,
      }],
    }, "custom", "Build energy gradually")).toThrow(/does not support a custom answer/u);
    expect(() => hostedGuidanceAnswers({
      questions: [{
        ...optional.questions[0],
        criticality: "required",
      }],
    }, "skipped")).toThrow(/cannot be skipped/u);
  });

  test("uses a server-owned confirmation after the first custom revision", () => {
    expect(hostedGuidanceFixtureForRevision(
      "custom",
      "Mostly women, clean, and no Bad Bunny",
      false,
    )).toEqual({
      mode: "custom",
      customText: "Mostly women, clean, and no Bad Bunny",
    });
    expect(hostedGuidanceFixtureForRevision(
      "custom",
      "Mostly women, clean, and no Bad Bunny",
      true,
    )).toEqual({
      mode: "recommended",
      customText: null,
    });
  });

  test("binds the selected typed patch to the final guidance lineage", () => {
    const execution = expectedHostedGuidanceExecution({
      questions: [{
        id: "breadth",
        options: [{
          id: "adjacent",
          contractPatch: {
            operations: [{
              op: "set_playlist_constraints",
              constraints: [{ id: "core-share", minimumShare: 0.7 }],
            }],
          },
        }],
      }],
    }, {
      questionSetHash: "a".repeat(64),
      answers: [{ questionId: "breadth", optionId: "adjacent" }],
    });
    expect(execution).toMatchObject({
      questionSetHash: "a".repeat(64),
      executionDeltaHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const result = completedResult();
    result.executionProof.guidanceLineage = [{
      ...execution,
      baseContractHash: "1".repeat(64),
      resultingContractHash: "2".repeat(64),
      affectedClauseIds: ["guidance:quota:core-reggaeton-share"],
      acceptedAt: "2026-07-23T12:00:30.000Z",
    }];
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      result,
      3,
      promotedRevision,
      [promotedWorkerConfigurationHash],
      [execution],
    )).not.toThrow();
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      result,
      3,
      promotedRevision,
      [promotedWorkerConfigurationHash],
      [{ ...execution, executionDeltaHash: "3".repeat(64) }],
    )).toThrow(/guidance did not reach/u);
  });

  test("rejects repeated question-set revisions before another answer submission", () => {
    const seen = new Set<string>();
    recordNewGuidanceQuestionSet(seen, "a".repeat(64));
    expect(seen).toEqual(new Set(["a".repeat(64)]));
    expect(() => recordNewGuidanceQuestionSet(seen, "a".repeat(64)))
      .toThrow(/already answered/u);
    recordNewGuidanceQuestionSet(seen, "b".repeat(64), 2);
    expect(() => recordNewGuidanceQuestionSet(seen, "c".repeat(64), 2))
      .toThrow(/2-revision/u);
  });

  test("rejects malformed hosted guidance instead of silently choosing the first option", () => {
    expect(() => recommendedGuidanceAnswers({ questions: [] })).toThrow(/1–3 valid questions/u);
    expect(() => recommendedGuidanceAnswers({
      questions: [{
        id: "period",
        options: [
          { id: "classic", recommended: false },
          { id: "modern", recommended: false },
          { id: "survey", recommended: false },
        ],
      }],
    })).toThrow(/exactly one recommendation/u);
    expect(() => hostedGuidanceAnswers({
      questions: [
        {
          id: "period",
          options: [
            { id: "classic", recommended: false },
            { id: "modern", recommended: true },
          ],
        },
        {
          id: "period",
          options: [
            { id: "early", recommended: true },
            { id: "late", recommended: false },
          ],
        },
      ],
    })).toThrow(/ID is repeated/u);
  });

  test("accepts only a complete exact publication with valid Apple volume links", () => {
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      completedResult(),
      3,
      promotedRevision,
      [promotedWorkerConfigurationHash],
    )).not.toThrow();
    expect(() => assertHostedPublication(
      { status: "failed" },
      completedResult(),
      3,
      promotedRevision,
      [promotedWorkerConfigurationHash],
    )).toThrow(/status failed/u);
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      { ...completedResult(), completedTracks: 2 },
      3,
      promotedRevision,
      [promotedWorkerConfigurationHash],
    )).toThrow(/completed 2 tracks instead of 3/u);
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      {
        ...completedResult(),
        volumes: [{ ...completedResult().volumes[0], shareUrl: "https://example.com/not-apple" }],
      },
      3,
      promotedRevision,
      [promotedWorkerConfigurationHash],
    )).toThrow(/valid public Apple Music link/u);
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      {
        ...completedResult(),
        volumes: [{ ...completedResult().volumes[0], startPosition: 1, endPosition: 3 }],
      },
      3,
      promotedRevision,
      [promotedWorkerConfigurationHash],
    )).toThrow(/ordered manifest range/u);
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      {
        ...completedResult(),
        executionProof: {
          ...completedResult().executionProof,
          attempts: [{
            ...completedResult().executionProof.attempts[0],
            executorRevision: "a".repeat(40),
          }],
        },
      },
      3,
      promotedRevision,
      [promotedWorkerConfigurationHash],
    )).toThrow(/promoted worker artifact/u);
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      {
        ...completedResult(),
        executionProof: {
          ...completedResult().executionProof,
          attempts: [{
            ...completedResult().executionProof.attempts[0],
            configurationHash: "9".repeat(64),
          }],
        },
      },
      3,
      promotedRevision,
      [promotedWorkerConfigurationHash],
    )).toThrow(/promoted worker artifact/u);
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      {
        ...completedResult(),
        executionProof: {
          ...completedResult().executionProof,
          attempts: [{
            ...completedResult().executionProof.attempts[0],
            queryPlanRevisionId:
              "00000000-0000-4000-a000-000000000002",
          }],
        },
      },
      3,
      promotedRevision,
      [promotedWorkerConfigurationHash],
    )).toThrow(/promoted worker artifact/u);
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      {
        ...completedResult(),
        executionProof: {
          ...completedResult().executionProof,
          publicationReconciliation: {
            ...completedResult().executionProof.publicationReconciliation,
            orderedIdsVerified: false,
          },
        },
      },
      3,
      promotedRevision,
      [promotedWorkerConfigurationHash],
    )).toThrow(/exact ordered IDs/u);
  });

  test("fails immediately on bounded deadlines and non-exact decision states", () => {
    expect(() => assertHostedCanaryStillExact(
      { status: "researching" },
      10_000,
      9_999,
    )).not.toThrow();
    expect(() => assertHostedCanaryStillExact(
      { status: "researching" },
      10_000,
      10_000,
    )).toThrow(/bounded deadline/u);
    expect(() => assertHostedCanaryStillExact(
      { status: "blocked_dependency" },
      10_000,
      1,
    )).toThrow(/non-exact decision/u);
    expect(() => assertHostedCanaryStillExact(
      { status: "researching", resolution: { state: "needs_decision" } },
      10_000,
      1,
    )).toThrow(/non-exact decision/u);
    expect(() => assertHostedCanaryStillExact(
      { status: "quarantined" },
      10_000,
      1,
    )).toThrow(/non-exact decision/u);
  });

  test("binds the smoke to schema 19, protocol 11, contract 3, query-plan 6, and the exact build", () => {
    const live = {
      build: { version: "2.3.5", revision: "a".repeat(40) },
      configurationHash: promotedApiConfigurationHash,
      runtime: {
        releaseEnvironment: "staging",
        deploymentPhase: "activate",
        expectedDatabaseSchemaVersion: "19",
        canonicalActivationConfigured: true,
        schemaVersion: "19",
        schemaMaximum: "19",
        schemaPreferred: "19",
        workerProtocol: "playlist-pipeline-v11",
        queryPlanSchemaVersion: "6",
        briefContractVersion: "3",
      },
    };
    expect(() => assertHostedRuntime(
      live,
      "a".repeat(40),
      "2.3.5",
      "staging",
      promotedApiConfigurationHash,
    )).not.toThrow();
    expect(() => assertHostedRuntime({
      ...live,
      runtime: { ...live.runtime, queryPlanSchemaVersion: "3" },
    }, "a".repeat(40), "2.3.5", "staging", promotedApiConfigurationHash))
      .toThrow(/queryPlanSchemaVersion/u);
    expect(() => assertHostedRuntime({
      ...live,
      runtime: {
        ...live.runtime,
        deploymentPhase: "expand",
        canonicalActivationConfigured: false,
      },
    }, "a".repeat(40), "2.3.5", "staging", promotedApiConfigurationHash))
      .toThrow(/deploymentPhase/u);
    expect(() => assertHostedRuntime({
      ...live,
      configurationHash: "9".repeat(64),
    }, "a".repeat(40), "2.3.5", "staging", promotedApiConfigurationHash))
      .toThrow(/configuration does not match/u);
  });

  test("emits canary evidence without run, capability, or Apple library identifiers", () => {
    const independentAppleEvidenceHash = "8".repeat(64);
    const evidence = hostedPublicationEvidence(
      completedResult(),
      3,
      "fixed-control",
      "reuse_disabled",
      independentAppleEvidenceHash,
      [promotedWorkerConfigurationHash],
    );
    expect(evidence).toMatchObject({
      canaryId: "fixed-control",
      cacheMode: "reuse_disabled",
      targetTrackCount: 3,
      serverReportedOrderedAppleReconciliation: true,
      independentAppleEvidenceHash,
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("manifest-1");
    expect(serialized).not.toContain("p.hosted-smoke");
    expect(() => hostedPublicationEvidence(
      completedResult(),
      3,
      "fixed-control",
      "reuse_disabled",
      "not-a-hash",
      [promotedWorkerConfigurationHash],
    )).toThrow(/Independent Apple evidence hash/u);
  });
});
