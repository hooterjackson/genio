import type {
  PlaylistGuidanceAnswer,
  PlaylistGuidanceQuestion,
} from "../shared/types.ts";
import {
  ADAPTIVE_GUIDANCE_POLICY_VERSION,
  assertGuidanceDecisionV3,
  compileGuidanceSelectionV3,
  type GuidanceDecisionV3,
} from "./adaptive-guidance-v3.ts";
import type {
  PlaylistContractPatchOperationV1,
  PlaylistContractPatchV1,
  PlaylistContractRevisionV1,
} from "./playlist-contract-v1.ts";
import { sha256Hex, stableStringify } from "./security.ts";

function feasibility(
  value: "narrower" | "neutral" | "broader",
): "narrow" | "moderate" | "broad" {
  if (value === "narrower") return "narrow";
  if (value === "broader") return "broad";
  return "moderate";
}

export function publicGuidanceQuestionV3(
  decision: GuidanceDecisionV3,
): PlaylistGuidanceQuestion {
  assertGuidanceDecisionV3(decision);
  return {
    id: decision.id,
    header: decision.header,
    question: decision.question,
    schemaVersion: 3,
    policyVersion: decision.policyVersion,
    questionHash: decision.questionHash,
    trigger: decision.trigger,
    axis: decision.axis,
    criticality: decision.criticality,
    selectionMode: decision.selectionMode,
    allowCustom: decision.allowCustom,
    decisionKey: decision.axis,
    baseContractRevisionId: decision.baseContractRevisionId,
    baseContractSemanticHash: decision.baseContractSemanticHash,
    allowedPatchOperations: [...decision.allowedPatchOperations],
    affectedClauseIds: [...decision.affectedClauseIds],
    materialityScore: decision.materialityScore,
    ...(decision.interpretationSummary
      ? { interpretationSummary: structuredClone(decision.interpretationSummary) }
      : {}),
    whyMaterial: decision.whyMaterial,
    groundingMode: "inference",
    options: decision.options.map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
      recommended: option.recommended,
      feasibility: feasibility(option.expectedFeasibilityDirection),
      contractPatch: {
        operations: option.patch.operations.map((operation) => (
          structuredClone(operation) as unknown as Record<string, unknown>
        )),
        affectedClauseIds: [...option.patch.affectedClauseIds],
        expectedFeasibilityDirection: option.expectedFeasibilityDirection,
      },
    })),
  };
}

export function guidanceDecisionV3FromPublicQuestion(
  question: PlaylistGuidanceQuestion,
): GuidanceDecisionV3 {
  if (question.schemaVersion !== 3
    || question.policyVersion !== ADAPTIVE_GUIDANCE_POLICY_VERSION
    || typeof question.questionHash !== "string"
    || typeof question.axis !== "string"
    || typeof question.trigger !== "string"
    || typeof question.baseContractRevisionId !== "string"
    || typeof question.baseContractSemanticHash !== "string"
    || !Array.isArray(question.allowedPatchOperations)
    || !Array.isArray(question.affectedClauseIds)
    || typeof question.materialityScore !== "number"
    || typeof question.criticality !== "string"
    || typeof question.selectionMode !== "string"
    || typeof question.allowCustom !== "boolean") {
    throw new Error("invalid_contract3_guidance_question");
  }
  const decision: GuidanceDecisionV3 = {
    schemaVersion: 3,
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION,
    id: question.id,
    header: question.header,
    question: question.question,
    axis: question.axis,
    trigger: question.trigger,
    criticality: question.criticality,
    selectionMode: question.selectionMode,
    allowCustom: question.allowCustom,
    baseContractRevisionId: question.baseContractRevisionId,
    baseContractSemanticHash: question.baseContractSemanticHash,
    whyMaterial: question.whyMaterial ?? "",
    allowedPatchOperations: [...question.allowedPatchOperations],
    affectedClauseIds: [...question.affectedClauseIds],
    materialityScore: question.materialityScore,
    ...(question.interpretationSummary
      ? { interpretationSummary: structuredClone(question.interpretationSummary) }
      : {}),
    options: question.options.map((option) => {
      if (!option.contractPatch) throw new Error("missing_contract3_guidance_patch");
      return {
        id: option.id,
        label: option.label,
        description: option.description,
        recommended: option.recommended,
        expectedFeasibilityDirection: option.contractPatch.expectedFeasibilityDirection,
        patch: {
          operations: option.contractPatch.operations.map((operation) => (
            structuredClone(operation) as unknown as PlaylistContractPatchOperationV1
          )),
          affectedClauseIds: [...option.contractPatch.affectedClauseIds],
        },
      };
    }),
    questionHash: question.questionHash,
  };
  assertGuidanceDecisionV3(decision);
  return decision;
}

export function compileGuidanceRoundPatchV3(input: {
  base: PlaylistContractRevisionV1;
  questionSetHash: string;
  questions: readonly PlaylistGuidanceQuestion[];
  answers: readonly PlaylistGuidanceAnswer[];
}): PlaylistContractPatchV1 | null {
  if (!/^[a-f0-9]{64}$/u.test(input.questionSetHash)) {
    throw new Error("invalid_contract3_question_set_hash");
  }
  const answerByQuestion = new Map(input.answers.map((answer) => [answer.questionId, answer]));
  const accepted = input.questions.map((question) => {
    const decision = guidanceDecisionV3FromPublicQuestion(question);
    if (decision.baseContractRevisionId !== input.base.revisionId
      || decision.baseContractSemanticHash !== input.base.semanticHash) {
      throw new Error("stale_contract3_guidance_question");
    }
    const answer = answerByQuestion.get(question.id);
    if (answer?.customText) throw new Error("custom_contract3_answer_requires_recompile");
    return {
      decision,
      compiled: compileGuidanceSelectionV3(decision, {
        optionIds: answer?.optionIds ?? (answer?.optionId ? [answer.optionId] : []),
        skipped: answer?.skipped,
      }),
    };
  });
  if (accepted.some(({ compiled }) => compiled.state === "required_answer_missing")) {
    throw new Error("required_contract3_answer_missing");
  }
  const operations = accepted.flatMap(({ compiled }) => compiled.operations);
  if (operations.length === 0) return null;
  const answerHash = sha256Hex(stableStringify(accepted.map(({ decision, compiled }) => ({
    questionHash: decision.questionHash,
    answerHash: compiled.answerHash,
    selectedOptionIds: compiled.selectedOptionIds,
  }))));
  return {
    baseRevisionId: input.base.revisionId,
    baseSemanticHash: input.base.semanticHash,
    answerLineage: {
      questionSetHash: input.questionSetHash,
      questionId: `guidance-round:${input.questionSetHash.slice(0, 24)}`,
      answerHash,
    },
    operations,
  };
}
