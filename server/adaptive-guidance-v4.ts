import { sha256Hex, stableStringify } from "./security.ts";
import {
  applyPlaylistContractPatchV1,
  type PlaylistContractClauseDraftV1,
  type PlaylistContractPatchOperationV1,
  type PlaylistContractRevisionV1,
  type PlaylistPredicateV1,
} from "./playlist-contract-v1.ts";
import {
  deterministicGuidanceCandidatesV3,
  type GuidanceDecisionV3,
  type GuidanceFeasibilityDirectionV3,
  type GuidanceOptionV3,
  type GuidanceSelectionAnswerV3,
  type PlaylistInterpretationSummaryV1,
} from "./adaptive-guidance-v3.ts";
import type { CriticalAmbiguityV3 } from "./selection-plan-v3.ts";

export const ADAPTIVE_GUIDANCE_POLICY_VERSION_V4 = "adaptive_guidance_v4" as const;

export type GuidanceModeV4 =
  | "correctness_blocking"
  | "nuance_optional"
  | "interpretation_confirmation";

export interface GuidanceDecisionV4 {
  schemaVersion: 4;
  policyVersion: typeof ADAPTIVE_GUIDANCE_POLICY_VERSION_V4;
  mode: Exclude<GuidanceModeV4, "interpretation_confirmation">;
  id: string;
  header: string;
  question: string;
  axis: string;
  trigger: "correctness" | "yield_risk" | "nuance";
  criticality: "required" | "optional";
  selectionMode: "single" | "multiple";
  allowCustom: boolean;
  baseContractRevisionId: string;
  baseContractSemanticHash: string;
  whyMaterial: string;
  allowedPatchOperations: readonly string[];
  affectedClauseIds: readonly string[];
  materialityScore: number;
  interpretationSummary?: PlaylistInterpretationSummaryV1;
  options: readonly GuidanceOptionV3[];
  questionHash: string;
}

export interface GuidanceCheckpointV4 {
  policyVersion: typeof ADAPTIVE_GUIDANCE_POLICY_VERSION_V4;
  mode: GuidanceModeV4;
  decisions: readonly GuidanceDecisionV4[];
  interpretationSummary: PlaylistInterpretationSummaryV1;
  showEditableInterpretationSummary: boolean;
  showDecisionPanel: boolean;
  rejectedDecisionReasons: Readonly<Record<string, string>>;
  checkpointHash: string;
}

export interface CompiledGuidanceSelectionV4 {
  state: "accepted" | "required_answer_missing";
  answerHash: string;
  selectedOptionIds: string[];
  operations: PlaylistContractPatchOperationV1[];
  affectedClauseIds: string[];
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizedKey(value: string): string {
  return normalized(value).toLocaleLowerCase("en-US");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map(normalized).filter(Boolean))].sort();
}

function operationName(operation: PlaylistContractPatchOperationV1): string {
  return operation.op;
}

function withoutQuestionHash(
  decision: Omit<GuidanceDecisionV4, "questionHash">,
): Omit<GuidanceDecisionV4, "questionHash"> {
  return decision;
}

export function createGuidanceDecisionV4(
  input: Omit<GuidanceDecisionV4, "schemaVersion" | "policyVersion" | "questionHash">,
): GuidanceDecisionV4 {
  const body = withoutQuestionHash({
    schemaVersion: 4,
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V4,
    ...input,
    allowedPatchOperations: uniqueSorted(input.allowedPatchOperations),
    affectedClauseIds: uniqueSorted(input.affectedClauseIds),
    options: input.options.map((option) => ({
      ...option,
      patch: {
        operations: [...option.patch.operations],
        affectedClauseIds: uniqueSorted(option.patch.affectedClauseIds),
      },
    })),
  });
  const decision: GuidanceDecisionV4 = {
    ...body,
    questionHash: sha256Hex(stableStringify(body)),
  };
  assertGuidanceDecisionV4(decision);
  return decision;
}

function isCountMutation(operation: PlaylistContractPatchOperationV1): boolean {
  return operation.op === "set_requested_track_count";
}

/**
 * Server-side simulation is deliberately stricter than display validation:
 * every option must apply to the fenced base contract, produce a distinct
 * contract/ranking effect, and leave the immutable requested count unchanged.
 */
export function simulateGuidanceDecisionV4(
  decision: GuidanceDecisionV4,
  baseContract?: PlaylistContractRevisionV1,
): void {
  const effectHashes = new Set<string>();
  for (const option of decision.options) {
    if (option.patch.operations.some(isCountMutation)) {
      throw new Error("guidance_v4_cannot_change_count");
    }
    const effectHash = sha256Hex(stableStringify({
      operations: option.patch.operations,
      affectedClauseIds: option.patch.affectedClauseIds,
    }));
    if (effectHashes.has(effectHash)) throw new Error("guidance_v4_duplicate_option_effect");
    effectHashes.add(effectHash);
    if (!baseContract || option.patch.operations.length === 0) continue;
    const successor = applyPlaylistContractPatchV1(baseContract, {
      baseRevisionId: baseContract.revisionId,
      baseSemanticHash: baseContract.semanticHash,
      answerLineage: {
        questionSetHash: decision.questionHash,
        questionId: decision.id,
        answerHash: effectHash,
      },
      operations: option.patch.operations,
    });
    if (successor.requestedTrackCount !== baseContract.requestedTrackCount) {
      throw new Error("guidance_v4_count_drift");
    }
  }
}

export function assertGuidanceDecisionV4(
  decision: GuidanceDecisionV4,
  baseContract?: PlaylistContractRevisionV1,
): void {
  if (decision.schemaVersion !== 4
    || decision.policyVersion !== ADAPTIVE_GUIDANCE_POLICY_VERSION_V4) {
    throw new Error("unsupported_guidance_v4_version");
  }
  if (!decision.id.trim() || !decision.axis.trim() || !decision.question.trim()) {
    throw new Error("invalid_guidance_v4_identity");
  }
  if (!/^[a-f0-9]{64}$/u.test(decision.baseContractSemanticHash)) {
    throw new Error("invalid_guidance_v4_contract_hash");
  }
  if (decision.options.length < 2 || decision.options.length > 4) {
    throw new Error("guidance_v4_requires_two_to_four_options");
  }
  if (new Set(decision.options.map(({ id }) => id)).size !== decision.options.length) {
    throw new Error("duplicate_guidance_v4_option");
  }
  const recommendations = decision.options.filter(({ recommended }) => recommended).length;
  if (decision.mode === "correctness_blocking" && recommendations > 1) {
    throw new Error("blocking_guidance_v4_has_multiple_recommendations");
  }
  if (decision.mode === "nuance_optional") {
    if (recommendations !== 1) throw new Error("optional_guidance_v4_requires_one_recommendation");
    if (!decision.options.some(({ id }) => id === "keep_current_interpretation")) {
      throw new Error("optional_guidance_v4_requires_keep_option");
    }
  }
  const allowedOperations = new Set(decision.allowedPatchOperations);
  const allowedClauseIds = new Set(decision.affectedClauseIds);
  for (const option of decision.options) {
    if (!option.id.trim() || !option.label.trim() || !option.description.trim()) {
      throw new Error("invalid_guidance_v4_option");
    }
    if (option.id === "keep_current_interpretation") {
      if (option.patch.operations.length || option.patch.affectedClauseIds.length) {
        throw new Error("guidance_v4_keep_option_must_be_noop");
      }
    } else if (!option.patch.operations.length) {
      throw new Error("empty_guidance_v4_patch");
    }
    for (const operation of option.patch.operations) {
      if (!allowedOperations.has(operationName(operation))) {
        throw new Error("guidance_v4_patch_operation_not_allowed");
      }
    }
    for (const clauseId of option.patch.affectedClauseIds) {
      if (!allowedClauseIds.has(clauseId)) {
        throw new Error("guidance_v4_patch_clause_not_allowed");
      }
    }
  }
  const hashBody = Object.fromEntries(
    Object.entries(decision).filter(([key]) => key !== "questionHash"),
  );
  const expectedHash = sha256Hex(stableStringify(hashBody));
  // The first V4 production build upgraded V3 questions with an explicit
  // `interpretationSummary: undefined`. Its public projection omitted that
  // non-value, so an otherwise identical in-flight question could not
  // round-trip its own hash. Accept only that exact legacy representation;
  // every executable field, option, patch, and contract fence is still
  // validated above.
  const legacyUndefinedSummaryHash = decision.interpretationSummary === undefined
    ? sha256Hex(stableStringify({
        ...hashBody,
        interpretationSummary: undefined,
      }))
    : null;
  if (decision.questionHash !== expectedHash
    && decision.questionHash !== legacyUndefinedSummaryHash) {
    throw new Error("guidance_v4_question_hash_mismatch");
  }
  simulateGuidanceDecisionV4(decision, baseContract);
}

function upgradedV3Mode(decision: GuidanceDecisionV3): GuidanceDecisionV4["mode"] {
  return decision.trigger === "correctness" && decision.criticality === "required"
    ? "correctness_blocking"
    : "nuance_optional";
}

function keepCurrentOption(): GuidanceOptionV3 {
  return {
    id: "keep_current_interpretation",
    label: "Keep my request as written",
    description: "Do not add another taste preference.",
    recommended: false,
    expectedFeasibilityDirection: "neutral",
    patch: { operations: [], affectedClauseIds: [] },
  };
}

export function upgradeGuidanceDecisionV3(
  decision: GuidanceDecisionV3,
): GuidanceDecisionV4 {
  const mode = upgradedV3Mode(decision);
  let options = decision.options.map((option) => structuredClone(option));
  if (mode === "correctness_blocking") {
    const preserveWordingRecommendation = decision.axis === "adjacent_latin_urban_scope";
    options = options.map((option) => ({
      ...option,
      recommended: preserveWordingRecommendation && option.id === "reggaeton_dembow_latin_urban",
    }));
  } else {
    if (!options.some(({ id }) => id === "keep_current_interpretation")) {
      if (options.length >= 4) options = options.slice(0, 3);
      options.push(keepCurrentOption());
    }
    const recommendedId = options.find(({ recommended }) => recommended)?.id
      ?? "keep_current_interpretation";
    options = options.map((option) => ({
      ...option,
      recommended: option.id === recommendedId,
    }));
  }
  return createGuidanceDecisionV4({
    mode,
    id: decision.id.replace(/^v3/u, "v4"),
    header: decision.header,
    question: decision.question,
    axis: decision.axis,
    trigger: decision.trigger,
    criticality: decision.criticality,
    selectionMode: decision.selectionMode,
    allowCustom: decision.allowCustom,
    baseContractRevisionId: decision.baseContractRevisionId,
    baseContractSemanticHash: decision.baseContractSemanticHash,
    whyMaterial: decision.whyMaterial,
    allowedPatchOperations: decision.allowedPatchOperations,
    affectedClauseIds: decision.affectedClauseIds,
    materialityScore: decision.materialityScore,
    ...(decision.interpretationSummary
      ? { interpretationSummary: decision.interpretationSummary }
      : {}),
    options,
  });
}

function predicateWithAddedClause(
  predicate: PlaylistPredicateV1,
  clauseId: string,
): PlaylistPredicateV1 {
  return predicate.op === "all"
    ? { op: "all", children: [...predicate.children, { op: "clause", clauseId }] }
    : { op: "all", children: [predicate, { op: "clause", clauseId }] };
}

function eraClause(id: string, values: readonly string[], sourceText: string): PlaylistContractClauseDraftV1 {
  return {
    id,
    kind: "catalog_version",
    scope: "track",
    hardness: "hard",
    axis: "era",
    operator: "require",
    values,
    source: { provenance: "guidance", text: sourceText },
    unknownPolicy: "reject",
  };
}

function temporalWidthDecision(input: {
  ambiguity: CriticalAmbiguityV3;
  baseContract: PlaylistContractRevisionV1;
}): GuidanceDecisionV4 | null {
  const year = input.ambiguity.key === "temporal_width"
    ? input.ambiguity.yearValue
    : undefined;
  if (!year) return null;
  const decade = Math.floor(year / 10) * 10;
  const specs = [
    {
      id: "era_year_only",
      label: `${year} only`,
      description: `Use recordings released in ${year}.`,
      values: [String(year)],
    },
    {
      id: "era_around_year",
      label: `Around ${year}`,
      description: `Use ${year - 2}–${year + 2}.`,
      values: [String(year - 2), String(year + 2)],
    },
    {
      id: "era_full_decade",
      label: `The ${decade}s`,
      description: `Use ${decade}–${decade + 9}.`,
      values: [String(decade), String(decade + 9)],
    },
  ] as const;
  const clauseIds = specs.map(({ id }) => `guidance:v4:temporal:${id}`);
  return createGuidanceDecisionV4({
    mode: "correctness_blocking",
    id: "v4-critical:temporal_width",
    header: "Time span",
    question: `What time span should “${year}” cover?`,
    axis: "temporal_width",
    trigger: "correctness",
    criticality: "required",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: input.baseContract.revisionId,
    baseContractSemanticHash: input.baseContract.semanticHash,
    whyMaterial: "One release year, a nearby window, and a full decade produce different eligible catalogues.",
    allowedPatchOperations: ["add_clause", "replace_track_predicate"],
    affectedClauseIds: clauseIds,
    materialityScore: 100,
    options: specs.map((spec) => {
      const clauseId = `guidance:v4:temporal:${spec.id}`;
      return {
        id: spec.id,
        label: spec.label,
        description: spec.description,
        recommended: false,
        expectedFeasibilityDirection: (
          spec.id === "era_year_only" ? "narrower"
            : spec.id === "era_full_decade" ? "broader"
              : "neutral"
        ) as GuidanceFeasibilityDirectionV3,
        patch: {
          affectedClauseIds: [clauseId],
          operations: [
            {
              op: "add_clause",
              clause: eraClause(clauseId, spec.values, spec.description),
            },
            {
              op: "replace_track_predicate",
              predicate: predicateWithAddedClause(input.baseContract.trackPredicate, clauseId),
            },
          ],
        },
      };
    }),
  });
}

function preferenceClause(
  id: string,
  axis: string,
  value: string,
  text: string,
): PlaylistContractClauseDraftV1 {
  return {
    id,
    kind: "ranking_preference",
    scope: "track",
    hardness: "soft",
    axis,
    operator: "prefer",
    values: [value],
    source: { provenance: "guidance", text },
    unknownPolicy: "allow",
  };
}

function optionalPreferenceDecision(input: {
  baseContract: PlaylistContractRevisionV1;
  id: string;
  axis: string;
  header: string;
  question: string;
  whyMaterial: string;
  options: readonly { id: string; label: string; description: string; value: string; recommended?: boolean }[];
}): GuidanceDecisionV4 {
  const clauseIds = input.options.map(({ id }) => `guidance:v4:${input.axis}:${id}`);
  const explicitlyRecommended = input.options.find(({ recommended }) => recommended)?.id;
  const recommendedId = explicitlyRecommended ?? input.options[0]?.id;
  return createGuidanceDecisionV4({
    mode: "nuance_optional",
    id: input.id,
    header: input.header,
    question: input.question,
    axis: input.axis,
    trigger: "nuance",
    criticality: "optional",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: input.baseContract.revisionId,
    baseContractSemanticHash: input.baseContract.semanticHash,
    whyMaterial: input.whyMaterial,
    allowedPatchOperations: ["add_clause"],
    affectedClauseIds: clauseIds,
    materialityScore: 70,
    options: [
      ...input.options.map((option) => {
        const clauseId = `guidance:v4:${input.axis}:${option.id}`;
        return {
          id: option.id,
          label: option.label,
          description: option.description,
          recommended: option.id === recommendedId,
          expectedFeasibilityDirection: "neutral" as const,
          patch: {
            affectedClauseIds: [clauseId],
            operations: [{
              op: "add_clause" as const,
              clause: preferenceClause(
                clauseId,
                input.axis,
                option.value,
                option.description,
              ),
            }],
          },
        };
      }),
      keepCurrentOption(),
    ],
  });
}

function narrativeDateDecision(
  prompt: string,
  baseContract: PlaylistContractRevisionV1,
  compilationYear: number,
): GuidanceDecisionV4 | null {
  if (!/\b(?:met|when we|grew up|years? ago)\b/iu.test(prompt)
    || !/\b(?:r\s*&?\s*b|rhythm\s+and\s+blues)\b/iu.test(prompt)
    || !/\b(?:long island|del mar)\b/iu.test(prompt)) return null;
  const yearsAgo = Number(prompt.match(/\b(\d{1,2})\s+years?\s+ago\b/iu)?.[1] ?? 10);
  const year = compilationYear - yearsAgo;
  const decade = Math.floor(year / 10) * 10;
  return optionalPreferenceDecision({
    baseContract,
    id: "v4-nuance:narrative-date-window",
    axis: "narrative_date_window",
    header: "Time window",
    question: "How tightly should the music follow when you met?",
    whyMaterial: "The date window changes the period emphasized while both places remain listening context.",
    options: [
      { id: "meeting_year", label: `${year}`, description: `Emphasize releases from ${year}.`, value: String(year) },
      { id: "around_meeting_year", label: `Around ${year}`, description: `Emphasize ${year - 2}–${year + 2}.`, value: `${year - 2}-${year + 2}`, recommended: true },
      { id: "meeting_decade", label: `The ${decade}s`, description: `Emphasize the broader ${decade}s.`, value: `${decade}-${decade + 9}` },
    ],
  });
}

function lateNightSmokeDecision(
  prompt: string,
  baseContract: PlaylistContractRevisionV1,
): GuidanceDecisionV4 | null {
  if (!/\blate[- ]night\s+smoke\b/iu.test(prompt)
    && !(/\bsmok(?:e|ing)\b/iu.test(prompt) && /\blate[- ]night\b/iu.test(prompt))) {
    return null;
  }
  return optionalPreferenceDecision({
    baseContract,
    id: "v4-nuance:late-night-sonic-anchor",
    axis: "sonic_anchor",
    header: "Sonic anchor",
    question: "What should anchor the late-night mood?",
    whyMaterial: "The anchor changes discovery and sequencing without turning a vibe into a hard genre rule.",
    options: [
      { id: "downtempo_electronic", label: "Downtempo / electronic", description: "Lean atmospheric, spacious, and electronic.", value: "downtempo electronic" },
      { id: "mellow_hiphop_rnb", label: "Mellow hip-hop / R&B", description: "Lean warm, rhythmic, and vocal.", value: "mellow hip-hop and R&B", recommended: true },
      { id: "cross_genre", label: "Cross-genre", description: "Blend compatible styles around the mood.", value: "cross-genre late-night" },
    ],
  });
}

export function interpretationSummaryV4(
  contract: PlaylistContractRevisionV1,
): PlaylistInterpretationSummaryV1 {
  const hard = contract.clauses.filter(({ hardness }) => hardness === "hard");
  const soft = contract.clauses.filter(({ hardness }) => hardness === "soft");
  return {
    mustHave: hard.filter(({ operator }) => operator !== "exclude").map(({ source }) => source.text),
    prefer: soft.map(({ source }) => source.text),
    avoid: hard.filter(({ operator }) => operator === "exclude").map(({ source }) => source.text),
    flow: contract.sequencingObjectives.map(({ dimension, direction }) => `${dimension}: ${direction}`),
    count: contract.requestedTrackCount,
  };
}

export function guidanceCheckpointV4(input: {
  prompt: string;
  baseContract: PlaylistContractRevisionV1;
  preservedTrackPredicate: PlaylistPredicateV1 | null;
  ambiguousScopeClauseIds: readonly string[];
  criticalAmbiguities?: readonly CriticalAmbiguityV3[];
  requestShape: "fully_explicit" | "fixed_list" | "factual" | "curated";
  compilationTimestamp?: string;
  answeredAxes?: readonly string[];
  priorQuestionHashes?: readonly string[];
  clarificationAttemptsByAxis?: Readonly<Record<string, number>>;
}): GuidanceCheckpointV4 {
  const summary = interpretationSummaryV4(input.baseContract);
  const temporalAmbiguities = (input.criticalAmbiguities ?? [])
    .filter(({ key }) => key === "temporal_width");
  const v3Candidates = deterministicGuidanceCandidatesV3({
    prompt: input.prompt,
    baseContractRevisionId: input.baseContract.revisionId,
    baseContractSemanticHash: input.baseContract.semanticHash,
    preservedTrackPredicate: input.preservedTrackPredicate,
    ambiguousScopeClauseIds: input.ambiguousScopeClauseIds,
    baseContract: input.baseContract,
    criticalAmbiguities: (input.criticalAmbiguities ?? [])
      .filter(({ key }) => key !== "temporal_width"),
  }).map((decision) => upgradeGuidanceDecisionV3(decision));
  const compilationYear = new Date(input.compilationTimestamp ?? new Date().toISOString())
    .getUTCFullYear();
  const candidates = [
    ...temporalAmbiguities.flatMap((ambiguity) => {
      const decision = temporalWidthDecision({ ambiguity, baseContract: input.baseContract });
      return decision ? [decision] : [];
    }),
    ...(
      narrativeDateDecision(input.prompt, input.baseContract, compilationYear)
        ? [narrativeDateDecision(input.prompt, input.baseContract, compilationYear)!]
        : []
    ),
    ...(
      lateNightSmokeDecision(input.prompt, input.baseContract)
        ? [lateNightSmokeDecision(input.prompt, input.baseContract)!]
        : []
    ),
    ...v3Candidates,
  ];
  const answeredAxes = new Set((input.answeredAxes ?? []).map(normalizedKey));
  const priorQuestionHashes = new Set(input.priorQuestionHashes ?? []);
  const rejectedDecisionReasons: Record<string, string> = {};
  let showDecisionPanel = false;
  let showEditableInterpretationSummary = false;
  const eligible = candidates.filter((candidate) => {
    assertGuidanceDecisionV4(candidate, input.baseContract);
    if (answeredAxes.has(normalizedKey(candidate.axis))) {
      rejectedDecisionReasons[candidate.id] = "axis_already_answered";
      return false;
    }
    if (priorQuestionHashes.has(candidate.questionHash)) {
      rejectedDecisionReasons[candidate.id] = "question_hash_already_used";
      return false;
    }
    if ((input.clarificationAttemptsByAxis?.[candidate.axis] ?? 0) >= 2) {
      rejectedDecisionReasons[candidate.id] = "clarification_attempt_limit";
      showDecisionPanel = true;
      showEditableInterpretationSummary = true;
      return false;
    }
    if (input.requestShape !== "curated" && candidate.mode === "nuance_optional") {
      rejectedDecisionReasons[candidate.id] = "explicit_request_uses_confirmation";
      return false;
    }
    return true;
  });
  const blocking = eligible.find(({ mode }) => mode === "correctness_blocking");
  const optional = eligible.find(({ mode }) => mode === "nuance_optional");
  const decisions = [
    ...(blocking ? [blocking] : []),
    ...(optional ? [optional] : []),
  ];
  const mode: GuidanceModeV4 = blocking
    ? "correctness_blocking"
    : optional
      ? "nuance_optional"
      : "interpretation_confirmation";
  if (mode === "interpretation_confirmation") showEditableInterpretationSummary = true;
  const body = {
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V4,
    mode,
    decisionHashes: decisions.map(({ questionHash }) => questionHash),
    summary,
    showEditableInterpretationSummary,
    showDecisionPanel,
  };
  return {
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V4,
    mode,
    decisions,
    interpretationSummary: summary,
    showEditableInterpretationSummary,
    showDecisionPanel,
    rejectedDecisionReasons,
    checkpointHash: sha256Hex(stableStringify(body)),
  };
}

export function compileGuidanceSelectionV4(
  decision: GuidanceDecisionV4,
  answer: GuidanceSelectionAnswerV3,
): CompiledGuidanceSelectionV4 {
  assertGuidanceDecisionV4(decision);
  if (answer.skipped) {
    const answerHash = sha256Hex(stableStringify({
      questionHash: decision.questionHash,
      skipped: true,
    }));
    return decision.criticality === "required"
      ? { state: "required_answer_missing", answerHash, selectedOptionIds: [], operations: [], affectedClauseIds: [] }
      : { state: "accepted", answerHash, selectedOptionIds: [], operations: [], affectedClauseIds: [] };
  }
  const optionIds = [...new Set(answer.optionIds ?? [])];
  if (decision.selectionMode === "single" && optionIds.length !== 1) {
    return {
      state: decision.criticality === "required" ? "required_answer_missing" : "accepted",
      answerHash: sha256Hex(stableStringify({ questionHash: decision.questionHash, optionIds })),
      selectedOptionIds: [],
      operations: [],
      affectedClauseIds: [],
    };
  }
  const selected = optionIds.map((id) => {
    const option = decision.options.find((candidate) => candidate.id === id);
    if (!option) throw new Error("unknown_guidance_v4_option");
    return option;
  });
  return {
    state: "accepted",
    answerHash: sha256Hex(stableStringify({
      questionHash: decision.questionHash,
      optionIds,
    })),
    selectedOptionIds: optionIds,
    operations: selected.flatMap(({ patch }) => [...patch.operations]),
    affectedClauseIds: uniqueSorted(selected.flatMap(({ patch }) => patch.affectedClauseIds)),
  };
}
