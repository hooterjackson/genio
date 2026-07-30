import { sha256Hex, stableStringify } from "./security.ts";
import {
  customGuidanceTrackCountAdmission,
  type CustomGuidanceTrackCountAuthorityV1,
} from "./playlist-count-policy.ts";
import type {
  PlaylistContractClauseDraftV1,
  PlaylistContractPatchV1,
  PlaylistContractPatchOperationV1,
  PlaylistContractRevisionV1,
  PlaylistPredicateV1,
  PlaylistQuotaConstraintV1,
  PlaylistSequencingObjectiveV1,
} from "./playlist-contract-v1.ts";
import {
  applyPlaylistContractPatchV1,
} from "./playlist-contract-v1.ts";
import {
  exactArtistExclusionIntentsV1,
  type ResolvedExactArtistIdentityV1,
} from "./exact-artist-identity-v1.ts";
import type {
  CriticalAmbiguityV3,
} from "./selection-plan-v3.ts";

export const ADAPTIVE_GUIDANCE_POLICY_VERSION = "adaptive_guidance_v3" as const;
const FLOW_GUIDANCE_CLAUSE_ID = "guidance:flow:objective";
const FLOW_GUIDANCE_SEQUENCE_ID = "guidance:flow:sequence";

export type GuidanceTriggerV3 = "correctness" | "yield_risk" | "nuance";
export type GuidanceCriticalityV3 = "required" | "optional";
export type GuidanceSelectionModeV3 = "single" | "multiple";
export type GuidanceFeasibilityDirectionV3 = "narrower" | "neutral" | "broader";

/**
 * A patch template contains server-owned operations but not answer lineage.
 * The lineage and contract fence are attached only after a valid answer is
 * accepted, so a display option cannot be replayed against another revision.
 */
export interface GuidancePatchTemplateV3 {
  operations: readonly PlaylistContractPatchOperationV1[];
  affectedClauseIds: readonly string[];
}

export interface GuidanceOptionV3 {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
  /**
   * A server-owned, explicitly labelled answer that confirms the already
   * compiled semantics. This is never an implicit default.
   */
  explicitNoop?: boolean;
  expectedFeasibilityDirection: GuidanceFeasibilityDirectionV3;
  patch: GuidancePatchTemplateV3;
}

export interface GuidanceDecisionV3 {
  schemaVersion: 3;
  policyVersion: typeof ADAPTIVE_GUIDANCE_POLICY_VERSION;
  id: string;
  header: string;
  question: string;
  axis: string;
  trigger: GuidanceTriggerV3;
  criticality: GuidanceCriticalityV3;
  selectionMode: GuidanceSelectionModeV3;
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

export interface PlaylistInterpretationSummaryV1 {
  mustHave: readonly string[];
  prefer: readonly string[];
  avoid: readonly string[];
  flow: readonly string[];
  count: number;
}

export interface GuidanceRoundSelectionInputV3 {
  stage: "initial" | "rescue";
  requestShape: "fully_explicit" | "fixed_list" | "factual" | "curated";
  candidates: readonly GuidanceDecisionV3[];
  explicitAxes?: readonly string[];
  answeredAxes?: readonly string[];
  clarificationAttemptsByAxis?: Readonly<Record<string, number>>;
  rescueQuestionsAlreadyAsked?: number;
}

export interface GuidanceRoundV3 {
  decisions: GuidanceDecisionV3[];
  showEditableInterpretationSummary: boolean;
  showDecisionPanel: boolean;
  rejectedDecisionReasons: Record<string, string>;
  roundHash: string;
}

export interface GuidanceSelectionAnswerV3 {
  optionIds?: readonly string[];
  skipped?: boolean;
}

export interface CompiledGuidanceSelectionV3 {
  state: "accepted" | "required_answer_missing";
  answerHash: string;
  selectedOptionIds: string[];
  operations: PlaylistContractPatchOperationV1[];
  affectedClauseIds: string[];
}

export interface ServerCompiledCustomGuidanceV3 {
  operations: readonly PlaylistContractPatchOperationV1[];
  affectedClauseIds: readonly string[];
}

export interface CompiledCustomGuidanceAnswerV3 {
  state: "needs_recompile" | "needs_confirmation" | "accepted";
  normalizedText: string;
  answerHash: string;
  hardChangeReasons: string[];
  executableOperations: PlaylistContractPatchOperationV1[] | null;
  affectedClauseIds: string[];
}

export interface ServerRecompiledCustomGuidanceV3 {
  normalizedText: string;
  operations: PlaylistContractPatchOperationV1[];
  affectedClauseIds: string[];
  hardChangeReasons: string[];
  summary: PlaylistInterpretationSummaryV1;
  previewContract: PlaylistContractRevisionV1;
}

export interface AcceptedGuidanceExecutionV3 {
  answerHash: string;
  executableOperations: readonly PlaylistContractPatchOperationV1[];
}

export const SMOOTH_REGGAETON_HEAT_PROMPT = "Smooth Reggaeton Heat: A 50-track smooth reggaeton playlist centered on polished, sensual, danceable reggaeton and adjacent Latin urban tracks with a flirtatious, crowd-pleasing vibe." as const;

const REGGAETON_CORE_CLAUSE_ID = "guidance:membership:core-reggaeton";
const REGGAETON_DEMBOW_CLAUSE_ID = "guidance:membership:dembow";
const REGGAETON_LATIN_URBAN_CLAUSE_ID = "guidance:membership:latin-urban";
const REGGAETON_LATIN_POP_CLAUSE_ID = "guidance:membership:latin-pop";
const REGGAETON_CORE_QUOTA_CLAUSE_ID = "guidance:quota:core-reggaeton-share";
const REGGAETON_CORE_QUOTA_ID = "quota:genre:core-reggaeton-share";

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizedPrompt(value: string): string {
  return normalized(value)
    .toLocaleLowerCase("en-US")
    .replace(/[–—]/gu, "-")
    .replace(/\s*([,:.!?])\s*/gu, "$1");
}

function guidanceMembershipClause(
  id: string,
  conceptId: string,
  label: string,
): PlaylistContractClauseDraftV1 {
  return {
    id,
    kind: "membership",
    scope: "track",
    hardness: "hard",
    axis: "genre",
    operator: "require",
    conceptInputs: [{
      text: label,
      expectedKind: "genre",
      selectedConceptId: conceptId,
    }],
    source: {
      provenance: "guidance",
      text: label,
    },
    unknownPolicy: "defer",
  };
}

function reggaetonScopeOperations(input: {
  concepts: ReadonlyArray<{ clauseId: string; conceptId: string; label: string }>;
  minimumCoreShare: number;
  ambiguousScopeClauseIds: readonly string[];
  preservedTrackPredicate: PlaylistPredicateV1 | null;
}): PlaylistContractPatchOperationV1[] {
  const scopePredicate: PlaylistPredicateV1 = input.concepts.length === 1
    ? { op: "clause", clauseId: input.concepts[0]!.clauseId }
    : {
      op: "any",
      children: input.concepts.map(({ clauseId }) => ({ op: "clause", clauseId })),
    };
  const predicate: PlaylistPredicateV1 = input.preservedTrackPredicate
    ? {
      op: "all",
      children: [input.preservedTrackPredicate, scopePredicate],
    }
    : scopePredicate;
  const quotaClause: PlaylistContractClauseDraftV1 = {
    id: REGGAETON_CORE_QUOTA_CLAUSE_ID,
    kind: "quota_diversity",
    scope: "playlist",
    hardness: "hard",
    axis: "genre",
    operator: "limit",
    values: [`minimum core reggaeton share ${input.minimumCoreShare}`],
    source: {
      provenance: "guidance",
      text: `At least ${Math.round(input.minimumCoreShare * 100)}% core reggaeton.`,
    },
  };
  const constraints: PlaylistQuotaConstraintV1[] = [{
    id: REGGAETON_CORE_QUOTA_ID,
    clauseId: REGGAETON_CORE_QUOTA_CLAUSE_ID,
    predicate: { op: "clause", clauseId: REGGAETON_CORE_CLAUSE_ID },
    minimumCount: null,
    maximumCount: null,
    minimumRatio: input.minimumCoreShare,
    maximumRatio: 1,
  }];
  return [
    ...input.ambiguousScopeClauseIds.map((clauseId) => ({
      op: "remove_clause" as const,
      clauseId,
    })),
    ...input.concepts.map(({ clauseId, conceptId, label }) => ({
      op: "add_clause" as const,
      clause: guidanceMembershipClause(clauseId, conceptId, label),
    })),
    {
      op: "replace_track_predicate",
      predicate,
    },
    {
      op: "add_clause",
      clause: quotaClause,
    },
    {
      op: "set_playlist_constraints",
      constraints,
    },
  ];
}

export function isSmoothReggaetonHeatRequestV3(prompt: string): boolean {
  return normalizedPrompt(prompt) === normalizedPrompt(SMOOTH_REGGAETON_HEAT_PROMPT);
}

/**
 * The production regression has one material semantic fork: what "adjacent
 * Latin urban" permits. Texture and vibe terms remain ranking/suitability
 * objectives and deliberately do not become per-track evidence gates here.
 */
export function smoothReggaetonHeatGuidanceDecisionV3(input: {
  prompt: string;
  baseContractRevisionId: string;
  baseContractSemanticHash: string;
  /**
   * The preliminary compiler removes only the ambiguous adjacent-genre
   * subtree. Every unrelated hard predicate is supplied here and preserved.
   */
  preservedTrackPredicate: PlaylistPredicateV1 | null;
  ambiguousScopeClauseIds: readonly string[];
}): GuidanceDecisionV3 | null {
  if (!isSmoothReggaetonHeatRequestV3(input.prompt)) return null;
  const clauseIds = [
    ...input.ambiguousScopeClauseIds,
    REGGAETON_CORE_CLAUSE_ID,
    REGGAETON_DEMBOW_CLAUSE_ID,
    REGGAETON_LATIN_URBAN_CLAUSE_ID,
    REGGAETON_LATIN_POP_CLAUSE_ID,
    REGGAETON_CORE_QUOTA_CLAUSE_ID,
  ] as const;
  const coreConcepts = [
    {
      clauseId: REGGAETON_CORE_CLAUSE_ID,
      conceptId: "genre:reggaeton",
      label: "reggaeton",
    },
  ] as const;
  const adjacentConcepts = [
    ...coreConcepts,
    {
      clauseId: REGGAETON_DEMBOW_CLAUSE_ID,
      conceptId: "genre:dembow",
      label: "dembow",
    },
    {
      clauseId: REGGAETON_LATIN_URBAN_CLAUSE_ID,
      conceptId: "genre:latin-urban",
      label: "Latin urban",
    },
  ] as const;
  const crossoverConcepts = [
    ...adjacentConcepts,
    {
      clauseId: REGGAETON_LATIN_POP_CLAUSE_ID,
      conceptId: "genre:latin-pop",
      label: "Latin pop",
    },
  ] as const;
  return createGuidanceDecisionV3({
    id: "guidance:reggaeton:adjacent-latin-urban-scope",
    header: "Genre reach",
    question: "How far should “adjacent Latin urban” extend?",
    axis: "adjacent_latin_urban_scope",
    trigger: "correctness",
    criticality: "required",
    selectionMode: "single",
    // This axis is compiled only through the server-owned options below.
    // Free text can express a scope the typed reggaeton compiler cannot
    // represent, so do not advertise a custom path that must later reject.
    allowCustom: false,
    baseContractRevisionId: input.baseContractRevisionId,
    baseContractSemanticHash: input.baseContractSemanticHash,
    whyMaterial: "This determines which non-reggaeton recordings may enter while preserving a core reggaeton majority.",
    allowedPatchOperations: [
      "add_clause",
      "remove_clause",
      "replace_track_predicate",
      "set_playlist_constraints",
    ],
    affectedClauseIds: clauseIds,
    materialityScore: 100,
    options: [
      {
        id: "core_reggaeton_only",
        label: "Core reggaeton only",
        description: "Every track must qualify as reggaeton.",
        recommended: false,
        expectedFeasibilityDirection: "narrower",
        patch: {
          affectedClauseIds: [
            REGGAETON_CORE_CLAUSE_ID,
            REGGAETON_CORE_QUOTA_CLAUSE_ID,
          ],
          operations: reggaetonScopeOperations({
            concepts: coreConcepts,
            minimumCoreShare: 1,
            ambiguousScopeClauseIds: input.ambiguousScopeClauseIds,
            preservedTrackPredicate: input.preservedTrackPredicate,
          }),
        },
      },
      {
        id: "reggaeton_dembow_latin_urban",
        label: "Reggaeton + Latin urban",
        description: "Keep at least 70% core reggaeton, with qualifying dembow and Latin urban around it.",
        recommended: true,
        expectedFeasibilityDirection: "neutral",
        patch: {
          affectedClauseIds: [
            REGGAETON_CORE_CLAUSE_ID,
            REGGAETON_DEMBOW_CLAUSE_ID,
            REGGAETON_LATIN_URBAN_CLAUSE_ID,
            REGGAETON_CORE_QUOTA_CLAUSE_ID,
          ],
          operations: reggaetonScopeOperations({
            concepts: adjacentConcepts,
            minimumCoreShare: 0.7,
            ambiguousScopeClauseIds: input.ambiguousScopeClauseIds,
            preservedTrackPredicate: input.preservedTrackPredicate,
          }),
        },
      },
      {
        id: "broader_latin_crossover",
        label: "Broader crossover",
        description: "Keep at least 50% core reggaeton, with the remainder qualifying as Latin urban/pop crossover.",
        recommended: false,
        expectedFeasibilityDirection: "broader",
        patch: {
          affectedClauseIds: clauseIds,
          operations: reggaetonScopeOperations({
            concepts: crossoverConcepts,
            minimumCoreShare: 0.5,
            ambiguousScopeClauseIds: input.ambiguousScopeClauseIds,
            preservedTrackPredicate: input.preservedTrackPredicate,
          }),
        },
      },
    ],
  });
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

function predicateWithRequiredClause(
  predicate: PlaylistPredicateV1 | null,
  clauseId: string,
): PlaylistPredicateV1 {
  const required: PlaylistPredicateV1 = { op: "clause", clauseId };
  if (!predicate) return required;
  return {
    op: "all",
    children: [predicate, required],
  };
}

function predicateWithGuidedScope(
  preserved: PlaylistPredicateV1 | null,
  clauseIds: readonly string[],
  composition: "all" | "any" = "all",
): PlaylistPredicateV1 {
  if (clauseIds.length === 0) throw new Error("critical_guidance_scope_is_empty");
  const scope: PlaylistPredicateV1 = clauseIds.length === 1
    ? { op: "clause", clauseId: clauseIds[0]! }
    : {
      op: composition,
      children: clauseIds.map((clauseId) => ({ op: "clause", clauseId })),
    };
  if (!preserved) return scope;
  return {
    op: "all",
    children: [preserved, scope],
  };
}

function criticalMembershipClause(input: {
  id: string;
  axis: string;
  value: string;
  sourceText: string;
  conceptId?: string;
  expectedKind?: "genre" | "theme";
  relationship?: string;
}): PlaylistContractClauseDraftV1 {
  return {
    id: input.id,
    kind: "membership",
    scope: "track",
    hardness: "hard",
    axis: input.axis,
    operator: "require",
    values: [
      input.value,
      ...(input.relationship ? [`relationship:${input.relationship}`] : []),
    ],
    ...(input.conceptId && input.expectedKind ? {
      conceptInputs: [{
        text: input.value,
        expectedKind: input.expectedKind,
        selectedConceptId: input.conceptId,
      }],
    } : {}),
    source: {
      provenance: "guidance",
      text: input.sourceText,
    },
    unknownPolicy: "defer",
  };
}

function criticalFactualClause(input: {
  id: string;
  value: string;
  relationship: string;
  sourceText: string;
}): PlaylistContractClauseDraftV1 {
  return {
    id: input.id,
    kind: "factual_relationship",
    scope: "track",
    hardness: "hard",
    axis: "factual_relationship",
    operator: "require",
    values: [input.value, `relationship:${input.relationship}`],
    source: {
      provenance: "guidance",
      text: input.sourceText,
    },
    unknownPolicy: "defer",
  };
}

function criticalAmbiguityClauseMatches(
  ambiguity: CriticalAmbiguityV3,
  clause: PlaylistContractRevisionV1["clauses"][number],
): boolean {
  if (clause.scope !== "track") return false;
  const axis = normalizedKey(clause.axis);
  const material = normalizedKey([
    clause.axis,
    ...clause.values,
    ...clause.concepts.map(({ originalText }) => originalText),
    clause.source.text,
  ].join(" "));
  if (ambiguity.key === "house_semantics") {
    return ["genre", "subgenre", "scene", "theme"].includes(axis)
      && /\b(?:house|houses|home|homes)\b/u.test(material);
  }
  if (ambiguity.key === "french_jazz_scope") {
    return ["geography", "scene", "language"].includes(axis)
      && /\b(?:french|france)\b/u.test(material);
  }
  if (ambiguity.key === "geographic_genre_scope") {
    if (!["geography", "scene", "language"].includes(axis)) return false;
    const values = [
      ambiguity.geographicLabel,
      ambiguity.sceneValue,
      ambiguity.originValue,
      ambiguity.languageValue,
    ].flatMap((value) => value ? [normalizedKey(value)] : []);
    return values.some((value) => material.includes(value));
  }
  if (ambiguity.key === "possessive_relationship") {
    return axis === "relationship" || axis === "factual_relationship";
  }
  const namesBrazilianFunk = /\b(?:brazilian funk|funk carioca|baile funk|brazilian soul(?:-| )?funk|samba(?:-| )?funk)\b/u
    .test(material);
  if (["genre", "subgenre", "scene"].includes(axis)) {
    return namesBrazilianFunk;
  }
  if (axis === "geography") {
    return /\bbrazil(?:ian)?\b/u.test(material);
  }
  return (axis === "relationship" || axis === "factual_relationship")
    && namesBrazilianFunk;
}

function criticalAmbiguousScopeClauseMatches(
  ambiguity: CriticalAmbiguityV3,
  clause: PlaylistContractRevisionV1["clauses"][number],
): boolean {
  if (criticalAmbiguityClauseMatches(ambiguity, clause)) return true;
  const axis = normalizedKey(clause.axis);
  // Some shadow-migrated clauses intentionally contain only a generic
  // unresolved token (for example “funk”). The bridge identifies those exact
  // clause IDs, while the V3 ambiguity key supplies the semantic axis needed
  // to prevent one question from deleting another question's scope.
  if (ambiguity.key === "house_semantics") {
    return ["genre", "subgenre", "scene", "theme"].includes(axis);
  }
  if (ambiguity.key === "french_jazz_scope"
    || ambiguity.key === "geographic_genre_scope") {
    return ["geography", "scene", "language"].includes(axis);
  }
  if (ambiguity.key === "possessive_relationship") {
    return axis === "relationship" || axis === "factual_relationship";
  }
  return ["genre", "subgenre", "scene", "geography", "relationship", "factual_relationship"]
    .includes(axis);
}

function ambiguousContentLanguageLabels(ambiguity: CriticalAmbiguityV3): string[] {
  if (ambiguity.key === "french_jazz_scope") return ["french", "france"];
  if (ambiguity.key !== "geographic_genre_scope") return [];
  return [
    ambiguity.geographicLabel,
    ambiguity.languageValue,
    ambiguity.originValue,
  ].flatMap((value) => value ? [normalizedKey(value)] : []);
}

function isAmbiguousMigratedContentLanguage(
  ambiguity: CriticalAmbiguityV3,
  value: string,
): boolean {
  const normalizedValue = normalizedKey(value);
  if (!normalizedValue.startsWith("language:")) return false;
  const language = normalizedValue.slice("language:".length).trim();
  return ambiguousContentLanguageLabels(ambiguity).some((label) => (
    language === label
    || language.startsWith(`${label} `)
    || language.endsWith(` ${label}`)
  ));
}

function sanitizedContentClauseDraft(
  clause: PlaylistContractRevisionV1["clauses"][number],
  values: readonly string[],
): PlaylistContractClauseDraftV1 {
  return {
    id: clause.id,
    kind: clause.kind,
    scope: clause.scope,
    hardness: clause.hardness,
    axis: clause.axis,
    operator: clause.operator,
    values,
    source: {
      provenance: clause.source.provenance,
      text: clause.source.text,
      spans: clause.source.spans,
    },
    evidence: {
      required: clause.evidence.required,
      claim: clause.evidence.claim,
      minimumGrade: clause.evidence.minimumGrade,
      permittedGrades: clause.evidence.permittedGrades,
    },
    unknownPolicy: clause.unknownPolicy,
  };
}

interface CriticalAmbiguityContractCleanupV3 {
  readonly removedClauseIds: readonly string[];
  readonly preScopeOperations: readonly PlaylistContractPatchOperationV1[];
  readonly affectedClauseIds: readonly string[];
}

function criticalAmbiguityContractCleanup(input: {
  ambiguity: CriticalAmbiguityV3;
  baseContract: PlaylistContractRevisionV1;
  ambiguousScopeClauseIds: readonly string[];
}): CriticalAmbiguityContractCleanupV3 {
  const explicitAmbiguousIds = new Set(input.ambiguousScopeClauseIds);
  const removedClauseIds: string[] = [];
  const preScopeOperations: PlaylistContractPatchOperationV1[] = [];
  const affectedClauseIds: string[] = [];
  for (const clause of input.baseContract.clauses) {
    const explicitAmbiguity = explicitAmbiguousIds.has(clause.id)
      && criticalAmbiguousScopeClauseMatches(input.ambiguity, clause);
    if (criticalAmbiguityClauseMatches(input.ambiguity, clause) || explicitAmbiguity) {
      removedClauseIds.push(clause.id);
      affectedClauseIds.push(clause.id);
      preScopeOperations.push({ op: "remove_clause", clauseId: clause.id });
      continue;
    }
    if (clause.source.provenance !== "migration"
      || normalizedKey(clause.axis) !== "content") continue;
    const retainedValues = clause.values.filter((value) => (
      !isAmbiguousMigratedContentLanguage(input.ambiguity, value)
    ));
    if (retainedValues.length === clause.values.length) continue;
    affectedClauseIds.push(clause.id);
    const retainsHardPolicy = retainedValues.some((value) => (
      value !== "explicit-content:allow" && value !== "instrumental:allow"
    ));
    if (!retainsHardPolicy) {
      removedClauseIds.push(clause.id);
      preScopeOperations.push({ op: "remove_clause", clauseId: clause.id });
    } else {
      preScopeOperations.push({
        op: "replace_clause",
        clauseId: clause.id,
        clause: sanitizedContentClauseDraft(clause, retainedValues),
      });
    }
  }
  return {
    removedClauseIds: uniqueSorted(removedClauseIds),
    preScopeOperations,
    affectedClauseIds: uniqueSorted(affectedClauseIds),
  };
}

interface CriticalAmbiguityOptionDraftV3 {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
  expectedFeasibilityDirection: GuidanceFeasibilityDirectionV3;
  clauses: readonly PlaylistContractClauseDraftV1[];
  composition?: "all" | "any";
}

/**
 * Project every server-detected V3 blocking ambiguity into an immutable
 * contract decision. Unlike the legacy research-preference questions, each
 * option carries the complete typed patch that removes only the unresolved
 * interpretation and composes the chosen hard scope with every preserved
 * catalog, evidence, exclusion, count, quality, and sequencing rule.
 */
export function criticalAmbiguityGuidanceDecisionV3(input: {
  ambiguity: CriticalAmbiguityV3;
  baseContract: PlaylistContractRevisionV1;
  ambiguousScopeClauseIds?: readonly string[];
}): GuidanceDecisionV3 {
  const { ambiguity, baseContract } = input;
  const cleanup = criticalAmbiguityContractCleanup({
    ambiguity,
    baseContract,
    ambiguousScopeClauseIds: input.ambiguousScopeClauseIds ?? [],
  });
  const preserved = predicateWithoutClauseIds(
    baseContract.trackPredicate,
    new Set(cleanup.removedClauseIds),
  );
  let header: string;
  let question: string;
  let whyMaterial: string;
  let options: readonly CriticalAmbiguityOptionDraftV3[];

  if (ambiguity.key === "house_semantics") {
    header = "Meaning";
    question = "What does “house” mean here?";
    whyMaterial = "The answer changes playlist membership, not merely its ordering.";
    const genreClause = criticalMembershipClause({
      id: "guidance:critical:house-semantics:genre",
      axis: "genre",
      value: "house music",
      conceptId: "genre:house-music",
      expectedKind: "genre",
      sourceText: "Require recordings in the house-music genre.",
    });
    const themeClause = criticalMembershipClause({
      id: "guidance:critical:house-semantics:theme",
      axis: "theme",
      value: "houses and homes",
      conceptId: "theme:houses-and-homes",
      expectedKind: "theme",
      sourceText: "Require songs whose subject is houses, homes, or domestic space.",
    });
    options = [
      {
        id: "house_genre",
        label: "House music",
        description: "Use recordings in the electronic dance-music genre.",
        recommended: true,
        expectedFeasibilityDirection: "neutral",
        clauses: [genreClause],
      },
      {
        id: "house_theme",
        label: "Houses and homes",
        description: "Use songs whose subject is houses, homes, or domestic space.",
        recommended: false,
        expectedFeasibilityDirection: "neutral",
        clauses: [themeClause],
      },
      {
        id: "house_both",
        label: "Both",
        description: "Require house music whose lyrical subject also concerns houses or homes.",
        recommended: false,
        expectedFeasibilityDirection: "narrower",
        clauses: [genreClause, themeClause],
        composition: "all",
      },
    ];
  } else if (
    ambiguity.key === "french_jazz_scope"
    || ambiguity.key === "geographic_genre_scope"
  ) {
    const french = ambiguity.key === "french_jazz_scope";
    const geographicLabel = french
      ? "French"
      : ambiguity.geographicLabel ?? "Geographic";
    const genreLabel = french ? "jazz" : ambiguity.genreLabel ?? "music";
    const originValue = french ? "France" : ambiguity.originValue;
    const sceneValue = french ? "French jazz scene" : ambiguity.sceneValue;
    const languageValue = french ? "French" : ambiguity.languageValue;
    if (!originValue || !sceneValue || !languageValue) {
      throw new Error("critical_geography_metadata_is_incomplete");
    }
    header = french ? "French jazz" : `${geographicLabel} ${genreLabel}`;
    question = french
      ? "Which French relationship should define the tracks?"
      : `Which ${geographicLabel} relationship should define the tracks?`;
    whyMaterial = "Artist origin, scene participation, and language produce substantially different catalogues.";
    const prefix = french
      ? "guidance:critical:french-jazz-scope"
      : "guidance:critical:geographic-genre-scope";
    options = [
      {
        id: french ? "french_artist_origin" : "geographic_artist_origin",
        label: `${geographicLabel} artists`,
        description: `Require principal artists from ${originValue}.`,
        recommended: true,
        expectedFeasibilityDirection: "neutral",
        clauses: [criticalMembershipClause({
          id: `${prefix}:artist-origin`,
          axis: "geography",
          value: originValue,
          relationship: "artist_origin",
          sourceText: `Require a documented principal-artist origin in ${originValue}.`,
        })],
      },
      {
        id: french ? "french_scene" : "geographic_scene",
        label: `${geographicLabel} scene`,
        description: `Include recordings connected to the ${sceneValue}.`,
        recommended: false,
        expectedFeasibilityDirection: "neutral",
        clauses: [criticalMembershipClause({
          id: `${prefix}:scene`,
          axis: "scene",
          value: sceneValue,
          relationship: "label_or_venue_scene",
          sourceText: `Require a documented connection to the ${sceneValue}.`,
        })],
      },
      {
        id: french ? "french_language" : "geographic_language",
        label: `${languageValue} language`,
        description: `Require ${languageValue}-language vocal recordings.`,
        recommended: false,
        expectedFeasibilityDirection: "narrower",
        clauses: [criticalMembershipClause({
          id: `${prefix}:language`,
          axis: "language",
          value: languageValue,
          relationship: "language",
          sourceText: `Require documented ${languageValue}-language vocals.`,
        })],
      },
    ];
  } else if (ambiguity.key === "possessive_relationship") {
    const subject = normalized(
      ambiguity.subjectValue
        ?? baseContract.rawPrompt.match(
          /\b([a-z0-9][a-z0-9 .&-]{1,80})['’]s\s+(?:\d+\s+)?(?:most\s+)?(?:influential|essential|important|best)\s+(?:songs?|tracks?|recordings?)\b/iu,
        )?.[1]
        ?? "",
    );
    if (!subject) throw new Error("critical_possessive_subject_is_missing");
    header = "Relationship";
    question = "How must the named person relate to each recording?";
    whyMaterial = "Performance, authorship, and influence are different factual claims with different evidence.";
    const clause = (
      suffix: string,
      value: string,
      relationship: string,
      sourceText: string,
    ) => criticalFactualClause({
      id: `guidance:critical:possessive-relationship:${suffix}`,
      value: `${subject}: ${value}`,
      relationship,
      sourceText,
    });
    options = [
      {
        id: "subject_performed",
        label: "Performed on it",
        description: "Require evidence that the subject performed on the exact recording.",
        recommended: true,
        expectedFeasibilityDirection: "neutral",
        clauses: [clause(
          "performed",
          "performed on the exact recording",
          "subject_performed",
          `Require evidence that ${subject} performed on the exact recording.`,
        )],
      },
      {
        id: "subject_created",
        label: "Wrote or produced it",
        description: "Require an authorship, composition, arrangement, or production credit.",
        recommended: false,
        expectedFeasibilityDirection: "narrower",
        clauses: [clause(
          "created",
          "wrote, composed, arranged, or produced the exact recording",
          "subject_created",
          `Require an authorship, composition, arrangement, or production credit for ${subject}.`,
        )],
      },
      {
        id: "subject_influenced",
        label: "Influenced it",
        description: "Require documented influence rather than a direct recording credit.",
        recommended: false,
        expectedFeasibilityDirection: "broader",
        clauses: [clause(
          "influenced",
          "documentably influenced the exact recording",
          "subject_influenced",
          `Require track-specific evidence that ${subject} influenced the recording.`,
        )],
      },
    ];
  } else {
    header = "Brazilian funk";
    question = "Which Brazilian funk tradition should define the playlist?";
    whyMaterial = "Funk carioca and Brazilian soul/funk have different histories, artists, and recordings.";
    const carioca = criticalMembershipClause({
      id: "guidance:critical:brazilian-funk:funk-carioca",
      axis: "genre",
      value: "funk carioca",
      conceptId: "genre:funk-carioca",
      expectedKind: "genre",
      sourceText: "Require funk carioca or baile-funk lineage.",
    });
    const soulFunk = criticalMembershipClause({
      id: "guidance:critical:brazilian-funk:soul-funk",
      axis: "genre",
      value: "Brazilian soul-funk",
      conceptId: "genre:brazilian-soul-funk",
      expectedKind: "genre",
      sourceText: "Require Brazilian soul, funk, or samba-funk lineage.",
    });
    options = [
      {
        id: "funk_carioca",
        label: "Funk carioca",
        description: "Focus on baile funk and its related scenes.",
        recommended: true,
        expectedFeasibilityDirection: "neutral",
        clauses: [carioca],
      },
      {
        id: "brazilian_soul_funk",
        label: "Soul and samba-funk",
        description: "Focus on Brazilian soul, funk, and samba-funk traditions.",
        recommended: false,
        expectedFeasibilityDirection: "neutral",
        clauses: [soulFunk],
      },
      {
        id: "both_funk_traditions",
        label: "Both traditions",
        description: "Build a cross-tradition survey with evidence for either lineage.",
        recommended: false,
        expectedFeasibilityDirection: "broader",
        clauses: [carioca, soulFunk],
        composition: "any",
      },
    ];
  }

  const permittedOptionIds = new Set(
    ambiguity.optionIds.filter((optionId) => optionId !== "custom"),
  );
  if (options.some(({ id }) => !permittedOptionIds.has(id))) {
    throw new Error("critical_guidance_option_drift");
  }
  const potentialClauseIds = options.flatMap(({ clauses }) => (
    clauses.map(({ id }) => id)
  ));
  const affectedClauseIds = uniqueSorted([
    ...cleanup.affectedClauseIds,
    ...potentialClauseIds,
  ]);
  const buildOperations = (
    option: CriticalAmbiguityOptionDraftV3,
  ): PlaylistContractPatchOperationV1[] => {
    const selectedClauseIds = option.clauses.map(({ id }) => id);
    return [
      ...cleanup.preScopeOperations,
      ...option.clauses.map((clause) => ({
        op: "add_clause" as const,
        clause,
      })),
      {
        op: "replace_track_predicate" as const,
        predicate: predicateWithGuidedScope(
          preserved,
          selectedClauseIds,
          option.composition ?? "all",
        ),
      },
    ];
  };
  return createGuidanceDecisionV3({
    id: `v3-critical:${ambiguity.key}`,
    header,
    question,
    axis: ambiguity.key,
    trigger: "correctness",
    criticality: "required",
    selectionMode: "single",
    // Critical ambiguity axes use server-owned typed patches. The generic
    // custom compiler currently supports count/content/exclusion/quota/flow,
    // not these semantic membership forks.
    allowCustom: false,
    baseContractRevisionId: baseContract.revisionId,
    baseContractSemanticHash: baseContract.semanticHash,
    whyMaterial,
    allowedPatchOperations: [
      "add_clause",
      "remove_clause",
      "replace_clause",
      "replace_track_predicate",
    ],
    affectedClauseIds,
    materialityScore: 100,
    options: options.map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
      recommended: option.recommended,
      expectedFeasibilityDirection: option.expectedFeasibilityDirection,
      patch: {
        affectedClauseIds: uniqueSorted([
          ...cleanup.affectedClauseIds,
          ...option.clauses.map(({ id }) => id),
        ]),
        operations: buildOperations(option),
      },
    })),
  });
}

function frenchJazzRelationshipClause(input: {
  id: string;
  axis: "geography" | "scene" | "language";
  value: string;
  relationship:
    | "artist_origin"
    | "recording_location"
    | "label_or_venue_scene"
    | "language";
  sourceText: string;
}): PlaylistContractClauseDraftV1 {
  return {
    id: input.id,
    kind: "membership",
    scope: "track",
    hardness: "hard",
    axis: input.axis,
    operator: "require",
    // The relationship marker is immutable server data. The canonical
    // execution bridge strips it from the value list and projects it to the
    // typed SelectionGeographyRelationship field.
    values: [input.value, `relationship:${input.relationship}`],
    source: {
      provenance: "guidance",
      text: input.sourceText,
    },
    unknownPolicy: "defer",
  };
}

export function frenchJazzGuidanceDecisionV3(input: {
  prompt: string;
  baseContract: PlaylistContractRevisionV1;
}): GuidanceDecisionV3 | null {
  if (!/\bfrench(?:[- ]language)?\s+jazz\b/iu.test(input.prompt)) return null;
  if (/\b(?:artists?\s+from\s+france|french[- ]language|recorded\s+in\s+france|french\s+jazz\s+scene)\b/iu
    .test(input.prompt)) {
    return null;
  }
  const replaceableClauseIds = input.baseContract.clauses
    .filter((clause) => (
      clause.hardness === "hard"
      && ["geography", "language", "scene"].includes(clause.axis)
      && [...clause.values, clause.source.text].some((value) => /\bfrench\b|\bfrance\b/iu.test(value))
    ))
    .map(({ id }) => id);
  const removed = new Set(replaceableClauseIds);
  const preserved = predicateWithoutClauseIds(input.baseContract.trackPredicate, removed);
  const clauseId = "guidance:french-jazz:relationship";
  const operations = (
    axis: "geography" | "scene" | "language",
    value: string,
    relationship:
      | "artist_origin"
      | "recording_location"
      | "label_or_venue_scene"
      | "language",
    sourceText: string,
  ): PlaylistContractPatchOperationV1[] => [
    ...replaceableClauseIds.map((id) => ({ op: "remove_clause" as const, clauseId: id })),
    {
      op: "add_clause",
      clause: frenchJazzRelationshipClause({
        id: clauseId,
        axis,
        value,
        relationship,
        sourceText,
      }),
    },
    {
      op: "replace_track_predicate",
      predicate: predicateWithRequiredClause(preserved, clauseId),
    },
  ];
  const affectedClauseIds = [...replaceableClauseIds, clauseId];
  return createGuidanceDecisionV3({
    id: "guidance:french-jazz:relationship",
    header: "French jazz scope",
    question: "What should “French” mean for this jazz playlist?",
    axis: "french_jazz_relationship",
    trigger: "correctness",
    criticality: "required",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: input.baseContract.revisionId,
    baseContractSemanticHash: input.baseContract.semanticHash,
    whyMaterial: "Artist origin, scene association, recording location, and language describe different eligible recordings and require different evidence.",
    allowedPatchOperations: ["add_clause", "remove_clause", "replace_track_predicate"],
    affectedClauseIds,
    materialityScore: 100,
    options: [
      {
        id: "french_jazz_scene",
        label: "French jazz scene",
        description: "Require a documented connection to a French jazz scene, label, venue, or community.",
        recommended: true,
        expectedFeasibilityDirection: "neutral",
        patch: {
          affectedClauseIds,
          operations: operations(
            "scene",
            "French jazz scene",
            "label_or_venue_scene",
            "Documented connection to a French jazz scene, label, venue, or community.",
          ),
        },
      },
      {
        id: "french_artist_origin",
        label: "Artists from France",
        description: "Require a documented artist-origin relationship to France.",
        recommended: false,
        expectedFeasibilityDirection: "narrower",
        patch: {
          affectedClauseIds,
          operations: operations(
            "geography",
            "France",
            "artist_origin",
            "Artists whose origin is documented as France.",
          ),
        },
      },
      {
        id: "recorded_in_france",
        label: "Recorded in France",
        description: "Require the recording itself to have been made in France.",
        recommended: false,
        expectedFeasibilityDirection: "narrower",
        patch: {
          affectedClauseIds,
          operations: operations(
            "geography",
            "France",
            "recording_location",
            "Recordings documented as made in France.",
          ),
        },
      },
      {
        id: "french_language_jazz",
        label: "French-language jazz",
        description: "Require French-language vocals; instrumental recordings will not qualify.",
        recommended: false,
        expectedFeasibilityDirection: "narrower",
        patch: {
          affectedClauseIds,
          operations: operations(
            "language",
            "French",
            "language",
            "Jazz recordings with documented French-language vocals.",
          ),
        },
      },
    ],
  });
}

export function rareScopeGuidanceDecisionV3(input: {
  prompt: string;
  baseContract: PlaylistContractRevisionV1;
}): GuidanceDecisionV3 | null {
  if (input.baseContract.requestedTrackCount < 100
    || !/\b(?:rare|obscure|deep[- ]cuts?|esoteric|hard[- ]to[- ]find)\b/iu.test(input.prompt)) {
    return null;
  }
  const existing = input.baseContract.clauses.find((clause) => (
    clause.id === "guidance:rare-scope:ranking"
  ));
  const clauseId = "guidance:rare-scope:ranking";
  const operation = (
    value: string,
    sourceText: string,
  ): PlaylistContractPatchOperationV1 => ({
    op: existing ? "replace_clause" : "add_clause",
    ...(existing ? { clauseId } : {}),
    clause: {
      id: clauseId,
      kind: "ranking_preference",
      scope: "track",
      hardness: "soft",
      axis: "rarity",
      operator: "prefer",
      values: [value],
      source: { provenance: "guidance", text: sourceText },
    },
  } as PlaylistContractPatchOperationV1);
  return createGuidanceDecisionV3({
    id: "guidance:rare-scope:breadth",
    header: "Rarity boundary",
    question: "How should research balance rarity against finding all 100 tracks?",
    axis: "rare_scope_breadth",
    trigger: "yield_risk",
    criticality: "optional",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: input.baseContract.revisionId,
    baseContractSemanticHash: input.baseContract.semanticHash,
    whyMaterial: "The count stays fixed. This choice changes discovery order and ranking, but never permits filler or weakens any hard musical constraint.",
    allowedPatchOperations: [existing ? "replace_clause" : "add_clause"],
    affectedClauseIds: [clauseId],
    materialityScore: 88,
    options: [
      {
        id: "strict_documented_rarity",
        label: "Strict documented rarity",
        description: "Prioritize genuinely obscure recordings even if research takes longer.",
        recommended: true,
        expectedFeasibilityDirection: "narrower",
        patch: {
          affectedClauseIds: [clauseId],
          operations: [operation(
            "strict documented rarity",
            "Prioritize genuinely obscure recordings; do not substitute familiar filler.",
          )],
        },
      },
      {
        id: "scene_deep_cuts",
        label: "Scene deep cuts",
        description: "Favor lesser-known tracks by documented artists and labels within the exact scope.",
        recommended: false,
        expectedFeasibilityDirection: "neutral",
        patch: {
          affectedClauseIds: [clauseId],
          operations: [operation(
            "scene and catalog deep cuts",
            "Favor documented scene and catalog deep cuts within the unchanged hard scope.",
          )],
        },
      },
      {
        id: "rarity_with_recognizable_anchors",
        label: "Rare with anchors",
        description: "Keep the scope exact while allowing some recognizable tracks to anchor discovery.",
        recommended: false,
        expectedFeasibilityDirection: "broader",
        patch: {
          affectedClauseIds: [clauseId],
          operations: [operation(
            "rarity with recognizable anchors",
            "Balance rare discoveries with some recognizable anchors; never use filler.",
          )],
        },
      },
    ],
  });
}

export function flowNuanceGuidanceDecisionV3(input: {
  prompt: string;
  baseContract: PlaylistContractRevisionV1;
}): GuidanceDecisionV3 | null {
  if (!/\b(?:journey|arc|flow)\b/iu.test(input.prompt)
    || /\b(?:chronological|smooth(?:ly)?|contrast|editorial order)\b/iu.test(input.prompt)) {
    return null;
  }
  const clauseId = FLOW_GUIDANCE_CLAUSE_ID;
  const clauseOperation = input.baseContract.clauses.some(({ id }) => (
    id === clauseId
  ))
    ? "replace_clause"
    : "add_clause";
  const operation = (
    direction: PlaylistSequencingObjectiveV1["direction"],
    label: string,
  ): PlaylistContractPatchOperationV1[] => {
    const clause: PlaylistContractClauseDraftV1 = {
      id: clauseId,
      kind: "ranking_preference",
      scope: "playlist",
      hardness: "soft",
      axis: "playlist_flow",
      operator: "prefer",
      values: [label],
      source: { provenance: "guidance", text: label },
    };
    const clausePatch: PlaylistContractPatchOperationV1 = clauseOperation === "replace_clause"
      ? { op: "replace_clause", clauseId, clause }
      : { op: "add_clause", clause };
    return [clausePatch, {
      op: "set_sequencing_objectives",
      objectives: [{
        id: FLOW_GUIDANCE_SEQUENCE_ID,
        clauseId,
        dimension: "playlist_flow",
        direction,
        weight: 1,
        priority: 1,
      }],
    }];
  };
  return createGuidanceDecisionV3({
    id: "guidance:flow:shape",
    header: "Listening flow",
    question: "What kind of arc should the playlist follow?",
    axis: "playlist_flow",
    trigger: "nuance",
    criticality: "optional",
    selectionMode: "single",
    allowCustom: true,
    baseContractRevisionId: input.baseContract.revisionId,
    baseContractSemanticHash: input.baseContract.semanticHash,
    whyMaterial: "This changes the final sequence after every track has qualified; it does not change eligibility.",
    allowedPatchOperations: [
      clauseOperation,
      "set_sequencing_objectives",
    ],
    affectedClauseIds: [clauseId],
    materialityScore: 55,
    options: [
      {
        id: "smooth_arc",
        label: "Smooth arc",
        description: "Blend energy and texture gradually.",
        recommended: true,
        expectedFeasibilityDirection: "neutral",
        patch: { affectedClauseIds: [clauseId], operations: operation("smooth", "smooth listening arc") },
      },
      {
        id: "high_contrast_arc",
        label: "High contrast",
        description: "Use deliberate changes in energy, era, and texture.",
        recommended: false,
        expectedFeasibilityDirection: "neutral",
        patch: { affectedClauseIds: [clauseId], operations: operation("contrast", "high-contrast listening arc") },
      },
      {
        id: "editorial_arc",
        label: "Editorial journey",
        description: "Sequence for narrative and musical significance.",
        recommended: false,
        expectedFeasibilityDirection: "neutral",
        patch: { affectedClauseIds: [clauseId], operations: operation("editorial", "editorial narrative arc") },
      },
    ],
  });
}

export function deterministicGuidanceCandidatesV3(input: {
  prompt: string;
  baseContractRevisionId: string;
  baseContractSemanticHash: string;
  preservedTrackPredicate: PlaylistPredicateV1 | null;
  ambiguousScopeClauseIds: readonly string[];
  baseContract?: PlaylistContractRevisionV1;
  criticalAmbiguities?: readonly CriticalAmbiguityV3[];
}): GuidanceDecisionV3[] {
  const reggaeton = smoothReggaetonHeatGuidanceDecisionV3(input);
  if (!input.baseContract) return reggaeton ? [reggaeton] : [];
  const criticalAmbiguities = input.criticalAmbiguities ?? [];
  const critical = criticalAmbiguities.map((ambiguity) => (
    criticalAmbiguityGuidanceDecisionV3({
      ambiguity,
      baseContract: input.baseContract!,
      ambiguousScopeClauseIds: input.ambiguousScopeClauseIds,
    })
  ));
  const criticalKeys = new Set(criticalAmbiguities.map(({ key }) => key));
  return [
    ...(reggaeton ? [reggaeton] : []),
    ...critical,
    ...(criticalKeys.has("french_jazz_scope")
      ? []
      : [frenchJazzGuidanceDecisionV3({
          prompt: input.prompt,
          baseContract: input.baseContract,
        })]),
    rareScopeGuidanceDecisionV3({
      prompt: input.prompt,
      baseContract: input.baseContract,
    }),
    flowNuanceGuidanceDecisionV3({
      prompt: input.prompt,
      baseContract: input.baseContract,
    }),
  ].filter((decision): decision is GuidanceDecisionV3 => decision !== null);
}

/**
 * Build one conservative mid-run rescue question from the actual canonical
 * bottleneck. The server may demote or remove only the named positive
 * membership rule, and only when at least one other predicate remains to
 * bound discovery. Skipping the optional question preserves the contract.
 */
export function predicateYieldRescueGuidanceDecisionV3(input: {
  baseContract: PlaylistContractRevisionV1;
  limitingClauseIds: readonly string[];
}): GuidanceDecisionV3 | null {
  const referencedByQuota = new Set(input.baseContract.playlistConstraints.flatMap((quota) => {
    const clauseIds: string[] = [];
    const visit = (predicate: PlaylistPredicateV1): void => {
      if (predicate.op === "clause") clauseIds.push(predicate.clauseId);
      else if (predicate.op === "not") visit(predicate.child);
      else if (predicate.op === "except") {
        visit(predicate.base);
        predicate.exceptions.forEach(visit);
      } else if (predicate.op === "alternative") {
        predicate.choices.forEach((choice) => visit(choice.predicate));
      } else {
        predicate.children.forEach(visit);
      }
    };
    visit(quota.predicate);
    return clauseIds;
  }));
  const centralSuitability = new Set(
    input.baseContract.qualityPolicy.centralSuitabilityClauseIds,
  );
  const candidate = input.limitingClauseIds
    .map((clauseId) => input.baseContract.clauses.find(({ id }) => id === clauseId))
    .find((clause) => (
      clause
      && clause.hardness === "hard"
      && ["membership", "factual_relationship"].includes(clause.kind)
      && !referencedByQuota.has(clause.id)
      && !centralSuitability.has(clause.id)
    ));
  if (!candidate) return null;
  const revisedPredicate = predicateWithoutClauseIds(
    input.baseContract.trackPredicate,
    new Set([candidate.id]),
  );
  if (!revisedPredicate) return null;
  const label = normalized(
    candidate.source.text || candidate.values.join(", "),
  ).slice(0, 180);
  if (!label) return null;
  const preferenceClause: PlaylistContractClauseDraftV1 = {
    id: candidate.id,
    kind: "ranking_preference",
    scope: candidate.scope,
    hardness: "soft",
    axis: candidate.axis,
    operator: "prefer",
    values: candidate.values.filter((value) => !value.startsWith("relationship:")),
    source: {
      provenance: "guidance",
      text: `Prefer ${label}`,
    },
    evidence: {
      required: false,
      minimumGrade: null,
      permittedGrades: candidate.evidence.permittedGrades,
    },
    unknownPolicy: "allow",
  };
  return createGuidanceDecisionV3({
    id: `guidance:rescue:predicate:${sha256Hex(candidate.id).slice(0, 20)}`,
    header: "Yield bottleneck",
    question: `Would you like to revise “${label}” for this playlist?`,
    axis: `rescue_predicate:${candidate.id}`,
    trigger: "yield_risk",
    criticality: "optional",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: input.baseContract.revisionId,
    baseContractSemanticHash: input.baseContract.semanticHash,
    whyMaterial: "This was the named rule most often limiting otherwise qualified tracks. Skipping keeps it exact.",
    allowedPatchOperations: [
      "replace_clause",
      "remove_clause",
      "replace_track_predicate",
    ],
    affectedClauseIds: [candidate.id],
    materialityScore: 95,
    interpretationSummary: playlistInterpretationSummaryV1(input.baseContract),
    options: [
      {
        id: "keep_as_preference",
        label: "Keep as a preference",
        description: "Preserve this intent in ranking, but stop using it as an eligibility gate.",
        recommended: true,
        expectedFeasibilityDirection: "broader",
        patch: {
          affectedClauseIds: [candidate.id],
          operations: [
            {
              op: "replace_clause",
              clauseId: candidate.id,
              clause: preferenceClause,
            },
            {
              op: "replace_track_predicate",
              predicate: revisedPredicate,
            },
          ],
        },
      },
      {
        id: "remove_named_rule",
        label: "Remove this rule",
        description: "Delete only this named rule; every other Must have, Avoid, Flow, and Count rule remains.",
        recommended: false,
        expectedFeasibilityDirection: "broader",
        patch: {
          affectedClauseIds: [candidate.id],
          operations: [
            {
              op: "remove_clause",
              clauseId: candidate.id,
            },
            {
              op: "replace_track_predicate",
              predicate: revisedPredicate,
            },
          ],
        },
      },
    ],
  });
}

function normalizedKey(value: string): string {
  return normalized(value).toLocaleLowerCase("en-US");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map(normalized).filter(Boolean))].sort();
}

function operationName(operation: unknown): string | null {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return null;
  const value = (operation as Record<string, unknown>).op;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function questionHashBody(
  decision: Omit<GuidanceDecisionV3, "questionHash">,
): string {
  return sha256Hex(stableStringify(decision));
}

export function createGuidanceDecisionV3(
  input: Omit<GuidanceDecisionV3, "schemaVersion" | "policyVersion" | "questionHash">,
): GuidanceDecisionV3 {
  const body = {
    schemaVersion: 3 as const,
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION,
    ...input,
    affectedClauseIds: uniqueSorted(input.affectedClauseIds),
    allowedPatchOperations: uniqueSorted(input.allowedPatchOperations),
    options: input.options.map((option) => ({
      ...option,
      patch: {
        operations: [...option.patch.operations],
        affectedClauseIds: uniqueSorted(option.patch.affectedClauseIds),
      },
    })),
  };
  const decision: GuidanceDecisionV3 = {
    ...body,
    questionHash: questionHashBody(body),
  };
  assertGuidanceDecisionV3(decision);
  return decision;
}

export function assertGuidanceDecisionV3(decision: GuidanceDecisionV3): void {
  if (decision.schemaVersion !== 3 || decision.policyVersion !== ADAPTIVE_GUIDANCE_POLICY_VERSION) {
    throw new Error("unsupported_guidance_decision_version");
  }
  if (!decision.id.trim() || !decision.axis.trim() || !decision.question.trim()) {
    throw new Error("invalid_guidance_decision_identity");
  }
  if (!decision.baseContractRevisionId.trim()) throw new Error("missing_base_contract_revision");
  if (!/^[0-9a-f]{64}$/u.test(decision.baseContractSemanticHash)) {
    throw new Error("invalid_base_contract_semantic_hash");
  }
  if (!Number.isInteger(decision.materialityScore)
    || decision.materialityScore < 0
    || decision.materialityScore > 100) {
    throw new Error("invalid_guidance_materiality_score");
  }
  if (decision.options.length < 2 || decision.options.length > 4) {
    throw new Error("guidance_requires_two_to_four_options");
  }
  const optionIds = decision.options.map((option) => option.id);
  if (new Set(optionIds).size !== optionIds.length) throw new Error("duplicate_guidance_option");
  if (decision.options.filter((option) => option.recommended).length !== 1) {
    throw new Error("guidance_requires_one_recommended_option");
  }
  const allowedOperations = new Set(decision.allowedPatchOperations);
  const allowedClauseIds = new Set(decision.affectedClauseIds);
  for (const option of decision.options) {
    if (!option.id.trim() || !option.label.trim() || !option.description.trim()) {
      throw new Error("invalid_guidance_option");
    }
    const keepsCurrentInterpretation =
      option.id === "keep_current_interpretation";
    if (option.patch.operations.length < 1 && !keepsCurrentInterpretation) {
      throw new Error("empty_guidance_patch");
    }
    if (keepsCurrentInterpretation && (
      option.patch.operations.length > 0
      || option.patch.affectedClauseIds.length > 0
    )) {
      throw new Error("keep_current_interpretation_must_be_noop");
    }
    for (const operation of option.patch.operations) {
      const name = operationName(operation);
      if (!name || !allowedOperations.has(name)) throw new Error("guidance_patch_operation_not_allowed");
    }
    for (const clauseId of option.patch.affectedClauseIds) {
      if (!allowedClauseIds.has(clauseId)) throw new Error("guidance_patch_clause_not_allowed");
    }
  }
  const expectedHash = sha256Hex(stableStringify(Object.fromEntries(
    Object.entries(decision).filter(([key]) => key !== "questionHash"),
  )));
  if (decision.questionHash !== expectedHash) throw new Error("guidance_question_hash_mismatch");
}

function triggerRank(trigger: GuidanceTriggerV3): number {
  if (trigger === "correctness") return 0;
  if (trigger === "yield_risk") return 1;
  return 2;
}

/**
 * Questions are progressive: correctness first, then measured yield risk, then
 * no more than one optional nuance fork. Required blockers are the only reason
 * an initial round may contain a third question.
 */
export function selectGuidanceRoundV3(
  input: GuidanceRoundSelectionInputV3,
): GuidanceRoundV3 {
  const explicitAxes = new Set((input.explicitAxes ?? []).map(normalizedKey));
  const answeredAxes = new Set((input.answeredAxes ?? []).map(normalizedKey));
  const attempts = input.clarificationAttemptsByAxis ?? {};
  const rejectedDecisionReasons: Record<string, string> = {};
  let showEditableInterpretationSummary = false;

  const eligible = input.candidates.filter((candidate) => {
    assertGuidanceDecisionV3(candidate);
    const axis = normalizedKey(candidate.axis);
    const blockingSemanticAmbiguity = candidate.trigger === "correctness"
      && candidate.criticality === "required";
    // Fixed lists, factual scopes, and already-complete requests suppress
    // optional taste/nuance questions. A server-detected blocking semantic
    // ambiguity is different: request shape cannot silently choose its
    // membership or evidence relationship.
    if (input.requestShape !== "curated" && !blockingSemanticAmbiguity) {
      rejectedDecisionReasons[candidate.id] = "request_needs_no_guidance";
      return false;
    }
    if (explicitAxes.has(axis)) {
      rejectedDecisionReasons[candidate.id] = "axis_already_explicit";
      return false;
    }
    if (answeredAxes.has(axis)) {
      rejectedDecisionReasons[candidate.id] = "axis_already_answered";
      return false;
    }
    if ((attempts[candidate.axis] ?? attempts[axis] ?? 0) >= 2) {
      rejectedDecisionReasons[candidate.id] = "clarification_attempt_limit";
      showEditableInterpretationSummary = true;
      return false;
    }
    return true;
  }).sort((left, right) => (
    triggerRank(left.trigger) - triggerRank(right.trigger)
    || Number(right.criticality === "required") - Number(left.criticality === "required")
    || right.materialityScore - left.materialityScore
    || left.id.localeCompare(right.id)
  ));

  const selected: GuidanceDecisionV3[] = [];
  const selectedAxes = new Set<string>();
  let optionalNuanceCount = 0;
  const rescueLimitReached = input.stage === "rescue"
    && (input.rescueQuestionsAlreadyAsked ?? 0) >= 2;

  if (!rescueLimitReached) {
    for (const candidate of eligible) {
      const axis = normalizedKey(candidate.axis);
      if (selectedAxes.has(axis)) {
        rejectedDecisionReasons[candidate.id] = "duplicate_axis_in_round";
        continue;
      }
      if (candidate.trigger === "nuance" && candidate.criticality === "optional") {
        if (optionalNuanceCount >= 1) {
          rejectedDecisionReasons[candidate.id] = "optional_nuance_limit";
          continue;
        }
        optionalNuanceCount += 1;
      }
      const blockingSemanticAmbiguity = candidate.trigger === "correctness"
        && candidate.criticality === "required";
      const canUseThirdInitialSlot = input.stage === "initial"
        && selected.length === 2
        && blockingSemanticAmbiguity;
      const maximum = input.stage === "rescue"
        ? 1
        : canUseThirdInitialSlot
          ? 3
          : 2;
      if (selected.length >= maximum) {
        rejectedDecisionReasons[candidate.id] = "round_question_limit";
        continue;
      }
      selected.push(candidate);
      selectedAxes.add(axis);
    }
  }

  const showDecisionPanel = rescueLimitReached
    || (input.stage === "rescue" && selected.length === 0 && eligible.length > 0);
  const roundBody = {
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION,
    stage: input.stage,
    requestShape: input.requestShape,
    decisionHashes: selected.map((decision) => decision.questionHash),
    showEditableInterpretationSummary,
    showDecisionPanel,
  };
  return {
    decisions: selected,
    showEditableInterpretationSummary,
    showDecisionPanel,
    rejectedDecisionReasons,
    roundHash: sha256Hex(stableStringify(roundBody)),
  };
}

export function compileGuidanceSelectionV3(
  decision: GuidanceDecisionV3,
  answer: GuidanceSelectionAnswerV3,
): CompiledGuidanceSelectionV3 {
  assertGuidanceDecisionV3(decision);
  if (answer.skipped) {
    if (decision.criticality === "required") {
      return {
        state: "required_answer_missing",
        answerHash: sha256Hex(stableStringify({
          questionHash: decision.questionHash,
          skipped: true,
        })),
        selectedOptionIds: [],
        operations: [],
        affectedClauseIds: [],
      };
    }
    return {
      state: "accepted",
      answerHash: sha256Hex(stableStringify({
        questionHash: decision.questionHash,
        skipped: true,
      })),
      selectedOptionIds: [],
      operations: [],
      affectedClauseIds: [],
    };
  }
  const selectedOptionIds = uniqueSorted(answer.optionIds ?? []);
  if (selectedOptionIds.length < 1) throw new Error("missing_guidance_option");
  if (decision.selectionMode === "single" && selectedOptionIds.length !== 1) {
    throw new Error("single_guidance_option_required");
  }
  const byId = new Map(decision.options.map((option) => [option.id, option]));
  const selectedOptions = selectedOptionIds.map((id) => {
    const option = byId.get(id);
    if (!option) throw new Error("unknown_guidance_option");
    return option;
  });
  const operations = selectedOptions.flatMap((option) => [...option.patch.operations]);
  const affectedClauseIds = uniqueSorted(
    selectedOptions.flatMap((option) => option.patch.affectedClauseIds),
  );
  const answerHash = sha256Hex(stableStringify({
    questionHash: decision.questionHash,
    selectedOptionIds,
  }));
  return {
    state: "accepted",
    answerHash,
    selectedOptionIds,
    operations,
    affectedClauseIds,
  };
}

/**
 * Attach immutable answer lineage and the contract fence only after an answer
 * has been accepted. This is the executable handoff to the canonical contract
 * compiler; legacy display effects are not consulted.
 */
export function guidanceContractPatchV1(input: {
  decision: GuidanceDecisionV3;
  questionSetHash: string;
  accepted: AcceptedGuidanceExecutionV3;
}): PlaylistContractPatchV1 | null {
  assertGuidanceDecisionV3(input.decision);
  if (!/^[0-9a-f]{64}$/u.test(input.questionSetHash)) throw new Error("invalid_guidance_question_set_hash");
  if (!/^[0-9a-f]{64}$/u.test(input.accepted.answerHash)) throw new Error("invalid_guidance_answer_hash");
  if (input.accepted.executableOperations.length === 0) return null;
  const allowedOperations = new Set(input.decision.allowedPatchOperations);
  for (const operation of input.accepted.executableOperations) {
    if (!allowedOperations.has(operation.op)) throw new Error("guidance_patch_operation_not_allowed");
  }
  return {
    baseRevisionId: input.decision.baseContractRevisionId,
    baseSemanticHash: input.decision.baseContractSemanticHash,
    answerLineage: {
      questionSetHash: input.questionSetHash,
      questionId: input.decision.id,
      answerHash: input.accepted.answerHash,
    },
    operations: [...input.accepted.executableOperations],
  };
}

/**
 * "Create with recommendations" is deliberately incomplete when a required
 * semantic fork exists. It applies defaults only to optional decisions.
 */
export function recommendedGuidanceAnswersV3(
  decisions: readonly GuidanceDecisionV3[],
): {
  answers: Array<{ questionHash: string; optionIds: string[] }>;
  unresolvedRequiredQuestionHashes: string[];
} {
  const answers: Array<{ questionHash: string; optionIds: string[] }> = [];
  const unresolvedRequiredQuestionHashes: string[] = [];
  for (const decision of decisions) {
    assertGuidanceDecisionV3(decision);
    if (decision.criticality === "required") {
      unresolvedRequiredQuestionHashes.push(decision.questionHash);
      continue;
    }
    const recommended = decision.options.find((option) => option.recommended)!;
    answers.push({ questionHash: decision.questionHash, optionIds: [recommended.id] });
  }
  return { answers, unresolvedRequiredQuestionHashes };
}

function hardChangeReasonsForOperation(operation: unknown): string[] {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return ["invalid_operation"];
  const record = operation as Record<string, unknown>;
  const op = operationName(operation);
  if (!op) return ["invalid_operation"];
  if (op === "set_requested_track_count") return ["requested_count_changed"];
  if (op === "replace_track_predicate") return ["membership_predicate_changed"];
  if (op === "remove_clause") return ["contract_clause_removed"];
  if (op === "replace_clause" || op === "add_clause") {
    const clause = record.clause;
    if (clause && typeof clause === "object") {
      const clauseRecord = clause as Record<string, unknown>;
      const hard = clauseRecord.hardness === "hard"
        || clauseRecord.kind === "membership"
        || clauseRecord.kind === "exclusion"
        || clauseRecord.kind === "catalog_version";
      return hard ? ["hard_clause_changed"] : [];
    }
  }
  return [];
}

function predicateReferencesClause(
  predicate: PlaylistPredicateV1,
  clauseId: string,
): boolean {
  if (predicate.op === "clause") return predicate.clauseId === clauseId;
  if (predicate.op === "not") return predicateReferencesClause(predicate.child, clauseId);
  if (predicate.op === "except") {
    return predicateReferencesClause(predicate.base, clauseId)
      || predicate.exceptions.some((value) => predicateReferencesClause(value, clauseId));
  }
  if (predicate.op === "alternative") {
    return predicate.choices.some((choice) => predicateReferencesClause(choice.predicate, clauseId));
  }
  return predicate.children.some((value) => predicateReferencesClause(value, clauseId));
}

function summaryText(value: string): string {
  return normalized(value).replace(/^relationship:/u, "");
}

export function playlistInterpretationSummaryV1(
  contract: PlaylistContractRevisionV1,
): PlaylistInterpretationSummaryV1 {
  const referenced = new Set<string>();
  const visit = (predicate: PlaylistPredicateV1): void => {
    if (predicate.op === "clause") referenced.add(predicate.clauseId);
    else if (predicate.op === "not") visit(predicate.child);
    else if (predicate.op === "except") {
      visit(predicate.base);
      predicate.exceptions.forEach(visit);
    } else if (predicate.op === "alternative") {
      predicate.choices.forEach((choice) => visit(choice.predicate));
    } else {
      predicate.children.forEach(visit);
    }
  };
  visit(contract.trackPredicate);
  const mustHave: string[] = [];
  const prefer: string[] = [];
  const avoid: string[] = [];
  for (const clause of contract.clauses) {
    const label = summaryText(clause.source.text || clause.values.join(", "));
    if (!label) continue;
    if (clause.kind === "exclusion" || clause.operator === "exclude") {
      avoid.push(label);
    } else if (clause.hardness === "hard" && referenced.has(clause.id)) {
      mustHave.push(label);
    } else if (clause.hardness === "soft"
      && ["ranking_preference", "suitability"].includes(clause.kind)) {
      prefer.push(label);
    }
  }
  for (const quota of contract.playlistConstraints) {
    const predicateClauseId = quota.predicate.op === "clause"
      ? quota.predicate.clauseId
      : null;
    const predicateClause = predicateClauseId
      ? contract.clauses.find(({ id }) => id === predicateClauseId)
      : null;
    const subject = predicateClause?.source.text || predicateClause?.values.join(", ") || quota.id;
    if (quota.minimumRatio !== null) {
      mustHave.push(`At least ${Math.round(quota.minimumRatio * 100)}% ${summaryText(subject)}`);
    } else if (quota.minimumCount !== null) {
      mustHave.push(`At least ${quota.minimumCount} ${summaryText(subject)}`);
    }
    if (quota.maximumRatio !== null && quota.maximumRatio < 1) {
      mustHave.push(`No more than ${Math.round(quota.maximumRatio * 100)}% ${summaryText(subject)}`);
    } else if (quota.maximumCount !== null) {
      mustHave.push(`No more than ${quota.maximumCount} ${summaryText(subject)}`);
    }
  }
  const flow = contract.sequencingObjectives.map((objective) => {
    const clause = contract.clauses.find(({ id }) => id === objective.clauseId);
    return summaryText(clause?.source.text || `${objective.direction} ${objective.dimension}`);
  });
  return {
    mustHave: uniqueSorted(mustHave),
    prefer: uniqueSorted(prefer),
    avoid: uniqueSorted(avoid),
    flow: uniqueSorted(flow),
    count: contract.requestedTrackCount,
  };
}

function clauseUpsertOperation(
  base: PlaylistContractRevisionV1,
  clause: PlaylistContractClauseDraftV1,
): PlaylistContractPatchOperationV1 {
  return base.clauses.some(({ id }) => id === clause.id)
    ? { op: "replace_clause", clauseId: clause.id, clause }
    : { op: "add_clause", clause };
}

function conflictsWithRequiredArtistV3(
  base: PlaylistContractRevisionV1,
  artistName: string,
): boolean {
  const artistKey = normalizedKey(artistName);
  return base.clauses.some((clause) => (
    clause.kind === "membership"
    && clause.scope === "track"
    && clause.hardness === "hard"
    && clause.axis === "artist"
    && clause.operator === "require"
    && predicateReferencesClause(base.trackPredicate, clause.id)
    && [
      ...clause.values,
      ...clause.concepts.flatMap((concept) => [
        concept.originalText,
        ...concept.candidates
          .filter(({ conceptId }) => conceptId === concept.selectedConceptId)
          .map(({ label }) => label),
      ]),
    ].some((value) => normalizedKey(value) === artistKey)
  ));
}

/**
 * Reject deterministic custom-text contradictions before any provider lookup.
 * Proper-name candidates remain inert here; only a later server-owned catalog
 * resolution may authorize the executable exact-identity directive.
 */
export function preflightCustomGuidanceTextV3(input: {
  base: PlaylistContractRevisionV1;
  customText: string;
  trackCountAuthority?: CustomGuidanceTrackCountAuthorityV1 | null;
}): ReturnType<typeof exactArtistExclusionIntentsV1> {
  const normalizedText = normalized(input.customText);
  if (!normalizedText || normalizedText.length > 500) {
    throw new Error("invalid_custom_guidance_text");
  }
  const exactArtistIntent = exactArtistExclusionIntentsV1(normalizedText);
  if (exactArtistIntent.status === "needs_clarification") {
    throw new Error(
      `custom_artist_exclusion_requires_clarification:${exactArtistIntent.reason}`,
    );
  }
  if (exactArtistIntent.status === "candidates"
    && exactArtistIntent.candidates.some(({ inputText }) => (
      conflictsWithRequiredArtistV3(input.base, inputText)
    ))) {
    throw new Error("custom_guidance_conflicts_with_existing_hard_predicate");
  }
  const requestedCount = normalizedText.match(
    /\b(\d+)\s+(?:tracks?|songs?|recordings?)\b/iu,
  );
  if (requestedCount && input.trackCountAuthority
    && customGuidanceTrackCountAdmission({
      requestedTrackCount: Number(requestedCount[1]),
      authority: input.trackCountAuthority,
    }).status !== "accepted") {
    throw new Error("invalid_custom_requested_count");
  }
  return exactArtistIntent;
}

/**
 * Deterministic, deliberately small custom-input compiler. New prose is
 * accepted only through server-owned recognizers; the text itself never
 * becomes an executable instruction. Recognized hard changes are previewed
 * as a successor contract and must be confirmed through a fresh hash-bound
 * question set.
 */
export function recompileCustomGuidanceTextV3(input: {
  base: PlaylistContractRevisionV1;
  customText: string;
  trackCountAuthority?: CustomGuidanceTrackCountAuthorityV1 | null;
  resolvedExactArtistIdentities?: readonly ResolvedExactArtistIdentityV1[];
}): ServerRecompiledCustomGuidanceV3 {
  const normalizedText = normalized(input.customText);
  if (!normalizedText || normalizedText.length > 500) throw new Error("invalid_custom_guidance_text");
  const operations: PlaylistContractPatchOperationV1[] = [];
  const affectedClauseIds = new Set<string>();
  const hardChangeReasons = new Set<string>();
  let nextPredicate = input.base.trackPredicate;
  const exactArtistIntent = preflightCustomGuidanceTextV3({
    base: input.base,
    customText: normalizedText,
  });

  const cleanOnly = /\b(?:clean(?:\s+versions?)?|no\s+explicit(?:\s+lyrics|\s+content)?)\b/iu.test(normalizedText);
  if (cleanOnly) {
    const existing = input.base.clauses.find((clause) => clause.axis === "content");
    const clauseId = existing?.id ?? "guidance:custom:content:clean-only";
    const clause: PlaylistContractClauseDraftV1 = {
      id: clauseId,
      kind: "catalog_version",
      scope: "track",
      hardness: "hard",
      axis: "content",
      operator: "require",
      values: ["explicit-content:clean_only"],
      source: { provenance: "guidance", text: "Clean versions only" },
      evidence: {
        required: true,
        minimumGrade: "authoritative_structured_metadata",
        permittedGrades: ["authoritative_structured_metadata"],
      },
      unknownPolicy: "reject",
    };
    operations.push(existing
      ? { op: "replace_clause", clauseId, clause }
      : { op: "add_clause", clause });
    affectedClauseIds.add(clauseId);
    if (!predicateReferencesClause(nextPredicate, clauseId)) {
      nextPredicate = predicateWithRequiredClause(nextPredicate, clauseId);
    }
    hardChangeReasons.add("content_policy_changed");
  }

  if (exactArtistIntent.status === "candidates") {
    const existingBindings =
      input.base.executionDirectives?.exactArtistIdentityExclusions?.bindings
      ?? [];
    const nextBindings = [...existingBindings];
    for (const candidate of exactArtistIntent.candidates) {
      const resolved = (input.resolvedExactArtistIdentities ?? []).filter((identity) => (
        normalizedKey(identity.inputText) === normalizedKey(candidate.inputText)
        && identity.storefront === input.base.storefront
        && /^\d{1,32}$/u.test(identity.catalogArtistId)
        && identity.displayName.trim().length > 0
        && normalizedKey(identity.displayName)
          === normalizedKey(candidate.inputText)
      ));
      if (resolved.length !== 1) {
        throw new Error("custom_artist_exclusion_requires_catalog_identity");
      }
      const identity = resolved[0]!;
      const safeArtist = identity.displayName
        .normalize("NFKC").replace(/\s+/gu, " ").trim();
      if (conflictsWithRequiredArtistV3(input.base, safeArtist)) {
        throw new Error("custom_guidance_conflicts_with_existing_hard_predicate");
      }
      const clauseId = `guidance:custom:exclude:${sha256Hex(normalizedKey(safeArtist)).slice(0, 16)}`;
      const clause: PlaylistContractClauseDraftV1 = {
        id: clauseId,
        kind: "exclusion",
        scope: "track",
        hardness: "hard",
        axis: "artist",
        operator: "exclude",
        values: [safeArtist],
        source: { provenance: "guidance", text: `No recordings by ${safeArtist}` },
        evidence: {
          required: true,
          minimumGrade: "authoritative_structured_metadata",
          permittedGrades: ["authoritative_structured_metadata"],
        },
        unknownPolicy: "reject",
      };
      operations.push(clauseUpsertOperation(input.base, clause));
      const binding = {
        clauseId,
        catalogArtistId: identity.catalogArtistId,
        displayName: safeArtist,
        storefront: identity.storefront,
      };
      const existingIndex = nextBindings.findIndex(
        (candidateBinding) => candidateBinding.clauseId === clauseId,
      );
      if (existingIndex >= 0) nextBindings[existingIndex] = binding;
      else nextBindings.push(binding);
      affectedClauseIds.add(clauseId);
      if (!predicateReferencesClause(nextPredicate, clauseId)) {
        nextPredicate = predicateWithRequiredClause(nextPredicate, clauseId);
      }
    }
    operations.push({
      op: "set_exact_artist_identity_exclusions",
      directive: {
        bindings: nextBindings,
      },
    });
    hardChangeReasons.add("exclusion_changed");
  }

  const mostlyWomen = /\bmostly\s+(?:women|female(?:[- ]fronted)?(?:\s+artists?)?)\b/iu.test(normalizedText);
  if (mostlyWomen) {
    const membershipId = "guidance:custom:membership:women-artists";
    const quotaClauseId = "guidance:custom:quota:mostly-women";
    operations.push(clauseUpsertOperation(input.base, {
      id: membershipId,
      kind: "membership",
      scope: "track",
      hardness: "hard",
      axis: "artist",
      operator: "require",
      values: ["women artists"],
      source: { provenance: "guidance", text: "Tracks by women artists" },
      evidence: {
        required: true,
        minimumGrade: "independent_secondary_source",
        permittedGrades: ["primary_source", "independent_secondary_source"],
      },
      unknownPolicy: "defer",
    }));
    operations.push(clauseUpsertOperation(input.base, {
      id: quotaClauseId,
      kind: "quota_diversity",
      scope: "playlist",
      hardness: "hard",
      axis: "artist",
      operator: "limit",
      values: ["minimum women-artist share 0.51"],
      source: { provenance: "guidance", text: "A majority of tracks by women artists" },
    }));
    const preservedConstraints = input.base.playlistConstraints.filter(
      ({ id }) => id !== "guidance:custom:quota:mostly-women",
    );
    operations.push({
      op: "set_playlist_constraints",
      constraints: [...preservedConstraints, {
        id: "guidance:custom:quota:mostly-women",
        clauseId: quotaClauseId,
        predicate: { op: "clause", clauseId: membershipId },
        minimumCount: null,
        maximumCount: null,
        minimumRatio: 0.51,
        maximumRatio: 1,
      }],
    });
    affectedClauseIds.add(membershipId);
    affectedClauseIds.add(quotaClauseId);
    hardChangeReasons.add("playlist_quota_changed");
  }

  const requestedCount = normalizedText.match(/\b(\d+)\s+(?:tracks?|songs?|recordings?)\b/iu);
  if (requestedCount) {
    const count = Number(requestedCount[1]);
    if (customGuidanceTrackCountAdmission({
      requestedTrackCount: count,
      authority: input.trackCountAuthority,
    }).status !== "accepted") {
      throw new Error("invalid_custom_requested_count");
    }
    if (count !== input.base.requestedTrackCount) {
      operations.push({ op: "set_requested_track_count", count });
      hardChangeReasons.add("requested_count_changed");
    }
  }

  const flowDirection: PlaylistSequencingObjectiveV1["direction"] | null =
    /\bchronological(?:ly)?\b/iu.test(normalizedText) ? "ascending"
      : /\bhigh[- ]contrast\b|\bcontrast(?:ing)?\b/iu.test(normalizedText) ? "contrast"
        : /\bsmooth(?:ly)?\b|\bseamless(?:ly)?\b/iu.test(normalizedText) ? "smooth"
          : /\beditorial\b/iu.test(normalizedText) ? "editorial"
            : null;
  if (flowDirection) {
    const clauseId = FLOW_GUIDANCE_CLAUSE_ID;
    operations.push(clauseUpsertOperation(input.base, {
      id: clauseId,
      kind: "ranking_preference",
      scope: "playlist",
      hardness: "soft",
      axis: "playlist_flow",
      operator: "prefer",
      values: [flowDirection],
      source: { provenance: "guidance", text: `${flowDirection} playlist flow` },
    }));
    operations.push({
      op: "set_sequencing_objectives",
      objectives: [{
        id: FLOW_GUIDANCE_SEQUENCE_ID,
        clauseId,
        dimension: "playlist_flow",
        direction: flowDirection,
        weight: 1,
        priority: 1,
      }],
    });
    affectedClauseIds.add(clauseId);
  }

  if (nextPredicate !== input.base.trackPredicate) {
    operations.push({ op: "replace_track_predicate", predicate: nextPredicate });
  }
  if (operations.length === 0) {
    throw new Error("custom_guidance_requires_supported_music_terms");
  }
  const answerHash = sha256Hex(stableStringify({
    customText: normalizedText,
    operations,
  }));
  const previewContract = applyPlaylistContractPatchV1(input.base, {
    baseRevisionId: input.base.revisionId,
    baseSemanticHash: input.base.semanticHash,
    answerLineage: {
      questionSetHash: sha256Hex(stableStringify({
        kind: "custom_guidance_preview",
        base: input.base.semanticHash,
        answerHash,
      })),
      questionId: "guidance:custom:preview",
      answerHash,
    },
    operations,
  });
  return {
    normalizedText,
    operations,
    affectedClauseIds: uniqueSorted([...affectedClauseIds]),
    hardChangeReasons: uniqueSorted([...hardChangeReasons]),
    summary: playlistInterpretationSummaryV1(previewContract),
    previewContract,
  };
}

export function customGuidanceConfirmationDecisionV3(input: {
  base: PlaylistContractRevisionV1;
  compiled: ServerRecompiledCustomGuidanceV3;
}): GuidanceDecisionV3 {
  const id = `guidance:custom:confirm:${sha256Hex(stableStringify({
    base: input.base.semanticHash,
    operations: input.compiled.operations,
  })).slice(0, 20)}`;
  const allowedPatchOperations = uniqueSorted([
    ...input.compiled.operations.map(({ op }) => op),
    "replace_track_predicate",
  ]);
  return createGuidanceDecisionV3({
    id,
    header: "Confirm interpretation",
    question: "Apply this revised playlist contract?",
    axis: "custom_contract_revision",
    trigger: "correctness",
    criticality: "required",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: input.base.revisionId,
    baseContractSemanticHash: input.base.semanticHash,
    whyMaterial: input.compiled.hardChangeReasons.length > 0
      ? "Your custom answer changes one or more hard rules. Review every section before confirming."
      : "Your custom answer changes playlist flow or ranking. Review the interpretation before confirming.",
    allowedPatchOperations,
    affectedClauseIds: input.compiled.affectedClauseIds,
    materialityScore: 100,
    interpretationSummary: input.compiled.summary,
    options: [
      {
        id: "apply_revised_interpretation",
        label: "Apply revised interpretation",
        description: "Create a successor contract with exactly the Must have, Prefer, Avoid, Flow, and Count rules shown above.",
        recommended: true,
        expectedFeasibilityDirection: "neutral",
        patch: {
          affectedClauseIds: input.compiled.affectedClauseIds,
          operations: input.compiled.operations,
        },
      },
      {
        id: "keep_current_interpretation",
        label: "Keep current interpretation",
        description: "Discard the custom changes and continue with the current contract.",
        recommended: false,
        expectedFeasibilityDirection: "neutral",
        patch: {
          affectedClauseIds: [],
          // Explicit consent to discard the custom proposal is an accepted
          // no-op. It must not manufacture a semantically identical contract
          // revision merely to satisfy the generic option shape.
          operations: [],
        },
      },
    ],
  });
}

export interface ExactArtistIdentityGuidanceCandidateV3 {
  catalogArtistId: string;
  displayName: string;
  storefront: string;
  profileUrl?: string;
  genreNames?: readonly string[];
}

/**
 * Convert an Apple exact-name ambiguity into one immutable, server-owned
 * correctness question. Every identity option contains the full custom-text
 * patch; the stable ID never comes from the browser.
 */
export function exactArtistIdentityAmbiguityGuidanceDecisionV3(input: {
  base: PlaylistContractRevisionV1;
  customText: string;
  inputText: string;
  candidates: readonly ExactArtistIdentityGuidanceCandidateV3[];
  trackCountAuthority?: CustomGuidanceTrackCountAuthorityV1 | null;
}): GuidanceDecisionV3 {
  const intent = exactArtistExclusionIntentsV1(input.customText);
  if (intent.status !== "candidates"
    || intent.candidates.length !== 1
    || normalizedKey(intent.candidates[0]!.inputText)
      !== normalizedKey(input.inputText)) {
    throw new Error("exact_artist_ambiguity_requires_one_axis");
  }
  if (input.candidates.length < 2 || input.candidates.length > 3) {
    throw new Error("exact_artist_ambiguity_requires_two_to_three_candidates");
  }
  const candidateIds = input.candidates.map(({ catalogArtistId }) => (
    catalogArtistId.trim()
  ));
  if (new Set(candidateIds).size !== candidateIds.length
    || candidateIds.some((value) => !/^\d{1,32}$/u.test(value))) {
    throw new Error("invalid_exact_artist_ambiguity_candidates");
  }
  const expectedArtistKey = normalizedKey(input.inputText);
  const candidates = input.candidates.map((candidate) => {
    const displayName = normalized(candidate.displayName);
    const storefront = normalized(candidate.storefront)
      .toLocaleLowerCase("en-US");
    if (displayName.length > 160
      || normalizedKey(displayName) !== expectedArtistKey
      || storefront !== input.base.storefront) {
      throw new Error("exact_artist_ambiguity_candidate_mismatch");
    }
    const compiled = recompileCustomGuidanceTextV3({
      base: input.base,
      customText: input.customText,
      trackCountAuthority: input.trackCountAuthority,
      resolvedExactArtistIdentities: [{
        inputText: intent.candidates[0]!.inputText,
        catalogArtistId: candidate.catalogArtistId.trim(),
        displayName,
        storefront,
      }],
    });
    const genres = [...new Set((candidate.genreNames ?? [])
      .map((value) => normalized(value).slice(0, 80))
      .filter(Boolean))]
      .slice(0, 4);
    return {
      candidate: {
        catalogArtistId: candidate.catalogArtistId.trim(),
        displayName,
        storefront,
        genreNames: genres,
      },
      compiled,
    };
  });
  const summary = candidates[0]!.compiled.summary;
  if (candidates.some(({ compiled }) => (
    stableStringify(compiled.summary) !== stableStringify(summary)
  ))) {
    throw new Error("exact_artist_ambiguity_summary_mismatch");
  }
  const affectedClauseIds = uniqueSorted(candidates.flatMap(({ compiled }) => (
    compiled.affectedClauseIds
  )));
  const allowedPatchOperations = uniqueSorted(candidates.flatMap(({ compiled }) => (
    compiled.operations.map(({ op }) => op)
  )));
  const decisionId = `guidance:artist-identity:${sha256Hex(stableStringify({
    base: input.base.semanticHash,
    customText: normalized(input.customText),
    inputText: normalized(input.inputText),
    identities: candidates.map(({ candidate }) => ({
      id: candidate.catalogArtistId,
      name: candidate.displayName,
      storefront: candidate.storefront,
    })),
  })).slice(0, 20)}`;
  return createGuidanceDecisionV3({
    id: decisionId,
    header: "Choose exact artist",
    question: `Which Apple Music artist named “${normalized(input.inputText)}” should be excluded?`,
    axis: "exact_artist_identity",
    trigger: "correctness",
    criticality: "required",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: input.base.revisionId,
    baseContractSemanticHash: input.base.semanticHash,
    whyMaterial: "The same artist name maps to multiple Apple Music identities. Choose one stable profile, or keep the current interpretation unchanged.",
    allowedPatchOperations,
    affectedClauseIds,
    materialityScore: 100,
    interpretationSummary: summary,
    options: [
      {
        id: "keep_current_interpretation",
        label: "Keep current interpretation",
        description: "Do not add this artist exclusion. You can edit the artist wording separately.",
        recommended: true,
        expectedFeasibilityDirection: "neutral",
        patch: {
          affectedClauseIds: [],
          operations: [],
        },
      },
      ...candidates.map(({ candidate, compiled }) => {
        const genres = candidate.genreNames?.length
          ? ` Genres: ${candidate.genreNames.join(", ")}.`
          : "";
        return {
          id: `exclude_artist_${sha256Hex(stableStringify({
            id: candidate.catalogArtistId,
            storefront: candidate.storefront,
          })).slice(0, 16)}`,
          label: `${candidate.displayName} · ${candidate.catalogArtistId}`,
          description: `Exclude Apple Music artist ${candidate.catalogArtistId}.${genres}`,
          recommended: false,
          expectedFeasibilityDirection: "narrower" as const,
          patch: {
            affectedClauseIds: compiled.affectedClauseIds,
            operations: compiled.operations,
          },
        };
      }),
    ],
  });
}

/**
 * Custom prose is never itself executable. It must first be recompiled into
 * an operation set by server policy. Any operation which changes membership,
 * exclusion, catalog/content policy, or count then requires a second explicit
 * confirmation before an executable patch is returned.
 */
export function compileCustomGuidanceAnswerV3(input: {
  decision: GuidanceDecisionV3;
  customText: string;
  serverCompiled: ServerCompiledCustomGuidanceV3 | null;
  confirmed: boolean;
}): CompiledCustomGuidanceAnswerV3 {
  assertGuidanceDecisionV3(input.decision);
  if (!input.decision.allowCustom) throw new Error("custom_guidance_not_allowed");
  const normalizedText = normalized(input.customText);
  if (!normalizedText || normalizedText.length > 500) throw new Error("invalid_custom_guidance_text");
  const baseAnswer = {
    questionHash: input.decision.questionHash,
    customText: normalizedText,
  };
  if (!input.serverCompiled) {
    return {
      state: "needs_recompile",
      normalizedText,
      answerHash: sha256Hex(stableStringify(baseAnswer)),
      hardChangeReasons: [],
      executableOperations: null,
      affectedClauseIds: [],
    };
  }
  const allowedOperations = new Set(input.decision.allowedPatchOperations);
  const allowedClauseIds = new Set(input.decision.affectedClauseIds);
  for (const operation of input.serverCompiled.operations) {
    const name = operationName(operation);
    if (!name || !allowedOperations.has(name)) throw new Error("custom_patch_operation_not_allowed");
  }
  for (const clauseId of input.serverCompiled.affectedClauseIds) {
    if (!allowedClauseIds.has(clauseId)) throw new Error("custom_patch_clause_not_allowed");
  }
  const hardChangeReasons = uniqueSorted(
    input.serverCompiled.operations.flatMap(hardChangeReasonsForOperation),
  );
  const answerHash = sha256Hex(stableStringify({
    ...baseAnswer,
    operations: input.serverCompiled.operations,
    affectedClauseIds: uniqueSorted(input.serverCompiled.affectedClauseIds),
    confirmed: input.confirmed,
  }));
  if (hardChangeReasons.length > 0 && !input.confirmed) {
    return {
      state: "needs_confirmation",
      normalizedText,
      answerHash,
      hardChangeReasons,
      executableOperations: null,
      affectedClauseIds: uniqueSorted(input.serverCompiled.affectedClauseIds),
    };
  }
  return {
    state: "accepted",
    normalizedText,
    answerHash,
    hardChangeReasons,
    executableOperations: [...input.serverCompiled.operations],
    affectedClauseIds: uniqueSorted(input.serverCompiled.affectedClauseIds),
  };
}
