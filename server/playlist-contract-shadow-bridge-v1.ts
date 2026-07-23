import type {
  PlaylistBrief,
  SelectionConstraint,
  SelectionConstraintAxis,
  SelectionPlan,
} from "../shared/types.ts";
import {
  compilePlaylistContractRevisionV1,
  type PlaylistContractClauseDraftV1,
  type PlaylistContractDraftV1,
  type PlaylistContractRevisionV1,
  type PlaylistPredicateV1,
} from "./playlist-contract-v1.ts";
import {
  resolveMusicConceptV1,
  type MusicConceptKindV1,
  type MusicConceptResolutionStatusV1,
} from "./music-concept-registry-v1.ts";
import {
  SHADOW_PLAYLIST_EVIDENCE_POLICY_VERSION,
} from "./playlist-evidence-policy-v1.ts";

export const PLAYLIST_CONTRACT_SHADOW_BRIDGE_VERSION = "selection_plan_shadow_bridge_v1" as const;
export const PLAYLIST_CONTRACT_SHADOW_EVIDENCE_POLICY_VERSION =
  SHADOW_PLAYLIST_EVIDENCE_POLICY_VERSION;

export interface PlaylistContractShadowBridgeInputV1 {
  readonly contractId: string;
  readonly prompt: string;
  readonly brief: PlaylistBrief;
  readonly selectionPlan: SelectionPlan;
  readonly locale?: string;
}

export interface PlaylistContractShadowConceptDiagnosticV1 {
  readonly clauseId: string;
  readonly value: string;
  readonly status: MusicConceptResolutionStatusV1;
  readonly selectedConceptId: string | null;
}

export interface PlaylistContractShadowBridgeDraftV1 {
  readonly draft: PlaylistContractDraftV1;
  /**
   * The executable hard predicate with every unresolved semantic scope
   * removed. Guidance patches compose their chosen scope with this predicate,
   * so catalog, content, version, geography, era, and explicit exclusions are
   * never discarded when one ambiguous axis is answered.
   */
  readonly preservedTrackPredicate: PlaylistPredicateV1;
  /**
   * Clauses which retain the visitor's wording for audit/discovery but are not
   * eligible to gate tracks until a server-owned guidance patch resolves them.
   */
  readonly ambiguousScopeClauseIds: readonly string[];
  readonly softenedHardConstraintIds: readonly string[];
  readonly conceptDiagnostics: readonly PlaylistContractShadowConceptDiagnosticV1[];
}

export interface PlaylistContractShadowBridgeResultV1
  extends Omit<PlaylistContractShadowBridgeDraftV1, "draft"> {
  readonly contract: PlaylistContractRevisionV1;
}

const MUSIC_SCOPE_AXES = new Set<SelectionConstraintAxis>([
  "genre",
  "scene",
  "subgenre",
]);

const CENTRAL_SUITABILITY_AXES = new Set<SelectionConstraintAxis>([
  "mood",
  "activity",
  "theme",
]);

const POLICY_OWNED_AXES = new Set<SelectionConstraintAxis>([
  "recording_version",
  "content",
  "evidence",
]);

const SMOOTH_REGGAETON_SUITABILITY_TERMS: ReadonlyArray<{
  value: string;
  pattern: RegExp;
}> = [
  { value: "smooth", pattern: /\bsmooth(?:ness)?\b/iu },
  { value: "polished", pattern: /\bpolish(?:ed)?\b/iu },
  { value: "sensual", pattern: /\bsensual(?:ity)?\b/iu },
  { value: "danceable", pattern: /\bdanceab(?:le|ility)\b/iu },
  { value: "flirtatious", pattern: /\bflirtatious\b/iu },
  { value: "crowd-pleasing", pattern: /\bcrowd[- ]pleas(?:ing|er)|\bcrowd appeal\b/iu },
] as const;

function normalized(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const clean = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
    const key = normalized(clean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

function safeId(value: string): string {
  const clean = value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^A-Za-z0-9:._/-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return clean || "clause";
}

function promptSource(
  prompt: string,
  text: string,
): PlaylistContractClauseDraftV1["source"] {
  const clean = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const index = prompt.toLocaleLowerCase("en-US").indexOf(clean.toLocaleLowerCase("en-US"));
  if (index >= 0) {
    return {
      provenance: "prompt",
      text: clean,
      spans: [{ start: index, end: index + clean.length }],
    };
  }
  return {
    provenance: "migration",
    text: clean,
  };
}

function expectedConceptKind(axis: SelectionConstraintAxis): MusicConceptKindV1 | null {
  if (axis === "genre" || axis === "subgenre") return "genre";
  if (axis === "scene") return "scene";
  if (axis === "mood") return "mood";
  if (axis === "activity") return "activity";
  if (axis === "theme") return "theme";
  if (axis === "artist") return "artist";
  if (axis === "geography") return "geography";
  if (axis === "language") return "language";
  return null;
}

function conceptResolutionFor(
  axis: SelectionConstraintAxis,
  values: readonly string[],
): Array<{
  value: string;
  status: MusicConceptResolutionStatusV1;
  selectedConceptId: string | null;
}> {
  const expectedKind = expectedConceptKind(axis);
  if (!expectedKind) return [];
  return values.map((value) => {
    const resolved = resolveMusicConceptV1({ text: value, expectedKind });
    return {
      value,
      status: resolved.status,
      selectedConceptId: resolved.selectedConceptId,
    };
  });
}

function conceptInputsFor(
  axis: SelectionConstraintAxis,
  values: readonly string[],
  includeNonResolved = false,
): PlaylistContractClauseDraftV1["conceptInputs"] {
  const expectedKind = expectedConceptKind(axis);
  if (!expectedKind) return [];
  return values.flatMap((value) => {
    const resolved = resolveMusicConceptV1({ text: value, expectedKind });
    if (resolved.status === "resolved" && resolved.selectedConceptId) {
      return [{
          text: value,
          expectedKind,
          selectedConceptId: resolved.selectedConceptId,
        }];
    }
    return includeNonResolved ? [{ text: value, expectedKind }] : [];
  });
}

function predicateFor(clauseIds: readonly string[]): PlaylistPredicateV1 {
  if (clauseIds.length === 1) return { op: "clause", clauseId: clauseIds[0]! };
  return {
    op: "all",
    children: clauseIds.map((clauseId) => ({ op: "clause", clauseId })),
  };
}

function isNegativeConstraint(constraint: SelectionConstraint): boolean {
  return constraint.operator === "exclude" || constraint.operator === "avoid";
}

function isAdjacentLatinUrbanScope(
  prompt: string,
  constraint: SelectionConstraint,
): boolean {
  if (constraint.axis !== "genre" && constraint.axis !== "scene" && constraint.axis !== "subgenre") {
    return false;
  }
  if (!/\badjacent\s+latin[- ]urban\b/iu.test(prompt)) return false;
  const values = constraint.values.map(normalized);
  return values.includes("reggaeton") && values.includes("latin urban");
}

function hardClauseKind(
  constraint: SelectionConstraint,
): PlaylistContractClauseDraftV1["kind"] {
  if (isNegativeConstraint(constraint)) return "exclusion";
  if (MUSIC_SCOPE_AXES.has(constraint.axis)) return "membership";
  if (constraint.axis === "recording_version" || constraint.axis === "content") {
    return "catalog_version";
  }
  return "factual_relationship";
}

function hardClauseOperator(
  constraint: SelectionConstraint,
): PlaylistContractClauseDraftV1["operator"] {
  if (isNegativeConstraint(constraint)) return "exclude";
  return "require";
}

function sequencingDirection(
  mode: SelectionPlan["orderingPolicy"]["mode"],
): "ascending" | "smooth" | "contrast" | "editorial" {
  if (mode === "chronological" || mode === "source_order") return "ascending";
  if (mode === "smooth") return "smooth";
  if (mode === "contrast") return "contrast";
  return "editorial";
}

function addSuitabilityClause(input: {
  clauses: PlaylistContractClauseDraftV1[];
  centralSuitabilityClauseIds: string[];
  seenSuitability: Set<string>;
  prompt: string;
  idSeed: string;
  value: string;
  sourceText?: string;
}): void {
  const key = normalized(input.value);
  if (!key || input.seenSuitability.has(key)) return;
  input.seenSuitability.add(key);
  const id = `bridge:suitability:${safeId(input.idSeed)}`;
  input.clauses.push({
    id,
    kind: "suitability",
    scope: "track",
    hardness: "soft",
    axis: "central_suitability",
    operator: "prefer",
    values: [input.value],
    source: promptSource(input.prompt, input.sourceText ?? input.value),
  });
  input.centralSuitabilityClauseIds.push(id);
}

function versionPolicyValues(plan: SelectionPlan): string[] {
  return [
    ...plan.versionPolicy.allowed.map((version) => `allow:${version}`),
    ...plan.versionPolicy.preferred.map((version) => `prefer:${version}`),
    plan.versionPolicy.excludeCompilations ? "exclude:compilations" : "allow:compilations",
    plan.versionPolicy.excludeKaraokeAndTributes
      ? "exclude:karaoke-and-tributes"
      : "allow:karaoke-and-tributes",
  ];
}

function contentPolicyValues(plan: SelectionPlan): string[] {
  return [
    `explicit-content:${plan.contentPolicy.explicitContent}`,
    `instrumental:${plan.contentPolicy.instrumental}`,
    ...plan.contentPolicy.languages.map((language) => `language:${language}`),
  ];
}

/**
 * Produces a canonical-contract draft from the already-confirmed V2 execution
 * inputs. This is intentionally a projection, not a second interpretation of
 * the raw prompt: typed SelectionPlan constraints remain authoritative.
 */
export function buildPlaylistContractShadowDraftV1(
  input: PlaylistContractShadowBridgeInputV1,
): PlaylistContractShadowBridgeDraftV1 {
  const clauses: PlaylistContractClauseDraftV1[] = [];
  const hardTrackClauseIds: string[] = [];
  const ambiguousScopeClauseIds: string[] = [];
  const softenedHardConstraintIds: string[] = [];
  const conceptDiagnostics: PlaylistContractShadowConceptDiagnosticV1[] = [];
  const centralSuitabilityClauseIds: string[] = [];
  const seenSuitability = new Set<string>();
  const usedClauseIds = new Set<string>();

  const addClause = (clause: PlaylistContractClauseDraftV1): void => {
    if (usedClauseIds.has(clause.id)) throw new Error(`duplicate_bridge_clause:${clause.id}`);
    usedClauseIds.add(clause.id);
    clauses.push(clause);
  };

  const storefrontClauseId = "bridge:catalog:storefront-availability";
  addClause({
    id: storefrontClauseId,
    kind: "catalog_version",
    scope: "track",
    hardness: "hard",
    axis: "storefront_availability",
    operator: "require",
    values: [`available:${input.selectionPlan.storefront.toLocaleLowerCase("en-US")}`],
    source: {
      provenance: "system_default",
      text: `Available in the ${input.selectionPlan.storefront.toLocaleUpperCase("en-US")} storefront`,
    },
    evidence: {
      required: true,
      minimumGrade: "authoritative_structured_metadata",
      permittedGrades: ["authoritative_structured_metadata"],
    },
    unknownPolicy: "reject",
  });
  hardTrackClauseIds.push(storefrontClauseId);

  const versionClauseId = "bridge:catalog:recording-version-policy";
  addClause({
    id: versionClauseId,
    kind: "catalog_version",
    scope: "track",
    hardness: "hard",
    axis: "recording_version",
    operator: "require",
    values: versionPolicyValues(input.selectionPlan),
    source: {
      provenance: "migration",
      text: input.brief.versionPolicy || "Confirmed recording-version policy",
    },
    evidence: {
      required: true,
      minimumGrade: "authoritative_structured_metadata",
      permittedGrades: ["authoritative_structured_metadata"],
    },
    unknownPolicy: "reject",
  });
  hardTrackClauseIds.push(versionClauseId);

  const evidenceClauseId = "bridge:evidence:qualification-policy";
  addClause({
    id: evidenceClauseId,
    kind: "factual_relationship",
    scope: "track",
    hardness: "hard",
    axis: "evidence",
    operator: "require",
    values: [input.selectionPlan.evidencePolicy],
    source: {
      provenance: "migration",
      text: input.selectionPlan.evidencePolicy,
    },
    evidence: {
      required: true,
      // This bridge accepts several intentionally incomparable selection-grade
      // evidence routes. The allowlist controls entailment; no false global
      // ordering is imposed across those routes.
      minimumGrade: null,
      permittedGrades: [
        "authoritative_structured_metadata",
        "trusted_scoped_container",
        "track_specific_editorial_assertion",
        "primary_source",
        "independent_secondary_source",
      ],
    },
    unknownPolicy: "defer",
  });
  hardTrackClauseIds.push(evidenceClauseId);

  const contentRequiresGate = input.selectionPlan.contentPolicy.explicitContent === "clean_only"
    || input.selectionPlan.contentPolicy.instrumental === "exclude"
    || input.selectionPlan.contentPolicy.languages.length > 0;
  const contentClauseId = "bridge:catalog:content-policy";
  if (contentRequiresGate) {
    addClause({
      id: contentClauseId,
      kind: "catalog_version",
      scope: "track",
      hardness: "hard",
      axis: "content",
      operator: "require",
      values: contentPolicyValues(input.selectionPlan),
      source: {
        provenance: "migration",
        text: unique([
          ...input.brief.include,
          ...input.brief.exclude,
          input.brief.versionPolicy,
        ]).join("; ") || "Confirmed content policy",
      },
      evidence: {
        required: true,
        minimumGrade: "authoritative_structured_metadata",
        permittedGrades: ["authoritative_structured_metadata"],
      },
      unknownPolicy: "reject",
    });
    hardTrackClauseIds.push(contentClauseId);
  } else if (input.selectionPlan.contentPolicy.explicitContent === "prefer_clean"
    || input.selectionPlan.contentPolicy.instrumental === "prefer") {
    addClause({
      id: contentClauseId,
      kind: "ranking_preference",
      scope: "track",
      hardness: "soft",
      axis: "content",
      operator: "prefer",
      values: contentPolicyValues(input.selectionPlan),
      source: {
        provenance: "migration",
        text: "Confirmed content preference",
      },
    });
  }

  for (const [constraintIndex, constraint] of input.selectionPlan.constraints.entries()) {
    if (POLICY_OWNED_AXES.has(constraint.axis)) continue;
    const values = unique(constraint.values);
    if (values.length === 0) continue;
    const clauseId = `bridge:constraint:${safeId(constraint.id)}:${constraintIndex + 1}`;
    const resolutions = conceptResolutionFor(constraint.axis, values);
    for (const resolution of resolutions) {
      conceptDiagnostics.push({
        clauseId,
        value: resolution.value,
        status: resolution.status,
        selectedConceptId: resolution.selectedConceptId,
      });
    }

    if (constraint.operator === "maximum") {
      addClause({
        id: clauseId,
        kind: "quota_diversity",
        scope: "playlist",
        hardness: constraint.kind,
        axis: constraint.axis,
        operator: "limit",
        values,
        source: promptSource(input.prompt, values.join(" ")),
      });
      continue;
    }

    if (CENTRAL_SUITABILITY_AXES.has(constraint.axis)) {
      for (const [valueIndex, value] of values.entries()) {
        addSuitabilityClause({
          clauses,
          centralSuitabilityClauseIds,
          seenSuitability,
          prompt: input.prompt,
          idSeed: `${constraint.id}-${valueIndex + 1}`,
          value,
        });
      }
      if (constraint.kind === "hard") softenedHardConstraintIds.push(constraint.id);
      continue;
    }

    const semanticAmbiguity = resolutions.some((resolution) => (
      resolution.status === "ambiguous"
      || resolution.status === "discovery_only"
      || (resolution.status === "unresolved" && MUSIC_SCOPE_AXES.has(constraint.axis))
    ));
    const adjacentLatinUrbanAmbiguity = constraint.kind === "hard"
      && isAdjacentLatinUrbanScope(input.prompt, constraint);
    if (constraint.kind === "hard" && (semanticAmbiguity || adjacentLatinUrbanAmbiguity)) {
      addClause({
        id: clauseId,
        kind: isNegativeConstraint(constraint) ? "exclusion" : "membership",
        scope: "track",
        hardness: "soft",
        axis: constraint.axis,
        operator: isNegativeConstraint(constraint) ? "exclude" : "allow",
        values,
        conceptInputs: conceptInputsFor(constraint.axis, values, true),
        source: adjacentLatinUrbanAmbiguity
          ? promptSource(input.prompt, "adjacent Latin urban")
          : promptSource(input.prompt, values.join(" ")),
        unknownPolicy: "defer",
      });
      ambiguousScopeClauseIds.push(clauseId);
      softenedHardConstraintIds.push(constraint.id);
      continue;
    }

    if (constraint.kind === "hard") {
      addClause({
        id: clauseId,
        kind: hardClauseKind(constraint),
        scope: "track",
        hardness: "hard",
        axis: constraint.axis,
        operator: hardClauseOperator(constraint),
        values,
        conceptInputs: conceptInputsFor(constraint.axis, values),
        source: promptSource(input.prompt, values.join(" ")),
        unknownPolicy: isNegativeConstraint(constraint)
          && ["artist", "album", "track", "content", "recording_version"].includes(constraint.axis)
          ? "reject"
          : "defer",
      });
      hardTrackClauseIds.push(clauseId);
      continue;
    }

    addClause({
      id: clauseId,
      kind: "ranking_preference",
      scope: "track",
      hardness: "soft",
      axis: constraint.axis,
      operator: "prefer",
      values: constraint.operator === "avoid"
        ? values.map((value) => `avoid:${value}`)
        : values,
      conceptInputs: conceptInputsFor(constraint.axis, values, true),
      source: promptSource(input.prompt, values.join(" ")),
    });
  }

  for (const term of SMOOTH_REGGAETON_SUITABILITY_TERMS) {
    const match = term.pattern.exec(input.prompt);
    if (!match) continue;
    addSuitabilityClause({
      clauses,
      centralSuitabilityClauseIds,
      seenSuitability,
      prompt: input.prompt,
      idSeed: term.value,
      value: term.value,
      sourceText: match[0],
    });
  }

  const orderingClauseId = "bridge:playlist:sequencing";
  addClause({
    id: orderingClauseId,
    kind: "ranking_preference",
    scope: "playlist",
    hardness: "soft",
    axis: "sequencing",
    operator: "prefer",
    values: unique([
      input.selectionPlan.orderingPolicy.mode,
      ...input.selectionPlan.orderingPolicy.goals,
      input.selectionPlan.orderingPolicy.avoidAdjacentSameArtist
        ? "avoid adjacent same artist"
        : "",
      input.selectionPlan.orderingPolicy.avoidAdjacentSameAlbum
        ? "avoid adjacent same album"
        : "",
    ]),
    source: {
      provenance: "migration",
      text: input.brief.orderingPolicy || "Confirmed sequencing policy",
    },
  });

  const diversityEntries: ReadonlyArray<[string, number | null]> = [
    ["minimum-distinct-artists", input.selectionPlan.diversityGoals.minimumDistinctArtists],
    ["minimum-distinct-albums", input.selectionPlan.diversityGoals.minimumDistinctAlbums],
    ["minimum-distinct-eras", input.selectionPlan.diversityGoals.minimumDistinctEras],
    ["minimum-distinct-scenes", input.selectionPlan.diversityGoals.minimumDistinctScenes],
    ["minimum-distinct-geographies", input.selectionPlan.diversityGoals.minimumDistinctGeographies],
    ["maximum-tracks-per-artist", input.selectionPlan.diversityGoals.maximumTracksPerArtist],
    ["maximum-tracks-per-album", input.selectionPlan.diversityGoals.maximumTracksPerAlbum],
  ];
  for (const [dimension, value] of diversityEntries) {
    if (value === null) continue;
    addClause({
      id: `bridge:playlist:diversity:${dimension}`,
      kind: "quota_diversity",
      scope: "playlist",
      hardness: "soft",
      axis: dimension,
      operator: dimension.startsWith("maximum") ? "limit" : "balance",
      values: [String(value)],
      source: {
        provenance: "migration",
        text: `${dimension.replace(/-/gu, " ")}: ${value}`,
      },
    });
  }

  const preservedTrackPredicate = predicateFor(hardTrackClauseIds);
  return {
    draft: {
      contractId: input.contractId,
      rawPrompt: input.prompt,
      requestedTrackCount: input.selectionPlan.requestedTrackCount,
      locale: input.locale ?? "en-US",
      storefront: input.selectionPlan.storefront,
      versions: {
        compiler: PLAYLIST_CONTRACT_SHADOW_BRIDGE_VERSION,
        evidencePolicy: PLAYLIST_CONTRACT_SHADOW_EVIDENCE_POLICY_VERSION,
      },
      clauses,
      trackPredicate: preservedTrackPredicate,
      playlistConstraints: [],
      sequencingObjectives: [{
        id: "bridge:sequence:primary",
        clauseId: orderingClauseId,
        dimension: "playlist_flow",
        direction: sequencingDirection(input.selectionPlan.orderingPolicy.mode),
        weight: 1,
        priority: 1,
      }],
      qualityPolicy: {
        centralSuitabilityClauseIds,
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
      },
    },
    preservedTrackPredicate,
    ambiguousScopeClauseIds,
    softenedHardConstraintIds,
    conceptDiagnostics,
  };
}

export function compilePlaylistContractShadowV1(
  input: PlaylistContractShadowBridgeInputV1,
): PlaylistContractShadowBridgeResultV1 {
  const built = buildPlaylistContractShadowDraftV1(input);
  return {
    contract: compilePlaylistContractRevisionV1(built.draft),
    preservedTrackPredicate: built.preservedTrackPredicate,
    ambiguousScopeClauseIds: built.ambiguousScopeClauseIds,
    softenedHardConstraintIds: built.softenedHardConstraintIds,
    conceptDiagnostics: built.conceptDiagnostics,
  };
}
