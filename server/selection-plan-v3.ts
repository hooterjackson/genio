/**
 * Pipeline V3 planning is deliberately pure and provider-independent.
 *
 * The planner records what may enter a playlist separately from how eligible
 * recordings should be ranked.  A ranking preference can never make an
 * ineligible recording eligible.
 */

import { createHash } from "node:crypto";
import type {
  CanonicalPlaylistContractExecutionPolicyV1,
  CanonicalPlaylistExecutionDirectivesV1,
  CanonicalPlaylistQualityPolicy,
  CanonicalPlaylistQuotaRule,
  PipelineV3ConceptDiscoveryHint,
  PipelineV3SourceDiscoveryHint,
  PlaylistGuidanceAnswer,
  PlaylistGuidanceQuestion,
  PlaylistGuidanceSourceHint,
  PlaylistBrief,
  ResearchIntent,
  SelectionConstraint,
  SelectionDiversityGoals,
  SelectionGeographyConstraint,
  SelectionOrderingPolicy,
  SelectionPlan,
  SelectionScopeKind,
} from "../shared/types.ts";
import { EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS } from "../shared/product-policy.ts";
import { assertPublicHttpsUrl, stableStringify } from "./security.ts";
import {
  inferSelectionGeographyRelationship,
  parseSelectionGeographyConstraints,
  selectionGeographyIsAudienceMarketContext,
} from "./selection-geography-policy.ts";
import {
  canonicalMusicConceptIdV3,
  eligibilityAliasesForMusicConceptV3,
  MUSIC_CONCEPT_POLICY_VERSION,
} from "./music-concepts-v3.ts";
import { excludedReferenceArtists } from "./similarity-policy.ts";
import {
  hasHistoricalInfluenceSemanticsV1,
} from "./historical-influence-semantics-v1.ts";

export const PIPELINE_V3_VERSION = "corpus_first_v3" as const;
export const PIPELINE_V3_POLICY_VERSION = "corpus_first_v3_policy_v1" as const;
export const GROUNDED_RECOVERY_V3_1_POLICY_VERSION = "grounded_recovery_v3_1_policy_v1" as const;
export const SEMANTIC_PLAN_V3_1_VERSION = "semantic_plan_v3_1" as const;
export const SELECTION_PLAN_V3_VERSION = "selection_plan_v3" as const;
export const SELECTION_PLAN_V3_SCHEMA_VERSION = 1 as const;
export const SEMANTIC_SCOPE_POLICY_VERSION = "scope_gate_v2_1_2" as const;
export const PIPELINE_V3_MAX_SOURCE_DISCOVERY_HINTS = 12;

export type IntentV3 =
  | "genre_scene"
  | "similarity"
  | "mood_activity"
  | "theme"
  | "artist_catalogue"
  | "editorial_ranking"
  | "factual_relationship"
  | "exhaustive";

export type IntentEngineV3 =
  | "curated_genre_scene"
  | "mood_activity_theme"
  | "similarity"
  | "artist_catalogue"
  | "fixed_container"
  | "factual_relationship"
  | "exhaustive";

export type MembershipAxisV3 =
  | "genre"
  | "subgenre"
  | "scene"
  | "era"
  | "geography"
  | "language"
  | "theme"
  | "mood"
  | "activity"
  | "artist"
  | "album"
  | "playlist"
  | "track"
  | "label"
  | "venue"
  | "factual_relationship"
  | "recording_version"
  | "content";

export type MembershipOperatorV3 = "include" | "exclude" | "require";

export interface MembershipPredicateV3 {
  readonly id: string;
  readonly axis: MembershipAxisV3;
  readonly operator: MembershipOperatorV3;
  readonly values: readonly string[];
  readonly source: "user" | "guided_answer" | "system_safety";
  readonly geographyRelationship?: SelectionConstraint["geographyRelationship"];
  /** A short machine-readable explanation used in audit reports. */
  readonly reason: string;
}

export type RankingDimensionV3 =
  | "influence"
  | "relevance"
  | "central_quality"
  | "similarity"
  | "source_rank"
  | "artist_diversity"
  | "album_diversity"
  | "era_balance"
  | "scene_balance"
  | "geography_balance"
  | "sequencing";

export interface RankingObjectiveV3 {
  readonly id: string;
  readonly dimension: RankingDimensionV3;
  readonly direction: "maximize" | "minimize" | "balance";
  readonly weight: number;
  /** Lower values are relaxed first; null means the objective is not relaxed. */
  readonly relaxationRank: number | null;
  readonly values: readonly string[];
  readonly reason: string;
}

export interface RecordingPolicyV3 {
  readonly allowedVersions: readonly (
    | "canonical"
    | "clean"
    | "explicit"
    | "live"
    | "remix"
    | "radio_edit"
    | "extended"
    | "acoustic"
    | "instrumental"
  )[];
  readonly preferCanonicalStudio: boolean;
  readonly excludeKaraokeTributeAndCovers: boolean;
}

/**
 * Every interpreted clause has one execution role.  Keeping the role on the
 * immutable plan prevents presentation prose and listener context from being
 * replayed later as track-evidence requirements.
 */
export type SemanticClauseRoleV32 =
  | "membership"
  | "catalog_policy"
  | "context"
  | "ranking"
  | "diversity_sequencing"
  | "discovery_hint";

export type SemanticClauseSourceV32 =
  | "raw_prompt"
  | "guided_answer"
  | "v2_compatibility"
  | "system_default";

export interface SemanticPlanClauseV32 {
  readonly id: string;
  readonly role: SemanticClauseRoleV32;
  readonly axis: MembershipAxisV3 | RankingDimensionV3 | SelectionConstraint["axis"];
  readonly operator: MembershipOperatorV3 | SelectionConstraint["operator"] | RankingObjectiveV3["direction"];
  readonly values: readonly string[];
  readonly source: SemanticClauseSourceV32;
  readonly explicitUserAuthored: boolean;
  readonly geographyRelationship: SelectionConstraint["geographyRelationship"];
  readonly reason: string;
}

export interface CriticalAmbiguityV3 {
  readonly key:
    | "house_semantics"
    | "french_jazz_scope"
    | "geographic_genre_scope"
    | "possessive_relationship"
    | "brazilian_funk_semantics"
    | "temporal_width";
  readonly summary: string;
  readonly blocking: true;
  readonly trust:
    | "server_derived"
    | "model_correlated"
    | "rejected_untrusted";
  readonly resolution:
    | "covered_by_contract"
    | "nonmaterial_display"
    | "pending_question"
    | "answered_successor"
    | "explicit_summary_consent"
    | "blocked_unmodeled";
  readonly optionIds: readonly string[];
  /** Context is present for the generic nationality/scene/language question. */
  readonly geographicLabel?: string;
  readonly genreLabel?: string;
  readonly sceneValue?: string;
  readonly originValue?: string;
  readonly languageValue?: string;
  /** Exact named subject for possessive factual-relationship questions. */
  readonly subjectValue?: string;
  /** Exact user-authored year whose intended width is unresolved. */
  readonly yearValue?: number;
}

export interface RunSpecV3 {
  readonly schemaVersion: typeof SELECTION_PLAN_V3_SCHEMA_VERSION;
  readonly pipelineVersion: typeof PIPELINE_V3_VERSION;
  readonly selectionPlanVersion: typeof SELECTION_PLAN_V3_VERSION;
  readonly prompt: string;
  readonly requestedTrackCount: number;
  readonly storefront: string;
  readonly intents: readonly IntentV3[];
  readonly engines: readonly IntentEngineV3[];
  readonly membershipPredicates: readonly MembershipPredicateV3[];
  readonly rankingObjectives: readonly RankingObjectiveV3[];
  readonly scopeKind: SelectionScopeKind;
  readonly hardConstraints: readonly SelectionConstraint[];
  readonly softPreferences: readonly SelectionConstraint[];
  readonly diversityGoals: Readonly<SelectionDiversityGoals>;
  readonly orderingPolicy: Readonly<SelectionOrderingPolicy>;
  readonly softGoalRelaxationOrder: readonly string[];
  readonly sourceDiscoveryHints: readonly PipelineV3SourceDiscoveryHint[];
  /** Immutable, untrusted concept leads; never selection or ranking policy. */
  readonly conceptDiscoveryHints: readonly PipelineV3ConceptDiscoveryHint[];
  /** Present only when an immutable canonical contract owns distribution. */
  readonly playlistQuotaRules?: readonly CanonicalPlaylistQuotaRule[];
  /** Present only when an immutable canonical contract owns central quality. */
  readonly playlistQualityPolicy?: Readonly<CanonicalPlaylistQualityPolicy>;
  /** Sole selection authority for immutable contract-3 work. */
  readonly canonicalContractPolicy?: Readonly<CanonicalPlaylistContractExecutionPolicyV1>;
  /** Typed discovery identity; canonical workers never reconstruct it from prompt prose. */
  readonly executionDirectives?: Readonly<CanonicalPlaylistExecutionDirectivesV1>;
  readonly criticalAmbiguities: readonly CriticalAmbiguityV3[];
  readonly recordingPolicy: RecordingPolicyV3;
  readonly semanticPolicyVersion: typeof SEMANTIC_SCOPE_POLICY_VERSION;
  /** Pins the server-owned alias/evidence registry for reproducible execution. */
  readonly musicConceptPolicyVersion: typeof MUSIC_CONCEPT_POLICY_VERSION;
  readonly semanticClauses: readonly SemanticPlanClauseV32[];
  readonly contextSignals: readonly SemanticPlanClauseV32[];
  readonly catalogPolicies: readonly SemanticPlanClauseV32[];
  /** Hash of user-authored input only; model/compatibility prose is excluded. */
  readonly explicitUserConstraintHash: string;
  /** Immutable semantic contract compiled from the raw request. */
  readonly userGoal?: UserGoalV31;
  /** Deterministic proof that the compiler did not create contradictory hard clauses. */
  readonly semanticAudit?: SemanticAuditV31;
}

export type UserGoalClauseRoleV31 = SemanticClauseRoleV32;
export interface UserGoalClauseV31 {
  readonly id: string;
  readonly role: UserGoalClauseRoleV31;
  readonly axis: SemanticPlanClauseV32["axis"];
  readonly values: readonly string[];
  readonly sourceIds: readonly string[];
}
export interface UserGoalV31 {
  readonly version: typeof SEMANTIC_PLAN_V3_1_VERSION;
  readonly rawPrompt: string;
  readonly requestedTrackCount: number;
  readonly clauses: readonly UserGoalClauseV31[];
}
export interface SemanticAuditV31 {
  readonly version: typeof SEMANTIC_PLAN_V3_1_VERSION;
  readonly musicConceptPolicyVersion: typeof MUSIC_CONCEPT_POLICY_VERSION;
  readonly passed: boolean;
  readonly hardConstraintHash: string;
  readonly aliasCollapses: readonly string[];
  readonly contradictions: readonly string[];
}

export interface SelectionPlanV3 extends RunSpecV3 {
  readonly confirmed: boolean;
  readonly resolvedAmbiguityKeys: readonly CriticalAmbiguityV3["key"][];
}

/**
 * Recording-version, content, and era rules are verified against the resolved
 * catalog recording, not by requiring an editorial source to repeat the
 * policy sentence (or literal range endpoints). They remain immutable
 * membership policy in the plan, but are intentionally absent from the
 * source-evidence contract.
 */
export function evidenceMembershipPredicatesV3(
  plan: Pick<RunSpecV3, "membershipPredicates">,
): MembershipPredicateV3[] {
  return plan.membershipPredicates.filter((predicate) => (
    predicate.operator !== "exclude"
    && predicate.axis !== "recording_version"
    && predicate.axis !== "content"
    && predicate.axis !== "era"
  ));
}

export function evidenceMembershipPredicateIdsV3(
  plan: Pick<RunSpecV3, "membershipPredicates">,
): string[] {
  return evidenceMembershipPredicatesV3(plan).map(({ id }) => id);
}

export interface RunSpecV3Input {
  prompt: string;
  requestedTrackCount: number;
  storefront?: string;
  /** Provider-attested scout sources; bounded leads only, never evidence. */
  guidanceSourceHints?: readonly PlaylistGuidanceSourceHint[];
  /** Confirmed model interpretation; it may enrich discovery but never replace the raw prompt or count. */
  brief?: PlaylistBrief;
  /** Existing typed parser output used as the compatibility bridge while V2 drains. */
  typedSelectionPlan?: Pick<SelectionPlan,
    | "intents"
    | "scopeKind"
    | "constraints"
    | "diversityGoals"
    | "orderingPolicy"
    | "softGoalRelaxationOrder"
    | "versionPolicy"
    | "contentPolicy"
  >;
}

function boundedSourceHintText(value: unknown, maximumLength: number): string {
  return typeof value === "string"
    ? value.replace(/\s+/gu, " ").trim().slice(0, maximumLength)
    : "";
}

/**
 * Normalize provider-attested scout output before it enters an immutable V3
 * contract. Invalid/private URLs are discarded independently so one bad
 * sibling cannot erase valid discovery leads.
 */
export function sanitizePipelineV3SourceDiscoveryHints(
  hints: readonly PlaylistGuidanceSourceHint[] | undefined,
): PipelineV3SourceDiscoveryHint[] {
  const seen = new Set<string>();
  const output: PipelineV3SourceDiscoveryHint[] = [];
  for (const hint of hints ?? []) {
    let url: string;
    try { url = assertPublicHttpsUrl(hint.url).toString(); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    output.push({
      url,
      title: boundedSourceHintText(hint.title, 200) || new URL(url).hostname,
      excerpt: boundedSourceHintText(hint.excerpt, 500),
      attestation: "guidance_scout_provider_response",
    });
    if (output.length >= PIPELINE_V3_MAX_SOURCE_DISCOVERY_HINTS) break;
  }
  return output;
}

const GENRE_TERMS = [
  "ambient", "baile funk", "bossa nova", "classical", "disco", "drill",
  "dembow", "dub", "electro", "footwork", "funk carioca", "garage", "grime", "house",
  "hip hop", "jazz", "jungle", "metal", "pop", "punk", "r b", "rap", "reggae", "rock",
  "latin urban", "reggaeton", "samba", "soul", "techno", "trance",
] as const;

interface GeographicQualifierV3 {
  readonly aliases: readonly string[];
  readonly scenePrefix: string;
  readonly originValue: string;
  readonly languageValue?: string;
  /** A bare adjective can materially mean origin, scene, or language. */
  readonly ambiguousBareGenre?: boolean;
}

/**
 * Geography is data-driven rather than a list of complete prompt phrases.
 * This deliberately distinguishes a music scene from artist nationality:
 * “Detroit techno” is a scene binding, while “French jazz” needs guidance
 * unless the visitor explicitly says scene, artist origin, or language.
 */
const GEOGRAPHIC_QUALIFIERS: readonly GeographicQualifierV3[] = [
  { aliases: ["detroit"], scenePrefix: "Detroit", originValue: "Detroit" },
  { aliases: ["chicago"], scenePrefix: "Chicago", originValue: "Chicago" },
  { aliases: ["berlin"], scenePrefix: "Berlin", originValue: "Berlin" },
  { aliases: ["rio de janeiro", "rio"], scenePrefix: "Rio de Janeiro", originValue: "Rio de Janeiro" },
  { aliases: ["los angeles", "la", "l a"], scenePrefix: "Los Angeles", originValue: "Los Angeles" },
  { aliases: ["new york", "nyc"], scenePrefix: "New York", originValue: "New York" },
  { aliases: ["london"], scenePrefix: "London", originValue: "London" },
  { aliases: ["bristol"], scenePrefix: "Bristol", originValue: "Bristol" },
  { aliases: ["manchester"], scenePrefix: "Manchester", originValue: "Manchester" },
  { aliases: ["paris", "parisian"], scenePrefix: "Paris", originValue: "Paris", languageValue: "French" },
  { aliases: ["uk", "u k", "british"], scenePrefix: "UK", originValue: "United Kingdom", languageValue: "English" },
  { aliases: ["american", "usa", "united states"], scenePrefix: "American", originValue: "United States", languageValue: "English" },
  { aliases: ["brazilian", "brazil"], scenePrefix: "Brazilian", originValue: "Brazil", languageValue: "Portuguese" },
  { aliases: ["french", "france"], scenePrefix: "French", originValue: "France", languageValue: "French", ambiguousBareGenre: true },
  { aliases: ["german", "germany"], scenePrefix: "German", originValue: "Germany", languageValue: "German" },
  { aliases: ["italian", "italy"], scenePrefix: "Italian", originValue: "Italy", languageValue: "Italian" },
  { aliases: ["irish", "ireland"], scenePrefix: "Irish", originValue: "Ireland" },
  { aliases: ["japanese", "japan"], scenePrefix: "Japanese", originValue: "Japan", languageValue: "Japanese" },
  { aliases: ["nigerian", "nigeria"], scenePrefix: "Nigerian", originValue: "Nigeria" },
  { aliases: ["jamaican", "jamaica"], scenePrefix: "Jamaican", originValue: "Jamaica", languageValue: "English" },
];

interface GeographicGenreScopeV3 {
  readonly qualifier: GeographicQualifierV3;
  readonly matchedAlias: string;
  readonly genre: string;
  readonly sceneValue: string;
}

const SIMILARITY_CUE_SOURCE = String.raw`(?:similar to|sounds? like|(?:songs?|tracks?|music) like|in the style of|inspired by)`;
const REFERENCE_POINT_CUE_SOURCE = String.raw`as (?:a )?(?:(?:style|sonic|musical) )?reference point`;

function normalize(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[’']/gu, "'")
    .replace(/[^a-z0-9'\s-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function preserveExplicitUnitedStatesScope(value: string): string {
  return value.replace(
    /\bU\.?S\.?(?=\s+(?:music|songs?|tracks?|recordings?|artists?|rap|hip[ -]?hop|r\s*(?:&|and)\s*b|jazz|rock|pop|country|drill|house|techno|scene|genre))/gu,
    "United States",
  );
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${normalize(value).replace(/[^a-z0-9]+/gu, "_").replace(/^_|_$/gu, "")}`;
}

function dedupe<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function detectedAudienceContextClauses(rawPrompt: string): SemanticPlanClauseV32[] {
  const prompt = normalize(rawPrompt);
  const contexts: SemanticPlanClauseV32[] = [];
  const seen = new Set<string>();
  for (const qualifier of GEOGRAPHIC_QUALIFIERS) {
    const mentioned = qualifier.aliases.some((alias) => new RegExp(`\\b${escapedPattern(alias)}\\b`, "u").test(prompt));
    if (!mentioned || seen.has(normalize(qualifier.originValue))) continue;
    const contextual = selectionGeographyIsAudienceMarketContext(rawPrompt, qualifier.originValue)
      || qualifier.aliases.some((alias) => {
        const escaped = escapedPattern(alias);
        return new RegExp(
          `\\b(?:for\\s+(?:a|an|the)?\\s*(?:dinner|party|drive|road trip|night out)|driving|cruising|partying|clubbing|nightlife|discoteques?|clubs?|born|raised|grew|growing)\\b[^.;!?]{0,100}\\b(?:in|through|around)\\s+${escaped}\\b`,
          "u",
        ).test(prompt)
          || new RegExp(
            `\\bfor\\s+(?:a|an|the)?\\s*${escaped}\\s+(?:dinner|party|drive|road trip|night out|club night)\\b`,
            "u",
          ).test(prompt);
      });
    if (!contextual) continue;
    seen.add(normalize(qualifier.originValue));
    contexts.push({
      id: stableId("context:audience_market", qualifier.originValue),
      role: "context",
      axis: "geography",
      operator: "prefer",
      values: [qualifier.originValue],
      source: "raw_prompt",
      explicitUserAuthored: true,
      geographyRelationship: "unspecified",
      reason: `${qualifier.originValue} describes the intended audience, setting, or listening market.`,
    });
  }
  return contexts;
}

function predicate(
  axis: MembershipAxisV3,
  operator: MembershipOperatorV3,
  values: readonly string[],
  reason: string,
  geographyRelationship: SelectionConstraint["geographyRelationship"] = null,
): MembershipPredicateV3 {
  const normalizedValues = values.map((value) => value.trim()).filter(Boolean);
  return {
    id: stableId(`membership:${axis}:${operator}:${geographyRelationship ?? "none"}`, normalizedValues.join("-")),
    axis,
    operator,
    values: normalizedValues,
    source: "user",
    geographyRelationship,
    reason,
  };
}

function explicitRawGeographicPredicates(rawPrompt: string): MembershipPredicateV3[] {
  const predicates: MembershipPredicateV3[] = [];
  for (const constraint of parseSelectionGeographyConstraints(rawPrompt)) {
    if (constraint.relationship !== "language") continue;
    predicates.push(predicate(
      "language",
      "require",
      [constraint.value],
      `The request explicitly requires ${constraint.value}-language recordings.`,
      "language",
    ));
  }
  const normalizedPrompt = normalize(rawPrompt);
  for (const qualifier of GEOGRAPHIC_QUALIFIERS) {
    const mentioned = qualifier.aliases.some((alias) => (
      new RegExp(`\\b${escapedPattern(alias)}\\b`, "u").test(normalizedPrompt)
    ));
    if (!mentioned || selectionGeographyIsAudienceMarketContext(rawPrompt, qualifier.originValue)) continue;
    const relationship = inferSelectionGeographyRelationship(rawPrompt, qualifier.originValue);
    if (relationship === "artist_origin" || relationship === "artist_residence" || relationship === "recording_location") {
      predicates.push(predicate(
        "geography",
        "require",
        [qualifier.originValue],
        `The request explicitly requires ${relationship.replaceAll("_", " ")} in ${qualifier.originValue}.`,
        relationship,
      ));
    } else if (relationship === "label_or_venue_scene") {
      predicates.push(predicate(
        "scene",
        "require",
        [qualifier.originValue],
        `The request explicitly requires documented scene, label, or venue membership in ${qualifier.originValue}.`,
        relationship,
      ));
    } else if (relationship === "language" && qualifier.languageValue) {
      predicates.push(predicate(
        "language",
        "require",
        [qualifier.languageValue],
        `The request explicitly requires ${qualifier.languageValue}-language recordings.`,
        "language",
      ));
    } else if (relationship === "unspecified") {
      const intrinsicMusicScope = qualifier.aliases.some((alias) => (
        new RegExp(
          `\\b${escapedPattern(alias)}\\s+(?:music|songs?|tracks?|recordings?|playlist|mix)\\b`,
          "u",
        ).test(normalizedPrompt)
      ));
      if (intrinsicMusicScope) {
        // A broad national-music request is hard membership even when the
        // listener has not chosen between artist origin and documented scene
        // association. Either proof route may satisfy this one broad
        // geography obligation; neither is silently reinterpreted as
        // language or recording location.
        predicates.push(predicate(
          "geography",
          "require",
          [qualifier.originValue],
          `The request explicitly requires music bound to ${qualifier.originValue} by exact artist origin or a documented local scene association.`,
          "unspecified",
        ));
      }
    }
  }
  return predicates;
}

function normalizedPredicateKey(value: Pick<MembershipPredicateV3, "axis" | "operator" | "values">): string {
  return `${value.axis}:${value.operator}:${value.values.map(normalize).sort().join("|")}`;
}

function pushPredicate(
  predicates: MembershipPredicateV3[],
  value: MembershipPredicateV3,
): void {
  const key = normalizedPredicateKey(value);
  if (!predicates.some((item) => normalizedPredicateKey(item) === key)) predicates.push(value);
}

const TYPED_AXIS_TO_V3: Readonly<Partial<Record<SelectionConstraint["axis"], MembershipAxisV3>>> = {
  genre: "genre",
  subgenre: "subgenre",
  scene: "scene",
  era: "era",
  geography: "geography",
  language: "language",
  mood: "mood",
  activity: "activity",
  theme: "theme",
  artist: "artist",
  track: "track",
  label: "label",
  venue: "venue",
  recording_version: "recording_version",
  content: "content",
  relationship: "factual_relationship",
};

function explicitEraPolicyRequested(rawPrompt: string): boolean {
  const prompt = normalize(rawPrompt);
  const ambiguousBareYear = /\b(?:18|19|20)\d{2}\s+(?:rap|hip hop|r&b|rhythm and blues|jazz|rock|pop|disco|house|techno|funk|soul)\b/u.test(prompt)
    && !/\b(?:released?|recorded|recordings?|songs?|tracks?|music)\s+(?:from|during|in)\s+(?:the\s+)?(?:18|19|20)\d{2}\b/u.test(prompt)
    && !/\b(?:only|year)\s+(?:18|19|20)\d{2}\b/u.test(prompt);
  if (ambiguousBareYear) return false;
  return /\b(?:songs?|tracks?|music|recordings?|releases?)\b[^.;!?]{0,30}\b(?:released\s+)?(?:from|during|in|before|after|between)\s+(?:the\s+)?(?:18|19|20)\d{2}s?\b/u.test(prompt)
    || /\b(?:18|19|20)\d{2}s?\b[^.;!?]{0,30}\b(?:era|songs?|tracks?|music|recordings?|releases?|disco|house|jazz|techno|drill|funk|ambient|rock|soul)\b/u.test(prompt)
    || /\b(?:before|after|between|from)\s+(?:18|19|20)\d{2}\b/u.test(prompt);
}

function v2ConstraintExplicitlyUserAuthored(
  constraint: SelectionConstraint,
  rawPrompt: string,
): boolean {
  if (/^guidance_scope(?:_|$)/u.test(constraint.id)) return true;
  if (/^(?:evidence|version|relationship|brief_|subject_)/u.test(constraint.id)) return false;
  if (constraint.axis === "evidence") return false;
  if (constraint.axis === "recording_version" || constraint.axis === "content") {
    return explicitVersionPolicyRequested(rawPrompt);
  }
  if (constraint.axis === "era") {
    return explicitEraPolicyRequested(rawPrompt);
  }
  const prompt = normalize(rawPrompt);
  return constraint.values.some((value) => {
    const normalizedValue = normalize(value);
    const eligibleAliases = constraint.axis === "genre"
      ? eligibilityAliasesForMusicConceptV3(value).map(normalize)
      : [normalizedValue];
    return eligibleAliases.some((alias) => alias.length >= 2 && ` ${prompt} `.includes(` ${alias} `));
  });
}

function audienceMarketContext(
  rawPrompt: string,
  constraint: Pick<SelectionConstraint, "values" | "geographyRelationship">,
): boolean {
  if (constraint.geographyRelationship && constraint.geographyRelationship !== "unspecified") return false;
  return constraint.values.some((value) => selectionGeographyIsAudienceMarketContext(rawPrompt, value));
}

function typedConstraintRole(
  constraint: SelectionConstraint,
  rawPrompt: string,
): SemanticClauseRoleV32 {
  if (constraint.operator === "maximum") return "diversity_sequencing";
  if (["era", "recording_version", "content"].includes(constraint.axis)) return "catalog_policy";
  if (constraint.axis === "evidence") return "discovery_hint";
  if (constraint.axis === "geography" && audienceMarketContext(rawPrompt, constraint)) return "context";
  if (constraint.axis === "geography"
    && (!constraint.geographyRelationship
      || constraint.geographyRelationship === "unspecified"
      || constraint.geographyRelationship === "sound_association")) return "discovery_hint";
  if (constraint.kind === "soft") {
    return ["geography", "mood", "activity", "theme"].includes(constraint.axis)
      ? "context"
      : "discovery_hint";
  }
  return v2ConstraintExplicitlyUserAuthored(constraint, rawPrompt)
    ? "membership"
    : "discovery_hint";
}

function typedConstraintPredicate(
  constraint: SelectionConstraint,
  rawPrompt: string,
): MembershipPredicateV3 | null {
  if (typedConstraintRole(constraint, rawPrompt) !== "membership") return null;
  if (constraint.kind !== "hard" || constraint.operator === "maximum") return null;
  const axis = TYPED_AXIS_TO_V3[constraint.axis];
  if (!axis) return null;
  const operator: MembershipOperatorV3 = constraint.operator === "exclude" || constraint.operator === "avoid"
    ? "exclude"
    : "require";
  const built = predicate(
    axis,
    operator,
    constraint.values,
    `Confirmed typed constraint ${constraint.id} (${constraint.operator}).`,
  );
  return {
    ...built,
    id: `v2:${constraint.id}`,
    geographyRelationship: constraint.geographyRelationship ?? (axis === "language" ? "language" : null),
  };
}

function semanticClauseFromTypedConstraint(
  constraint: SelectionConstraint,
  rawPrompt: string,
): SemanticPlanClauseV32 {
  const explicitUserAuthored = v2ConstraintExplicitlyUserAuthored(constraint, rawPrompt);
  const role = typedConstraintRole(constraint, rawPrompt);
  const operator = role === "catalog_policy" && !explicitUserAuthored
    ? "prefer"
    : constraint.operator;
  return {
    id: `v2:${constraint.id}`,
    role,
    axis: TYPED_AXIS_TO_V3[constraint.axis] ?? constraint.axis,
    operator,
    values: [...constraint.values],
    source: "v2_compatibility",
    explicitUserAuthored,
    geographyRelationship: constraint.geographyRelationship ?? null,
    reason: role === "membership"
      ? `Confirmed user-authored typed constraint ${constraint.id}.`
      : `Compatibility constraint ${constraint.id} is classified as ${role}.`,
  };
}

const RECORDING_POLICY_V3_VALUES = new Set<RecordingPolicyV3["allowedVersions"][number]>([
  "canonical", "clean", "explicit", "live", "remix", "radio_edit", "extended", "acoustic", "instrumental",
]);

function explicitVersionPolicyRequested(rawPrompt: string): boolean {
  return /\b(?:only|must|require|required|exclude|avoid|without|no|prefer|include|allow)\b[^.;!?\n]{0,80}\b(?:canonical|original|studio|clean|explicit|live|remix|radio edit|single edit|extended|acoustic|instrumental|karaoke|cover|tribute|version)\b/iu.test(rawPrompt)
    || /\b(?:canonical|original|studio|clean|explicit|live|remix|radio edit|single edit|extended|acoustic|instrumental|karaoke|cover|tribute)\s+(?:recordings?|versions?|tracks?)\s+only\b/iu.test(rawPrompt);
}

function recordingPolicyForInput(input: RunSpecV3Input): RecordingPolicyV3 {
  if (!explicitVersionPolicyRequested(input.prompt)) {
    return {
      allowedVersions: ["canonical", "clean", "explicit"],
      preferCanonicalStudio: true,
      excludeKaraokeTributeAndCovers: true,
    };
  }
  const only = input.prompt.match(/\bonly\s+(?:use\s+)?(?:the\s+)?(canonical|original|studio|clean|explicit|live|remix|radio edit|single edit|extended|acoustic|instrumental)(?:\s+(?:recordings?|versions?|tracks?))?/iu)
    ?? input.prompt.match(/\b(canonical|original|studio|clean|explicit|live|remix|radio edit|single edit|extended|acoustic|instrumental)\s+(?:recordings?|versions?|tracks?)\s+only\b/iu);
  const normalizedOnly = normalize(only?.[1] ?? "").replace(/\s+/gu, "_");
  const mappedOnly = normalizedOnly === "original" || normalizedOnly === "studio" ? "canonical"
    : normalizedOnly === "single_edit" ? "radio_edit"
      : normalizedOnly;
  if (RECORDING_POLICY_V3_VALUES.has(mappedOnly as RecordingPolicyV3["allowedVersions"][number])) {
    const allowed = [mappedOnly as RecordingPolicyV3["allowedVersions"][number]];
    return {
      allowedVersions: allowed,
      preferCanonicalStudio: allowed.includes("canonical"),
      excludeKaraokeTributeAndCovers: true,
    };
  }
  if (!input.typedSelectionPlan) {
    return {
      allowedVersions: ["canonical", "clean", "explicit"],
      preferCanonicalStudio: true,
      excludeKaraokeTributeAndCovers: true,
    };
  }
  const allowed = input.typedSelectionPlan.versionPolicy.allowed
    .filter((value): value is RecordingPolicyV3["allowedVersions"][number] => (
      RECORDING_POLICY_V3_VALUES.has(value as RecordingPolicyV3["allowedVersions"][number])
    ));
  return {
    allowedVersions: allowed.length > 0 ? dedupe(allowed) : ["canonical", "clean", "explicit"],
    preferCanonicalStudio: input.typedSelectionPlan.versionPolicy.preferred.includes("canonical"),
    excludeKaraokeTributeAndCovers: input.typedSelectionPlan.versionPolicy.excludeKaraokeAndTributes,
  };
}

function rawCatalogPolicyClauses(rawPrompt: string): SemanticPlanClauseV32[] {
  const clauses: SemanticPlanClauseV32[] = [];
  const eraValues = explicitEraPolicyRequested(rawPrompt)
    ? dedupe([
      ...rawPrompt.matchAll(/\b(?:18|19|20)\d0s\b|\b(?:[2-9]0s)\b|\b(?:18|19|20)\d{2}\b/giu),
    ].map((match) => match[0]))
    : [];
  if (eraValues.length > 0) {
    const rangeRequested = eraValues.length === 2 && (
      /\bfrom\s+(?:18|19|20)\d{2}\s+(?:through|to|until|-)\s+(?:18|19|20)\d{2}\b/iu.test(rawPrompt)
      || /\bbetween\s+(?:18|19|20)\d{2}\s+and\s+(?:18|19|20)\d{2}\b/iu.test(rawPrompt)
      || /\b(?:18|19|20)\d{2}\s*[-–—]\s*(?:18|19|20)\d{2}\b/u.test(rawPrompt)
    );
    clauses.push({
      id: stableId("catalog:era", eraValues.join("-")),
      role: "catalog_policy",
      axis: "era",
      operator: rangeRequested ? "between" : "within",
      values: eraValues,
      source: "raw_prompt",
      explicitUserAuthored: true,
      geographyRelationship: null,
      reason: "The request explicitly names an era; the resolved catalog recording enforces it.",
    });
  }
  if (explicitVersionPolicyRequested(rawPrompt)) {
    const versionValues = dedupe([...rawPrompt.matchAll(
      /\b(?:canonical|original|studio|clean|explicit|live|remix|radio edit|single edit|extended|acoustic|instrumental|karaoke|cover|tribute)(?:\s+(?:recordings?|versions?|tracks?))?\b/giu,
    )].map((match) => match[0]));
    if (versionValues.length > 0) {
      clauses.push({
        id: stableId("catalog:recording_version", versionValues.join("-")),
        role: "catalog_policy",
        axis: "recording_version",
        operator: /\b(?:exclude|avoid|without|no)\b/iu.test(rawPrompt) ? "exclude" : "require",
        values: versionValues,
        source: "raw_prompt",
        explicitUserAuthored: true,
        geographyRelationship: null,
        reason: "The request explicitly names a recording-version policy.",
      });
    }
  }
  return clauses;
}

function intentsFromTypedPlan(intents: readonly ResearchIntent[]): IntentV3[] {
  return intents.flatMap((intent): IntentV3[] => {
    switch (intent) {
      case "mood_activity": return ["mood_activity"];
      case "genre_scene":
      case "similarity":
      case "theme":
      case "artist_catalogue":
      case "editorial_ranking":
      case "factual_relationship":
      case "exhaustive": return [intent];
    }
  });
}

function cloneConstraint(value: SelectionConstraint): SelectionConstraint {
  return {
    ...value,
    values: [...value.values],
    geographyRelationship: value.geographyRelationship ?? null,
  };
}

function inferredScopeKind(
  prompt: string,
  intents: readonly IntentV3[],
): SelectionScopeKind {
  if (intents.includes("factual_relationship") || intents.includes("exhaustive")) return "factual_frontier";
  if (intents.includes("artist_catalogue")) return "artist_catalogue";
  if (/\b(?:from|every|all|this|the)\s+(?:album|soundtrack|compilation|chart|label catalog(?:ue)?|track list)\b/iu.test(prompt)
    || /\b(?:album|soundtrack|compilation)\s+["“][^"”]{2,120}["”]/iu.test(prompt)) {
    return "fixed_release_container";
  }
  return "broad_curated";
}

function defaultDiversityGoals(
  requestedTrackCount: number,
  scopeKind: SelectionScopeKind,
): SelectionDiversityGoals {
  if (scopeKind !== "broad_curated") {
    return {
      minimumDistinctArtists: null,
      minimumDistinctAlbums: null,
      minimumDistinctEras: null,
      minimumDistinctScenes: null,
      minimumDistinctGeographies: null,
      maximumTracksPerArtist: null,
      maximumTracksPerAlbum: null,
    };
  }
  return {
    minimumDistinctArtists: Math.min(requestedTrackCount, Math.max(5, Math.ceil(requestedTrackCount * 0.2))),
    minimumDistinctAlbums: Math.min(requestedTrackCount, Math.max(5, Math.ceil(requestedTrackCount * 0.25))),
    minimumDistinctEras: 2,
    minimumDistinctScenes: 2,
    minimumDistinctGeographies: null,
    maximumTracksPerArtist: Math.max(1, Math.ceil(requestedTrackCount * 0.15)),
    maximumTracksPerAlbum: Math.max(2, Math.ceil(requestedTrackCount * 0.1)),
  };
}

function defaultOrderingPolicy(scopeKind: SelectionScopeKind): SelectionOrderingPolicy {
  const broad = scopeKind === "broad_curated";
  return {
    mode: "editorial",
    goals: [],
    avoidAdjacentSameArtist: broad,
    avoidAdjacentSameAlbum: broad,
  };
}

function possessiveSubject(prompt: string): string | null {
  const match = prompt.trim().match(
    /^(.{2,100}?)[’']s\s+(?:\d+\s+)?(?:most\s+)?(?:influential|essential|important|best)\s+(?:songs?|tracks?|recordings?)\b/iu,
  );
  return match?.[1]?.trim() || null;
}

function objective(
  dimension: RankingDimensionV3,
  direction: RankingObjectiveV3["direction"],
  weight: number,
  relaxationRank: number | null,
  reason: string,
  values: readonly string[] = [],
): RankingObjectiveV3 {
  return {
    id: stableId(`ranking:${dimension}`, values.join("-") || reason),
    dimension,
    direction,
    weight,
    relaxationRank,
    values: [...values],
    reason,
  };
}

function detectedGenreTerms(prompt: string): string[] {
  // Compound genre names are concepts, not an AND with every token they
  // contain. In particular, baile funk/funk carioca must never silently
  // become both `funk carioca` and the much broader `funk` genre.
  const baileFunk = /\b(?:baile\s+funk|funk\s+carioca)\b/u.test(prompt);
  const terms = GENRE_TERMS.filter((genre) => {
    if (genre === "baile funk" || genre === "funk carioca") return false;
    return new RegExp(`\\b${genre.replace(/\s+/gu, "\\s+")}\\b`, "u").test(prompt);
  });
  if (baileFunk) terms.push("funk carioca");
  return terms;
}

/**
 * The corpus and Apple editorial catalog use several names for the same Rio
 * genre. They are OR aliases inside one membership predicate, never three
 * independent requirements and never the unrelated broad US `funk` genre.
 */
function genreEvidenceAliases(genre: string): string[] {
  return [...eligibilityAliasesForMusicConceptV3(genre)];
}

function genrePredicate(
  operator: MembershipOperatorV3,
  genres: readonly string[],
  reason: string,
): MembershipPredicateV3 {
  const built = predicate("genre", operator, genres.flatMap(genreEvidenceAliases), reason);
  const conceptIds = dedupe(genres.map(canonicalMusicConceptIdV3)).sort();
  return {
    ...built,
    id: stableId(`membership:genre:${operator}`, conceptIds.join("|")),
  };
}

function explicitTrackLevelViralityRequirement(prompt: string): boolean {
  return /\b(?:only|every|all|must|require|required)\b[^.;!?\n]{0,100}\b(?:tiktok|viral|virality|trending|trend|breakout)\b/iu.test(prompt)
    || /\b(?:tiktok|viral|virality|trending|trend|breakout)\b[^.;!?\n]{0,100}\b(?:only|every|all|must|require|required|documented|verified)\b/iu.test(prompt);
}

function constraintConflictsWithMembership(
  constraint: SelectionConstraint,
  predicates: readonly MembershipPredicateV3[],
  allConstraints: readonly SelectionConstraint[] = [],
): boolean {
  if (constraint.operator !== "avoid" && constraint.operator !== "exclude") return false;
  const contradictsMembership = predicates.some((item) => (
    item.operator !== "exclude"
    && item.axis === constraint.axis
    && item.values.some((required) => constraint.values.some((value) => normalize(value) === normalize(required)))
  ));
  const contradictsPositivePreference = allConstraints.some((item) => (
    item.id !== constraint.id
    && item.axis === constraint.axis
    && (item.operator === "prefer" || item.operator === "include" || item.operator === "require")
    && item.values.some((required) => constraint.values.some((value) => normalize(value) === normalize(required)))
  ));
  return contradictsMembership || contradictsPositivePreference;
}

/**
 * V2 stored generated evidence and version prose as constraints. In V3 these
 * domains have dedicated evidence predicates and recording policy. Replaying
 * that prose as a second hard gate can reject every valid candidate even when
 * the immutable raw request never made it mandatory.
 */
function executionHardConstraints(
  constraints: readonly SelectionConstraint[],
  rawPrompt: string,
): SelectionConstraint[] {
  return constraints
    .filter((constraint) => constraint.kind === "hard")
    .filter((constraint) => typedConstraintRole(constraint, rawPrompt) === "membership"
      || typedConstraintRole(constraint, rawPrompt) === "diversity_sequencing")
    .map(cloneConstraint);
}

function compileSemanticContractV31(input: {
  rawPrompt: string;
  requestedTrackCount: number;
  predicates: readonly MembershipPredicateV3[];
  objectives: readonly RankingObjectiveV3[];
  semanticClauses: readonly SemanticPlanClauseV32[];
}): { userGoal: UserGoalV31; semanticAudit: SemanticAuditV31; explicitUserConstraintHash: string } {
  const clauses: UserGoalClauseV31[] = input.semanticClauses
    .filter((item) => item.explicitUserAuthored || item.source === "raw_prompt" || item.source === "guided_answer")
    .map((item) => ({
      id: item.id,
      role: item.role,
      axis: item.axis,
      values: [...item.values],
      sourceIds: [item.id],
    }));
  const contradictions: string[] = [];
  for (const required of input.predicates.filter((item) => item.operator !== "exclude")) {
    for (const excluded of input.predicates.filter((item) => item.operator === "exclude" && item.axis === required.axis)) {
      const overlap = required.values.filter((value) => excluded.values.some((other) => normalize(other) === normalize(value)));
      if (overlap.length > 0) contradictions.push(`${required.axis}:${overlap.map(normalize).join("|")}`);
    }
  }
  const additionalExplicitConstraints = input.semanticClauses
    .filter((item) => item.explicitUserAuthored
      && (item.source === "guided_answer" || /^v2:guidance_scope(?:_|$)/u.test(item.id)))
    .map(({ role, axis, operator, values, geographyRelationship }) => ({
      role,
      axis,
      operator,
      values: values.map(normalize).sort(),
      geographyRelationship: geographyRelationship ?? null,
    }));
  const explicitUserConstraintHash = createHash("sha256").update(stableStringify({
    rawPrompt: input.rawPrompt.trim(),
    requestedTrackCount: input.requestedTrackCount,
    explicitGuidanceConstraints: additionalExplicitConstraints,
  })).digest("hex");
  return {
    userGoal: {
      version: SEMANTIC_PLAN_V3_1_VERSION,
      rawPrompt: input.rawPrompt,
      requestedTrackCount: input.requestedTrackCount,
      clauses,
    },
    semanticAudit: {
      version: SEMANTIC_PLAN_V3_1_VERSION,
      musicConceptPolicyVersion: MUSIC_CONCEPT_POLICY_VERSION,
      passed: contradictions.length === 0,
      // Keep the legacy field populated while schema-1 plans drain. Its value
      // now obeys the corrected user-authored-only hashing contract.
      hardConstraintHash: explicitUserConstraintHash,
      aliasCollapses: /\b(?:baile\s+funk|funk\s+carioca)\b/iu.test(input.rawPrompt)
        ? ["baile funk|funk carioca=>funk carioca"]
        : [],
      contradictions: dedupe(contradictions),
    },
    explicitUserConstraintHash,
  };
}

function semanticClauseFromPredicate(value: MembershipPredicateV3): SemanticPlanClauseV32 {
  const compatibilityGuidance = /^v2:guidance_scope(?:_|$)/u.test(value.id);
  return {
    id: value.id,
    role: "membership",
    axis: value.axis,
    operator: value.operator,
    values: [...value.values],
    source: value.source === "guided_answer" || compatibilityGuidance ? "guided_answer"
      : value.id.startsWith("v2:") ? "v2_compatibility"
        : "raw_prompt",
    explicitUserAuthored: value.source !== "system_safety" && (!value.id.startsWith("v2:") || compatibilityGuidance),
    geographyRelationship: value.geographyRelationship ?? null,
    reason: value.reason,
  };
}

function semanticClauseFromObjective(value: RankingObjectiveV3, rawPrompt: string): SemanticPlanClauseV32 {
  const explicit = value.dimension === "influence"
    ? hasHistoricalInfluenceSemanticsV1(rawPrompt)
    : value.dimension === "similarity"
      ? new RegExp(`\\b(?:${SIMILARITY_CUE_SOURCE}|${REFERENCE_POINT_CUE_SOURCE})\\b`, "iu").test(rawPrompt)
      : value.values.length > 0 && value.values.some((item) => normalize(rawPrompt).includes(normalize(item)));
  return {
    id: value.id,
    role: value.dimension === "sequencing" || value.dimension.endsWith("diversity") || value.dimension.endsWith("balance")
      ? "diversity_sequencing"
      : "ranking",
    axis: value.dimension,
    operator: value.direction,
    values: [...value.values],
    source: explicit ? "raw_prompt" : "system_default",
    explicitUserAuthored: explicit,
    geographyRelationship: null,
    reason: value.reason,
  };
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");
}

function detectedGeographicGenreScopes(
  prompt: string,
  genres = detectedGenreTerms(prompt),
): GeographicGenreScopeV3[] {
  const scopes: GeographicGenreScopeV3[] = [];
  const seen = new Set<string>();
  for (const qualifier of GEOGRAPHIC_QUALIFIERS) {
    for (const alias of qualifier.aliases) {
      for (const genre of genres) {
        const pattern = new RegExp(`\\b${escapedPattern(alias)}\\s+${escapedPattern(genre)}\\b`, "u");
        if (!pattern.test(prompt)) continue;
        const sceneValue = `${qualifier.scenePrefix} ${genre}`;
        const key = `${normalize(sceneValue)}:${normalize(genre)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scopes.push({ qualifier, matchedAlias: alias, genre, sceneValue });
      }
    }
  }
  return scopes;
}

function explicitGenreFusion(prompt: string, genres: readonly string[]): boolean {
  if (genres.length < 2) return false;
  if (/\b(?:fusion|fused|blend|blended|hybrid|crossover|cross-over|mashup|combines?|combining)\b/u.test(prompt)) {
    return true;
  }
  if (/\beach\s+(?:song|track|recording)\b.{0,80}\b(?:both|all)\b/u.test(prompt)) return true;
  return genres.some((left, index) => genres.slice(index + 1).some((right) => (
    new RegExp(`\\b${escapedPattern(left)}-${escapedPattern(right)}\\b|\\b${escapedPattern(right)}-${escapedPattern(left)}\\b`, "u")
      .test(prompt)
  )));
}

function replacePromptGenrePredicates(
  predicates: MembershipPredicateV3[],
  genres: readonly string[],
  intersection: boolean,
): void {
  if (genres.length === 0) return;
  const normalizedGenres = new Set(genres.map(normalize));
  const aliasEquivalentGenres = normalizedGenres.has("funk carioca")
    ? new Set(["funk carioca", "baile funk", "funk"])
    : normalizedGenres;
  const promptGenrePredicate = (value: MembershipPredicateV3): boolean => (
    value.axis === "genre"
    && (value.operator === "include" || value.operator === "require")
    && value.values.length > 0
    && value.values.every((item) => aliasEquivalentGenres.has(normalize(item)))
  );
  for (let index = predicates.length - 1; index >= 0; index -= 1) {
    if (promptGenrePredicate(predicates[index]!)) predicates.splice(index, 1);
  }
  if (intersection) {
    for (const genre of genres) {
      pushPredicate(predicates, genrePredicate(
        "require",
        [genre],
        `The request explicitly asks for recordings that combine ${genres.join(" and ")}.`,
      ));
    }
    return;
  }
  pushPredicate(predicates, genrePredicate(
    "require",
    genres,
    genres.length === 1
      ? `The request explicitly names the ${genres[0]} genre.`
      : `Each recording may satisfy any one of the requested genres: ${genres.join(", ")}.`,
  ));
}

function explicitGeographicRelationship(
  prompt: string,
  scope: GeographicGenreScopeV3,
): "scene" | "origin" | "language" | null {
  const alias = escapedPattern(scope.matchedAlias);
  const genre = escapedPattern(scope.genre);
  if (new RegExp(`\\b${alias}\\s+${genre}\\s+scene\\b|\\b${genre}\\s+scene\\s+in\\s+${alias}\\b`, "u").test(prompt)) {
    return "scene";
  }
  if (new RegExp(`\\b${alias}[-\\s]+language\\s+${genre}\\b|\\b${genre}\\b.{0,40}\\b(?:sung|performed)\\s+in\\s+${alias}\\b`, "u").test(prompt)) {
    return "language";
  }
  if (new RegExp(`\\b${alias}\\s+artists?\\b.{0,50}\\b${genre}\\b|\\b${genre}\\b.{0,50}\\b(?:artists? from|artists? born in)\\s+${alias}\\b`, "u").test(prompt)) {
    return "origin";
  }
  return null;
}

function intentEngines(intents: readonly IntentV3[]): IntentEngineV3[] {
  const engines: IntentEngineV3[] = [];
  if (intents.includes("exhaustive")) engines.push("exhaustive");
  else if (intents.includes("factual_relationship")) engines.push("factual_relationship");
  if (intents.includes("artist_catalogue")) engines.push("artist_catalogue");
  if (intents.includes("similarity")) engines.push("similarity");
  if (intents.includes("mood_activity") || intents.includes("theme")) engines.push("mood_activity_theme");
  if (intents.includes("genre_scene") || intents.includes("editorial_ranking")) engines.push("curated_genre_scene");
  return dedupe(engines.length > 0 ? engines : ["curated_genre_scene"]);
}

function detectCriticalAmbiguities(prompt: string): CriticalAmbiguityV3[] {
  const ambiguities: CriticalAmbiguityV3[] = [];
  const ambiguousYear = prompt.match(
    /\b((?:18|19|20)\d{2})\s+(?:rap|hip hop|r&b|rhythm and blues|jazz|rock|pop|disco|house|techno|funk|soul)\b/u,
  )?.[1];
  if (ambiguousYear
    && !/\b(?:released?|recorded|recordings?|songs?|tracks?|music)\s+(?:from|during|in)\s+(?:the\s+)?(?:18|19|20)\d{2}\b/u.test(prompt)
    && !/\b(?:only|year)\s+(?:18|19|20)\d{2}\b/u.test(prompt)) {
    ambiguities.push({
      key: "temporal_width",
      summary: `“${ambiguousYear}” may mean that exact release year, a nearby window, or the full decade.`,
      blocking: true,
      trust: "server_derived",
      resolution: "pending_question",
      optionIds: ["era_year_only", "era_around_year", "era_full_decade", "custom"],
      yearValue: Number(ambiguousYear),
    });
  }
  const houseAlongsideAnotherGenre = detectedGenreTerms(prompt).some((genre) => genre !== "house");
  const bareHouse = /\bhouse\b/u.test(prompt)
    && !houseAlongsideAnotherGenre
    && !/\bhouse\s+music\b|\bhouse\s+(?:tracks?|songs?|genre|scene|dj)\b|\b(chicago|acid|deep|progressive|tech|afro)\s+house\b/u.test(prompt)
    && !/\b(?:songs?|music|tracks?)\s+(?:about|mentioning)\s+(?:a\s+)?(?:house|home|houses|homes)\b|\bhome-themed\b/u.test(prompt);
  if (bareHouse) {
    ambiguities.push({
      key: "house_semantics",
      summary: "“House” may mean the music genre or a lyrical theme about houses and homes.",
      blocking: true,
      trust: "server_derived",
      resolution: "pending_question",
      optionIds: ["house_genre", "house_theme", "house_both", "custom"],
    });
  }

  if (/\bfrench\s+jazz\b/u.test(prompt)
    && !/\b(?:french-born|french artists?|artists? from france|recorded in france|france scene|french jazz scene|french-language|sung in french)\b/u.test(prompt)) {
    ambiguities.push({
      key: "french_jazz_scope",
      summary: "“French jazz” may refer to artist origin, a scene in France, or French-language recordings.",
      blocking: true,
      trust: "server_derived",
      resolution: "pending_question",
      optionIds: ["french_artist_origin", "french_scene", "french_language", "custom"],
    });
  }

  for (const scope of detectedGeographicGenreScopes(prompt)) {
    if (!scope.qualifier.ambiguousBareGenre || scope.genre === "jazz") continue;
    if (explicitGeographicRelationship(prompt, scope) !== null) continue;
    ambiguities.push({
      key: "geographic_genre_scope",
      summary: `“${scope.sceneValue}” may refer to artist origin, a scene, or ${scope.qualifier.languageValue ?? "a language relationship"}.`,
      blocking: true,
      trust: "server_derived",
      resolution: "pending_question",
      optionIds: ["geographic_artist_origin", "geographic_scene", "geographic_language", "custom"],
      geographicLabel: scope.qualifier.scenePrefix,
      genreLabel: scope.genre,
      sceneValue: scope.sceneValue,
      originValue: scope.qualifier.originValue,
      ...(scope.qualifier.languageValue ? { languageValue: scope.qualifier.languageValue } : {}),
    });
    break;
  }

  const possessive = prompt.match(/\b([a-z0-9][a-z0-9 .&-]{1,80})'s\s+(?:\d+\s+)?(?:most\s+)?(?:influential|essential|important|best)\s+(?:songs?|tracks?|recordings?)\b/u);
  if (possessive
    && !/\b(?:performed|played|produced|written|composed|recorded|released|sung)\s+by\b|\b(?:credits?|contributions?|discography)\b/u.test(prompt)) {
    ambiguities.push({
      key: "possessive_relationship",
      summary: "The possessive does not say whether the subject performed, wrote, produced, or merely influenced the recordings.",
      blocking: true,
      trust: "server_derived",
      resolution: "pending_question",
      optionIds: ["subject_performed", "subject_created", "subject_influenced", "custom"],
      subjectValue: possessive[1]!.trim(),
    });
  }

  if (/\bbrazilian\s+funk\b/u.test(prompt)
    && !/\b(?:baile\s+funk|funk\s+carioca|mandelao|tamborzao)\b/u.test(prompt)
    && !/\b(?:1960s|1970s|1980s|60s|70s|80s|soul|samba[- ]funk)\b/u.test(prompt)) {
    ambiguities.push({
      key: "brazilian_funk_semantics",
      summary: "“Brazilian funk” may mean funk carioca/baile funk or Brazilian soul-and-funk traditions.",
      blocking: true,
      trust: "server_derived",
      resolution: "pending_question",
      optionIds: ["funk_carioca", "brazilian_soul_funk", "both_funk_traditions", "custom"],
    });
  }
  return ambiguities;
}

/** Deterministically interpret only facts present in the request. */
export function createRunSpecV3(input: RunSpecV3Input): RunSpecV3 {
  const prompt = normalize(preserveExplicitUnitedStatesScope(input.prompt));
  if (prompt.length < 2 || prompt.length > 4_000) throw new Error("Playlist prompt must contain 2–4,000 characters");
  if (!Number.isSafeInteger(input.requestedTrackCount)
    || input.requestedTrackCount < 1
    || input.requestedTrackCount > EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS) {
    throw new Error(
      `Requested track count must be an integer between 1 and ${EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS}`,
    );
  }
  const storefront = (input.storefront ?? "us").trim().toLowerCase();
  if (!/^[a-z]{2}$/u.test(storefront)) throw new Error("Storefront must be a two-letter code");

  const intents: IntentV3[] = [];
  const predicates: MembershipPredicateV3[] = [];
  const compatibilityClauses: SemanticPlanClauseV32[] = [];
  const objectives: RankingObjectiveV3[] = [
    objective("relevance", "maximize", 1, null, "Prefer the strongest qualified match to the confirmed request."),
    objective("artist_diversity", "balance", 0.35, 3, "Avoid artist concentration in broad curated playlists."),
    objective("album_diversity", "balance", 0.2, 2, "Avoid album-sized blocks when alternatives exist."),
    objective("sequencing", "maximize", 0.15, 1, "Interleave qualified artists and albums deterministically."),
  ];

  // The V2 parser already carries confirmed, typed axes derived from the raw
  // request and guided answers. V3 consumes those types as a compatibility
  // bridge instead of throwing them away and attempting to recover scope from
  // prompt keywords a second time.
  if (input.typedSelectionPlan) {
    intents.push(...intentsFromTypedPlan(input.typedSelectionPlan.intents));
    for (const constraint of input.typedSelectionPlan.constraints) {
      compatibilityClauses.push(semanticClauseFromTypedConstraint(constraint, input.prompt));
      const mapped = typedConstraintPredicate(constraint, input.prompt);
      if (mapped) pushPredicate(predicates, mapped);
    }
  }

  if (/\b(?:every|all|complete|exhaustive|entire)\b/u.test(prompt)) intents.push("exhaustive");
  if (/\b(?:played|performed|produced|written|composed|arranged|credited|credits?|contributions?|session)\b/u.test(prompt)) {
    intents.push("factual_relationship");
  }
  if (
    new RegExp(
      `\\b(?:${SIMILARITY_CUE_SOURCE}|${REFERENCE_POINT_CUE_SOURCE}|resembl(?:e|es|ing))\\b`,
      "u",
    ).test(prompt)
    || excludedReferenceArtists(input.brief ?? {}).length > 0
  ) intents.push("similarity");
  if (/\b(?:songs?|tracks?|music)\s+(?:about|mentioning|whose theme is)\b/u.test(prompt)) intents.push("theme");
  if (/\b(?:for (?:sleep|studying|study|running|work|dinner|party|road trip|gaming|a smoke session)|workout|focus|relaxing|calm|upbeat|dark|melanchol|gaming|smoking|late[ -]?night|chill(?:ed|ing)?)\b/u.test(prompt)) {
    intents.push("mood_activity");
  }
  if (hasHistoricalInfluenceSemanticsV1(prompt)) {
    intents.push("editorial_ranking");
    objectives.push(objective("influence", "maximize", 0.9, null, "Rank only eligible tracks by documented influence."));
  }
  if (/\b(?:discography|songs? by|tracks? by|catalog(?:ue)? of|released by)\b/u.test(prompt)) intents.push("artist_catalogue");

  const ambiguities = detectCriticalAmbiguities(prompt);
  const ambiguousKeys = new Set(ambiguities.map(({ key }) => key));
  const genres = detectedGenreTerms(prompt).filter((genre) => {
    if (genre === "house" && ambiguousKeys.has("house_semantics")) return false;
    if ((genre === "baile funk" || genre === "funk carioca") && ambiguousKeys.has("brazilian_funk_semantics")) return false;
    return true;
  });
  const genreIntersection = explicitGenreFusion(prompt, genres);
  if (genres.length > 0) {
    intents.push("genre_scene");
    replacePromptGenrePredicates(predicates, genres, genreIntersection);
  }
  const geographicScopes = detectedGeographicGenreScopes(prompt, genres);
  // One user clause must compile to one semantic role.  Phrases such as
  // "artists born in France" contain the lexical cue "born in", but they are
  // an explicit artist-origin membership rule, not an audience biography.
  // Resolve the explicit geographic predicates first, then remove the same
  // place from contextual projections below.
  let directContextSignals = detectedAudienceContextClauses(input.prompt);
  const audienceContextValues = new Set(directContextSignals.flatMap(({ values }) => values.map(normalize)));
  const sceneValues: string[] = [];
  const sceneScopedGenres = new Set<string>();
  for (const scope of geographicScopes) {
    if (audienceContextValues.has(normalize(scope.qualifier.originValue))) continue;
    const relationship = explicitGeographicRelationship(prompt, scope);
    const ambiguous = (normalize(scope.sceneValue) === "french jazz" && ambiguousKeys.has("french_jazz_scope"))
      || ambiguities.some((ambiguity) => (
        ambiguity.key === "geographic_genre_scope"
        && ambiguity.sceneValue === scope.sceneValue
      ));
    if (ambiguous && relationship === null) continue;
    intents.push("genre_scene");
    if (relationship === "origin") {
      pushPredicate(predicates, predicate(
        "geography",
        "require",
        [scope.qualifier.originValue],
        `The request explicitly limits principal artist origin to ${scope.qualifier.originValue}.`,
        "artist_origin",
      ));
    } else if (relationship === "language" && scope.qualifier.languageValue) {
      pushPredicate(predicates, predicate(
        "language",
        "require",
        [scope.qualifier.languageValue],
        `The request explicitly requires ${scope.qualifier.languageValue}-language recordings.`,
        "language",
      ));
    } else {
      sceneValues.push(scope.sceneValue);
      sceneScopedGenres.add(normalize(scope.genre));
    }
  }
  const explicitGeographyValues = new Set(predicates.flatMap((candidate) => (
    candidate.axis === "geography"
      && candidate.geographyRelationship !== null
      && candidate.geographyRelationship !== "unspecified"
      && candidate.geographyRelationship !== "sound_association"
      ? candidate.values.map(normalize)
      : []
  )));
  directContextSignals = directContextSignals.filter((signal) => (
    !signal.values.some((value) => explicitGeographyValues.has(normalize(value)))
  ));
  // A recognized geographic genre is one scene concept. Requiring the scene
  // and then separately requiring its generic genre duplicates one user
  // clause into two evidence gates and was a primary source of false zeroes.
  if (genres.length > 0 && genres.every((genre) => sceneScopedGenres.has(normalize(genre)))) {
    const scopedAliases = new Set(genres.flatMap(genreEvidenceAliases).map(normalize));
    for (let index = predicates.length - 1; index >= 0; index -= 1) {
      const candidate = predicates[index]!;
      if (candidate.axis === "genre"
        && candidate.operator === "require"
        && candidate.values.every((value) => scopedAliases.has(normalize(value)))) {
        predicates.splice(index, 1);
      }
    }
  }
  if (sceneValues.length > 0) {
    if (genreIntersection) {
      for (const scene of sceneValues) {
        pushPredicate(predicates, predicate(
          "scene",
          "require",
          [scene],
          `The requested fusion must be supported by the ${scene} scene scope.`,
          "label_or_venue_scene",
        ));
      }
    } else {
      pushPredicate(predicates, predicate(
        "scene",
        "require",
        dedupe(sceneValues),
        sceneValues.length === 1
          ? `The request explicitly limits the recording pool to the ${sceneValues[0]} scene.`
          : `Each recording may belong to any one of the requested scenes: ${sceneValues.join(", ")}.`,
        "label_or_venue_scene",
      ));
    }
  }
  for (const explicitGeography of explicitRawGeographicPredicates(input.prompt)) {
    pushPredicate(predicates, explicitGeography);
  }

  // Explicit relationship phrases need not use the compact “place + genre”
  // spelling handled above.
  if (/\bfrench[-\s]+language\b/u.test(prompt)) {
    pushPredicate(predicates, predicate("language", "require", ["French"], "The request explicitly requires French-language recordings.", "language"));
  } else if (/\b(?:french-born|french artists?|artists? from france)\b/u.test(prompt)) {
    pushPredicate(predicates, predicate("geography", "require", ["France"], "The request explicitly requires artists from France.", "artist_origin"));
  }

  if (/\b(?:songs?|tracks?|music)\s+(?:about|mentioning)\s+(?:a\s+)?(?:house|home|houses|homes)\b/u.test(prompt)) {
    pushPredicate(predicates, predicate("theme", "require", ["houses and homes"], "The request explicitly asks for a lyrical theme."));
  }
  if (/\b(?:baile\s+funk|funk\s+carioca)\b/u.test(prompt)) {
    pushPredicate(predicates, genrePredicate(
      "require",
      ["funk carioca"],
      "The request explicitly names funk carioca/baile funk; these are equivalent source labels.",
    ));
  }
  if (/\btiktok\b/u.test(prompt) && /\b(?:breakout|breakouts|viral|virality|trending|trend)\b/u.test(prompt)) {
    const values = ["TikTok breakout", "TikTok virality"];
    if (explicitTrackLevelViralityRequirement(prompt)) {
      pushPredicate(predicates, predicate(
        "theme",
        "require",
        values,
        "The request explicitly makes documented TikTok virality mandatory for every recording.",
      ));
    } else {
      objectives.push(objective(
        "relevance",
        "maximize",
        0.95,
        null,
        "Prefer genre-eligible recordings with documented TikTok breakout relevance.",
        values,
      ));
    }
  }
  if (/\b(?:1960s|1970s|1980s|60s|70s|80s|soul|samba[- ]funk)\s+(?:brazilian\s+)?funk\b|\bbrazilian\s+(?:soul|samba[- ]funk)\b/u.test(prompt)) {
    pushPredicate(predicates, predicate("genre", "require", ["Brazilian soul and funk"], "The request explicitly distinguishes the soul-and-funk tradition."));
  }

  // A possessive factual request names a subject even when the relationship
  // itself still requires guidance. Preserve the subject independently so
  // choosing “performed on” cannot produce a relationship-only graph query.
  const explicitPossessiveSubject = possessiveSubject(input.prompt);
  if (explicitPossessiveSubject) {
    pushPredicate(predicates, predicate(
      "artist",
      "require",
      [explicitPossessiveSubject],
      "The request explicitly names the subject whose recording relationship must be proven.",
    ));
  } else if (input.brief && (intents.includes("factual_relationship") || intents.includes("artist_catalogue"))) {
    // This path is limited to relationship/catalogue intents. Subject entities
    // on broad curated briefs remain discovery hints and are never hardened.
    const subjects = input.brief.subjectEntities.map((value) => value.trim()).filter(Boolean);
    if (subjects.length > 0) {
      pushPredicate(predicates, predicate(
        "artist",
        "require",
        subjects,
        "The confirmed factual or catalogue brief identifies the subject entity.",
      ));
    }
  }

  const seedMatch = prompt.match(new RegExp(
    `\\b${SIMILARITY_CUE_SOURCE}\\s+(.{2,120}?)(?=\\s+\\b(?:but|without|excluding|except)\\b|$)`,
    "u",
  ));
  const referencePointSeed = input.brief?.subjectEntities.find((entity) => (
    new RegExp(
      `\\b${escapedPattern(normalize(entity))}\\s+${REFERENCE_POINT_CUE_SOURCE}\\b`,
      "u",
    ).test(prompt)
  ));
  const similaritySeeds = dedupe([
    ...(seedMatch?.[1]?.trim() ? [seedMatch[1].trim()] : []),
    ...(referencePointSeed ? [referencePointSeed] : []),
    ...excludedReferenceArtists(input.brief ?? {}),
  ]);
  if (similaritySeeds.length > 0) {
    pushPredicate(predicates, predicate(
      "artist",
      "exclude",
      similaritySeeds,
      "The reference artist is excluded as primary artist; featured appearances remain eligible.",
    ));
    objectives.push(objective(
      "similarity",
      "maximize",
      0.9,
      null,
      "Rank qualified recordings by supported similarity dimensions.",
      similaritySeeds,
    ));
  }
  if (
    /\b(?:new|emerging|up-and-coming|up and coming|lesser-known)\s+artists?\b/u
      .test(prompt)
    || /\b(?:wants?\s+to\s+discover|want\s+to\s+discover|discover(?:ing)?)\s+(?:new|more|different)\s+(?:music|stuff|sounds?|tracks?|songs?)\b/u
      .test(prompt)
  ) {
    objectives.push(objective(
      "relevance",
      "maximize",
      0.85,
      null,
      "Favor discovery of new and emerging artists after hard eligibility is proven.",
      ["new artists", "emerging artists"],
    ));
  }

  const uniqueIntents = dedupe(intents);
  const scopeKind = input.typedSelectionPlan?.scopeKind
    ?? inferredScopeKind(input.prompt, uniqueIntents);
  const hardConstraints = executionHardConstraints(input.typedSelectionPlan?.constraints ?? [], input.prompt);
  const softPreferences = (input.typedSelectionPlan?.constraints ?? [])
    .filter((constraint) => constraint.kind === "soft")
    .filter((constraint) => !constraintConflictsWithMembership(
      constraint,
      predicates,
      input.typedSelectionPlan?.constraints ?? [],
    ))
    .map(cloneConstraint);
  const diversityGoals = input.typedSelectionPlan?.diversityGoals
    ? { ...input.typedSelectionPlan.diversityGoals }
    : defaultDiversityGoals(input.requestedTrackCount, scopeKind);
  const orderingPolicy = input.typedSelectionPlan?.orderingPolicy
    ? {
        ...input.typedSelectionPlan.orderingPolicy,
        goals: [...input.typedSelectionPlan.orderingPolicy.goals],
      }
    : defaultOrderingPolicy(scopeKind);
  const softGoalRelaxationOrder = input.typedSelectionPlan?.softGoalRelaxationOrder
    ? [...input.typedSelectionPlan.softGoalRelaxationOrder]
    : [
        "sequencing_preferences",
        "album_concentration",
        "artist_concentration",
        "era_balance",
        "subgenre_regional_representation",
      ];
  // Some explicit relationship phrases (for example, “artists born in
  // France”) are compiled after the geographic-scene pass above. Reconcile
  // context one final time so a single user clause cannot survive as both an
  // artist-origin membership rule and an audience/listening-market signal.
  const finalExplicitGeographyValues = new Set(predicates.flatMap((candidate) => (
    candidate.axis === "geography"
      && candidate.geographyRelationship !== null
      && candidate.geographyRelationship !== "unspecified"
      && candidate.geographyRelationship !== "sound_association"
      ? candidate.values.map(normalize)
      : []
  )));
  directContextSignals = directContextSignals.filter((signal) => (
    !signal.values.some((value) => finalExplicitGeographyValues.has(normalize(value)))
  ));
  const semanticClauses = [
    ...predicates.map(semanticClauseFromPredicate),
    ...objectives.map((value) => semanticClauseFromObjective(value, input.prompt)),
    ...compatibilityClauses.filter((clause) => clause.role !== "membership"),
    ...directContextSignals,
    ...rawCatalogPolicyClauses(input.prompt),
  ].filter((clause, index, all) => all.findIndex((candidate) => (
    candidate.role === clause.role
    && candidate.axis === clause.axis
    && candidate.operator === clause.operator
    && candidate.values.map(normalize).sort().join("|") === clause.values.map(normalize).sort().join("|")
  )) === index);
  const contextSignals = semanticClauses.filter(({ role }) => role === "context");
  const catalogPolicies = semanticClauses.filter(({ role }) => role === "catalog_policy");
  const semantic = compileSemanticContractV31({
    rawPrompt: input.prompt.trim(),
    requestedTrackCount: input.requestedTrackCount,
    predicates,
    objectives,
    semanticClauses,
  });
  if (!semantic.semanticAudit.passed) {
    throw new Error(`Pipeline V3.1 semantic audit found contradictory hard clauses: ${semantic.semanticAudit.contradictions.join(", ")}`);
  }
  return deepFreeze({
    schemaVersion: SELECTION_PLAN_V3_SCHEMA_VERSION,
    pipelineVersion: PIPELINE_V3_VERSION,
    selectionPlanVersion: SELECTION_PLAN_V3_VERSION,
    prompt: input.prompt.trim(),
    requestedTrackCount: input.requestedTrackCount,
    storefront,
    intents: uniqueIntents,
    engines: intentEngines(uniqueIntents),
    membershipPredicates: predicates,
    rankingObjectives: objectives,
    scopeKind,
    hardConstraints,
    softPreferences,
    diversityGoals,
    orderingPolicy,
    softGoalRelaxationOrder,
    sourceDiscoveryHints: sanitizePipelineV3SourceDiscoveryHints(input.guidanceSourceHints),
    conceptDiscoveryHints: [],
    criticalAmbiguities: ambiguities,
    recordingPolicy: recordingPolicyForInput(input),
    semanticPolicyVersion: SEMANTIC_SCOPE_POLICY_VERSION,
    musicConceptPolicyVersion: MUSIC_CONCEPT_POLICY_VERSION,
    semanticClauses,
    contextSignals,
    catalogPolicies,
    ...semantic,
  });
}

export type CriticalAmbiguityAnswerV3 =
  | { key: "house_semantics"; optionId: "house_genre" | "house_theme" | "house_both"; customValue?: never }
  | { key: "french_jazz_scope"; optionId: "french_artist_origin" | "french_scene" | "french_language"; customValue?: never }
  | { key: "geographic_genre_scope"; optionId: "geographic_artist_origin" | "geographic_scene" | "geographic_language"; customValue?: never }
  | { key: "possessive_relationship"; optionId: "subject_performed" | "subject_created" | "subject_influenced"; customValue?: never }
  | { key: "brazilian_funk_semantics"; optionId: "funk_carioca" | "brazilian_soul_funk" | "both_funk_traditions"; customValue?: never }
  | { key: "temporal_width"; optionId: "era_year_only" | "era_around_year" | "era_full_decade"; customValue?: never }
  | { key: CriticalAmbiguityV3["key"]; optionId: "custom"; customValue: string };

function guidedPredicate(
  axis: MembershipAxisV3,
  values: readonly string[],
  reason: string,
  geographyRelationship: SelectionConstraint["geographyRelationship"] = null,
): MembershipPredicateV3 {
  const built = predicate(axis, "require", values, reason, geographyRelationship);
  return { ...built, source: "guided_answer" };
}

function customAmbiguityAxis(
  key: CriticalAmbiguityV3["key"],
  custom: string,
): MembershipAxisV3 {
  if (key === "temporal_width") return "era";
  if (key === "possessive_relationship") return "factual_relationship";
  if (key === "french_jazz_scope" || key === "geographic_genre_scope") {
    if (/\b(?:language|french[- ]language|francophone|sung|lyrics?)\b/iu.test(custom)) return "language";
    if (/\b(?:origin|nationality|born|artists? from|country)\b/iu.test(custom)) return "geography";
    return "scene";
  }
  return /\bscene\b/iu.test(custom) ? "scene" : "genre";
}

export function resolveRunSpecV3(
  spec: RunSpecV3,
  answers: readonly CriticalAmbiguityAnswerV3[],
): SelectionPlanV3 {
  const unanswered = new Map(spec.criticalAmbiguities.map((ambiguity) => [ambiguity.key, ambiguity]));
  const predicates = [...spec.membershipPredicates];
  const objectives = [...spec.rankingObjectives];
  const intents = [...spec.intents];
  const seen = new Set<string>();
  for (const answer of answers) {
    if (seen.has(answer.key)) throw new Error(`Ambiguity ${answer.key} was answered more than once`);
    seen.add(answer.key);
    const ambiguity = unanswered.get(answer.key);
    if (!ambiguity) throw new Error(`Ambiguity ${answer.key} is not present in this run specification`);
    if (!ambiguity.optionIds.includes(answer.optionId)) throw new Error(`Answer ${answer.optionId} is not valid for ${answer.key}`);
    if (answer.optionId === "custom") {
      const custom = answer.customValue.trim();
      if (custom.length < 2 || custom.length > 240) throw new Error("Custom ambiguity answers must contain 2–240 characters");
      predicates.push(guidedPredicate(
        customAmbiguityAxis(answer.key, custom),
        [custom],
        `The visitor resolved ${answer.key} with custom scope.`,
      ));
    } else if (answer.key === "house_semantics") {
      if (answer.optionId === "house_genre" || answer.optionId === "house_both") {
        intents.push("genre_scene");
        predicates.push(guidedPredicate("genre", ["house music"], "The visitor selected the house-music genre."));
      }
      if (answer.optionId === "house_theme" || answer.optionId === "house_both") {
        intents.push("theme");
        predicates.push(guidedPredicate("theme", ["houses and homes"], "The visitor selected the houses-and-homes theme."));
      }
    } else if (answer.key === "french_jazz_scope") {
      const axis = answer.optionId === "french_language" ? "language" : answer.optionId === "french_scene" ? "scene" : "geography";
      const semanticValue = answer.optionId === "french_language"
        ? "French"
        : answer.optionId === "french_scene"
          ? "French jazz scene"
          : "France";
      pushPredicate(predicates, guidedPredicate(
        axis,
        [semanticValue],
        "The visitor resolved the requested French relationship.",
        answer.optionId === "french_language" ? "language"
          : answer.optionId === "french_scene" ? "label_or_venue_scene"
            : "artist_origin",
      ));
    } else if (answer.key === "geographic_genre_scope") {
      const axis = answer.optionId === "geographic_language"
        ? "language"
        : answer.optionId === "geographic_scene"
          ? "scene"
          : "geography";
      const semanticValue = answer.optionId === "geographic_language"
        ? ambiguity.languageValue
        : answer.optionId === "geographic_scene"
          ? ambiguity.sceneValue
          : ambiguity.originValue;
      if (!semanticValue) throw new Error(`Answer ${answer.optionId} is unavailable for ${answer.key}`);
      pushPredicate(predicates, guidedPredicate(
        axis,
        [semanticValue],
        `The visitor resolved the ${ambiguity.geographicLabel ?? "geographic"} relationship for ${ambiguity.genreLabel ?? "the requested genre"}.`,
        answer.optionId === "geographic_language" ? "language"
          : answer.optionId === "geographic_scene" ? "label_or_venue_scene"
            : "artist_origin",
      ));
    } else if (answer.key === "possessive_relationship") {
      intents.push(answer.optionId === "subject_influenced" ? "editorial_ranking" : "factual_relationship");
      pushPredicate(predicates, guidedPredicate("factual_relationship", [answer.optionId], "The visitor resolved the possessive relationship."));
      if (answer.optionId === "subject_influenced") {
        objectives.push(objective("influence", "maximize", 1, null, "Rank eligible recordings by documented influence."));
      }
    } else if (answer.key === "temporal_width") {
      if (!ambiguity.yearValue) throw new Error("Temporal ambiguity is missing its anchor year");
      const year = ambiguity.yearValue;
      const decadeStart = Math.floor(year / 10) * 10;
      const values = answer.optionId === "era_year_only"
        ? [String(year)]
        : answer.optionId === "era_around_year"
          ? [String(year - 2), String(year + 2)]
          : [String(decadeStart), String(decadeStart + 9)];
      predicates.push(guidedPredicate(
        "era",
        values,
        answer.optionId === "era_year_only"
          ? `The visitor selected the exact release year ${year}.`
          : answer.optionId === "era_around_year"
            ? `The visitor selected a five-year window centered on ${year}.`
            : `The visitor selected the full ${decadeStart}s decade.`,
      ));
    } else {
      intents.push("genre_scene");
      const values = answer.optionId === "both_funk_traditions"
        ? ["funk carioca", "Brazilian soul and funk"]
        : [answer.optionId === "funk_carioca" ? "funk carioca" : "Brazilian soul and funk"];
      predicates.push(guidedPredicate("genre", values, "The visitor resolved the meaning of Brazilian funk."));
    }
    unanswered.delete(answer.key);
  }
  const uniqueIntents = dedupe(intents);
  const semanticClauses = [
    ...predicates.map(semanticClauseFromPredicate),
    ...objectives.map((value) => semanticClauseFromObjective(value, spec.prompt)),
    ...spec.semanticClauses.filter(({ role }) => (
      role === "context" || role === "catalog_policy" || role === "discovery_hint"
    )),
  ].filter((clause, index, all) => all.findIndex((candidate) => (
    candidate.role === clause.role
    && candidate.axis === clause.axis
    && candidate.operator === clause.operator
    && candidate.values.map(normalize).sort().join("|") === clause.values.map(normalize).sort().join("|")
  )) === index);
  const semantic = compileSemanticContractV31({
    rawPrompt: spec.prompt,
    requestedTrackCount: spec.requestedTrackCount,
    predicates,
    objectives,
    semanticClauses,
  });
  if (!semantic.semanticAudit.passed) {
    throw new Error(`Pipeline V3.1 guidance created contradictory hard clauses: ${semantic.semanticAudit.contradictions.join(", ")}`);
  }
  return deepFreeze({
    ...spec,
    intents: uniqueIntents,
    engines: intentEngines(uniqueIntents),
    membershipPredicates: predicates,
    rankingObjectives: objectives,
    criticalAmbiguities: spec.criticalAmbiguities.map((ambiguity) => (
      seen.has(ambiguity.key)
        ? { ...ambiguity, resolution: "answered_successor" as const }
        : ambiguity
    )),
    semanticClauses,
    contextSignals: semanticClauses.filter(({ role }) => role === "context"),
    catalogPolicies: semanticClauses.filter(({ role }) => role === "catalog_policy"),
    ...semantic,
    confirmed: unanswered.size === 0,
    resolvedAmbiguityKeys: [...seen] as CriticalAmbiguityV3["key"][],
  });
}

type StaticCriticalAmbiguityKeyV3 = Exclude<CriticalAmbiguityV3["key"], "geographic_genre_scope">;

const CRITICAL_QUESTION_COPY: Readonly<Record<StaticCriticalAmbiguityKeyV3, {
  header: string;
  question: string;
  whyMaterial: string;
  options: readonly [
    { id: string; label: string; description: string },
    { id: string; label: string; description: string },
    { id: string; label: string; description: string },
  ];
}>> = {
  house_semantics: {
    header: "Meaning",
    question: "What does “house” mean here?",
    whyMaterial: "The answer changes playlist membership, not merely its ordering.",
    options: [
      { id: "house_genre", label: "House music", description: "Use recordings in the electronic dance-music genre." },
      { id: "house_theme", label: "Houses and homes", description: "Use songs whose subject is houses, homes, or domestic space." },
      { id: "house_both", label: "Both", description: "Require house music whose lyrical subject also concerns houses or homes." },
    ],
  },
  french_jazz_scope: {
    header: "French jazz",
    question: "Which French relationship should define the tracks?",
    whyMaterial: "Artist origin, scene participation, and language produce substantially different catalogues.",
    options: [
      { id: "french_artist_origin", label: "French artists", description: "Require principal artists from France." },
      { id: "french_scene", label: "French scene", description: "Include recordings connected to jazz scenes in France." },
      { id: "french_language", label: "French language", description: "Require French-language vocal recordings." },
    ],
  },
  possessive_relationship: {
    header: "Relationship",
    question: "How must the named person relate to each recording?",
    whyMaterial: "Performance, authorship, and influence are different factual claims with different evidence.",
    options: [
      { id: "subject_performed", label: "Performed on it", description: "Require evidence that the subject performed on the exact recording." },
      { id: "subject_created", label: "Wrote or produced it", description: "Require an authorship, composition, arrangement, or production credit." },
      { id: "subject_influenced", label: "Influenced it", description: "Require documented influence rather than a direct recording credit." },
    ],
  },
  brazilian_funk_semantics: {
    header: "Brazilian funk",
    question: "Which Brazilian funk tradition should define the playlist?",
    whyMaterial: "Funk carioca and Brazilian soul/funk have different histories, artists, and recordings.",
    options: [
      { id: "funk_carioca", label: "Funk carioca", description: "Focus on baile funk and its related scenes." },
      { id: "brazilian_soul_funk", label: "Soul and samba-funk", description: "Focus on Brazilian soul, funk, and samba-funk traditions." },
      { id: "both_funk_traditions", label: "Both traditions", description: "Build a cross-tradition survey with evidence for either lineage." },
    ],
  },
  temporal_width: {
    header: "Time span",
    question: "What time span should the year cover?",
    whyMaterial: "One release year, a nearby window, and a full decade produce different eligible catalogues.",
    options: [
      { id: "era_year_only", label: "That year only", description: "Use recordings released in the exact named year." },
      { id: "era_around_year", label: "Around that year", description: "Use a five-year window centered on the named year." },
      { id: "era_full_decade", label: "The full decade", description: "Use the complete decade containing the named year." },
    ],
  },
};

function criticalQuestionGeographyConstraint(
  ambiguity: CriticalAmbiguityV3,
  optionId: string,
): SelectionGeographyConstraint | null {
  if (ambiguity.key === "french_jazz_scope") {
    if (optionId === "french_artist_origin") return { value: "France", relationship: "artist_origin" };
    if (optionId === "french_scene") return { value: "French jazz scene", relationship: "label_or_venue_scene" };
    if (optionId === "french_language") return { value: "French", relationship: "language" };
  }
  if (ambiguity.key === "geographic_genre_scope") {
    if (optionId === "geographic_artist_origin" && ambiguity.originValue) {
      return { value: ambiguity.originValue, relationship: "artist_origin" };
    }
    if (optionId === "geographic_scene" && ambiguity.sceneValue) {
      return { value: ambiguity.sceneValue, relationship: "label_or_venue_scene" };
    }
    if (optionId === "geographic_language" && ambiguity.languageValue) {
      return { value: ambiguity.languageValue, relationship: "language" };
    }
  }
  return null;
}

/** Critical questions are server-owned and survive scout/provider failure. */
export function criticalGuidanceQuestionsV3(spec: RunSpecV3): PlaylistGuidanceQuestion[] {
  return spec.criticalAmbiguities.slice(0, 3).map((ambiguity) => {
    const copy = ambiguity.key === "temporal_width" && ambiguity.yearValue
      ? {
          header: "Time span",
          question: `What time span should “${ambiguity.yearValue}” cover?`,
          whyMaterial: "One release year, a nearby window, and a full decade produce different eligible catalogues.",
          options: [
            {
              id: "era_year_only",
              label: `${ambiguity.yearValue} only`,
              description: `Use recordings released in ${ambiguity.yearValue}.`,
            },
            {
              id: "era_around_year",
              label: `Around ${ambiguity.yearValue}`,
              description: `Use ${ambiguity.yearValue - 2}–${ambiguity.yearValue + 2}.`,
            },
            {
              id: "era_full_decade",
              label: `The ${Math.floor(ambiguity.yearValue / 10) * 10}s`,
              description: `Use ${Math.floor(ambiguity.yearValue / 10) * 10}–${Math.floor(ambiguity.yearValue / 10) * 10 + 9}.`,
            },
          ] as const,
        }
      : ambiguity.key === "geographic_genre_scope"
      ? {
          header: `${ambiguity.geographicLabel ?? "Geographic"} ${ambiguity.genreLabel ?? "music"}`,
          question: `Which ${ambiguity.geographicLabel ?? "geographic"} relationship should define the tracks?`,
          whyMaterial: "Artist origin, scene participation, and language produce substantially different catalogues.",
          options: [
            {
              id: "geographic_artist_origin",
              label: `${ambiguity.geographicLabel ?? "Local"} artists`,
              description: `Require principal artists from ${ambiguity.originValue ?? "the named place"}.`,
            },
            {
              id: "geographic_scene",
              label: `${ambiguity.geographicLabel ?? "Local"} scene`,
              description: `Include recordings connected to the ${ambiguity.sceneValue ?? "named music scene"}.`,
            },
            {
              id: "geographic_language",
              label: `${ambiguity.languageValue ?? "Local"} language`,
              description: `Require ${ambiguity.languageValue ?? "the relevant local language"}-language vocal recordings.`,
            },
          ] as const,
        }
      : CRITICAL_QUESTION_COPY[ambiguity.key];
    return {
      id: `v3-critical:${ambiguity.key}`,
      header: copy.header,
      question: copy.question,
      decisionKey: ambiguity.key,
      whyMaterial: copy.whyMaterial,
      options: copy.options.map((option, index) => {
        const geographyConstraint = criticalQuestionGeographyConstraint(ambiguity, option.id);
        return {
          ...option,
          recommended: ambiguity.key === "temporal_width" ? false : index === 0,
          effect: {
            kind: "research_preference" as const,
            value: ambiguity.key === "temporal_width" && ambiguity.yearValue
              ? option.id === "era_year_only"
                ? String(ambiguity.yearValue)
                : option.id === "era_around_year"
                  ? `${ambiguity.yearValue - 2}-${ambiguity.yearValue + 2}`
                  : `${Math.floor(ambiguity.yearValue / 10) * 10}-${Math.floor(ambiguity.yearValue / 10) * 10 + 9}`
              : option.id,
            orderingBehavior: null,
            ...(geographyConstraint ? { geographyConstraint } : {}),
          },
        };
      }),
    };
  });
}

/**
 * Server-owned subject fallbacks keep broad contract-2 requests from silently
 * skipping guidance when the bounded scout returns no usable questions. These
 * are optional preference forks: they change discovery/ranking, never the
 * immutable membership scope or requested count.
 */
export function deterministicGuidanceQuestionsV3(spec: RunSpecV3): PlaylistGuidanceQuestion[] {
  const prompt = normalize(spec.prompt);
  if (!/\bbrazil(?:ian)?\s+disco\b/u.test(prompt)) return [];
  return [{
    id: "v3-fallback:brazilian_disco_focus",
    header: "Brazilian disco",
    question: "Which side of Brazilian disco should lead the playlist?",
    decisionKey: "brazilian_disco_focus",
    whyMaterial: "The choice changes which recordings are discovered and how familiar staples are balanced against boogie and disco-funk cuts.",
    groundingMode: "inference",
    options: [
      {
        id: "brazilian_disco_staples",
        label: "Dance-floor staples",
        description: "Lead with canonical, widely recognized Brazilian disco recordings.",
        recommended: true,
        effect: {
          kind: "familiarity_bias",
          value: "Brazilian disco dance-floor staples",
          orderingBehavior: null,
        },
      },
      {
        id: "brazilian_disco_boogie",
        label: "Boogie and funk",
        description: "Emphasize Brazilian boogie and disco-funk crossover recordings.",
        recommended: false,
        effect: {
          kind: "subscene_focus",
          value: "Brazilian boogie and disco-funk crossovers",
          orderingBehavior: null,
        },
      },
      {
        id: "brazilian_disco_balanced",
        label: "Balanced survey",
        description: "Balance staples, deeper cuts, and adjacent disco-funk across the scene.",
        recommended: false,
        effect: {
          kind: "research_preference",
          value: "balanced Brazilian disco survey with staples, deeper cuts, and disco-funk breadth",
          orderingBehavior: null,
        },
      },
    ],
  }];
}

/** Convert only server-owned critical-question answers into typed V3 scope. */
export function criticalAmbiguityAnswersFromGuidanceV3(
  spec: RunSpecV3,
  answers: readonly PlaylistGuidanceAnswer[],
): CriticalAmbiguityAnswerV3[] {
  const required = new Set(spec.criticalAmbiguities.map(({ key }) => key));
  return answers.flatMap((answer): CriticalAmbiguityAnswerV3[] => {
    if (!answer.questionId.startsWith("v3-critical:")) return [];
    const key = answer.questionId.slice("v3-critical:".length) as CriticalAmbiguityV3["key"];
    if (!required.has(key)) return [];
    if (answer.customText) return [{ key, optionId: "custom", customValue: answer.customText }];
    if (!answer.optionId) return [];
    return [{ key, optionId: answer.optionId } as CriticalAmbiguityAnswerV3];
  });
}

/** Recursively freeze a small planning value so resumed jobs cannot mutate it. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Stable identity for a confirmed selection contract and its revisions. */
export function selectionPlanV3Hash(plan: SelectionPlanV3): string {
  return createHash("sha256").update(stableStringify(plan)).digest("hex");
}
