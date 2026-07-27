import { describe, expect, test } from "vitest";
import {
  buildReleaseConvergenceEvidence,
  parseReleaseConvergenceArgs,
  releaseConvergenceObservation,
  sitesRevisionFromHtml,
  sitesVersionFromHtml,
} from "../scripts/verify-release-convergence.ts";

const revision = "abcdef0123456789abcdef0123456789abcdef01";
const configurationHash = "1".repeat(64);
const expectedConfigurationHashes = {
  api: configurationHash,
  interactiveWorker: configurationHash,
  deepWorker: configurationHash,
};
const observedAt = "2026-07-23T12:00:00.000Z";
const nextObservedAt = "2026-07-23T12:00:30.000Z";

function observation(overrides: {
  sitesVersion?: string;
  sitesRevision?: string;
  apiRevision?: string;
  apiConfigurationHash?: string;
  interactiveConfigurationHash?: string;
  deepConfigurationHash?: string;
  interactiveRevisions?: string[];
  deepRevisions?: string[];
  observedAt?: string;
  interactiveLastSeenAt?: string;
  deepLastSeenAt?: string;
} = {}) {
  return releaseConvergenceObservation({
    observedAt: overrides.observedAt ?? observedAt,
    sitesHtml: `<html lang="en" data-build-version="${overrides.sitesVersion ?? "2.3.5"}" data-build-revision="${overrides.sitesRevision ?? revision}">`,
    livePayload: {
      configurationHash: overrides.apiConfigurationHash ?? configurationHash,
      build: {
        identifier: `2.3.5+${revision.slice(0, 12)}`,
        version: "2.3.5",
        revision: overrides.apiRevision ?? revision,
      },
      runtime: {
        releaseEnvironment: "production",
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
        queryPlanSchemaVersion: "5",
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
      releaseManifestCanaryGuardsVersion: "1",
      canonicalExecutionHardeningVersion: "1",
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
          eligibleIdentityCount: 1,
          eligibleRevisions: overrides.interactiveRevisions ?? [revision],
          eligibleConfigurationHashes: [
            overrides.interactiveConfigurationHash ?? configurationHash,
          ],
          lastSeenAt: overrides.interactiveLastSeenAt ?? "2026-07-23T11:59:50.000Z",
        },
        deep: {
          status: "healthy",
          protocolVersion: "playlist-pipeline-v10",
          compatibleCapacity: 1,
          eligibleWorkerCount: 1,
          eligibleIdentityCount: 1,
          eligibleRevisions: overrides.deepRevisions ?? [revision],
          eligibleConfigurationHashes: [
            overrides.deepConfigurationHash ?? configurationHash,
          ],
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
      "--interval-seconds", "30",
    ])).toEqual({
      origin: "https://9enio.com",
      scope: "full",
      expectedRevision: revision,
      expectedVersion: "2.3.5",
      expectedSitesRevision: revision,
      expectedSitesVersion: "2.3.5",
      samples: 3,
      intervalMs: 30_000,
    });
    expect(() => parseReleaseConvergenceArgs([
      "--origin", "http://9enio.com",
      "--expected-revision", revision,
      "--expected-version", "2.3.5",
    ])).toThrow(/HTTPS origin/u);
    expect(() => parseReleaseConvergenceArgs([
      "--expected-revision", "main",
      "--expected-version", "2.3.5",
    ])).toThrow(/full hexadecimal Git revision/u);
    expect(() => parseReleaseConvergenceArgs([
      "--expected-revision", revision,
      "--expected-version", "2.3.5",
      "--interval-seconds", "0",
    ])).toThrow(/30 to 120/u);
  });

  test("reads the immutable Sites version marker without executing page scripts", () => {
    expect(sitesVersionFromHtml("<html data-build-version='2.3.5'>")).toBe("2.3.5");
    expect(sitesVersionFromHtml("<html><body>v2.3.5</body></html>")).toBeNull();
    expect(sitesRevisionFromHtml(
      `<html data-build-revision="${revision}">`,
    )).toBe(revision);
    expect(sitesRevisionFromHtml("<html><body>main</body></html>")).toBeNull();
  });

  test("passes only when Sites, API, both worker lanes, and runtime stay converged", () => {
    const result = buildReleaseConvergenceEvidence({
      origin: "https://9enio.com",
      expectedRevision: revision,
      expectedVersion: "2.3.5",
      expectedSamples: 2,
      expectedConfigurationHashes,
      observations: [observation(), observation({
        observedAt: nextObservedAt,
        interactiveLastSeenAt: "2026-07-23T12:00:20.000Z",
        deepLastSeenAt: "2026-07-23T12:00:15.000Z",
      })],
      generatedAt: observedAt,
    });
    expect(result).toMatchObject({
      schemaVersion: "genio-release-convergence/v2",
      scope: "full",
      expected: {
        backend: { revision, version: "2.3.5" },
        sites: {
          revision,
          version: "2.3.5",
          candidateMatched: true,
        },
      },
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
        queryPlanSchemaVersion: "5",
        briefContractVersion: "3",
        baselineProviderModelId: "gpt-5.6-luna",
      },
      system: {
        queue: { failed: 2 },
      },
    });
  });

  test("accepts candidate backend convergence while the exact prior Sites version remains live", () => {
    const priorSitesRevision = "f".repeat(40);
    const result = buildReleaseConvergenceEvidence({
      origin: "https://9enio.com",
      scope: "backend",
      expectedRevision: revision,
      expectedVersion: "2.3.5",
      expectedSitesRevision: priorSitesRevision,
      expectedSitesVersion: "2.3.4",
      expectedSamples: 2,
      expectedConfigurationHashes,
      observations: [
        observation({
          sitesVersion: "2.3.4",
          sitesRevision: priorSitesRevision,
        }),
        observation({
          sitesVersion: "2.3.4",
          sitesRevision: priorSitesRevision,
          observedAt: nextObservedAt,
          interactiveLastSeenAt: "2026-07-23T12:00:20.000Z",
          deepLastSeenAt: "2026-07-23T12:00:15.000Z",
        }),
      ],
      generatedAt: observedAt,
    });
    expect(result).toMatchObject({
      scope: "backend",
      passed: true,
      expected: {
        backend: { revision, version: "2.3.5" },
        sites: {
          revision: priorSitesRevision,
          version: "2.3.4",
          candidateMatched: false,
        },
      },
      violations: [],
    });
  });

  test("fails closed when an old worker overlaps or Sites is still on the prior version", () => {
    const result = buildReleaseConvergenceEvidence({
      origin: "https://9enio.com",
      expectedRevision: revision,
      expectedVersion: "2.3.5",
      expectedSamples: 2,
      expectedConfigurationHashes,
      observations: [
        observation({
          sitesVersion: "2.3.4",
          sitesRevision: "1234567890abcdef",
          interactiveRevisions: [revision, "1234567890abcdef"],
        }),
        observation({
          sitesVersion: "2.3.4",
          sitesRevision: "1234567890abcdef",
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
      "sample_1:sites_revision:missing",
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
      expectedConfigurationHashes,
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
      expectedConfigurationHashes,
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

  test("rejects a stale configuration even when source revision is unchanged", () => {
    const result = buildReleaseConvergenceEvidence({
      origin: "https://9enio.com",
      expectedRevision: revision,
      expectedVersion: "2.3.5",
      expectedSamples: 2,
      expectedConfigurationHashes,
      observations: [
        observation({
          apiConfigurationHash: "9".repeat(64),
          interactiveConfigurationHash: "8".repeat(64),
        }),
        observation({
          observedAt: nextObservedAt,
          apiConfigurationHash: "9".repeat(64),
          interactiveConfigurationHash: "8".repeat(64),
          interactiveLastSeenAt: "2026-07-23T12:00:20.000Z",
          deepLastSeenAt: "2026-07-23T12:00:15.000Z",
        }),
      ],
      generatedAt: nextObservedAt,
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      "sample_1:api_configuration_mismatch",
      "sample_1:interactive_configuration_mismatch",
      "sample_2:api_configuration_mismatch",
      "sample_2:interactive_configuration_mismatch",
    ]));
  });
});
