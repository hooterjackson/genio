import { DATABASE_SCHEMA_VERSION } from "../db/index.ts";
import {
  PIPELINE_V3_ALLOWED_PROVIDER_MODEL_IDS,
  PIPELINE_V3_DEFAULT_BASELINE_MODEL_ID,
  PIPELINE_V3_DEFAULT_ESCALATION_MODEL_ID,
  PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT,
  PIPELINE_V3_MODEL_RESOLUTION_MODE,
  PIPELINE_V3_PROMPT_VERSION,
} from "./pipeline-v3-policy.ts";
import { QUERY_PLAN_V3_POLICY_VERSION } from "./query-plan-v3.ts";
import {
  PIPELINE_V3_POLICY_VERSION,
  SELECTION_PLAN_V3_VERSION,
} from "./selection-plan-v3.ts";
import { WORKER_PIPELINE_PROTOCOL_VERSION } from "./worker-protocol.ts";

export interface RuntimeReleaseContract {
  pipelineVersion: "corpus_first_v3";
  assignmentEnabled: boolean;
  ownerCanaryEnabled: boolean;
  productionEvidenceApproved: boolean;
  factualFeasibilityApproved: boolean;
  schemaVersion: string;
  workerProtocol: string;
  selectionPlanVersion: string;
  queryPlanPolicyVersion: string;
  pipelinePolicyVersion: string;
  promptVersion: string;
  baselineProviderModelId: string;
  escalationProviderModelId: string;
  modelResolutionMode: typeof PIPELINE_V3_MODEL_RESOLUTION_MODE;
  modelCatalogValidatedAt: string;
}

function safeProviderModelId(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() ?? "";
  return (PIPELINE_V3_ALLOWED_PROVIDER_MODEL_IDS as readonly string[]).includes(normalized)
    ? normalized
    : fallback;
}

function safeCatalogValidatedAt(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === normalized
    ? normalized
    : PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT;
}

/**
 * Public, secret-free runtime contract shown on About and health endpoints.
 * It describes the exact protocol the deployed binary understands; rollout
 * flags remain explicit so a capable binary is never mistaken for active V3
 * traffic.
 */
export function runtimeReleaseContract(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeReleaseContract {
  return Object.freeze({
    pipelineVersion: "corpus_first_v3",
    assignmentEnabled: environment.PIPELINE_V3_ASSIGNMENT_ENABLED === "true",
    ownerCanaryEnabled: environment.PIPELINE_V3_OWNER_CANARY === "true",
    productionEvidenceApproved: environment.PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED === "true",
    factualFeasibilityApproved: environment.PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED === "true",
    schemaVersion: DATABASE_SCHEMA_VERSION,
    workerProtocol: WORKER_PIPELINE_PROTOCOL_VERSION,
    selectionPlanVersion: SELECTION_PLAN_V3_VERSION,
    queryPlanPolicyVersion: QUERY_PLAN_V3_POLICY_VERSION,
    pipelinePolicyVersion: PIPELINE_V3_POLICY_VERSION,
    promptVersion: PIPELINE_V3_PROMPT_VERSION,
    baselineProviderModelId: safeProviderModelId(
      environment.PIPELINE_V3_BASELINE_MODEL_ID,
      PIPELINE_V3_DEFAULT_BASELINE_MODEL_ID,
    ),
    escalationProviderModelId: safeProviderModelId(
      environment.PIPELINE_V3_ESCALATION_MODEL_ID,
      PIPELINE_V3_DEFAULT_ESCALATION_MODEL_ID,
    ),
    modelResolutionMode: PIPELINE_V3_MODEL_RESOLUTION_MODE,
    modelCatalogValidatedAt: safeCatalogValidatedAt(environment.PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT),
  });
}
