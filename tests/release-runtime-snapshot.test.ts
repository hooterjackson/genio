import { describe, expect, test } from "vitest";
import { apiReleaseConfigurationHash } from "../server/runtime-release.ts";
import {
  buildReleaseRuntimeSnapshot,
  parseReleaseSecretVersions,
  REQUIRED_RELEASE_SECRET_VERSION_NAMES,
  sitesBuildIdentityFromHtml,
} from "../scripts/release-runtime-snapshot.ts";
import { validateRuntimeSnapshot } from "../scripts/release-evidence.ts";

const revision = "a".repeat(40);
const hash = "b".repeat(64);
const sitesConfigurationHash = "2".repeat(64);
const semanticExecutionConfigurationHash = "f".repeat(64);

function live(configurationHash = hash) {
  const build = {
    identifier: `2.4.0+${revision.slice(0, 12)}`,
    version: "2.4.0",
    revision,
  };
  return {
    ok: true,
    build,
    api: {
      schemaVersion: "genio-api-runtime-identity/v1",
      replicaIdentityHash: "6".repeat(64),
      build,
      configurationHash,
      semanticExecutionConfigurationHash,
    },
    configurationHash,
    runtime: {
      ownerAllowlistVersion: "owner-allowlist-v1",
      semanticExecutionConfigurationHash,
      releaseEnvironment: "staging",
      deploymentPhase: "activate",
      workerProtocol: "playlist-pipeline-v11",
      briefContractVersion: "3",
      queryPlanSchemaVersion: "6",
      briefProviderModelId: "gpt-5.4-mini",
      baselineProviderModelId: "gpt-5.6-luna",
      escalationProviderModelId: "gpt-5.6-terra",
      publicRolloutEvidenceHash: null,
      publicRolloutStage: null,
      guidancePolicyVersion: "adaptive_guidance_v4",
      evidencePolicyVersion: "governed_evidence_v2",
      queryPlanPolicyVersion: "query_plan_v3_4",
      selectionPlanVersion: "selection_plan_v3",
      semanticScopePolicyVersion: "scope_gate_v2_1_2",
      musicConceptPolicyVersion: "music_concepts_v3_4_0",
      pipelinePolicyVersion: "corpus_first_v3",
      promptVersion: "grounded_recovery_v3_1_prompt_v1",
    },
  };
}

function lane(configurationHash: string) {
  return {
    status: "healthy",
    protocolVersion: "playlist-pipeline-v11",
    compatibleCapacity: 1,
    eligibleWorkerCount: 1,
    eligibleIdentityCount: 1,
    candidateExecutorIdentityReady: true,
    eligibleRevisions: [revision],
    eligibleConfigurationHashes: [configurationHash],
    eligibleSemanticExecutionConfigurationHashes: [
      semanticExecutionConfigurationHash,
    ],
  };
}

function system() {
  return {
    ok: true,
    activationReady: true,
    database: "ready",
    schemaVersion: "19",
    releaseManifestCanaryGuardsVersion: "1",
    canonicalExecutionHardeningVersion: "1",
    canonicalExecutorReleaseIdentityFencingVersion: "1",
    executorFencing: {
      ready: true,
      incompleteJobs: 0,
      mismatchedActiveAttempts: 0,
      uncoveredJobs: 0,
      requirements: [],
    },
    api: {
      schemaVersion: "genio-api-runtime-identity/v1",
      replicaIdentityHash: "7".repeat(64),
      build: {
        identifier: `2.4.0+${revision.slice(0, 12)}`,
        version: "2.4.0",
        revision,
      },
      configurationHash: hash,
      semanticExecutionConfigurationHash,
    },
    publicRollout: {
      active: false,
      databaseAuthorized: true,
      evidenceHash: null,
      stage: null,
      targetConfigurationHash: null,
    },
    paused: false,
    workerLanes: {
      interactive: lane("c".repeat(64)),
      deep: lane("d".repeat(64)),
    },
  };
}

function secretVersions(value = "e".repeat(64)) {
  return {
    schemaVersion: "genio-release-secret-versions/v2",
    environment: "staging",
    versions: Object.fromEntries(REQUIRED_RELEASE_SECRET_VERSION_NAMES.map(
      (name, index) => [name, index === 0 ? value : String((index % 9) + 1).repeat(64)],
    )),
  };
}

function snapshot(overrides: Partial<Parameters<typeof buildReleaseRuntimeSnapshot>[0]> = {}) {
  return buildReleaseRuntimeSnapshot({
    origin: "https://staging-9enio.example",
    environment: "staging",
    scope: "full",
    expectedRevision: revision,
    expectedVersion: "2.4.0",
    sitesHtml:
      `<html data-build-version="2.4.0" data-build-revision="${revision}">`,
    sitesConfigurationHashes: Array(3).fill(sitesConfigurationHash),
    sitesOwnerAllowlistVersions: Array(3).fill("owner-allowlist-v1"),
    livePayload: live(),
    systemPayload: system(),
    systemHttpStatus: 200,
    secretVersions: secretVersions(),
    generatedAt: "2026-07-23T18:00:00.000Z",
    ...overrides,
  });
}

describe("authoritative release runtime snapshot", () => {
  test("binds Sites, API, both worker lanes, runtime, and secret versions", () => {
    expect(snapshot()).toMatchObject({
      schemaVersion: "genio-release-runtime-snapshot/v3",
      environment: "staging",
      scope: "full",
      candidate: { version: "2.4.0", sourceRevision: revision },
      sitesObservation: {
        version: "2.4.0",
        sourceRevision: revision,
        configurationHash: sitesConfigurationHash,
        ownerAllowlistVersion: "owner-allowlist-v1",
        candidateMatched: true,
      },
      apiObservations: {
        liveReplicaIdentityHash: "6".repeat(64),
        systemReplicaIdentityHash: "7".repeat(64),
      },
      executorFencing: {
        version: "1",
        ready: true,
        incompleteJobs: 0,
        mismatchedActiveAttempts: 0,
        uncoveredJobs: 0,
        requirementsHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      configuration: {
        apiHash: hash,
        interactiveWorkerHash: "c".repeat(64),
        deepWorkerHash: "d".repeat(64),
        sitesHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      runtime: {
        semanticExecutionConfigurationHash,
        releaseEnvironment: "staging",
        databaseSchemaVersion: "19",
        databaseCapabilityVersion: "2",
        releaseManifestCanaryGuardsVersion: "1",
        canonicalExecutionHardeningVersion: "1",
        workerProtocol: "playlist-pipeline-v11",
        modelIds: {
          brief: "gpt-5.4-mini",
          baseline: "gpt-5.6-luna",
          escalation: "gpt-5.6-terra",
        },
      },
      publicRollout: {
        active: false,
        databaseAuthorized: true,
        evidenceHash: null,
        stage: null,
        targetConfigurationHash: null,
      },
    });
    expect(snapshot().configurationHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(snapshot().runtimeHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(snapshot().snapshotHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("separates pre-Sites production promotion from final full-domain proof", () => {
    const previousSitesRevision = "9".repeat(40);
    const productionBackend = snapshot({
      origin: "https://9enio.com",
      environment: "production",
      scope: "backend",
      sitesHtml:
        `<html data-build-version="2.3.9" data-build-revision="${previousSitesRevision}">`,
      sitesOwnerAllowlistVersions: Array(3).fill("owner-allowlist-v0"),
      livePayload: {
        ...live(),
        runtime: {
          ...live().runtime,
          releaseEnvironment: "production",
        },
      },
      secretVersions: {
        ...secretVersions(),
        environment: "production",
      },
    });
    expect(productionBackend).toMatchObject({
      environment: "production",
      scope: "backend",
      sitesObservation: {
        version: "2.3.9",
        sourceRevision: previousSitesRevision,
        ownerAllowlistVersion: "owner-allowlist-v0",
        candidateMatched: false,
      },
    });
    expect(validateRuntimeSnapshot(
      productionBackend,
      "production",
      "backend",
    )).toEqual(productionBackend);
    expect(() => validateRuntimeSnapshot({
      ...productionBackend,
      origin: "https://candidate-production.example",
    }, "production", "backend")).toThrow(
      /canonical https:\/\/9enio\.com origin/u,
    );
    expect(() => validateRuntimeSnapshot(
      productionBackend,
      "production",
      "full",
    )).toThrow(/scope/u);

    expect(() => snapshot({
      environment: "staging",
      scope: "backend",
    })).toThrow(/production-only/u);
    expect(() => snapshot({
      origin: "https://9enio.com",
      environment: "production",
      scope: "backend",
      livePayload: {
        ...live(),
        runtime: {
          ...live().runtime,
          releaseEnvironment: "production",
        },
      },
      secretVersions: {
        ...secretVersions(),
        environment: "production",
      },
    })).toThrow(/pre-candidate Sites deployment/u);
    expect(() => snapshot({
      scope: "full",
      sitesHtml:
        `<html data-build-version="2.3.9" data-build-revision="${previousSitesRevision}">`,
    })).toThrow(/full-scope Sites build identity/u);
  });

  test("fails closed on source drift, worker overlap, and raw secret values", () => {
    expect(() => snapshot({
      sitesHtml:
        `<html data-build-version="2.4.0" data-build-revision="${"9".repeat(40)}">`,
    })).toThrow(/Sites build identity/u);
    expect(() => snapshot({
      sitesConfigurationHashes: [
        sitesConfigurationHash,
        "3".repeat(64),
        sitesConfigurationHash,
      ],
    })).toThrow(/changed across release probes/u);
    expect(() => snapshot({
      sitesOwnerAllowlistVersions: [
        "owner-allowlist-v1",
        "owner-allowlist-v2",
        "owner-allowlist-v1",
      ],
    })).toThrow(/owner allowlist version/u);
    const unidentified = system();
    unidentified.workerLanes.deep.eligibleWorkerCount = 2;
    expect(() => snapshot({ systemPayload: unidentified }))
      .toThrow(/deep worker lane is not healthy/u);
    const overlapping = system();
    overlapping.workerLanes.deep.eligibleRevisions.push("9".repeat(40));
    expect(() => snapshot({ systemPayload: overlapping }))
      .toThrow(/exclusively on the candidate revision/u);
    const semanticDrift = system();
    semanticDrift.workerLanes.deep
      .eligibleSemanticExecutionConfigurationHashes = ["9".repeat(64)];
    expect(() => snapshot({ systemPayload: semanticDrift }))
      .toThrow(/semantic execution configuration does not match the API/u);
    const mixedApi = system();
    mixedApi.api.build.revision = "9".repeat(40);
    expect(() => snapshot({ systemPayload: mixedApi }))
      .toThrow(/system health API runtime identity does not match the candidate/u);
    const mixedConfiguration = system();
    mixedConfiguration.api.configurationHash = "9".repeat(64);
    expect(() => snapshot({ systemPayload: mixedConfiguration }))
      .toThrow(/system health API runtime identity does not match the candidate/u);
    const mixedSemanticIdentity = system();
    mixedSemanticIdentity.api.semanticExecutionConfigurationHash =
      "9".repeat(64);
    expect(() => snapshot({ systemPayload: mixedSemanticIdentity }))
      .toThrow(/system health API runtime identity does not match the candidate/u);
    expect(() => parseReleaseSecretVersions({
      ...secretVersions(),
      versions: {
        ...secretVersions().versions,
        providerProject: "sk-not-a-version-hash",
      },
    })).toThrow(/SHA-256 digest/u);
    expect(() => parseReleaseSecretVersions({
      ...secretVersions(),
      versions: { providerProject: "1".repeat(64) },
    })).toThrow(/missing or unapproved/u);
    expect(() => parseReleaseSecretVersions({
      ...secretVersions(),
      environment: "production",
    }, "staging")).toThrow(/release environment/u);
  });

  test("changes the aggregate when API config or secret versions change", () => {
    const changedLive = live("9".repeat(64));
    const changedSystem = system();
    changedSystem.api.configurationHash = "9".repeat(64);
    expect(snapshot({
      livePayload: changedLive,
      systemPayload: changedSystem,
    }).configurationHash).not.toBe(snapshot().configurationHash);
    expect(snapshot({
      secretVersions: secretVersions("8".repeat(64)),
    }).configuration.secretVersionsHash)
      .not.toBe(snapshot().configuration.secretVersionsHash);
  });

  test("binds active rollout runtime markers to exact database authority", () => {
    const evidenceHash = "7".repeat(64);
    const targetConfigurationHash = "8".repeat(64);
    const stage = "genre_scene:50->100";
    const activeLive = {
      ...live(),
      runtime: {
        ...live().runtime,
        publicRolloutEvidenceHash: evidenceHash,
        publicRolloutStage: stage,
      },
    };
    const activeSystem = {
      ...system(),
      publicRollout: {
        active: true,
        databaseAuthorized: true,
        evidenceHash,
        stage,
        targetConfigurationHash,
      },
    };
    expect(snapshot({
      livePayload: activeLive,
      systemPayload: activeSystem,
    }).publicRollout).toEqual(activeSystem.publicRollout);

    expect(() => snapshot({
      livePayload: {
        ...activeLive,
        runtime: {
          ...activeLive.runtime,
          publicRolloutEvidenceHash: "9".repeat(64),
        },
      },
      systemPayload: activeSystem,
    })).toThrow(/does not match its database authority/u);
    expect(() => snapshot({
      livePayload: activeLive,
      systemPayload: {
        ...activeSystem,
        publicRollout: {
          ...activeSystem.publicRollout,
          databaseAuthorized: false,
        },
      },
    })).toThrow(/was not read from the database/u);
    expect(() => snapshot({
      systemPayload: {
        ...system(),
        publicRollout: {
          ...system().publicRollout,
          evidenceHash,
        },
      },
    })).toThrow(/stale runtime or database markers/u);
  });

  test("extracts only full Sites build identities", () => {
    expect(sitesBuildIdentityFromHtml(
      `<html data-build-version=2.4.0 data-build-revision="${revision}">`,
    )).toEqual({ version: "2.4.0", sourceRevision: revision });
    expect(() => sitesBuildIdentityFromHtml(
      "<html data-build-version=2.4.0>",
    )).toThrow(/full Git revision/u);
  });

  test("fails closed when runtime and requested environments differ", () => {
    expect(() => snapshot({
      livePayload: {
        ...live(),
        runtime: {
          ...live().runtime,
          releaseEnvironment: "production",
        },
      },
    })).toThrow(/schema-19\/protocol-11 release contract/u);
  });

  test("does not derive composite capability 2 unless both database markers are 1", () => {
    for (const field of [
      "releaseManifestCanaryGuardsVersion",
      "canonicalExecutionHardeningVersion",
    ] as const) {
      expect(() => snapshot({
        systemPayload: {
          ...system(),
          [field]: "0",
        },
      })).toThrow(/composite capability requires both authoritative marker-1 values/u);
      expect(() => snapshot({
        systemPayload: Object.fromEntries(
          Object.entries(system()).filter(([key]) => key !== field),
        ),
      })).toThrow(/composite capability requires both authoritative marker-1 values/u);
    }
  });

  test("API configuration identity is deterministic, secret-insensitive, and behavior-sensitive", () => {
    const environment = {
      RELEASE_DEPLOYMENT_PHASE: "activate",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "19",
      OPENAI_API_KEY: "sk-first",
      PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
    };
    const first = apiReleaseConfigurationHash(environment);
    expect(apiReleaseConfigurationHash({
      ...environment,
      OPENAI_API_KEY: "sk-second",
    })).toBe(first);
    expect(apiReleaseConfigurationHash({
      ...environment,
      PIPELINE_V3_ASSIGNMENT_ENABLED: "false",
    })).not.toBe(first);
    expect(apiReleaseConfigurationHash({
      ...environment,
      APP_ORIGIN: "https://staging-9enio.example",
    })).not.toBe(first);
    expect(apiReleaseConfigurationHash({
      ...environment,
      APPLE_TOKEN_ENCRYPTION_KEY_ID: "apple-token-v2",
    })).not.toBe(first);
    expect(apiReleaseConfigurationHash({
      ...environment,
      OWNER_ALLOWLIST_VERSION: "owner-allowlist-v2",
    })).not.toBe(first);
    for (const [key, value] of [
      ["RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION", "2"],
      ["RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION", "1"],
      ["RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION", "1"],
      ["PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION", "5"],
    ] as const) {
      expect(apiReleaseConfigurationHash({
        ...environment,
        [key]: value,
      })).not.toBe(first);
    }
  });
});
