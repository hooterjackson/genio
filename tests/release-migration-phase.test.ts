import { describe, expect, test } from "vitest";
import {
  buildReleaseMigrationPhaseEvidence,
  parseReleaseMigrationVerificationArgs,
  releaseMigrationObservation,
} from "../scripts/verify-release-migration-phase.ts";

const revision = "a".repeat(40);
const configurationHash = "b".repeat(64);

function observation(input: {
  observedAt: string;
  heartbeatAt: string;
  phase?: "bridge" | "expand";
  schema?: string;
  canonicalActivationConfigured?: boolean;
  briefContractVersion?: string;
  queryPlanSchemaVersion?: string;
  revision?: string;
}) {
  const phase = input.phase ?? "bridge";
  const schema = input.schema ?? "16";
  return releaseMigrationObservation({
    observedAt: input.observedAt,
    livePayload: {
      build: { version: "2.4.0", revision: input.revision ?? revision },
      runtime: {
        deploymentPhase: phase,
        expectedDatabaseSchemaVersion: schema,
        canonicalActivationConfigured: input.canonicalActivationConfigured ?? false,
        schemaMinimum: "13",
        schemaMaximum: "18",
        workerProtocol: "playlist-pipeline-v10",
        briefContractVersion: input.briefContractVersion ?? "2",
        queryPlanSchemaVersion: input.queryPlanSchemaVersion ?? "3",
      },
    },
    readyHttpStatus: 200,
    readyPayload: { ok: true, database: true, schemaVersion: schema },
    systemHttpStatus: 200,
    systemPayload: {
      ok: true,
      activationReady: true,
      schemaVersion: schema,
      workerLanes: {
        interactive: {
          status: "healthy",
          protocolVersion: "playlist-pipeline-v10",
          compatibleCapacity: 2,
          eligibleWorkerCount: 1,
          eligibleRevisions: [input.revision ?? revision],
          eligibleConfigurationHashes: [configurationHash],
          lastSeenAt: input.heartbeatAt,
        },
        deep: {
          status: "healthy",
          protocolVersion: "playlist-pipeline-v10",
          compatibleCapacity: 1,
          eligibleWorkerCount: 1,
          eligibleRevisions: [input.revision ?? revision],
          eligibleConfigurationHashes: [configurationHash],
          lastSeenAt: input.heartbeatAt,
        },
      },
    },
  });
}

describe("release migration phase verification", () => {
  test("parses only explicit bridge or schema-18 expand probes", () => {
    expect(parseReleaseMigrationVerificationArgs([
      "--origin", "https://api-staging.example",
      "--expected-revision", revision,
      "--expected-version", "2.4.0",
      "--expected-schema", "16",
      "--phase", "bridge",
    ])).toMatchObject({
      origin: "https://api-staging.example",
      expectedRevision: revision,
      expectedVersion: "2.4.0",
      expectedSchemaVersion: "16",
      phase: "bridge",
      samples: 2,
    });
    expect(() => parseReleaseMigrationVerificationArgs([
      "--origin", "https://api-staging.example",
      "--expected-revision", revision,
      "--expected-version", "2.4.0",
      "--expected-schema", "17",
      "--phase", "expand",
    ])).toThrow(/requires --expected-schema 18/u);
  });

  test("proves the same bridge artifact and two advancing protocol-10 worker lanes", () => {
    const evidence = buildReleaseMigrationPhaseEvidence({
      origin: "https://api-staging.example",
      expectedRevision: revision,
      expectedVersion: "2.4.0",
      expectedDatabaseSchemaVersion: "16",
      phase: "bridge",
      expectedSamples: 2,
      generatedAt: "2026-07-23T12:00:30.000Z",
      observations: [
        observation({
          observedAt: "2026-07-23T12:00:00.000Z",
          heartbeatAt: "2026-07-23T11:59:55.000Z",
        }),
        observation({
          observedAt: "2026-07-23T12:00:30.000Z",
          heartbeatAt: "2026-07-23T12:00:25.000Z",
        }),
      ],
    });
    expect(evidence).toMatchObject({
      schemaVersion: "genio-release-migration-phase/v1",
      passed: true,
      violations: [],
      expected: {
        revision,
        databaseSchemaVersion: "16",
        phase: "bridge",
      },
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  test("proves schema 18 while canonical/schema-4 emission remains disabled during expand", () => {
    const evidence = buildReleaseMigrationPhaseEvidence({
      origin: "https://api-staging.example",
      expectedRevision: revision,
      expectedVersion: "2.4.0",
      expectedDatabaseSchemaVersion: "18",
      phase: "expand",
      expectedSamples: 2,
      generatedAt: "2026-07-23T12:00:30.000Z",
      observations: [
        observation({
          phase: "expand",
          schema: "18",
          observedAt: "2026-07-23T12:00:00.000Z",
          heartbeatAt: "2026-07-23T11:59:55.000Z",
        }),
        observation({
          phase: "expand",
          schema: "18",
          observedAt: "2026-07-23T12:00:30.000Z",
          heartbeatAt: "2026-07-23T12:00:25.000Z",
        }),
      ],
    });
    expect(evidence.passed).toBe(true);
  });

  test("fails on early canonical activation, stale heartbeats, or a different artifact", () => {
    const evidence = buildReleaseMigrationPhaseEvidence({
      origin: "https://api-staging.example",
      expectedRevision: revision,
      expectedVersion: "2.4.0",
      expectedDatabaseSchemaVersion: "16",
      phase: "bridge",
      expectedSamples: 2,
      generatedAt: "2026-07-23T12:00:30.000Z",
      observations: [
        observation({
          observedAt: "2026-07-23T12:00:00.000Z",
          heartbeatAt: "2026-07-23T11:59:55.000Z",
          canonicalActivationConfigured: true,
          briefContractVersion: "3",
          queryPlanSchemaVersion: "4",
        }),
        observation({
          observedAt: "2026-07-23T12:00:30.000Z",
          heartbeatAt: "2026-07-23T11:59:55.000Z",
          revision: "c".repeat(40),
        }),
      ],
    });
    expect(evidence.passed).toBe(false);
    expect(evidence.violations).toEqual(expect.arrayContaining([
      "sample_1:canonical_activation_enabled_before_activate",
      "sample_1:canonical_emission_not_disabled",
      "sample_2:api_revision:cccccccccccccccccccccccccccccccccccccccc",
      "sample_2:interactive_revision_overlap",
      "sample_2:interactive_heartbeat_not_advanced",
      "sample_2:deep_heartbeat_not_advanced",
    ]));
  });
});
