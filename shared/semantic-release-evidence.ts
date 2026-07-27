import {
  exactObject,
  signedArtifactSha256,
  type JsonRecord,
} from "./signed-artifact.ts";

export const SEMANTIC_BEHAVIOR_CONTRACT_SCHEMA_V1 =
  "genio-semantic-behavior-contract/v1" as const;

export interface SemanticBehaviorRuntimeV1 {
  semanticExecutionConfigurationHash: string;
  briefContractVersion: string;
  queryPlanSchemaVersion: string;
  modelIds: {
    brief: string;
    baseline: string;
    escalation: string;
  };
  policyVersions: {
    guidance: string;
    evidence: string;
    queryPlan: string;
    selection: string;
    semanticScope: string;
    musicConcept: string;
    pipeline: string;
    prompt: string;
  };
}

export interface SemanticBehaviorContractV1
  extends SemanticBehaviorRuntimeV1 {
  schemaVersion: typeof SEMANTIC_BEHAVIOR_CONTRACT_SCHEMA_V1;
}

const SAFE_BEHAVIOR_VERSION =
  /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,159}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function behaviorVersion(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !SAFE_BEHAVIOR_VERSION.test(value)
    || /(?:sk-|secret|token|password)/iu.test(value)
  ) {
    throw new Error(`${label} is not an approved semantic behavior label`);
  }
  return value;
}

function behaviorDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

/**
 * Extracts the environment-neutral contract that can change playlist semantics
 * or ranking. Deployment identity, credentials, database connectivity, and
 * worker placement are intentionally excluded so staging and production can be
 * compared without weakening the behavior fence.
 */
export function semanticBehaviorContractV1(
  runtimeValue: unknown,
): SemanticBehaviorContractV1 {
  if (
    !runtimeValue
    || typeof runtimeValue !== "object"
    || Array.isArray(runtimeValue)
  ) {
    throw new Error("semantic behavior runtime must be an object");
  }
  const runtime = runtimeValue as JsonRecord;
  const modelIds = exactObject(
    runtime.modelIds,
    ["brief", "baseline", "escalation"],
    "semantic behavior runtime.modelIds",
  );
  const policyVersions = exactObject(
    runtime.policyVersions,
    [
      "guidance",
      "evidence",
      "queryPlan",
      "selection",
      "semanticScope",
      "musicConcept",
      "pipeline",
      "prompt",
    ],
    "semantic behavior runtime.policyVersions",
  );
  return {
    schemaVersion: SEMANTIC_BEHAVIOR_CONTRACT_SCHEMA_V1,
    semanticExecutionConfigurationHash: behaviorDigest(
      runtime.semanticExecutionConfigurationHash,
      "semantic behavior runtime.semanticExecutionConfigurationHash",
    ),
    briefContractVersion: behaviorVersion(
      runtime.briefContractVersion,
      "semantic behavior runtime.briefContractVersion",
    ),
    queryPlanSchemaVersion: behaviorVersion(
      runtime.queryPlanSchemaVersion,
      "semantic behavior runtime.queryPlanSchemaVersion",
    ),
    modelIds: {
      brief: behaviorVersion(
        modelIds.brief,
        "semantic behavior runtime.modelIds.brief",
      ),
      baseline: behaviorVersion(
        modelIds.baseline,
        "semantic behavior runtime.modelIds.baseline",
      ),
      escalation: behaviorVersion(
        modelIds.escalation,
        "semantic behavior runtime.modelIds.escalation",
      ),
    },
    policyVersions: {
      guidance: behaviorVersion(
        policyVersions.guidance,
        "semantic behavior runtime.policyVersions.guidance",
      ),
      evidence: behaviorVersion(
        policyVersions.evidence,
        "semantic behavior runtime.policyVersions.evidence",
      ),
      queryPlan: behaviorVersion(
        policyVersions.queryPlan,
        "semantic behavior runtime.policyVersions.queryPlan",
      ),
      selection: behaviorVersion(
        policyVersions.selection,
        "semantic behavior runtime.policyVersions.selection",
      ),
      semanticScope: behaviorVersion(
        policyVersions.semanticScope,
        "semantic behavior runtime.policyVersions.semanticScope",
      ),
      musicConcept: behaviorVersion(
        policyVersions.musicConcept,
        "semantic behavior runtime.policyVersions.musicConcept",
      ),
      pipeline: behaviorVersion(
        policyVersions.pipeline,
        "semantic behavior runtime.policyVersions.pipeline",
      ),
      prompt: behaviorVersion(
        policyVersions.prompt,
        "semantic behavior runtime.policyVersions.prompt",
      ),
    },
  };
}

export function semanticBehaviorHashV1(runtimeValue: unknown): string {
  return signedArtifactSha256(semanticBehaviorContractV1(runtimeValue));
}
