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
  capability?: "1" | null;
  hardening?: "1" | null;
  proofVersion?: "1" | null;
  proofAuthority?: "shadow" | null;
}) {
  const phase = input.phase ?? "bridge";
  const schema = input.schema ?? (phase === "expand" ? "20" : "19");
  return releaseMigrationObservation({
    observedAt: input.observedAt,
    livePayload: {
      build: { version: "2.4.0", revision: input.revision ?? revision },
      configurationHash,
      runtime: {
        deploymentPhase: phase,
        expectedDatabaseSchemaVersion: schema,
        canonicalActivationConfigured: input.canonicalActivationConfigured ?? false,
        schemaMinimum: "13",
        schemaMaximum: "20",
        workerProtocol: "playlist-pipeline-v12",
        proofArchitectureMode: phase === "expand" ? "shadow" : "off",
        briefContractVersion: input.briefContractVersion ?? "2",
        queryPlanSchemaVersion: input.queryPlanSchemaVersion ?? "3",
      },
    },
    readyHttpStatus: 200,
    readyPayload: {
      ok: true,
      database: true,
      schemaVersion: schema,
      releaseManifestCanaryGuardsVersion: input.capability === undefined
        ? Number(schema) >= 18 ? "1" : null
        : input.capability,
      canonicalExecutionHardeningVersion: input.hardening === undefined
        ? Number(schema) >= 18 ? "1" : null
        : input.hardening,
      proofArchitectureVersion: input.proofVersion === undefined
        ? schema === "20" ? "1" : null
        : input.proofVersion,
      proofArchitectureAuthority: input.proofAuthority === undefined
        ? schema === "20" ? "shadow" : null
        : input.proofAuthority,
    },
    systemHttpStatus: 200,
    systemPayload: {
      ok: true,
      activationReady: true,
      schemaVersion: schema,
      workerLanes: {
        interactive: {
          status: "healthy",
          protocolVersion: "playlist-pipeline-v12",
          compatibleCapacity: 2,
          eligibleWorkerCount: 1,
          eligibleRevisions: [input.revision ?? revision],
          eligibleConfigurationHashes: [configurationHash],
          lastSeenAt: input.heartbeatAt,
        },
        deep: {
          status: "healthy",
          protocolVersion: "playlist-pipeline-v12",
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
  test("parses only an explicit schema-19 bridge or schema-20 expand probe", () => {
    expect(parseReleaseMigrationVerificationArgs([
      "--origin", "https://api-staging.example",
      "--expected-revision", revision,
      "--expected-version", "2.4.0",
      "--expected-schema", "19",
      "--expected-capability", "2",
      "--expected-manifest-canary-guards", "1",
      "--expected-canonical-hardening", "1",
      "--phase", "bridge",
    ])).toMatchObject({
      origin: "https://api-staging.example",
      expectedRevision: revision,
      expectedVersion: "2.4.0",
      expectedSchemaVersion: "19",
      expectedDatabaseCapabilityVersion: "2",
      expectedReleaseManifestCanaryGuardsVersion: "1",
      expectedCanonicalExecutionHardeningVersion: "1",
      expectedProofArchitectureVersion: null,
      expectedProofArchitectureAuthority: null,
      phase: "bridge",
      samples: 2,
    });
    expect(() => parseReleaseMigrationVerificationArgs([
      "--origin", "https://api-staging.example",
      "--expected-revision", revision,
      "--expected-version", "2.4.0",
      "--expected-schema", "17",
      "--expected-capability", "none",
      "--expected-manifest-canary-guards", "none",
      "--expected-canonical-hardening", "none",
      "--phase", "expand",
    ])).toThrow(/bridge verification requires schema 19.*expand.*schema 20/u);
    expect(() => parseReleaseMigrationVerificationArgs([
      "--origin", "https://api-staging.example",
      "--expected-revision", revision,
      "--expected-version", "2.4.0",
      "--expected-schema", "19",
      "--expected-capability", "2",
      "--expected-manifest-canary-guards", "1",
      "--expected-canonical-hardening", "1",
      "--phase", "bridge",
      "--interval-seconds", "0",
    ])).toThrow(/30 through 120/u);
  });

  test("proves the same schema-19 bridge artifact and two advancing protocol-12 worker lanes", () => {
    const evidence = buildReleaseMigrationPhaseEvidence({
      origin: "https://api-staging.example",
      expectedRevision: revision,
      expectedVersion: "2.4.0",
      expectedDatabaseSchemaVersion: "19",
      expectedDatabaseCapabilityVersion: "2",
      expectedReleaseManifestCanaryGuardsVersion: "1",
      expectedCanonicalExecutionHardeningVersion: "1",
      expectedProofArchitectureVersion: null,
      expectedProofArchitectureAuthority: null,
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
      schemaVersion: "genio-release-migration-phase/v2",
      passed: true,
      violations: [],
      expected: {
        revision,
        databaseSchemaVersion: "19",
        databaseCapabilityVersion: "2",
        releaseManifestCanaryGuardsVersion: "1",
        canonicalExecutionHardeningVersion: "1",
        proofArchitectureVersion: null,
        proofArchitectureAuthority: null,
        phase: "bridge",
        minimumObservationSpanMs: 30_000,
      },
      observationSpanMs: 30_000,
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  test("proves schema 20 shadow proof authority while canonical emission remains disabled during expand", () => {
    const evidence = buildReleaseMigrationPhaseEvidence({
      origin: "https://api-staging.example",
      expectedRevision: revision,
      expectedVersion: "2.4.0",
      expectedDatabaseSchemaVersion: "20",
      expectedDatabaseCapabilityVersion: "2",
      expectedReleaseManifestCanaryGuardsVersion: "1",
      expectedCanonicalExecutionHardeningVersion: "1",
      expectedProofArchitectureVersion: "1",
      expectedProofArchitectureAuthority: "shadow",
      phase: "expand",
      expectedSamples: 2,
      generatedAt: "2026-07-23T12:00:30.000Z",
      observations: [
        observation({
          phase: "expand",
          schema: "20",
          observedAt: "2026-07-23T12:00:00.000Z",
          heartbeatAt: "2026-07-23T11:59:55.000Z",
        }),
        observation({
          phase: "expand",
          schema: "20",
          observedAt: "2026-07-23T12:00:30.000Z",
          heartbeatAt: "2026-07-23T12:00:25.000Z",
        }),
      ],
    });
    expect(evidence.passed).toBe(true);
  });

  test("requires composite capability 2 and both marker-1 values during the schema-19 bridge", () => {
    expect(parseReleaseMigrationVerificationArgs([
      "--origin", "https://api-staging.example",
      "--expected-revision", revision,
      "--expected-version", "2.4.0",
      "--expected-schema", "19",
      "--expected-capability", "2",
      "--expected-manifest-canary-guards", "1",
      "--expected-canonical-hardening", "1",
      "--phase", "bridge",
    ])).toMatchObject({
      expectedSchemaVersion: "19",
      expectedDatabaseCapabilityVersion: "2",
      expectedReleaseManifestCanaryGuardsVersion: "1",
      expectedCanonicalExecutionHardeningVersion: "1",
      expectedProofArchitectureVersion: null,
      expectedProofArchitectureAuthority: null,
      phase: "bridge",
    });
    expect(() => parseReleaseMigrationVerificationArgs([
      "--origin", "https://api-staging.example",
      "--expected-revision", revision,
      "--expected-version", "2.4.0",
      "--expected-schema", "19",
      "--expected-capability", "none",
      "--expected-manifest-canary-guards", "none",
      "--expected-canonical-hardening", "none",
      "--phase", "bridge",
    ])).toThrow(/schemas 18 through 20 require composite capability 2/u);

    const evidence = buildReleaseMigrationPhaseEvidence({
      origin: "https://api-staging.example",
      expectedRevision: revision,
      expectedVersion: "2.4.0",
      expectedDatabaseSchemaVersion: "19",
      expectedDatabaseCapabilityVersion: "2",
      expectedReleaseManifestCanaryGuardsVersion: "1",
      expectedCanonicalExecutionHardeningVersion: "1",
      expectedProofArchitectureVersion: null,
      expectedProofArchitectureAuthority: null,
      phase: "bridge",
      expectedSamples: 2,
      generatedAt: "2026-07-23T12:00:30.000Z",
      observations: [
        observation({
          schema: "19",
          capability: null,
          observedAt: "2026-07-23T12:00:00.000Z",
          heartbeatAt: "2026-07-23T11:59:55.000Z",
        }),
        observation({
          schema: "19",
          capability: null,
          observedAt: "2026-07-23T12:00:30.000Z",
          heartbeatAt: "2026-07-23T12:00:25.000Z",
        }),
      ],
    });
    expect(evidence.passed).toBe(false);
    expect(evidence.violations).toEqual(expect.arrayContaining([
      "sample_1:database_capability:missing",
      "sample_2:database_capability:missing",
      "sample_1:manifest_canary_guards:missing",
      "sample_2:manifest_canary_guards:missing",
    ]));
  });

  test("fails on early canonical activation, stale heartbeats, or a different artifact", () => {
    const evidence = buildReleaseMigrationPhaseEvidence({
      origin: "https://api-staging.example",
      expectedRevision: revision,
      expectedVersion: "2.4.0",
      expectedDatabaseSchemaVersion: "19",
      expectedDatabaseCapabilityVersion: "2",
      expectedReleaseManifestCanaryGuardsVersion: "1",
      expectedCanonicalExecutionHardeningVersion: "1",
      expectedProofArchitectureVersion: null,
      expectedProofArchitectureAuthority: null,
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
          queryPlanSchemaVersion: "5",
        }),
      ],
    });
    expect(evidence.passed).toBe(false);
    expect(evidence.violations).toEqual(expect.arrayContaining([
      "sample_1:canonical_activation_enabled_before_activate",
      "sample_1:canonical_emission_not_disabled",
      "sample_2:canonical_emission_not_disabled",
      "sample_2:api_revision:cccccccccccccccccccccccccccccccccccccccc",
      "sample_2:interactive_revision_overlap",
      "sample_2:interactive_heartbeat_not_advanced",
      "sample_2:deep_heartbeat_not_advanced",
    ]));
  });

  test("rejects handcrafted zero-time migration convergence evidence", () => {
    const first = observation({
      observedAt: "2026-07-23T12:00:00.000Z",
      heartbeatAt: "2026-07-23T11:59:55.000Z",
    });
    const evidence = buildReleaseMigrationPhaseEvidence({
      origin: "https://api-staging.example",
      expectedRevision: revision,
      expectedVersion: "2.4.0",
      expectedDatabaseSchemaVersion: "19",
      expectedDatabaseCapabilityVersion: "2",
      expectedReleaseManifestCanaryGuardsVersion: "1",
      expectedCanonicalExecutionHardeningVersion: "1",
      expectedProofArchitectureVersion: null,
      expectedProofArchitectureAuthority: null,
      phase: "bridge",
      expectedSamples: 2,
      generatedAt: "2026-07-23T12:00:00.000Z",
      observations: [
        first,
        {
          ...first,
          workerLanes: {
            interactive: {
              ...first.workerLanes.interactive,
              lastSeenAt: "2026-07-23T11:59:56.000Z",
            },
            deep: {
              ...first.workerLanes.deep,
              lastSeenAt: "2026-07-23T11:59:56.000Z",
            },
          },
        },
      ],
    });
    expect(evidence.passed).toBe(false);
    expect(evidence.observationSpanMs).toBe(0);
    expect(evidence.violations).toContain(
      "observation_span_too_short:0/30000",
    );
  });
});
