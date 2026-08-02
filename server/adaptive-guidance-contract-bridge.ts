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
import {
  ADAPTIVE_GUIDANCE_POLICY_VERSION_V4,
  assertGuidanceDecisionV4,
  compileGuidanceSelectionV4,
  type GuidanceDecisionV4,
} from "./adaptive-guidance-v4.ts";
import {
  ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
  assertGuidanceDecisionV5,
  compileGuidanceSelectionV5,
  type GuidanceDecisionV5,
} from "./adaptive-guidance-v5.ts";
import type {
  PlaylistContractPatchOperationV1,
  PlaylistContractPatchV1,
  PlaylistContractRevisionV1,
  PlaylistPredicateV1,
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

export function publicGuidanceQuestionV4(
  decision: GuidanceDecisionV4,
): PlaylistGuidanceQuestion {
  assertGuidanceDecisionV4(decision);
  return {
    id: decision.id,
    header: decision.header,
    question: decision.question,
    schemaVersion: 4,
    policyVersion: decision.policyVersion,
    questionHash: decision.questionHash,
    guidanceMode: decision.mode,
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
      ...(option.explicitNoop === true ? { explicitNoop: true } : {}),
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

export function publicGuidanceQuestionV5(
  decision: GuidanceDecisionV5,
): PlaylistGuidanceQuestion {
  assertGuidanceDecisionV5(decision);
  const simulationByOption = new Map(
    decision.simulations.map((simulation) => [
      simulation.optionId,
      simulation,
    ]),
  );
  return {
    id: decision.id,
    header: decision.header,
    question: decision.question,
    schemaVersion: 5,
    policyVersion: decision.policyVersion,
    questionHash: decision.questionHash,
    guidanceMode: decision.mode,
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
    axisRegistryVersion: decision.axisRegistryVersion,
    simulationPolicyVersion: decision.simulationPolicyVersion,
    capabilitySnapshotHash: decision.capabilitySnapshotHash,
    semanticConfigurationHash: decision.semanticConfigurationHash,
    ...(decision.interpretationSummary
      ? {
          interpretationSummary: structuredClone(
            decision.interpretationSummary,
          ),
        }
      : {}),
    whyMaterial: decision.whyMaterial,
    groundingMode: "inference",
    options: decision.options.map((option) => {
      const simulation = simulationByOption.get(option.id);
      if (!simulation) throw new Error("missing_guidance_v5_simulation");
      return {
        id: option.id,
        label: option.label,
        description: option.description,
        recommended: option.recommended,
        ...(option.explicitNoop === true ? { explicitNoop: true } : {}),
        feasibility: feasibility(option.expectedFeasibilityDirection),
        contractPatch: {
          operations: option.patch.operations.map((operation) => (
            structuredClone(operation) as unknown as Record<string, unknown>
          )),
          affectedClauseIds: [...option.patch.affectedClauseIds],
          expectedFeasibilityDirection:
            option.expectedFeasibilityDirection,
        },
        executionEffect: simulation.executionEffect
          ? { ...simulation.executionEffect }
          : null,
        optionSimulation: {
          patchHash: simulation.patchHash,
          successorSemanticHash: simulation.successorSemanticHash,
          valid: true,
        },
      };
    }),
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

export function guidanceDecisionV4FromPublicQuestion(
  question: PlaylistGuidanceQuestion,
): GuidanceDecisionV4 {
  if (question.schemaVersion !== 4
    || question.policyVersion !== ADAPTIVE_GUIDANCE_POLICY_VERSION_V4
    || typeof question.questionHash !== "string"
    || (question.guidanceMode !== "correctness_blocking"
      && question.guidanceMode !== "nuance_optional")
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
    throw new Error("invalid_contract4_guidance_question");
  }
  const decision: GuidanceDecisionV4 = {
    schemaVersion: 4,
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V4,
    mode: question.guidanceMode,
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
      if (!option.contractPatch) throw new Error("missing_contract4_guidance_patch");
      const emptyPatch = option.contractPatch.operations.length === 0
        && option.contractPatch.affectedClauseIds.length === 0;
      return {
        id: option.id,
        label: option.label,
        description: option.description,
        recommended: option.recommended,
        ...(
          option.explicitNoop === true
          || (
            option.explicitNoop === undefined
            && question.guidanceMode === "correctness_blocking"
            && emptyPatch
          )
            ? { explicitNoop: true }
            : {}
        ),
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
  assertGuidanceDecisionV4(decision);
  return decision;
}

export function guidanceDecisionV5FromPublicQuestion(
  question: PlaylistGuidanceQuestion,
  baseContract?: PlaylistContractRevisionV1,
): GuidanceDecisionV5 {
  if (question.schemaVersion !== 5
    || question.policyVersion !== ADAPTIVE_GUIDANCE_POLICY_VERSION_V5
    || typeof question.questionHash !== "string"
    || (question.guidanceMode !== "correctness_blocking"
      && question.guidanceMode !== "nuance_optional")
    || typeof question.axis !== "string"
    || typeof question.trigger !== "string"
    || typeof question.baseContractRevisionId !== "string"
    || typeof question.baseContractSemanticHash !== "string"
    || !Array.isArray(question.allowedPatchOperations)
    || !Array.isArray(question.affectedClauseIds)
    || typeof question.materialityScore !== "number"
    || typeof question.criticality !== "string"
    || typeof question.selectionMode !== "string"
    || typeof question.allowCustom !== "boolean"
    || typeof question.axisRegistryVersion !== "string"
    || typeof question.simulationPolicyVersion !== "string"
    || typeof question.capabilitySnapshotHash !== "string"
    || typeof question.semanticConfigurationHash !== "string") {
    throw new Error("invalid_contract5_guidance_question");
  }
  const options = question.options.map((option) => {
    if (!option.contractPatch || !option.optionSimulation) {
      throw new Error("missing_contract5_guidance_patch_or_simulation");
    }
    return {
      id: option.id,
      label: option.label,
      description: option.description,
      recommended: option.recommended,
      ...(option.explicitNoop === true ? { explicitNoop: true } : {}),
      expectedFeasibilityDirection:
        option.contractPatch.expectedFeasibilityDirection,
      patch: {
        operations: option.contractPatch.operations.map((operation) => (
          structuredClone(
            operation,
          ) as unknown as PlaylistContractPatchOperationV1
        )),
        affectedClauseIds: [...option.contractPatch.affectedClauseIds],
      },
    };
  });
  const decision: GuidanceDecisionV5 = {
    schemaVersion: 5,
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
    mode: question.guidanceMode,
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
      ? {
          interpretationSummary: structuredClone(
            question.interpretationSummary,
          ),
        }
      : {}),
    options,
    axisRegistryVersion:
      question.axisRegistryVersion as GuidanceDecisionV5["axisRegistryVersion"],
    simulationPolicyVersion:
      question.simulationPolicyVersion as GuidanceDecisionV5["simulationPolicyVersion"],
    capabilitySnapshotHash: question.capabilitySnapshotHash,
    semanticConfigurationHash: question.semanticConfigurationHash,
    simulations: question.options.map((option) => {
      if (!option.optionSimulation) {
        throw new Error("missing_contract5_guidance_simulation");
      }
      return {
        optionId: option.id,
        patchHash: option.optionSimulation.patchHash,
        successorSemanticHash:
          option.optionSimulation.successorSemanticHash,
        executionEffect: option.executionEffect
          ? { ...option.executionEffect }
          : null,
        valid: true,
      };
    }),
    questionHash: question.questionHash,
  };
  assertGuidanceDecisionV5(decision, baseContract);
  return decision;
}

function predicateWithoutClauseIds(
  predicate: PlaylistPredicateV1,
  removedClauseIds: ReadonlySet<string>,
): PlaylistPredicateV1 | null {
  if (predicate.op === "clause") {
    return removedClauseIds.has(predicate.clauseId) ? null : predicate;
  }
  if (predicate.op === "not") {
    const child = predicateWithoutClauseIds(predicate.child, removedClauseIds);
    return child ? { op: "not", child } : null;
  }
  if (predicate.op === "except") {
    const base = predicateWithoutClauseIds(predicate.base, removedClauseIds);
    if (!base) return null;
    const exceptions = predicate.exceptions.flatMap((value) => {
      const next = predicateWithoutClauseIds(value, removedClauseIds);
      return next ? [next] : [];
    });
    return exceptions.length > 0 ? { op: "except", base, exceptions } : base;
  }
  if (predicate.op === "alternative") {
    const choices = predicate.choices.flatMap((choice) => {
      const next = predicateWithoutClauseIds(choice.predicate, removedClauseIds);
      return next ? [{ ...choice, predicate: next }] : [];
    });
    if (choices.length === 0) return null;
    if (choices.length === 1) return choices[0]!.predicate;
    return { op: "alternative", choices };
  }
  const children = predicate.children.flatMap((value) => {
    const next = predicateWithoutClauseIds(value, removedClauseIds);
    return next ? [next] : [];
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { op: predicate.op, children };
}

function predicateClauseIds(
  predicate: PlaylistPredicateV1,
  output = new Set<string>(),
): Set<string> {
  if (predicate.op === "clause") output.add(predicate.clauseId);
  else if (predicate.op === "not") predicateClauseIds(predicate.child, output);
  else if (predicate.op === "except") {
    predicateClauseIds(predicate.base, output);
    predicate.exceptions.forEach((value) => predicateClauseIds(value, output));
  } else if (predicate.op === "alternative") {
    predicate.choices.forEach(({ predicate: value }) => (
      predicateClauseIds(value, output)
    ));
  } else {
    predicate.children.forEach((value) => predicateClauseIds(value, output));
  }
  return output;
}

function composeGuidanceRoundOperations(
  base: PlaylistContractRevisionV1,
  operations: readonly PlaylistContractPatchOperationV1[],
): PlaylistContractPatchOperationV1[] {
  const predicateOperations = operations.filter(
    (operation): operation is Extract<
      PlaylistContractPatchOperationV1,
      { op: "replace_track_predicate" }
    > => operation.op === "replace_track_predicate",
  );
  if (predicateOperations.length <= 1) return [...operations];

  const removedClauseIds = new Set(operations.flatMap((operation) => (
    operation.op === "remove_clause" ? [operation.clauseId] : []
  )));
  const baseClauseIds = predicateClauseIds(base.trackPredicate);
  const addedClauseIds = new Set(operations.flatMap((operation) => (
    operation.op === "add_clause" ? [operation.clause.id] : []
  )));
  const guidedScopes = predicateOperations.flatMap(({ predicate }) => {
    const scope = predicateWithoutClauseIds(predicate, baseClauseIds);
    if (!scope) return [];
    const unownedClauseId = [...predicateClauseIds(scope)].find(
      (clauseId) => !addedClauseIds.has(clauseId),
    );
    if (unownedClauseId) {
      throw new Error("conflicting_contract3_guidance_predicates");
    }
    return [scope];
  }).filter((scope, index, all) => (
    all.findIndex((candidate) => (
      stableStringify(candidate) === stableStringify(scope)
    )) === index
  ));
  const preserved = predicateWithoutClauseIds(
    base.trackPredicate,
    removedClauseIds,
  );
  const children = [
    ...(preserved ? [preserved] : []),
    ...guidedScopes,
  ];
  if (children.length === 0) {
    throw new Error("empty_contract3_guidance_predicate");
  }
  const predicate = children.length === 1
    ? children[0]!
    : { op: "all" as const, children };
  return [
    ...operations.filter(({ op }) => op !== "replace_track_predicate"),
    { op: "replace_track_predicate", predicate },
  ];
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
    const decision = question.schemaVersion === 5
      ? guidanceDecisionV5FromPublicQuestion(question, input.base)
      : question.schemaVersion === 4
        ? guidanceDecisionV4FromPublicQuestion(question)
        : guidanceDecisionV3FromPublicQuestion(question);
    if (decision.baseContractRevisionId !== input.base.revisionId
      || decision.baseContractSemanticHash !== input.base.semanticHash) {
      throw new Error("stale_contract3_guidance_question");
    }
    const answer = answerByQuestion.get(question.id);
    if (answer?.customText) throw new Error("custom_contract3_answer_requires_recompile");
    return {
      decision,
      compiled: decision.schemaVersion === 5
        ? compileGuidanceSelectionV5(decision, {
            optionIds: answer?.optionIds ?? (
              answer?.optionId ? [answer.optionId] : []
            ),
            skipped: answer?.skipped,
          })
        : decision.schemaVersion === 4
          ? compileGuidanceSelectionV4(decision, {
            optionIds: answer?.optionIds ?? (answer?.optionId ? [answer.optionId] : []),
            skipped: answer?.skipped,
          })
        : compileGuidanceSelectionV3(decision, {
            optionIds: answer?.optionIds ?? (answer?.optionId ? [answer.optionId] : []),
            skipped: answer?.skipped,
          }),
    };
  });
  if (accepted.some(({ compiled }) => compiled.state === "required_answer_missing")) {
    throw new Error("required_contract3_answer_missing");
  }
  const operations = composeGuidanceRoundOperations(
    input.base,
    accepted.flatMap(({ compiled }) => compiled.operations),
  );
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
