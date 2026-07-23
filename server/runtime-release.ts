import { DATABASE_SCHEMA_SUPPORT, DATABASE_SCHEMA_VERSION } from "../db/index.ts";
import {
  PIPELINE_V3_ALLOWED_PROVIDER_MODEL_IDS,
  PIPELINE_V3_DEFAULT_BASELINE_MODEL_ID,
  PIPELINE_V3_DEFAULT_ESCALATION_MODEL_ID,
  PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT,
  PIPELINE_V3_MODEL_RESOLUTION_MODE,
  PIPELINE_V3_PROMPT_VERSION,
} from "./pipeline-v3-policy.ts";
import { MUSIC_CONCEPT_POLICY_VERSION } from "./music-concepts-v3.ts";
import {
  QUERY_PLAN_V3_POLICY_VERSION,
  queryPlanV3EmissionSchemaVersion,
} from "./query-plan-v3.ts";
import {
  PIPELINE_V3_POLICY_VERSION,
  SELECTION_PLAN_V3_VERSION,
  SEMANTIC_SCOPE_POLICY_VERSION,
} from "./selection-plan-v3.ts";
import {
  BRIEF_CONTRACT_VERSION,
  EVIDENCE_POLICY_VERSION,
  GUIDANCE_POLICY_VERSION,
} from "./guidance-contract-v2.ts";
import {
  BRIDGE_API_MINIMUM_WORKER_PROTOCOL_VERSION,
  WORKER_PIPELINE_PROTOCOL_VERSION,
} from "./worker-protocol.ts";
import { ADAPTIVE_GUIDANCE_POLICY_VERSION } from "./adaptive-guidance-v3.ts";
import { PLAYLIST_CONTRACT_EVIDENCE_POLICY_VERSION } from "./playlist-contract-v1.ts";
import {
  canonicalContractActivationConfigured,
  canonicalContractCohortConfigured,
  expectedReleaseDatabaseSchemaVersion,
  runtimeReleaseDeploymentPhase,
  type RuntimeReleaseDeploymentPhase,
} from "./release-deployment-phase.ts";

export interface RuntimeReleaseContract {
  pipelineVersion: "corpus_first_v3";
  deploymentPhase: RuntimeReleaseDeploymentPhase;
  expectedDatabaseSchemaVersion: string | null;
  canonicalActivationConfigured: boolean;
  assignmentEnabled: boolean;
  ownerCanaryEnabled: boolean;
  productionEvidenceApproved: boolean;
  curatedHostedEvidenceApproved: boolean;
  genreSceneEvidenceApproved: boolean;
  geographicScopeEvidenceApproved: boolean;
  factualFeasibilityApproved: boolean;
  schemaVersion: string;
  schemaMinimum: string;
  schemaMaximum: string;
  schemaPreferred: string;
  workerProtocol: string;
  minimumWorkerProtocol: string;
  selectionPlanVersion: string;
  queryPlanSchemaVersion: string;
  briefContractVersion: string;
  guidanceContractOwnerCanaryEnabled: boolean;
  guidanceContractReggaetonCanaryEnabled: boolean;
  guidancePolicyVersion: string;
  evidencePolicyVersion: string;
  queryPlanPolicyVersion: string;
  semanticScopePolicyVersion: string;
  musicConceptPolicyVersion: string;
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
  const canonicalActivationConfigured = canonicalContractActivationConfigured(environment);
  const canonicalContractActive = canonicalContractCohortConfigured(environment);
  return Object.freeze({
    pipelineVersion: "corpus_first_v3",
    deploymentPhase: runtimeReleaseDeploymentPhase(environment),
    expectedDatabaseSchemaVersion: expectedReleaseDatabaseSchemaVersion(environment),
    canonicalActivationConfigured,
    assignmentEnabled: environment.PIPELINE_V3_ASSIGNMENT_ENABLED === "true",
    ownerCanaryEnabled: environment.PIPELINE_V3_OWNER_CANARY === "true",
    productionEvidenceApproved: environment.PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED === "true",
    curatedHostedEvidenceApproved: environment.PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED === "true",
    genreSceneEvidenceApproved: environment.PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED === "true",
    geographicScopeEvidenceApproved: environment.PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED === "true",
    factualFeasibilityApproved: environment.PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED === "true",
    schemaVersion: DATABASE_SCHEMA_VERSION,
    schemaMinimum: DATABASE_SCHEMA_SUPPORT.minimum,
    schemaMaximum: DATABASE_SCHEMA_SUPPORT.maximum,
    schemaPreferred: DATABASE_SCHEMA_SUPPORT.preferred,
    workerProtocol: WORKER_PIPELINE_PROTOCOL_VERSION,
    minimumWorkerProtocol: BRIDGE_API_MINIMUM_WORKER_PROTOCOL_VERSION,
    selectionPlanVersion: SELECTION_PLAN_V3_VERSION,
    queryPlanSchemaVersion: String(canonicalContractActive
      ? 4
      : environment.GUIDANCE_CONTRACT_V2_ENABLED === "true"
        ? 3
        : queryPlanV3EmissionSchemaVersion(environment)),
    briefContractVersion: String(canonicalContractActive
      ? 3
      : environment.GUIDANCE_CONTRACT_V2_ENABLED === "true"
        ? BRIEF_CONTRACT_VERSION
        : 1),
    guidanceContractOwnerCanaryEnabled: (
      canonicalActivationConfigured
      && environment.GUIDANCE_CONTRACT_V3_OWNER_CANARY === "true"
    )
      || environment.GUIDANCE_CONTRACT_V2_OWNER_CANARY === "true",
    guidanceContractReggaetonCanaryEnabled:
      canonicalActivationConfigured
      && environment.GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED === "true",
    guidancePolicyVersion: canonicalContractActive
      ? ADAPTIVE_GUIDANCE_POLICY_VERSION
      : GUIDANCE_POLICY_VERSION,
    evidencePolicyVersion: canonicalContractActive
      ? PLAYLIST_CONTRACT_EVIDENCE_POLICY_VERSION
      : EVIDENCE_POLICY_VERSION,
    queryPlanPolicyVersion: QUERY_PLAN_V3_POLICY_VERSION,
    semanticScopePolicyVersion: SEMANTIC_SCOPE_POLICY_VERSION,
    musicConceptPolicyVersion: MUSIC_CONCEPT_POLICY_VERSION,
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
