import { describe, expect, test } from "vitest";
import {
  assertHostedPublication,
  assertHostedRuntime,
  hostedPublicationEvidence,
  parseHostedSmokeArgs,
  recommendedGuidanceAnswers,
  recommendedGuidanceSubmission,
} from "../scripts/hosted-publication-smoke.ts";

const promotedRevision = "c".repeat(40);

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
      attempts: [{
        stage: "research",
        status: "complete",
        executorRevision: promotedRevision,
        executorIdentityHash: "d".repeat(64),
        configurationHash: "e".repeat(64),
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
  test("parses a bounded exact public request and normalizes its origin", () => {
    expect(parseHostedSmokeArgs([
      "--confirm-live-write",
      "--origin", "https://9enio.com:443",
      "--prompt", "Rio de Janeiro songs",
      "--count", "50",
      "--canary-id", "affected-regression",
      "--expected-revision", "A".repeat(40),
      "--expected-version", "2.3.5",
      "--environment", "staging",
      "--cache-mode", "cold",
    ])).toMatchObject({
      confirmLiveWrite: true,
      origin: "https://9enio.com",
      prompt: "Rio de Janeiro songs",
      targetTrackCount: 50,
      canaryId: "affected-regression",
      expectedRevision: "a".repeat(40),
      expectedVersion: "2.3.5",
      environment: "staging",
      cacheMode: "cold",
    });
  });

  test("refuses an unconfirmed write, an unsafe origin, and counts the public API rejects", () => {
    expect(() => parseHostedSmokeArgs([])).toThrow(/confirm-live-write/u);
    expect(() => parseHostedSmokeArgs([
      "--confirm-live-write", "--origin", "http://9enio.com",
      "--canary-id", "fixed-control",
      "--expected-revision", "a".repeat(40),
      "--expected-version", "2.3.5",
      "--environment", "production",
      "--cache-mode", "cold",
    ])).toThrow(/HTTPS origin/u);
    expect(() => parseHostedSmokeArgs([
      "--confirm-live-write", "--count", "301",
      "--canary-id", "fixed-control",
      "--expected-revision", "a".repeat(40),
      "--expected-version", "2.3.5",
      "--environment", "production",
      "--cache-mode", "cold",
    ])).toThrow(/1 to 300/u);
    expect(() => parseHostedSmokeArgs([
      "--confirm-live-write",
      "--canary-id", "fixed-control",
      "--expected-revision", "main",
      "--expected-version", "2.3.5",
      "--environment", "production",
      "--cache-mode", "cold",
    ])).toThrow(/full Git revision/u);
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
  });

  test("accepts only a complete exact publication with valid Apple volume links", () => {
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      completedResult(),
      3,
      promotedRevision,
    )).not.toThrow();
    expect(() => assertHostedPublication(
      { status: "failed" },
      completedResult(),
      3,
      promotedRevision,
    )).toThrow(/status failed/u);
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      { ...completedResult(), completedTracks: 2 },
      3,
      promotedRevision,
    )).toThrow(/completed 2 tracks instead of 3/u);
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      {
        ...completedResult(),
        volumes: [{ ...completedResult().volumes[0], shareUrl: "https://example.com/not-apple" }],
      },
      3,
      promotedRevision,
    )).toThrow(/valid public Apple Music link/u);
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      {
        ...completedResult(),
        volumes: [{ ...completedResult().volumes[0], startPosition: 1, endPosition: 3 }],
      },
      3,
      promotedRevision,
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
    )).toThrow(/exact ordered IDs/u);
  });

  test("binds the smoke to schema 18, protocol 10, contract 3, query-plan 4, and the exact build", () => {
    const live = {
      build: { version: "2.3.5", revision: "a".repeat(40) },
      runtime: {
        deploymentPhase: "activate",
        expectedDatabaseSchemaVersion: "18",
        canonicalActivationConfigured: true,
        schemaVersion: "18",
        schemaMaximum: "18",
        schemaPreferred: "18",
        workerProtocol: "playlist-pipeline-v10",
        queryPlanSchemaVersion: "4",
        briefContractVersion: "3",
      },
    };
    expect(() => assertHostedRuntime(live, "a".repeat(40), "2.3.5")).not.toThrow();
    expect(() => assertHostedRuntime({
      ...live,
      runtime: { ...live.runtime, queryPlanSchemaVersion: "3" },
    }, "a".repeat(40), "2.3.5")).toThrow(/queryPlanSchemaVersion/u);
    expect(() => assertHostedRuntime({
      ...live,
      runtime: {
        ...live.runtime,
        deploymentPhase: "expand",
        canonicalActivationConfigured: false,
      },
    }, "a".repeat(40), "2.3.5")).toThrow(/deploymentPhase/u);
  });

  test("emits canary evidence without run, capability, or Apple library identifiers", () => {
    const evidence = hostedPublicationEvidence(completedResult(), 3, "fixed-control");
    expect(evidence).toMatchObject({
      canaryId: "fixed-control",
      cacheMode: "cold",
      targetTrackCount: 3,
      serverReportedOrderedAppleReconciliation: true,
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("manifest-1");
    expect(serialized).not.toContain("p.hosted-smoke");
  });
});
