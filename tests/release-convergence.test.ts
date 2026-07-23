import { describe, expect, test } from "vitest";
import {
  buildReleaseConvergenceEvidence,
  parseReleaseConvergenceArgs,
  releaseConvergenceObservation,
  sitesVersionFromHtml,
} from "../scripts/verify-release-convergence.ts";

const revision = "abcdef0123456789abcdef0123456789abcdef01";
const configurationHash = "1".repeat(64);
const observedAt = "2026-07-23T12:00:00.000Z";
const nextObservedAt = "2026-07-23T12:00:30.000Z";

function observation(overrides: {
  sitesVersion?: string;
  apiRevision?: string;
  interactiveRevisions?: string[];
  deepRevisions?: string[];
  observedAt?: string;
  interactiveLastSeenAt?: string;
  deepLastSeenAt?: string;
} = {}) {
  return releaseConvergenceObservation({
    observedAt: overrides.observedAt ?? observedAt,
    sitesHtml: `<html lang="en" data-build-version="${overrides.sitesVersion ?? "2.3.5"}">`,
    livePayload: {
      build: {
        identifier: `2.3.5+${revision.slice(0, 12)}`,
        version: "2.3.5",
        revision: overrides.apiRevision ?? revision,
      },
      runtime: {
        deploymentPhase: "activate",
        expectedDatabaseSchemaVersion: "18",
        canonicalActivationConfigured: true,
        schemaVersion: "18",
        schemaMinimum: "13",
        schemaMaximum: "18",
        schemaPreferred: "18",
        workerProtocol: "playlist-pipeline-v10",
        minimumWorkerProtocol: "playlist-pipeline-v8",
        selectionPlanVersion: "selection_plan_v3",
        queryPlanSchemaVersion: "4",
        briefContractVersion: "3",
        guidancePolicyVersion: "adaptive_guidance_v3",
        baselineProviderModelId: "gpt-5.6-luna",
      },
    },
    systemHttpStatus: 200,
    systemPayload: {
      ok: true,
      activationReady: true,
      database: "ready",
      paused: false,
      workerProtocol: {
        expected: "playlist-pipeline-v10",
        minimumAccepted: "playlist-pipeline-v8",
        actual: "playlist-pipeline-v10",
      },
      workerLanes: {
        interactive: {
          status: "healthy",
          protocolVersion: "playlist-pipeline-v10",
          compatibleCapacity: 2,
          eligibleWorkerCount: 1,
          eligibleRevisions: overrides.interactiveRevisions ?? [revision],
          eligibleConfigurationHashes: [configurationHash],
          lastSeenAt: overrides.interactiveLastSeenAt ?? "2026-07-23T11:59:50.000Z",
        },
        deep: {
          status: "healthy",
          protocolVersion: "playlist-pipeline-v10",
          compatibleCapacity: 1,
          eligibleWorkerCount: 1,
          eligibleRevisions: overrides.deepRevisions ?? [revision],
          eligibleConfigurationHashes: [configurationHash],
          lastSeenAt: overrides.deepLastSeenAt ?? "2026-07-23T11:59:45.000Z",
        },
      },
      queue: {
        queued: 0,
        leased: 0,
        expiredLeases: 0,
        failed: 2,
        oldestQueuedSeconds: 0,
      },
    },
  });
}

describe("release convergence evidence", () => {
  test("parses only bounded HTTPS probes with an explicit artifact identity", () => {
    expect(parseReleaseConvergenceArgs([
      "--origin", "https://9enio.com:443",
      "--expected-revision", revision.toUpperCase(),
      "--expected-version", "2.3.5",
      "--samples", "3",
      "--interval-seconds", "10",
    ])).toEqual({
      origin: "https://9enio.com",
      expectedRevision: revision,
      expectedVersion: "2.3.5",
      samples: 3,
      intervalMs: 10_000,
    });
    expect(() => parseReleaseConvergenceArgs([
      "--origin", "http://9enio.com",
      "--expected-revision", revision,
      "--expected-version", "2.3.5",
    ])).toThrow(/HTTPS origin/u);
    expect(() => parseReleaseConvergenceArgs([
      "--expected-revision", "main",
      "--expected-version", "2.3.5",
    ])).toThrow(/hexadecimal Git revision/u);
  });

  test("reads the immutable Sites version marker without executing page scripts", () => {
    expect(sitesVersionFromHtml("<html data-build-version='2.3.5'>")).toBe("2.3.5");
    expect(sitesVersionFromHtml("<html><body>v2.3.5</body></html>")).toBeNull();
  });

  test("passes only when Sites, API, both worker lanes, and runtime stay converged", () => {
    const result = buildReleaseConvergenceEvidence({
      origin: "https://9enio.com",
      expectedRevision: revision,
      expectedVersion: "2.3.5",
      expectedSamples: 2,
      observations: [observation(), observation({
        observedAt: nextObservedAt,
        interactiveLastSeenAt: "2026-07-23T12:00:20.000Z",
        deepLastSeenAt: "2026-07-23T12:00:15.000Z",
      })],
      generatedAt: observedAt,
    });
    expect(result).toMatchObject({
      schemaVersion: "genio-release-convergence/v1",
      passed: true,
      violations: [],
      expiresAt: "2026-07-24T12:00:00.000Z",
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(result.observations[0]).toMatchObject({
      runtime: {
        deploymentPhase: "activate",
        expectedDatabaseSchemaVersion: "18",
        canonicalActivationConfigured: true,
        schemaVersion: "18",
        workerProtocol: "playlist-pipeline-v10",
        queryPlanSchemaVersion: "4",
        briefContractVersion: "3",
        baselineProviderModelId: "gpt-5.6-luna",
      },
      system: {
        queue: { failed: 2 },
      },
    });
  });

  test("fails closed when an old worker overlaps or Sites is still on the prior version", () => {
    const result = buildReleaseConvergenceEvidence({
      origin: "https://9enio.com",
      expectedRevision: revision,
      expectedVersion: "2.3.5",
      expectedSamples: 2,
      observations: [
        observation({
          sitesVersion: "2.3.4",
          interactiveRevisions: [revision, "1234567890abcdef"],
        }),
        observation({
          sitesVersion: "2.3.4",
          interactiveRevisions: [revision, "1234567890abcdef"],
          observedAt: nextObservedAt,
          interactiveLastSeenAt: "2026-07-23T12:00:20.000Z",
          deepLastSeenAt: "2026-07-23T12:00:15.000Z",
        }),
      ],
      generatedAt: observedAt,
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      "sample_1:sites_version:2.3.4",
      expect.stringContaining("sample_1:interactive_revisions:"),
    ]));
  });

  test("rejects a converged old schema or contract even when every component agrees", () => {
    const old = observation();
    old.runtime = {
      ...old.runtime,
      deploymentPhase: "expand",
      canonicalActivationConfigured: false,
      schemaVersion: "17",
      schemaMaximum: "17",
      schemaPreferred: "17",
      workerProtocol: "playlist-pipeline-v9",
      queryPlanSchemaVersion: "3",
      briefContractVersion: "2",
    };
    old.system.workerProtocol = {
      expected: "playlist-pipeline-v9",
      minimumAccepted: "playlist-pipeline-v8",
      actual: "playlist-pipeline-v9",
    };
    old.system.workerLanes.interactive.protocolVersion = "playlist-pipeline-v9";
    old.system.workerLanes.deep.protocolVersion = "playlist-pipeline-v9";
    const result = buildReleaseConvergenceEvidence({
      origin: "https://9enio.com",
      expectedRevision: revision,
      expectedVersion: "2.3.5",
      expectedSamples: 2,
      observations: [
        old,
        {
          ...old,
          observedAt: nextObservedAt,
          system: {
            ...old.system,
            workerLanes: {
              interactive: {
                ...old.system.workerLanes.interactive,
                lastSeenAt: "2026-07-23T12:00:20.000Z",
              },
              deep: {
                ...old.system.workerLanes.deep,
                lastSeenAt: "2026-07-23T12:00:15.000Z",
              },
            },
          },
        },
      ],
      generatedAt: observedAt,
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      "sample_1:runtime_schemaVersion:17",
      "sample_1:runtime_deploymentPhase:expand",
      "sample_1:runtime_canonicalActivationConfigured:false",
      "sample_1:runtime_workerProtocol:playlist-pipeline-v9",
      "sample_1:runtime_queryPlanSchemaVersion:3",
      "sample_1:runtime_briefContractVersion:2",
    ]));
  });

  test("rejects replaying the same worker heartbeat across convergence samples", () => {
    const result = buildReleaseConvergenceEvidence({
      origin: "https://9enio.com",
      expectedRevision: revision,
      expectedVersion: "2.3.5",
      expectedSamples: 2,
      observations: [
        observation(),
        observation({ observedAt: nextObservedAt }),
      ],
      generatedAt: observedAt,
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      "sample_2:interactive_heartbeat_not_advanced",
      "sample_2:deep_heartbeat_not_advanced",
    ]));
  });
});
