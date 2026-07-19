import { createHash } from "node:crypto";
import type {
  PlaylistBrief,
  ResearchIntent,
  SelectionConstraint,
  SelectionConstraintAxis,
  SelectionGeographyConstraint,
  SelectionGeographyRelationship,
  SelectionPlan,
  SelectionScopeKind,
  SelectionVersionPolicy,
} from "../shared/types.ts";
import type { PlaylistGuidancePreference } from "./guidance-context.ts";
import { assertsFactualTrackRelationship } from "./factual-frontier-policy.ts";
import {
  parseSelectionGeographyConstraints,
  selectionConstraintGeography,
  uniqueGeographyConstraints,
} from "./selection-geography-policy.ts";

export const PIPELINE_V2_SELECTION_PLAN_VERSION = "relevance_first_2026_07" as const;

const EXHAUSTIVE_INTENT = /\b(?:every|all|complete|entire|exhaustive)\b.{0,100}\b(?:songs?|tracks?|recordings?|releases?|credits?|discograph(?:y|ies)|catalog(?:ue)?)\b/iu;
const SIMILARITY_INTENT = /\b(?:sounds?\s+like|songs?\s+like|tracks?\s+like|similar\s+to|resembl|adjacent\s+to|in\s+the\s+(?:style|vein)\s+of|for\s+fans\s+of|artists?\s+like)\b/iu;
const MOOD_ACTIVITY_INTENT = /\b(?:mood|vibe|sleep|study|studying|workout|running|road\s+trip|dinner|party|focus(?:\s+(?:music|playlist|session))|relax|meditat|sunset|churrasco)\b/iu;
const EDITORIAL_INTENT = /\b(?:best|essential|influential|important|definitive|iconic|foundational|representative|history\s+of|shaped)\b/iu;
const ARTIST_CATALOGUE_INTENT = /\b(?:discograph|catalog(?:ue)?|songs?\s+by|tracks?\s+by|recordings?\s+by|artist\s+catalog)\b/iu;
const GENRE_SCENE_INTENT = /\b(?:genre|subgenre|scene|music|jazz|techno|house|drill|funk|ambient|footwork|hip[ -]?hop|rock|samba|bossa|disco|soul|metal|punk|reggae|classical|country|electronic)\b/iu;
const THEME_INTENT = /\b(?:songs?\s+about|tracks?\s+about|lyrics?\s+about|theme|themed)\b/iu;

const VERSION_MARKERS: Array<[RegExp, SelectionVersionPolicy["allowed"][number]]> = [
  [/\b(?:canonical|original(?:[-\s]+era)?(?:\s+(?:studio|album|single))?\s+(?:recording|version)s?(?!\s+identity)|studio\s+(?:recording|version)s?)\b/iu, "canonical"],
  [/\bremaster(?:ed|s)?\b/iu, "remaster"],
  [/\blive\b/iu, "live"],
  [/\bremix(?:es)?\b/iu, "remix"],
  [/\b(?:(?:radio|single)\s+)?edits?\b/iu, "radio_edit"],
  [/\bextended\b/iu, "extended"],
  [/\balternate\b/iu, "alternate"],
  [/\bacoustic\b/iu, "acoustic"],
  [/\binstrumental\b/iu, "instrumental"],
  [/\bkaraoke\b/iu, "karaoke"],
  [/\b(?:cover|tribute)\b/iu, "cover"],
  [/\bclean\b/iu, "clean"],
  [/\bexplicit\b/iu, "explicit"],
];

type VersionMarkerDisposition = "include" | "exclude";

const VERSION_EXCLUSION_CUE = /\b(?:exclude|excluding|avoid|avoiding|without|no|not|never|omit|omitting|skip|skipping|do\s+not|don['’]?t)\b/giu;
const VERSION_INCLUSION_CUE = /\b(?:include|including|allow|allowing|prefer|preferring|preferred|only|must|require|required|all|every)\b/giu;
const VERSION_NEGATED_INCLUSION = /\b(?:avoid(?:ing)?|do\s+not|don['’]?t|never|not|without)\s+(?:include|including|allow|allowing|prefer|preferring|require|requiring)\b[^.;\n]*$/iu;
const VERSION_NEGATED_EXCLUSION = /\b(?:do\s+not|don['’]?t|never|not)\s+(?:exclude|excluding|avoid|avoiding|omit|omitting|skip|skipping)\b[^.;\n]*$/iu;
const VERSION_TRAILING_EXCLUSION = /\b(?:excluded|avoided|omitted|skipped|not\s+allowed|not\s+included)\b/iu;
const VERSION_TRAILING_INCLUSION = /\b(?:preferred|required|allowed|included|only)\b/iu;

function lastRegexIndex(value: string, pattern: RegExp): number {
  let index = -1;
  for (const match of value.matchAll(pattern)) index = match.index;
  return index;
}

/**
 * Version-policy prose frequently names unwanted versions while excluding
 * them (for example, "avoid later remixes and live versions"). A marker is a
 * preference only when it is bare or governed by an inclusion cue. Split on
 * sentence, adversative, and `unless` boundaries so mixed policies such as
 * "include live versions but exclude remixes" retain both decisions
 * independently, and an exclusion cue cannot leak through "unless" to reject
 * the canonical recording named by the exception.
 */
function versionMarkerDisposition(scope: string, marker: RegExp): VersionMarkerDisposition | null {
  const clauses = scope.split(/(?:[.;\n]+|\bbut\b|\bwhile\b|\bwhereas\b|\bunless\b)/iu);
  let disposition: VersionMarkerDisposition | null = null;
  for (const clause of clauses) {
    const matcher = new RegExp(marker.source, marker.flags.includes("g") ? marker.flags : `${marker.flags}g`);
    for (const match of clause.matchAll(matcher)) {
      const markerIndex = match.index;
      const before = clause.slice(0, markerIndex);
      const after = clause.slice(markerIndex + match[0].length);
      const exclusionIndex = lastRegexIndex(before, VERSION_EXCLUSION_CUE);
      const inclusionIndex = lastRegexIndex(before, VERSION_INCLUSION_CUE);
      if (VERSION_NEGATED_INCLUSION.test(before)) {
        disposition = "exclude";
      } else if (VERSION_NEGATED_EXCLUSION.test(before)) {
        disposition = "include";
      } else if (exclusionIndex >= 0 || inclusionIndex >= 0) {
        disposition = exclusionIndex > inclusionIndex ? "exclude" : "include";
      } else if (VERSION_TRAILING_EXCLUSION.test(after)) {
        disposition = "exclude";
      } else if (VERSION_TRAILING_INCLUSION.test(after)) {
        disposition = "include";
      } else {
        // A bare version name in the dedicated version-policy field is an
        // explicit request. Negative mentions are handled by the cue paths.
        disposition = "include";
      }
    }
  }
  return disposition;
}

function versionMarkerIsExclusive(scope: string, marker: RegExp): boolean {
  const clauses = scope.split(/(?:[.;\n]+|\bbut\b|\bwhile\b|\bwhereas\b|\bunless\b)/iu);
  return clauses.some((clause) => {
    const matcher = new RegExp(marker.source, marker.flags.includes("g") ? marker.flags : `${marker.flags}g`);
    return [...clause.matchAll(matcher)].some((match) => {
      const markerIndex = match.index;
      const before = clause.slice(0, markerIndex);
      const after = clause.slice(markerIndex + match[0].length);
      if (VERSION_NEGATED_INCLUSION.test(before) || VERSION_NEGATED_EXCLUSION.test(before)) return false;
      // "Only if/when/as needed" constrains whether this particular version
      // may be used; it does not mean that every other recording class is
      // forbidden. Treating that conditional `only` as a global whitelist is
      // what reduced the production policy to `allowed: ["remaster"]`.
      const conditionalOnly = /\bonly\s+(?:if|when|where|while|provided|as\s+(?:needed|required|necessary))\b/iu;
      if (conditionalOnly.test(before)
        || /^\s*(?:(?:versions?\s+)?only\s+)?(?:if|when|where|while|provided|as\s+(?:needed|required|necessary))\b/iu.test(after)) {
        return false;
      }
      return /\b(?:only|must|require|required)\b/iu.test(before)
        || /^\s*(?:versions?\s+)?only\b/iu.test(after);
    });
  });
}

function canonicalRecordingIsUnavailable(scope: string): boolean {
  return /\bno\s+(?:(?:compatible|playable|usable|available)\s+)?canonical(?:\s+(?:recording|version))?\b/iu.test(scope)
    || /\bcanonical(?:\s+(?:recording|version))?[^.;\n]{0,48}\b(?:is\s+)?(?:unavailable|not\s+available|missing)\b/iu.test(scope);
}

/**
 * A remaster named behind an availability condition is a fallback, not the
 * preferred recording class. In particular, the `no` in "only if no
 * canonical version is available" describes catalog availability; it must
 * not be interpreted as a request to exclude canonical recordings.
 */
function hasConditionalRemasterFallback(scope: string): boolean {
  return scope.split(/[.;\n]+/u).some((clause) => {
    const remaster = /\bremaster(?:ed|s)?\b/iu.exec(clause);
    if (!remaster) return false;
    const after = clause.slice(remaster.index + remaster[0].length);
    const condition = /\b(?:unless|only\s+(?:if|when))\b/iu.exec(after);
    return condition !== null
      && canonicalRecordingIsUnavailable(after.slice(condition.index + condition[0].length));
  });
}

function normalized(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

const EXPLICIT_EXCLUSION_CUE = /\b(?:exclude|avoid|without|no|not|never|do\s+not|don't)\b/iu;
const EXCLUSION_MATCH_STOPWORDS = new Set([
  "about", "and", "exclude", "include", "merely", "never", "not", "only", "recording", "recordings",
  "music", "song", "songs", "the", "track", "tracks", "without",
]);

function explicitUserExclusion(prompt: string, rule: string): boolean {
  if (!EXPLICIT_EXCLUSION_CUE.test(prompt)) return false;
  const terms = normalized(rule).split(" ")
    .filter((term) => term.length >= 3 && !EXCLUSION_MATCH_STOPWORDS.has(term));
  if (terms.length === 0) return false;
  // Generated exclusions may reuse generic words from the positive prompt.
  // A rule is user-authored only when one of its meaningful terms appears in
  // the clause immediately governed by an exclusion cue (for example,
  // "house music, no remixes"), never merely somewhere else in the request.
  const exclusionClauses = [...prompt.matchAll(
    /\b(?:exclude|avoid|without|no|not|never|do\s+not|don['’]?t)\b\s+([^,;.!?\n]{1,160})/giu,
  )].map((match) => ` ${normalized(match[1] ?? "")} `);
  return terms.some((term) => exclusionClauses.some((clause) => clause.includes(` ${term} `)));
}

function ruleNamesComplement(rule: string, value: string): boolean {
  const normalizedValue = normalized(value);
  return normalizedValue.length > 0
    && normalized(rule).includes(`non ${normalizedValue}`);
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalized(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function intentSet(prompt: string, brief: PlaylistBrief): ResearchIntent[] {
  const scope = [prompt, brief.title, brief.description, brief.relationship, ...brief.include].join(" ");
  // Subjective intent comes from the visitor's request, not from prose the
  // brief model generated while explaining that request. Otherwise a plain
  // genre request such as “Brazilian disco songs” becomes an editorial-ranking
  // or artist-catalogue request merely because the generated title says
  // “Essentials” or its description says “recordings by Brazilian artists”.
  const directIntentScope = prompt;
  const intents: ResearchIntent[] = [];
  if (brief.mode === "exhaustive" || brief.mode === "hybrid" || EXHAUSTIVE_INTENT.test(directIntentScope)) intents.push("exhaustive");
  if (assertsFactualTrackRelationship(`${brief.relationship} ${prompt}`)) intents.push("factual_relationship");
  if (SIMILARITY_INTENT.test(directIntentScope)) intents.push("similarity");
  if (MOOD_ACTIVITY_INTENT.test(directIntentScope)) intents.push("mood_activity");
  const directThemeIntent = THEME_INTENT.test(directIntentScope);
  if (directThemeIntent) intents.push("theme");
  // Generated descriptions often say “recordings by Brazilian artists” or
  // similar while describing a genre survey. That is not a direct-artist
  // catalogue request and must not disable broad-playlist diversity rules.
  if (ARTIST_CATALOGUE_INTENT.test(directIntentScope)) intents.push("artist_catalogue");
  if (EDITORIAL_INTENT.test(directIntentScope)) intents.push("editorial_ranking");
  const physicalHouseTheme = directThemeIntent
    && /\b(?:a|the|physical)\s+houses?\b|\bhomes?\b/iu.test(directIntentScope)
    && !/\bhouse\s+music\b/iu.test(directIntentScope);
  if (!physicalHouseTheme
    && (GENRE_SCENE_INTENT.test(scope) || /genre|scene|style/iu.test(brief.relationship))) {
    intents.push("genre_scene");
  }
  if (intents.length === 0) intents.push("genre_scene");
  return [...new Set(intents)];
}

function axisForRule(rule: string): SelectionConstraintAxis {
  const value = normalized(rule);
  if (/language|french language|portuguese|spanish/iu.test(value)) return "language";
  if (/year|decade|era|century|before|after|between/iu.test(value)) return "era";
  if (/live|remix|edit|version|studio|acoustic|instrumental/iu.test(value)) return "recording_version";
  if (/explicit|clean|lyrics/iu.test(value)) return "content";
  if (/country|city|scene|origin|resident|recorded in|geograph|french|brazil|berlin|american/iu.test(value)) return "geography";
  if (/label|imprint/iu.test(value)) return "label";
  if (/venue|club/iu.test(value)) return "venue";
  if (/mood|vibe|energy|dark|bright|calm/iu.test(value)) return "mood";
  if (/sleep|study|workout|party|dinner|road trip/iu.test(value)) return "activity";
  if (/genre|subgenre|house music|techno|jazz|drill|funk/iu.test(value)) return "genre";
  return "relationship";
}

interface ParsedAxisRule {
  axis: SelectionConstraintAxis;
  operator: SelectionConstraint["operator"];
  values: string[];
  geographyRelationship?: SelectionGeographyRelationship | null;
}

/**
 * Values inside one positive scope constraint are alternatives. Coalesce
 * independently parsed fragments before they become manifest rules so a
 * request such as "Brazilian or French disco from the 1970s and 1980s" does
 * not require every recording to be Brazilian AND French, or to belong to
 * both decades at once.
 */
function coalesceAlternativeScopeRules(rules: readonly ParsedAxisRule[]): ParsedAxisRule[] {
  const coalesced: ParsedAxisRule[] = [];
  const indexes = new Map<string, number>();

  for (const rule of rules) {
    if (rule.operator !== "require" && rule.operator !== "within") {
      coalesced.push(rule);
      continue;
    }
    const key = `${rule.axis}:${rule.operator}:${rule.geographyRelationship ?? ""}`;
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, coalesced.length);
      coalesced.push({ ...rule, values: unique(rule.values) });
      continue;
    }
    const existing = coalesced[existingIndex]!;
    coalesced[existingIndex] = {
      ...existing,
      values: unique([...existing.values, ...rule.values]),
    };
  }

  return coalesced;
}

const GENRE_TERMS: Array<[string, RegExp]> = [
  ["baile funk", /\b(?:baile funk|funk carioca)\b/iu],
  ["hip-hop", /\bhip[ -]?hop\b/iu],
  ["bossa nova", /\bbossa nova\b/iu],
  ["house music", /\bhouse\s+music\b|\bhouse\b(?=\s+(?:anthems?|artists?|classics?|djs?|genre|mixes?|producers?|scene|tracks?))/iu],
  ["drill", /\bdrill\b/iu],
  ["jazz", /\bjazz\b/iu],
  ["techno", /\btechno\b/iu],
  ["footwork", /\bfootwork\b/iu],
  ["ambient", /\bambient\b/iu],
  ["samba", /\bsamba\b/iu],
  ["disco", /\bdisco\b/iu],
  ["soul", /\bsoul\b/iu],
  ["metal", /\bmetal\b/iu],
  ["punk", /\bpunk\b/iu],
  ["reggae", /\breggae\b/iu],
  ["classical", /\bclassical\b/iu],
  ["country", /\bcountry\b/iu],
  ["electronic", /\belectronic\b/iu],
  ["rock", /\brock\b/iu],
  // Keep generic funk last so funk carioca is represented by its more
  // specific, independently enforceable scope above.
  ["funk", /\bfunk\b/iu],
];

const MOOD_TERMS: Array<[string, RegExp]> = [
  ["dark", /\bdark\b/iu],
  ["calm", /\b(?:calm|calming|serene|tranquil)\b/iu],
  ["bright", /\bbright\b/iu],
  ["melancholic", /\b(?:melancholic|melancholy)\b/iu],
  ["uplifting", /\b(?:uplifting|euphoric)\b/iu],
];

const ACTIVITY_TERMS: Array<[string, RegExp]> = [
  ["sleep", /\b(?:sleep|sleeping|bedtime)\b/iu],
  ["study", /\b(?:study|studying|focus(?:\s+(?:music|playlist|session)))\b/iu],
  ["workout", /\b(?:workout|exercise|running)\b/iu],
  ["road trip", /\broad[ -]trip\b/iu],
  ["dinner", /\bdinner\b/iu],
  ["party", /\bparty\b/iu],
];

function eraRules(value: string): ParsedAxisRule[] {
  const range = value.match(/\b((?:19|20)\d{2})\s*(?:-|\u2013|\u2014|to|through)\s*((?:19|20)\d{2})\b/iu);
  if (range) return [{ axis: "era", operator: "between", values: [range[1]!, range[2]!] }];
  const decades = [...value.matchAll(/\b(?:(early|mid|late)[ -]?)?((?:19|20)\d0)s\b/giu)]
    .map((decade) => {
      const qualifier = decade[1] ? `${decade[1].toLocaleLowerCase("en-US")} ` : "";
      return `${qualifier}${decade[2]}s`;
    });
  if (decades.length > 0) {
    // Multiple decades are alternatives inside one constraint. Emitting one
    // hard rule per decade would require every track to belong to all of them;
    // retaining only the first silently narrowed prompts such as
    // "1970s and 1980s" to a single decade.
    return [{ axis: "era", operator: "within", values: unique(decades) }];
  }
  const year = value.match(/\b(?:19|20)\d{2}\b/u)?.[0];
  if (!year) return [];
  const operator: SelectionConstraint["operator"] = /\bbefore\b/iu.test(value)
    ? "before"
    : /\bafter\b/iu.test(value)
      ? "after"
      : "within";
  return [{ axis: "era", operator, values: [year] }];
}

/**
 * A single natural-language rule may carry several orthogonal requirements.
 * Return one independently enforceable constraint per axis instead of letting
 * the first matching keyword flatten the rest of the request.
 */
function parsedAxisRules(value: string): ParsedAxisRule[] {
  const rules: ParsedAxisRule[] = [];
  const genres = GENRE_TERMS.filter(([, pattern]) => pattern.test(value)).map(([label]) => label);
  if (genres.length > 0) rules.push({ axis: "genre", operator: "require", values: genres });
  const geographic = parseSelectionGeographyConstraints(value);
  const languages = geographic.filter((constraint) => constraint.relationship === "language");
  if (languages.length > 0) {
    rules.push({
      axis: "language",
      operator: "require",
      // Values within one constraint are alternatives. A request for tracks
      // "in Arabic and French" therefore means the playlist may contain
      // tracks in either requested language; it must not require every track
      // to be bilingual by emitting two independent hard constraints.
      values: languages.map((constraint) => constraint.value),
      geographyRelationship: "language",
    });
  }
  for (const constraint of geographic.filter((item) => item.relationship !== "language")) {
    rules.push({
      axis: constraint.relationship === "label_or_venue_scene" ? "scene" : "geography",
      operator: "require",
      values: [constraint.value],
      geographyRelationship: constraint.relationship,
    });
  }
  rules.push(...eraRules(value));

  const moods = MOOD_TERMS.filter(([, pattern]) => pattern.test(value)).map(([label]) => label);
  if (moods.length > 0) rules.push({ axis: "mood", operator: "require", values: moods });
  const activities = ACTIVITY_TERMS.filter(([, pattern]) => pattern.test(value)).map(([label]) => label);
  if (activities.length > 0) rules.push({ axis: "activity", operator: "require", values: activities });

  if (/\b(?:women|woman|female)\b/iu.test(value)) {
    rules.push({ axis: "theme", operator: "require", values: ["Women"] });
  }
  const scene = value.match(/\b([\p{L}\p{N}][\p{L}\p{N}' -]{1,60}?)\s+scene\b/iu)?.[1]?.trim();
  if (scene) {
    rules.push({
      axis: "scene",
      operator: "require",
      values: [scene],
    });
  }
  const subgenre = value.match(/\bsubgenre\s+(?:of\s+)?([\p{L}\p{N}][\p{L}\p{N}' -]{1,60})/iu)?.[1]?.trim();
  if (subgenre) rules.push({ axis: "subgenre", operator: "require", values: [subgenre] });
  return rules;
}

function constraintsForBrief(
  prompt: string,
  brief: PlaylistBrief,
  guidance: readonly PlaylistGuidancePreference[],
  intents: readonly ResearchIntent[],
): SelectionConstraint[] {
  const constraints: SelectionConstraint[] = [];
  const constraintKeys = new Set<string>();
  let index = 0;
  const add = (
    prefix: string,
    axis: SelectionConstraintAxis,
    operator: SelectionConstraint["operator"],
    values: string[],
    kind: SelectionConstraint["kind"],
    relaxationRank: number | null,
    geographyRelationship: SelectionGeographyRelationship | null = null,
  ) => {
    const clean = unique(values.map((value) => value.trim()).filter(Boolean));
    if (clean.length === 0) return;
    const key = `${axis}:${operator}:${kind}:${geographyRelationship ?? ""}:${clean.map(normalized).sort().join("|")}`;
    if (constraintKeys.has(key)) return;
    constraintKeys.add(key);
    constraints.push({
      id: `${prefix}_${++index}`,
      axis,
      operator,
      values: clean,
      kind,
      geographyRelationship,
      relaxationRank,
    });
  };

  // Interpret recognizable axes from the confirmed scope as hard requirements.
  // Generated prose is never used as a catch-all constraint here; only typed
  // values emitted by the bounded parser survive into the plan.
  const promptScopeRules = coalesceAlternativeScopeRules(parsedAxisRules(prompt));
  for (const parsed of promptScopeRules) {
    add("scope", parsed.axis, parsed.operator, parsed.values, "hard", null, parsed.geographyRelationship ?? null);
  }

  // Subject entities are useful when the prompt does not name a typed axis,
  // but they are model-resolved fragments rather than additional visitor
  // requirements. Once the prompt defines an axis, never let a fragment
  // narrow it (for example, separate `1970s` and `1980s` entities). For axes
  // absent from the prompt, merge equivalent positive fragments as
  // alternatives before making them hard constraints.
  const promptDefinedAxes = new Set(promptScopeRules.map((rule) => rule.axis));
  const subjectScopeRules = coalesceAlternativeScopeRules(
    unique(brief.subjectEntities)
      .flatMap((scopeText) => parsedAxisRules(scopeText))
      .filter((rule) => !promptDefinedAxes.has(rule.axis)),
  );
  for (const parsed of subjectScopeRules) {
    add("scope", parsed.axis, parsed.operator, parsed.values, "hard", null, parsed.geographyRelationship ?? null);
  }
  // The user prompt and resolved subject entities define non-relaxable scope.
  // Model-authored title/description/include prose supplies useful discovery
  // hints, but must not silently invent hard eras, venues, activities, or
  // other requirements the visitor never requested.
  let generatedPreferenceRank = 10;
  for (const scopeText of unique([brief.title, brief.description, ...brief.include])) {
    for (const parsed of parsedAxisRules(scopeText)) {
      add(
        "brief_preference",
        parsed.axis,
        "prefer",
        parsed.values,
        "soft",
        generatedPreferenceRank++,
        parsed.geographyRelationship ?? null,
      );
    }
  }
  for (const rule of brief.include) {
    const parsed = parsedAxisRules(rule);
    if (parsed.length === 0) add("include", axisForRule(rule), "prefer", [rule], "soft", generatedPreferenceRank++);
  }
  for (const rule of brief.exclude) {
    const userAuthored = explicitUserExclusion(prompt, rule);
    const parsed = parsedAxisRules(rule);
    if (parsed.length === 0) {
      add(
        userAuthored ? "exclude" : "brief_avoid",
        axisForRule(rule),
        userAuthored ? "exclude" : "avoid",
        [rule],
        userAuthored ? "hard" : "soft",
        userAuthored ? null : generatedPreferenceRank++,
      );
    } else {
      let retainedTypedExclusion = false;
      let namesRequiredComplement = false;
      for (const item of parsed) {
        const nonConflictingValues = item.values.filter((value) => {
          const conflictsWithRequiredScope = constraints.some((constraint) => (
            constraint.kind === "hard"
            && constraint.operator !== "exclude"
            && constraint.operator !== "avoid"
            && constraint.axis === item.axis
            && constraint.values.some((required) => normalized(required) === normalized(value))
          ));
          if (conflictsWithRequiredScope && ruleNamesComplement(rule, value)) {
            namesRequiredComplement = true;
          }
          return !conflictsWithRequiredScope;
        });
        if (nonConflictingValues.length === 0) continue;
        retainedTypedExclusion = true;
        add(
          userAuthored ? "exclude" : "brief_avoid",
          item.axis,
          userAuthored ? "exclude" : "avoid",
          nonConflictingValues,
          userAuthored ? "hard" : "soft",
          userAuthored ? null : generatedPreferenceRank++,
          item.geographyRelationship ?? null,
        );
      }
      // Generated phrases such as “non-disco” and “non-Brazilian” merely name
      // the complement of positive hard scope. Persisting the raw phrase as a
      // token-matched exclusion causes valid Brazilian-disco evidence to match
      // both words and reject every candidate. The positive hard axes already
      // enforce this boundary, so the redundant generated complement is
      // intentionally dropped. Preserve only a genuinely user-authored,
      // non-complementary contradiction so it remains visible for policy
      // conflict handling.
      if (!retainedTypedExclusion && userAuthored && !namesRequiredComplement) {
        add("exclude", "relationship", "exclude", [rule], "hard", null);
      }
    }
  }
  // Factual and exhaustive work must prove the exact requested relationship.
  // For curated work, the brief's relationship sentence is model-authored
  // presentation prose; the typed intent axes and evidence gate already own
  // relevance. Treating that sentence as a literal hard phrase caused valid
  // specialist sources to be discarded unless they repeated it verbatim.
  const relationshipIsHard = intents.includes("factual_relationship") || intents.includes("exhaustive");
  add(
    "relationship",
    "relationship",
    relationshipIsHard ? "require" : "prefer",
    [brief.relationship],
    relationshipIsHard ? "hard" : "soft",
    relationshipIsHard ? null : 9,
  );
  add("evidence", "evidence", "require", [brief.evidencePolicy], "hard", null);
  add("version", "recording_version", "require", [brief.versionPolicy], "hard", null);

  // A selected scout answer resolves a previously ambiguous place adjective
  // into an exact, non-relaxable semantic relationship. Remove only the
  // matching `unspecified` rule; unrelated hard axes remain intact.
  for (const preference of guidance) {
    const resolved = preference.geographyConstraint;
    if (!resolved) continue;
    for (let constraintIndex = constraints.length - 1; constraintIndex >= 0; constraintIndex -= 1) {
      const existing = constraints[constraintIndex]!;
      if (existing.kind !== "hard" || existing.geographyRelationship !== "unspecified") continue;
      if (!existing.values.some((value) => normalized(value) === normalized(resolved.value))) continue;
      constraints.splice(constraintIndex, 1);
    }
    const axis: SelectionConstraintAxis = resolved.relationship === "language"
      ? "language"
      : resolved.relationship === "label_or_venue_scene"
        ? "scene"
        : "geography";
    add("guidance_scope", axis, "require", [resolved.value], "hard", null, resolved.relationship);
  }

  guidance.forEach((preference, guidanceIndex) => {
    const axis: SelectionConstraintAxis = preference.kind === "version_preference"
      ? "recording_version"
      : preference.kind === "subscene_focus"
        ? "scene"
        : preference.kind === "ordering_behavior"
          ? "relationship"
          : "theme";
    if (!preference.geographyConstraint) {
      add("guidance", axis, "prefer", [preference.value], "soft", 100 + guidanceIndex);
    }
  });
  return constraints;
}

function similarityDimensions(prompt: string): string[] {
  const dimensions: string[] = [];
  if (/production|texture|sound design|timbre/iu.test(prompt)) dimensions.push("production");
  if (/tempo|pace|fast|slow|bpm/iu.test(prompt)) dimensions.push("tempo");
  if (/harmon|chord|melod/iu.test(prompt)) dimensions.push("harmony");
  if (/scene|regional|geograph|community/iu.test(prompt)) dimensions.push("scene");
  if (/era|decade|\b(?:19|20)\d{2}s?\b/iu.test(prompt)) dimensions.push("era");
  if (/vocal|voice|singing|rap style|flow/iu.test(prompt)) dimensions.push("vocal_style");
  return dimensions.length > 0 ? dimensions : ["production", "scene", "era"];
}

function versionPolicyFor(brief: PlaylistBrief): SelectionVersionPolicy {
  const scope = brief.versionPolicy;
  const conditionalRemasterFallback = hasConditionalRemasterFallback(scope);
  const dispositions = VERSION_MARKERS.map(([pattern, value]) => ({
    pattern,
    value,
    disposition: versionMarkerDisposition(scope, pattern),
  }));
  const explicitlyRequested = dispositions
    .filter((entry) => entry.disposition === "include")
    .map((entry) => entry.value);
  const requested = conditionalRemasterFallback
    ? [
        "canonical" as const,
        ...explicitlyRequested.filter((value) => value !== "canonical" && value !== "remaster"),
        "remaster" as const,
      ]
    : explicitlyRequested;
  const excluded = new Set(dispositions
    .filter((entry) => entry.disposition === "exclude")
    .map((entry) => entry.value));
  if (conditionalRemasterFallback) {
    excluded.delete("canonical");
    excluded.delete("remaster");
  }
  const explicitOnly = dispositions.some((entry) => (
    entry.disposition === "include" && versionMarkerIsExclusive(scope, entry.pattern)
  ));
  const defaultAllowed: SelectionVersionPolicy["allowed"] = ["canonical", "remaster", "clean", "explicit", "unknown"];
  const defaultPreferred: SelectionVersionPolicy["preferred"] = ["canonical", "remaster"];
  const allowed: SelectionVersionPolicy["allowed"] = (explicitOnly
    ? requested
    : [...new Set([...defaultAllowed, ...requested])])
    .filter((value) => !excluded.has(value));
  const preferenceCandidates = conditionalRemasterFallback
    ? requested.filter((value) => value !== "remaster")
    : requested.length > 0
      ? requested
      : defaultPreferred;
  const preferred: SelectionVersionPolicy["preferred"] = preferenceCandidates
    .filter((value) => allowed.includes(value));
  return {
    preferred: preferred.length > 0 ? preferred : allowed.slice(0, 2),
    allowed,
    excludeCompilations: versionMarkerDisposition(scope, /\bcompilations?\b/iu) === "exclude",
    excludeKaraokeAndTributes: true,
  };
}

function contentPolicyFor(brief: PlaylistBrief): SelectionPlan["contentPolicy"] {
  const scope = [brief.versionPolicy, ...brief.include, ...brief.exclude].join(" ");
  return {
    explicitContent: /clean(?:\s+versions?)?\s+only|no explicit|exclude explicit/iu.test(scope)
      ? "clean_only"
      : /prefer clean/iu.test(scope)
        ? "prefer_clean"
        : "allow",
    instrumental: /exclude instrumental|no instrumentals/iu.test(scope)
      ? "exclude"
      : /prefer instrumental|instrumental only/iu.test(scope)
        ? "prefer"
        : "allow",
    languages: unique([
      ...brief.include,
      ...brief.subjectEntities,
    ].filter((value) => /language|english|french|portuguese|spanish|german|japanese/iu.test(value))),
  };
}

const FIXED_RELEASE_CONTAINER = /\b(?:album|ep|lp|mixtape|soundtrack|compilation|box\s+set|fixed\s+(?:release|container))\b/iu;
const TRACKS_FROM_CONTAINER = /\b(?:songs?|tracks?|recordings?)\s+(?:from|on|off)\b/iu;
const POSSESSIVE_CONTAINER_REFERENCE = /\b(?:songs?|tracks?|recordings?)\s+(?:from|on|off)\s+[^,;.!?\n]{1,120}[\p{L}\p{N}]['’]s\s+[^,;.!?\n]{1,120}/iu;
const EXPLICITLY_NAMED_CONTAINER = /\b(?:album|e\.?p\.?|l\.?p\.?|mixtape|soundtrack|compilation|box\s+set)\s+(?:called|named|titled)\b/iu;

function fixedReleaseContainerScope(prompt: string, brief: PlaylistBrief): boolean {
  if (EXPLICITLY_NAMED_CONTAINER.test(prompt)) return true;
  if (!TRACKS_FROM_CONTAINER.test(prompt)) return false;

  // Natural requests often omit the word "album" (for example, “songs from
  // Michael Jackson's Thriller”). Require either a typed two-entity brief or
  // an interpreted release/container relationship before treating that
  // possessive construction as fixed. This avoids misclassifying broad
  // geography/theme prompts such as “songs from Brazil” or “songs from my
  // childhood”.
  const interpretedScope = [
    brief.description,
    brief.relationship,
    ...brief.include,
  ].join(" ");
  return FIXED_RELEASE_CONTAINER.test(prompt)
    || FIXED_RELEASE_CONTAINER.test(interpretedScope)
    || (brief.subjectEntities.length >= 2 && POSSESSIVE_CONTAINER_REFERENCE.test(prompt));
}

function selectionScopeKind(
  prompt: string,
  intents: readonly ResearchIntent[],
  brief: PlaylistBrief,
): SelectionScopeKind {
  if (fixedReleaseContainerScope(prompt, brief)) return "fixed_release_container";
  if (intents.includes("factual_relationship") || intents.includes("exhaustive")) return "factual_frontier";
  if (intents.includes("artist_catalogue")) return "artist_catalogue";
  return "broad_curated";
}

export function createSelectionPlanV2(input: {
  prompt: string;
  brief: PlaylistBrief;
  guidancePreferences?: readonly PlaylistGuidancePreference[];
  storefront?: string;
}): SelectionPlan {
  const guidance = input.guidancePreferences ?? [];
  const intents = intentSet(input.prompt, input.brief);
  const scopeKind = selectionScopeKind(input.prompt, intents, input.brief);
  const requestedTrackCount = Math.max(1, Math.floor(input.brief.targetSize?.min ?? 50));
  const reserveTrackCount = Math.max(5, Math.ceil(requestedTrackCount * 0.1));
  const fixedScope = scopeKind !== "broad_curated";
  const maxArtist = fixedScope ? null : Math.max(1, Math.ceil(requestedTrackCount * 0.15));
  const constraints = constraintsForBrief(input.prompt, input.brief, guidance, intents);
  const geographyConstraints: SelectionGeographyConstraint[] = uniqueGeographyConstraints(
    constraints
      .filter((constraint) => constraint.kind === "hard"
        && !["exclude", "avoid", "maximum"].includes(constraint.operator))
      .flatMap(selectionConstraintGeography),
  );
  const orderingMode = /chronolog/iu.test(input.brief.orderingPolicy)
    ? "chronological"
    : /contrast/iu.test(input.brief.orderingPolicy)
      ? "contrast"
      : /smooth|flow|intermix/iu.test(input.brief.orderingPolicy)
        ? "smooth"
        : "editorial";

  return {
    schemaVersion: 1,
    pipelineVersion: "catalog_first_v2",
    policyVersion: PIPELINE_V2_SELECTION_PLAN_VERSION,
    intents,
    scopeKind,
    storefront: (input.storefront ?? "us").toLocaleLowerCase("en-US"),
    requestedTrackCount,
    minimumQualifiedTrackCount: requestedTrackCount,
    reserveTrackCount,
    constraints,
    geographyConstraints,
    similarityDimensions: intents.includes("similarity") ? similarityDimensions(input.prompt) : [],
    labels: unique(input.brief.include.filter((value) => /label|imprint/iu.test(value))),
    venues: unique(input.brief.include.filter((value) => /venue|club/iu.test(value))),
    referenceRecordings: intents.includes("similarity") ? unique(input.brief.subjectEntities) : [],
    softGoalRelaxationOrder: [
      "sequencing_preferences",
      "album_concentration",
      "artist_concentration",
      "era_balance",
      "subgenre_regional_representation",
    ],
    diversityGoals: {
      minimumDistinctArtists: fixedScope ? null : Math.min(requestedTrackCount, Math.max(5, Math.ceil(requestedTrackCount * 0.2))),
      minimumDistinctAlbums: fixedScope ? null : Math.min(requestedTrackCount, Math.max(5, Math.ceil(requestedTrackCount * 0.25))),
      minimumDistinctEras: fixedScope ? null : 2,
      minimumDistinctScenes: fixedScope ? null : 2,
      minimumDistinctGeographies: null,
      maximumTracksPerArtist: maxArtist,
      maximumTracksPerAlbum: fixedScope ? null : Math.max(2, Math.ceil(requestedTrackCount * 0.1)),
    },
    evidencePolicy: input.brief.evidencePolicy,
    versionPolicy: versionPolicyFor(input.brief),
    orderingPolicy: {
      mode: orderingMode,
      goals: unique([input.brief.orderingPolicy, ...guidance.map((preference) => preference.value)]),
      avoidAdjacentSameArtist: !fixedScope,
      avoidAdjacentSameAlbum: !fixedScope,
    },
    contentPolicy: contentPolicyFor(input.brief),
  };
}

export function pipelineV2Route(plan: Pick<SelectionPlan, "intents">): "curated_catalog" | "factual_frontier" {
  return plan.intents.includes("factual_relationship") || plan.intents.includes("exhaustive")
    ? "factual_frontier"
    : "curated_catalog";
}

export type PipelineV2RolloutGroup = "curated_core" | "curated_similarity" | "factual_frontier";

/**
 * Similarity is intentionally a separate public rollout cohort. It has a
 * different relevance benchmark (track-level stylistic support and reference
 * artist exclusion) and must not be enabled merely because genre/scene and
 * mood traffic graduated.
 */
export function pipelineV2RolloutGroup(
  plan: Pick<SelectionPlan, "intents">,
): PipelineV2RolloutGroup {
  if (pipelineV2Route(plan) === "factual_frontier") return "factual_frontier";
  return plan.intents.includes("similarity") ? "curated_similarity" : "curated_core";
}

export interface PipelineV2Assignment {
  assigned: boolean;
  cohort: number;
  percentage: number;
  reason: "owner_canary" | "sticky_rollout" | "legacy_control";
}

/**
 * A rollout cohort belongs to a browser/client bucket and a versioned route,
 * not to one prompt. This keeps a visitor on one pipeline while they compare
 * different playlist requests, while a deliberate route or policy revision
 * receives an independent cohort assignment.
 */
export function pipelineRolloutStickyKey(
  clientBucket: string,
  plan: Pick<SelectionPlan, "intents" | "policyVersion">,
): string {
  return `${clientBucket}:${pipelineV2RolloutGroup(plan)}:${plan.policyVersion}`;
}

function rolloutPercentage(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, parsed));
}

/**
 * Stable rollout assignment. Owner-curated runs are the first canary; public
 * traffic advances only when the explicit percentage is raised. Factual and
 * exhaustive work has a separate switch because its claim/frontier benchmark
 * must pass independently of curated genre and mood playlists.
 */
export function assignPipelineV2(input: {
  plan: SelectionPlan;
  owner: boolean;
  stickyKey: string;
  env?: NodeJS.ProcessEnv;
}): PipelineV2Assignment {
  const env = input.env ?? process.env;
  const rolloutGroup = pipelineV2RolloutGroup(input.plan);
  const factual = rolloutGroup === "factual_frontier";
  const digest = createHash("sha256").update(input.stickyKey).digest();
  const cohort = digest.readUInt32BE(0) % 10_000;
  // Factual/exhaustive work has independent rollout controls because its
  // claim/frontier benchmark graduates separately from curated catalog work.
  // Both routes remain legacy control when their own gates are absent.
  if (factual) {
    if (input.owner && env.PIPELINE_V2_FACTUAL_OWNER_CANARY === "true") {
      return { assigned: true, cohort, percentage: 100, reason: "owner_canary" };
    }
    const percentage = rolloutPercentage(env.PIPELINE_V2_FACTUAL_PERCENT);
    const assigned = cohort < Math.round(percentage * 100);
    return {
      assigned,
      cohort,
      percentage,
      reason: assigned ? "sticky_rollout" : "legacy_control",
    };
  }
  // Owner canaries are an explicit operational gate. Keeping this disabled by
  // default prevents an owner request from creating a V2 job during the short
  // interval in which pre-capability workers may still be draining a rolling
  // deployment. Operations enables the gate only after fresh V2-capable
  // heartbeats are the sole workers eligible for new V2 work.
  if (input.owner && env.PIPELINE_V2_OWNER_CANARY === "true") {
    return { assigned: true, cohort, percentage: 100, reason: "owner_canary" };
  }
  const percentage = rolloutPercentage(
    rolloutGroup === "curated_similarity"
      ? env.PIPELINE_V2_SIMILARITY_PERCENT
      : env.PIPELINE_V2_CURATED_PERCENT,
  );
  const assigned = cohort < Math.round(percentage * 100);
  return {
    assigned,
    cohort,
    percentage,
    reason: assigned ? "sticky_rollout" : "legacy_control",
  };
}

/**
 * The persisted plan is the server-owned contract. Expose only the fields a
 * research pass needs so model prompts cannot silently reinterpret hard
 * constraints, diversity targets, or the relaxation order from presentation
 * prose. This object is data, not an instruction source.
 */
export function selectionPlanResearchContext(plan: SelectionPlan | null | undefined) {
  if (!plan) return null;
  return {
    pipelineVersion: plan.pipelineVersion,
    policyVersion: plan.policyVersion,
    intents: plan.intents,
    hardConstraints: plan.constraints.filter((constraint) => constraint.kind === "hard"),
    softGoals: plan.constraints.filter((constraint) => constraint.kind === "soft"),
    softGoalRelaxationOrder: plan.softGoalRelaxationOrder,
    similarityDimensions: plan.similarityDimensions,
    referenceRecordings: plan.referenceRecordings,
    labels: plan.labels,
    venues: plan.venues,
    diversityGoals: plan.diversityGoals,
    evidencePolicy: plan.evidencePolicy,
    versionPolicy: plan.versionPolicy,
    contentPolicy: plan.contentPolicy,
    orderingPolicy: plan.orderingPolicy,
  };
}
