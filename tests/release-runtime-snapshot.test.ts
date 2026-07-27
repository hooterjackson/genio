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

function live(configurationHash = hash) {
  return {
    ok: true,
    build: {
      version: "2.4.0",
      revision,
    },
    configurationHash,
      runtime: {
      ownerAllowlistVersion: "owner-allowlist-v1",
      releaseEnvironment: "staging",
      deploymentPhase: "activate",
      workerProtocol: "playlist-pipeline-v10",
      briefContractVersion: "3",
      queryPlanSchemaVersion: "5",
      briefProviderModelId: "gpt-5.4-mini",
      baselineProviderModelId: "gpt-5.6-luna",
      escalationProviderModelId: "gpt-5.6-terra",
      guidancePolicyVersion: "adaptive_guidance_v3",
      evidencePolicyVersion: "governed_evidence_v2",
      queryPlanPolicyVersion: "query_plan_v3_4",
      selectionPlanVersion: "selection_plan_v3",
      semanticScopePolicyVersion: "scope_gate_v2_1_2",
      musicConceptPolicyVersion: "music_concepts_v3_2_0",
      pipelinePolicyVersion: "corpus_first_v3",
      promptVersion: "grounded_recovery_v3_1_prompt_v1",
    },
  };
}

function lane(configurationHash: string) {
  return {
    status: "healthy",
    protocolVersion: "playlist-pipeline-v10",
    compatibleCapacity: 1,
    eligibleWorkerCount: 1,
    eligibleIdentityCount: 1,
    eligibleRevisions: [revision],
    eligibleConfigurationHashes: [configurationHash],
  };
}

function system() {
  return {
    ok: true,
    activationReady: true,
    database: "ready",
    schemaVersion: "18",
    releaseManifestCanaryGuardsVersion: "1",
    canonicalExecutionHardeningVersion: "1",
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
      schemaVersion: "genio-release-runtime-snapshot/v2",
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
      configuration: {
        apiHash: hash,
        interactiveWorkerHash: "c".repeat(64),
        deepWorkerHash: "d".repeat(64),
        sitesHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      runtime: {
        releaseEnvironment: "staging",
        databaseSchemaVersion: "18",
        databaseCapabilityVersion: "2",
        releaseManifestCanaryGuardsVersion: "1",
        canonicalExecutionHardeningVersion: "1",
        workerProtocol: "playlist-pipeline-v10",
        modelIds: {
          brief: "gpt-5.4-mini",
          baseline: "gpt-5.6-luna",
          escalation: "gpt-5.6-terra",
        },
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
    expect(snapshot({
      livePayload: live("9".repeat(64)),
    }).configurationHash).not.toBe(snapshot().configurationHash);
    expect(snapshot({
      secretVersions: secretVersions("8".repeat(64)),
    }).configuration.secretVersionsHash)
      .not.toBe(snapshot().configuration.secretVersionsHash);
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
    })).toThrow(/schema-18\/protocol-10 release contract/u);
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
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
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
