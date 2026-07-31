import { describe, expect, test } from "vitest";
import {
  apiReleaseConfigurationHash,
  releaseOwnerAllowlistVersion,
  runtimeReleaseContract,
  semanticExecutionConfigurationHash,
} from "../server/runtime-release.ts";

describe("public V3 runtime release contract", () => {
  test("reports explicit rollout and versioned protocol metadata without secrets", () => {
    const result = runtimeReleaseContract({
      RELEASE_ENVIRONMENT: "staging",
      RELEASE_DEPLOYMENT_PHASE: "expand",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "19",
      PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
      PIPELINE_V3_OWNER_CANARY: "true",
      PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
      PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED: "false",
      PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED: "false",
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "2",
      GUIDANCE_CONTRACT_V2_ENABLED: "true",
      GUIDANCE_CONTRACT_V2_OWNER_CANARY: "true",
      PIPELINE_V3_BASELINE_MODEL_ID: "gpt-5.6-luna",
      PIPELINE_V3_ESCALATION_MODEL_ID: "gpt-5.6-terra",
      PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT: "2026-07-20T14:30:00.000Z",
      OPENAI_API_KEY: "sk-proj-never-return-this",
    });

    expect(result).toMatchObject({
      pipelineVersion: "corpus_first_v3",
      releaseEnvironment: "staging",
      ownerAllowlistVersion: null,
      deploymentPhase: "expand",
      expectedDatabaseSchemaVersion: "19",
      canonicalActivationConfigured: false,
      assignmentEnabled: true,
      ownerCanaryEnabled: true,
      productionEvidenceApproved: true,
      curatedHostedEvidenceApproved: false,
      genreSceneEvidenceApproved: false,
      geographicScopeEvidenceApproved: false,
      factualFeasibilityApproved: false,
      schemaVersion: "19",
      schemaMinimum: "13",
      schemaMaximum: "19",
      schemaPreferred: "19",
      workerProtocol: "playlist-pipeline-v11",
      minimumWorkerProtocol: "playlist-pipeline-v8",
      queryPlanSchemaVersion: "3",
      briefContractVersion: "2",
      guidanceContractOwnerCanaryEnabled: true,
      guidancePolicyVersion: "intelligent_guidance_v2",
      evidencePolicyVersion: "governed_evidence_v1",
      semanticScopePolicyVersion: "scope_gate_v2_1_2",
      musicConceptPolicyVersion: "music_concepts_v3_4_0",
      promptVersion: "grounded_recovery_v3_1_prompt_v1",
      baselineProviderModelId: "gpt-5.6-luna",
      escalationProviderModelId: "gpt-5.6-terra",
      modelResolutionMode: "provider_managed_alias",
      modelCatalogValidatedAt: "2026-07-20T14:30:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("sk-proj");
  });

  test("requires a versioned owner allowlist in release environments", () => {
    expect(() => runtimeReleaseContract({
      RELEASE_ENVIRONMENT: "production",
      OWNER_EMAIL: "owner@example.com",
    })).toThrow(/OWNER_ALLOWLIST_VERSION is required/u);
    expect(releaseOwnerAllowlistVersion({
      RELEASE_ENVIRONMENT: "staging",
      OWNER_EMAIL: "owner@example.com",
      OWNER_ALLOWLIST_VERSION: "owner-allowlist-v2",
    })).toBe("owner-allowlist-v2");
    expect(() => releaseOwnerAllowlistVersion({
      RELEASE_ENVIRONMENT: "staging",
      OWNER_EMAIL: "owner@example.com",
      OWNER_ALLOWLIST_VERSION: "owner email",
    })).toThrow(/safe non-secret release label/u);
    const firstHash = apiReleaseConfigurationHash({
      RELEASE_ENVIRONMENT: "production",
      OWNER_EMAIL: "first-owner@example.com",
      OWNER_ALLOWLIST_VERSION: "owner-allowlist-v2",
    });
    expect(apiReleaseConfigurationHash({
      RELEASE_ENVIRONMENT: "production",
      OWNER_EMAIL: "second-owner@example.com",
      OWNER_ALLOWLIST_VERSION: "owner-allowlist-v2",
    })).toBe(firstHash);
    expect(JSON.stringify(runtimeReleaseContract({
      RELEASE_ENVIRONMENT: "production",
      OWNER_EMAIL: "first-owner@example.com",
      OWNER_ALLOWLIST_VERSION: "owner-allowlist-v2",
    }))).not.toContain("first-owner@example.com");
  });

  test("reports canonical contract-3 and query-plan-6 activation", () => {
    const result = runtimeReleaseContract({
      RELEASE_ENVIRONMENT: "production",
      RELEASE_DEPLOYMENT_PHASE: "activate",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "19",
      RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
      RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
      RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
      RELEASE_EXECUTION_ENABLED: "true",
      GUIDANCE_CONTRACT_V3_ENABLED: "true",
      GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
    });
    expect(result).toMatchObject({
      deploymentPhase: "activate",
      expectedDatabaseSchemaVersion: "19",
      canonicalActivationConfigured: true,
      queryPlanSchemaVersion: "6",
      briefContractVersion: "3",
      guidanceContractOwnerCanaryEnabled: true,
      guidancePolicyVersion: "adaptive_guidance_v4",
      evidencePolicyVersion: "governed_evidence_v2",
    });
  });

  test("reports contract 3 when only a canonical owner or intent cohort is active", () => {
    const result = runtimeReleaseContract({
      RELEASE_ENVIRONMENT: "production",
      RELEASE_DEPLOYMENT_PHASE: "activate",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "19",
      RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
      RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
      RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
      RELEASE_EXECUTION_ENABLED: "true",
      GUIDANCE_CONTRACT_V2_ENABLED: "true",
      GUIDANCE_CONTRACT_V3_ENABLED: "false",
      GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "true",
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
    });
    expect(result).toMatchObject({
      canonicalActivationConfigured: true,
      queryPlanSchemaVersion: "6",
      briefContractVersion: "3",
      guidanceContractReggaetonCanaryEnabled: true,
      guidancePolicyVersion: "adaptive_guidance_v4",
    });
  });

  test("fails visibly closed to disabled rollout and validated provider defaults", () => {
    const result = runtimeReleaseContract({
      PIPELINE_V3_ASSIGNMENT_ENABLED: "false",
      PIPELINE_V3_BASELINE_MODEL_ID: "unavailable-model",
      PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT: "invalid",
    });
    expect(result.assignmentEnabled).toBe(false);
    expect(result.releaseEnvironment).toBe("development");
    expect(result.deploymentPhase).toBe("unconfigured");
    expect(result.expectedDatabaseSchemaVersion).toBeNull();
    expect(result.canonicalActivationConfigured).toBe(false);
    expect(result.ownerCanaryEnabled).toBe(false);
    expect(result.productionEvidenceApproved).toBe(false);
    expect(result.curatedHostedEvidenceApproved).toBe(false);
    expect(result.genreSceneEvidenceApproved).toBe(false);
    expect(result.geographicScopeEvidenceApproved).toBe(false);
    expect(result.factualFeasibilityApproved).toBe(false);
    expect(result.queryPlanSchemaVersion).toBe("1");
    expect(result.briefContractVersion).toBe("1");
    expect(result.guidanceContractOwnerCanaryEnabled).toBe(false);
    expect(result.guidancePolicyVersion).toBe("intelligent_guidance_v2");
    expect(result.evidencePolicyVersion).toBe("governed_evidence_v1");
    expect(result.semanticScopePolicyVersion).toBe("scope_gate_v2_1_2");
    expect(result.musicConceptPolicyVersion).toBe("music_concepts_v3_4_0");
    expect(result.baselineProviderModelId).toBe("gpt-5.6-luna");
    expect(result.modelResolutionMode).toBe("provider_managed_alias");
    expect(result.modelCatalogValidatedAt).toBe("2026-07-20T00:00:00.000Z");
  });

  test("uses the execution model resolver and never reports a silent fallback", () => {
    expect(runtimeReleaseContract({
      OPENAI_BRIEF_MODEL: "brief-snapshot",
    }).briefProviderModelId).toBe("brief-snapshot");
    expect(() => runtimeReleaseContract({
      OPENAI_BRIEF_MODEL: "sk-secret-looking-model",
    })).toThrow(/invalid_openai_brief_model/u);
  });

  test("keeps preserved canonical cohort settings inert during bridge and expand", () => {
    for (const deploymentPhase of ["bridge", "expand"] as const) {
      const result = runtimeReleaseContract({
        RELEASE_DEPLOYMENT_PHASE: deploymentPhase,
        RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION:
          deploymentPhase === "bridge" ? "18" : "19",
        RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
        RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
        RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
        GUIDANCE_CONTRACT_V3_ENABLED: "true",
        GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
        GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "true",
        PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
      });
      expect(result).toMatchObject({
        deploymentPhase,
        canonicalActivationConfigured: false,
        briefContractVersion: "1",
        queryPlanSchemaVersion: "1",
        guidanceContractOwnerCanaryEnabled: false,
        guidanceContractReggaetonCanaryEnabled: false,
      });
    }
  });

  test("fences normalized semantic execution controls without cohort percentages or secrets", () => {
    const environment = {
      APPLE_STOREFRONT: "US",
      GUIDANCE_CONTRACT_V3_ENABLED: "true",
      GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
      OPENAI_TIMEOUT_MS: "60000",
      FAST_MATCH_LOOKUP_TIMEOUT_MS: "7000",
      APPLE_CATALOG_RECOVERY_TIMEOUT_MS: "90000",
      RESULT_REUSE_DAYS: "30",
      OPENAI_MAX_RESPONSE_RESERVATION_USD: "0.75",
      OPENAI_API_KEY: "sk-secret-one",
      PIPELINE_V3_GENRE_SCENE_PERCENT: "10",
    };
    const first = semanticExecutionConfigurationHash(environment);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(runtimeReleaseContract(environment)
      .semanticExecutionConfigurationHash).toBe(first);
    expect(semanticExecutionConfigurationHash({
      ...environment,
      GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "true",
    })).not.toBe(first);
    expect(semanticExecutionConfigurationHash({
      ...environment,
      OPENAI_TIMEOUT_MS: "60001",
    })).not.toBe(first);
    expect(semanticExecutionConfigurationHash({
      ...environment,
      FAST_MATCH_LOOKUP_TIMEOUT_MS: "7001",
    })).not.toBe(first);
    expect(semanticExecutionConfigurationHash({
      ...environment,
      APPLE_MATCH_MAX_QUERIES: "7",
    })).not.toBe(first);
    expect(semanticExecutionConfigurationHash({
      ...environment,
      OPENAI_API_KEY: "sk-secret-two",
      PIPELINE_V3_GENRE_SCENE_PERCENT: "50",
    })).toBe(first);
    expect(semanticExecutionConfigurationHash({
      ...environment,
      APPLE_STOREFRONT: "us",
      OPENAI_TIMEOUT_MS: "060000",
    })).toBe(first);
    expect(() => semanticExecutionConfigurationHash({
      ...environment,
      GUIDANCE_CONTRACT_V3_ENABLED: "yes",
    })).toThrow(/must be true or false/u);
  });

  test("keeps operational monthly ceilings outside semantic execution identity", () => {
    const environment = {
      APP_MONTHLY_COST_LIMIT_USD: "100",
      MONTHLY_RESEARCH_CEILING_USD: "40",
      AUTO_RUN_COST_LIMIT_USD: "0.75",
      INITIAL_COST_GATE_USD: "0.20",
    };
    const first = semanticExecutionConfigurationHash(environment);
    expect(semanticExecutionConfigurationHash({
      ...environment,
      APP_MONTHLY_COST_LIMIT_USD: "250",
      MONTHLY_RESEARCH_CEILING_USD: "80",
    })).toBe(first);
    expect(semanticExecutionConfigurationHash({
      ...environment,
      AUTO_RUN_COST_LIMIT_USD: "1.00",
    })).not.toBe(first);
    expect(semanticExecutionConfigurationHash({
      ...environment,
      INITIAL_COST_GATE_USD: "0.25",
    })).not.toBe(first);
  });

  test("records only the privacy-safe MusicBrainz readiness mode", () => {
    const configuredEmail = semanticExecutionConfigurationHash({
      MUSICBRAINZ_CONTACT: "owner@example.com",
    });
    expect(semanticExecutionConfigurationHash({
      MUSICBRAINZ_CONTACT: "another-operator@example.net",
    })).toBe(configuredEmail);
    expect(semanticExecutionConfigurationHash({
      MUSICBRAINZ_CONTACT: "https://9enio.com/contact",
    })).not.toBe(configuredEmail);
    expect(() => semanticExecutionConfigurationHash({
      MUSICBRAINZ_CONTACT: "operator-contact-not-configured.invalid",
    })).toThrow(/valid email address or HTTPS URL/u);
  });
});
