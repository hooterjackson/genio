import { describe, expect, test } from "vitest";
import { runtimeReleaseContract } from "../server/runtime-release.ts";

describe("public V3 runtime release contract", () => {
  test("reports explicit rollout and versioned protocol metadata without secrets", () => {
    const result = runtimeReleaseContract({
      RELEASE_DEPLOYMENT_PHASE: "expand",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
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
      deploymentPhase: "expand",
      expectedDatabaseSchemaVersion: "18",
      canonicalActivationConfigured: false,
      assignmentEnabled: true,
      ownerCanaryEnabled: true,
      productionEvidenceApproved: true,
      curatedHostedEvidenceApproved: false,
      genreSceneEvidenceApproved: false,
      geographicScopeEvidenceApproved: false,
      factualFeasibilityApproved: false,
      schemaVersion: "18",
      schemaMinimum: "13",
      schemaMaximum: "18",
      schemaPreferred: "18",
      workerProtocol: "playlist-pipeline-v10",
      minimumWorkerProtocol: "playlist-pipeline-v8",
      queryPlanSchemaVersion: "3",
      briefContractVersion: "2",
      guidanceContractOwnerCanaryEnabled: true,
      guidancePolicyVersion: "intelligent_guidance_v2",
      evidencePolicyVersion: "governed_evidence_v1",
      semanticScopePolicyVersion: "scope_gate_v2_1_2",
      musicConceptPolicyVersion: "music_concepts_v3_2_0",
      promptVersion: "grounded_recovery_v3_1_prompt_v1",
      baselineProviderModelId: "gpt-5.6-luna",
      escalationProviderModelId: "gpt-5.6-terra",
      modelResolutionMode: "provider_managed_alias",
      modelCatalogValidatedAt: "2026-07-20T14:30:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("sk-proj");
  });

  test("reports canonical contract-3 and query-plan-4 activation", () => {
    const result = runtimeReleaseContract({
      RELEASE_DEPLOYMENT_PHASE: "activate",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GUIDANCE_CONTRACT_V3_ENABLED: "true",
      GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "4",
    });
    expect(result).toMatchObject({
      deploymentPhase: "activate",
      expectedDatabaseSchemaVersion: "18",
      canonicalActivationConfigured: true,
      queryPlanSchemaVersion: "4",
      briefContractVersion: "3",
      guidanceContractOwnerCanaryEnabled: true,
      guidancePolicyVersion: "adaptive_guidance_v3",
      evidencePolicyVersion: "governed_evidence_v2",
    });
  });

  test("reports contract 3 when only a canonical owner or intent cohort is active", () => {
    const result = runtimeReleaseContract({
      RELEASE_DEPLOYMENT_PHASE: "activate",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GUIDANCE_CONTRACT_V2_ENABLED: "true",
      GUIDANCE_CONTRACT_V3_ENABLED: "false",
      GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "true",
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "4",
    });
    expect(result).toMatchObject({
      canonicalActivationConfigured: true,
      queryPlanSchemaVersion: "4",
      briefContractVersion: "3",
      guidanceContractReggaetonCanaryEnabled: true,
      guidancePolicyVersion: "adaptive_guidance_v3",
    });
  });

  test("fails visibly closed to disabled rollout and validated provider defaults", () => {
    const result = runtimeReleaseContract({
      PIPELINE_V3_ASSIGNMENT_ENABLED: "false",
      PIPELINE_V3_BASELINE_MODEL_ID: "unavailable-model",
      PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT: "invalid",
    });
    expect(result.assignmentEnabled).toBe(false);
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
    expect(result.musicConceptPolicyVersion).toBe("music_concepts_v3_2_0");
    expect(result.baselineProviderModelId).toBe("gpt-5.6-luna");
    expect(result.modelResolutionMode).toBe("provider_managed_alias");
    expect(result.modelCatalogValidatedAt).toBe("2026-07-20T00:00:00.000Z");
  });

  test("keeps preserved canonical cohort settings inert during bridge and expand", () => {
    for (const deploymentPhase of ["bridge", "expand"] as const) {
      const result = runtimeReleaseContract({
        RELEASE_DEPLOYMENT_PHASE: deploymentPhase,
        RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
        GUIDANCE_CONTRACT_V3_ENABLED: "true",
        GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
        GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "true",
        PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "4",
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
});
