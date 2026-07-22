import { describe, expect, test } from "vitest";
import { runtimeReleaseContract } from "../server/runtime-release.ts";

describe("public V3 runtime release contract", () => {
  test("reports explicit rollout and versioned protocol metadata without secrets", () => {
    const result = runtimeReleaseContract({
      PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
      PIPELINE_V3_OWNER_CANARY: "true",
      PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
      PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED: "false",
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "2",
      PIPELINE_V3_BASELINE_MODEL_ID: "gpt-5.6-luna",
      PIPELINE_V3_ESCALATION_MODEL_ID: "gpt-5.6-terra",
      PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT: "2026-07-20T14:30:00.000Z",
      OPENAI_API_KEY: "sk-proj-never-return-this",
    });

    expect(result).toMatchObject({
      pipelineVersion: "corpus_first_v3",
      assignmentEnabled: true,
      ownerCanaryEnabled: true,
      productionEvidenceApproved: true,
      factualFeasibilityApproved: false,
      schemaVersion: "15",
      workerProtocol: "playlist-pipeline-v8",
      queryPlanSchemaVersion: "2",
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

  test("fails visibly closed to disabled rollout and validated provider defaults", () => {
    const result = runtimeReleaseContract({
      PIPELINE_V3_ASSIGNMENT_ENABLED: "false",
      PIPELINE_V3_BASELINE_MODEL_ID: "unavailable-model",
      PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT: "invalid",
    });
    expect(result.assignmentEnabled).toBe(false);
    expect(result.ownerCanaryEnabled).toBe(false);
    expect(result.productionEvidenceApproved).toBe(false);
    expect(result.factualFeasibilityApproved).toBe(false);
    expect(result.queryPlanSchemaVersion).toBe("1");
    expect(result.semanticScopePolicyVersion).toBe("scope_gate_v2_1_2");
    expect(result.musicConceptPolicyVersion).toBe("music_concepts_v3_2_0");
    expect(result.baselineProviderModelId).toBe("gpt-5.6-luna");
    expect(result.modelResolutionMode).toBe("provider_managed_alias");
    expect(result.modelCatalogValidatedAt).toBe("2026-07-20T00:00:00.000Z");
  });
});
