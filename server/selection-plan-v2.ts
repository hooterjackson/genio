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
import { EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS } from "../shared/product-policy.ts";
import {
  effectiveGuidanceGeographyConstraint,
  type PlaylistGuidancePreference,
} from "./guidance-context.ts";
import { assertsFactualTrackRelationship } from "./factual-frontier-policy.ts";
import { PIPELINE_POLICY_VERSION } from "./pipeline-v2-policy.ts";
import {
  parseSelectionGeographyConstraints,
  selectionGeographyIsAudienceMarketContext,
  selectionConstraintGeography,
  selectionGeographyValuesEquivalent,
  uniqueGeographyConstraints,
} from "./selection-geography-policy.ts";
import { compileFixedTrackList } from "./fixed-track-list-policy.ts";
import { excludedReferenceArtists } from "./similarity-policy.ts";
import {
  hasHistoricalInfluenceSemanticsV1,
  softEditorialDescriptorTermsV1,
} from "./historical-influence-semantics-v1.ts";

export const PIPELINE_V2_SELECTION_PLAN_VERSION = PIPELINE_POLICY_VERSION;
/**
 * Stable compiler-owned signal for a user-authored influence objective.
 *
 * Downstream guidance consumes this typed artifact, never the raw prompt. The
 * value is deliberately not a natural-language query so it cannot be confused
 * with model prose or silently become a hard evidence predicate.
 */
export const SELECTION_INFLUENCE_SCOPE_SIGNAL_V1 =
  "semantic:historical_influence" as const;

const EXHAUSTIVE_INTENT = /\b(?:every|all|complete|entire|exhaustive)\b.{0,100}\b(?:songs?|tracks?|recordings?|releases?|credits?|discograph(?:y|ies)|catalog(?:ue)?)\b/iu;
const SIMILARITY_INTENT = /\b(?:sounds?\s+like|songs?\s+like|tracks?\s+like|similar\s+to|resembl|adjacent\s+to|in\s+the\s+(?:style|vein)\s+of|for\s+fans\s+of|artists?\s+like)\b/iu;
const MOOD_ACTIVITY_INTENT = /\b(?:mood|sleep|study|studying|workout|running|road\s+trip|dinner|party|gaming|smok(?:e|ing)|late[ -]?night|chill(?:ed|ing)?|focus(?:\s+(?:music|playlist|session))|relax|meditat|sunset|churrasco)\b/iu;
const VIBE_INTENT = /\bvibes?\b/iu;
// `editorial_ranking` is an evidence-bearing intent: every selected track must
// independently prove the requested ranking or historical claim. Reserve it
// for requests that actually make such a claim. Lightweight curation words
// such as "iconic", "classic", and "essential" are useful ordering signals,
// but making them an intent rejected otherwise well-supported genre tracks
// whenever a source did not literally describe each recording that way.
const ARTIST_CATALOGUE_INTENT = /\b(?:discograph|catalog(?:ue)?|songs?\s+by|tracks?\s+by|recordings?\s+by|artist\s+catalog)\b/iu;
const GENRE_SCENE_INTENT = /\b(?:genre|subgenre|scene|jazz|techno|house|drill|funk|ambient|footwork|hip[ -]?hop|rap|r\s*(?:&|and)\s*b|rhythm\s+and\s+blues|rock|samba|bossa|disco|soul|metal|punk|reggaet[oó]n|reggae|latin[ -]?urban|dembow|classical|country|electronic)\b/iu;
const THEME_INTENT_MENTION = /\b(?:(?:songs?|tracks?|recordings?|music)\s+about|lyrics?\s+about|themes?|themed)\b/giu;

const VERSION_MARKERS: Array<[RegExp, SelectionVersionPolicy["allowed"][number]]> = [
  [/\b(?:canonical|original\s+or\s+definitive\s+(?:recording|version)s?|original(?:[-\s]+era)?(?:\s+(?:studio|album|single))?\s+(?:recording|version)s?(?!\s+identity)|studio\s+(?:recording|version)s?)\b/iu, "canonical"],
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
// `all` and `every` are quantifiers, not positive directives. Treating them
// as inclusion cues makes "exclude all alternate versions" include alternate
// recordings because the quantifier appears after the exclusion verb.
const VERSION_INCLUSION_CUE = /\b(?:include|including|allow|allowing|prefer|preferring|preferred|only|must|require|required)\b/giu;
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

/**
 * "Include/use X only if ..." makes X an allowed fallback, not a preferred
 * recording class. Without this distinction, guidance such as "prefer the
 * original; include later edits only if historically central" incorrectly
 * turns every canonical Apple match into an exception.
 */
function conditionallyAllowedVersionValues(
  scope: string,
): Set<SelectionVersionPolicy["allowed"][number]> {
  const conditional = new Set<SelectionVersionPolicy["allowed"][number]>();
  const clauses = scope.split(/[.;\n]+/u);
  for (const clause of clauses) {
    for (const [marker, value] of VERSION_MARKERS) {
      const matcher = new RegExp(marker.source, marker.flags.includes("g") ? marker.flags : `${marker.flags}g`);
      for (const match of clause.matchAll(matcher)) {
        const before = clause.slice(0, match.index);
        const after = clause.slice(match.index + match[0].length);
        if (!/\b(?:include(?:d|s)?|including|allow(?:ed|s|ing)?|use(?:d|s)?|using|accept(?:ed|s|ing)?)\b/iu.test(before)) continue;
        if (!/^\s*(?:versions?\s+)?only\s+(?:if|when|where|provided)\b/iu.test(after)) continue;
        conditional.add(value);
      }
    }
  }
  return conditional;
}

function normalized(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

/**
 * Resolve a general influence concept at the compiler boundary. Typo
 * tolerance is deliberately narrow and applies only to long musical intent
 * terms; there is no nationality, country, artist, or prompt-template rule.
 */
export function selectionPromptHasInfluenceScopeSignalV1(
  prompt: string,
): boolean {
  return hasHistoricalInfluenceSemanticsV1(prompt);
}

const EXPLICIT_EXCLUSION_CUE = /\b(?:exclude|avoid|without|no|not|never|do\s+not|don't)\b/iu;
const EXCLUSION_MATCH_STOPWORDS = new Set([
  "about", "and", "exclude", "include", "merely", "never", "not", "only", "recording", "recordings",
  "music", "song", "songs", "the", "track", "tracks", "without",
]);

function explicitUserExclusion(prompt: string, rule: string): boolean {
  if (!EXPLICIT_EXCLUSION_CUE.test(prompt)) return false;
  const terms = normalized(rule).split(" ")
    // NFKD punctuation normalization turns "re-recordings" into
    // "re recordings"; retain the semantically material `re` prefix even
    // though it is shorter than the normal token floor.
    .filter((term) => (term.length >= 3 || term === "re")
      && !EXCLUSION_MATCH_STOPWORDS.has(term));
  if (terms.length === 0) return false;
  // Generated exclusions may reuse generic words from the positive prompt.
  // A rule is user-authored only when one of its meaningful terms appears in
  // the clause immediately governed by an exclusion cue (for example,
  // "house music, no remixes"), never merely somewhere else in the request.
  // Commas enumerate one exclusion list; they are not clause boundaries.
  // Adversatives do end the governed span so "exclude remixes, but include
  // live recordings" cannot harden the inclusion as another exclusion.
  const exclusionClauses = [...prompt.matchAll(
    /\b(?:exclude|avoid|without|no|not|never|do\s+not|don['’]?t)\b\s+((?:(?!\b(?:but|while|whereas|except)\b)[^;.!?\n]){1,320})/giu,
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

function softEditorialDescriptors(prompt: string): string[] {
  return softEditorialDescriptorTermsV1(prompt);
}

/**
 * Theme language is also commonly used to reject a literal interpretation,
 * especially for polysemous genre names: "house music, not songs about
 * literal houses".  Treating that clarification as a positive theme intent
 * raises the evidence floor from genre membership to track-level thematic
 * proof and can discard an otherwise fully qualified catalog.
 *
 * Inspect each theme mention independently so a real mixed request such as
 * "songs about home, but exclude songs about real estate" keeps its positive
 * theme intent.  The local clause check deliberately recognizes both direct
 * rejection and double-negation/non-exclusive wording.
 */
function hasPositiveThemeIntent(prompt: string): boolean {
  for (const mention of prompt.matchAll(THEME_INTENT_MENTION)) {
    const prefix = prompt.slice(Math.max(0, mention.index - 160), mention.index);
    const localClause = prefix.split(/(?:[.,;!?\n\r]|[–—]|\bbut\b)/iu).at(-1)?.trim() ?? "";

    // "not only/just songs about ..." broadens the request; "do not
    // exclude songs about ..." explicitly retains it. Neither is a rejection.
    if (/\bnot\s+(?:only|just)\b/iu.test(localClause)
      || /\b(?:do\s+not|don['’]?t)\s+(?:exclude|avoid|omit|reject|remove)\b/iu.test(localClause)) {
      return true;
    }

    const rejected = /(?:\b(?:not|no|never|without|except|exclude(?:d|s|ing)?|avoid(?:ed|s|ing)?|omit(?:ted|s|ting)?|reject(?:ed|s|ing)?|remove(?:d|s|ing)?)\b|\brather\s+than\b|\binstead\s+of\b|\bas\s+opposed\s+to\b)/iu
      .test(localClause);
    if (!rejected) return true;
  }
  return false;
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
  const directThemeIntent = hasPositiveThemeIntent(directIntentScope);
  const physicalHouseTheme = directThemeIntent
    && /\b(?:a|the|physical)\s+houses?\b|\bhomes?\b/iu.test(directIntentScope)
    && !/\bhouse\s+music\b/iu.test(directIntentScope);
  const genreSceneIntent = !physicalHouseTheme
    && (GENRE_SCENE_INTENT.test(scope) || /genre|scene|style/iu.test(brief.relationship));
  if (brief.mode === "exhaustive" || brief.mode === "hybrid" || EXHAUSTIVE_INTENT.test(directIntentScope)) intents.push("exhaustive");
  if (assertsFactualTrackRelationship(`${brief.relationship} ${prompt}`)) intents.push("factual_relationship");
  if (
    SIMILARITY_INTENT.test(directIntentScope)
    || excludedReferenceArtists(brief).length > 0
  ) intents.push("similarity");
  // A generic "vibe" modifier on an explicit genre request is a soft
  // curation preference unless the visitor also names a concrete mood or
  // activity. Treating the word itself as an evidence-bearing intent made
  // every selected recording prove that mood independently, even when the
  // immutable plan correctly stored all vibe rules as relaxable preferences.
  if (MOOD_ACTIVITY_INTENT.test(directIntentScope)
    || (VIBE_INTENT.test(directIntentScope) && !genreSceneIntent)) {
    intents.push("mood_activity");
  }
  if (directThemeIntent) intents.push("theme");
  // Generated descriptions often say “recordings by Brazilian artists” or
  // similar while describing a genre survey. That is not a direct-artist
  // catalogue request and must not disable broad-playlist diversity rules.
  if (ARTIST_CATALOGUE_INTENT.test(directIntentScope)) intents.push("artist_catalogue");
  if (hasHistoricalInfluenceSemanticsV1(directIntentScope)) {
    intents.push("editorial_ranking");
  }
  if (genreSceneIntent) intents.push("genre_scene");
  // A request without a resolved genre is still a valid curated request.
  // Leaving the intent set empty retains general relevance qualification
  // without inventing a per-track genre evidence gate.
  return [...new Set(intents)];
}

function axisForRule(rule: string): SelectionConstraintAxis {
  const value = normalized(rule);
  if (/language|french language|portuguese|spanish/iu.test(value)) return "language";
  // Classify literal/theme exclusions before era. Token boundaries matter:
  // the old bare `era` alternative matched the middle of `literal`, turning
  // "not songs about literal houses" into a synthetic era constraint.
  if (/\b(?:(?:songs?|tracks?|recordings?|music|lyrics?)\s+about|themes?|themed)\b/iu.test(value)) return "theme";
  if (/\b(?:year|decade|era|century|before|after|between)\b/iu.test(value)) return "era";
  if (/live|remix|edit|version|studio|acoustic|instrumental|covers?|re recordings?/iu.test(value)) {
    return "recording_version";
  }
  if (/explicit|clean|lyrics/iu.test(value)) return "content";
  if (/country|city|scene|origin|resident|recorded in|geograph|french|brazil|berlin|american/iu.test(value)) return "geography";
  if (/label|imprint/iu.test(value)) return "label";
  if (/venue|club/iu.test(value)) return "venue";
  if (/mood|vibe|energy|dark|bright|calm/iu.test(value)) return "mood";
  if (/sleep|study|workout|party|dinner|road trip/iu.test(value)) return "activity";
  if (/genre|subgenre|house music|techno|jazz|drill|funk|hip[ -]?hop|rap|r\s*(?:&|and)\s*b|rhythm\s+and\s+blues/iu.test(value)) return "genre";
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
  ["rap", /\brap\b/iu],
  ["R&B", /\br\s*(?:&|and)\s*b\b|\brhythm\s+and\s+blues\b/iu],
  ["bossa nova", /\bbossa nova\b/iu],
  ["reggaeton", /\breggaet[oó]n\b/iu],
  ["Latin urban", /\blatin[ -]?urban\b/iu],
  ["dembow", /\bdembow\b/iu],
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
  const openEndedRange = value.match(
    /\b(?:from\s+(?:the\s+)?)?(?:(?:(?:early|mid|late)[ -]?)?((?:19|20)\d0)s|((?:19|20)\d{2}))\s*(?:-|\u2013|\u2014|to|through|thru|until|up\s+to)\s*(?:the\s+)?(?:present(?:\s+day)?|current(?:\s+(?:year|day))?|today|now|date)\b/iu,
  );
  if (openEndedRange) {
    const startYear = openEndedRange[1] ?? openEndedRange[2];
    return [{
      axis: "era",
      operator: "between",
      values: [startYear!, String(new Date().getUTCFullYear())],
    }];
  }
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
  const ambiguousBareYear = /\b(?:18|19|20)\d{2}\s+(?:rap|hip[ -]?hop|r\s*(?:&|and)\s*b|rhythm\s+and\s+blues|jazz|rock|pop|disco|house|techno|funk|soul)\b/iu.test(value)
    && !/\b(?:released?|recorded|recordings?|songs?|tracks?|music)\s+(?:from|during|in)\s+(?:the\s+)?(?:18|19|20)\d{2}\b/iu.test(value)
    && !/\b(?:only|year)\s+(?:18|19|20)\d{2}\b/iu.test(value);
  if (ambiguousBareYear) return [];
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
  fixedTrackList: boolean,
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
  const parsedPromptScopeRules = coalesceAlternativeScopeRules(parsedAxisRules(prompt));
  const promptScopeRules: ParsedAxisRule[] = [];
  const audienceMarketPreferenceRules: ParsedAxisRule[] = [];
  for (const parsed of parsedPromptScopeRules) {
    if (parsed.axis !== "geography" || parsed.geographyRelationship !== "unspecified") {
      promptScopeRules.push(parsed);
      continue;
    }
    const marketValues = parsed.values.filter((value) => (
      selectionGeographyIsAudienceMarketContext(prompt, value)
    ));
    const intrinsicValues = parsed.values.filter((value) => !marketValues.includes(value));
    if (intrinsicValues.length > 0) promptScopeRules.push({ ...parsed, values: intrinsicValues });
    if (marketValues.length > 0) audienceMarketPreferenceRules.push({ ...parsed, values: marketValues });
  }
  for (const parsed of promptScopeRules) {
    add("scope", parsed.axis, parsed.operator, parsed.values, "hard", null, parsed.geographyRelationship ?? null);
  }
  // Listener location and popularity-market context should guide discovery
  // and ranking without requiring every track to prove artist origin, scene
  // membership, or recording location in that place.
  for (const parsed of audienceMarketPreferenceRules) {
    add(
      "audience_market_preference",
      parsed.axis,
      "prefer",
      parsed.values,
      "soft",
      2,
      parsed.geographyRelationship ?? null,
    );
  }
  if (selectionPromptHasInfluenceScopeSignalV1(prompt)) {
    add(
      "influence_scope_signal",
      "relationship",
      "prefer",
      [SELECTION_INFLUENCE_SCOPE_SIGNAL_V1],
      "soft",
      0,
    );
  }
  // Words such as "iconic" and "essential" express a curation preference,
  // not a demand for an independent influence/ranking claim on every track.
  // Keep the preference visible to the constraint ladder, where it can improve
  // ordering and selection when supported without emptying a catalog-rich
  // genre request. Explicit ranking/history claims remain an
  // `editorial_ranking` intent and keep their strict evidence threshold.
  if (!intents.includes("editorial_ranking")) {
    const descriptors = softEditorialDescriptors(prompt);
    if (descriptors.length > 0) {
      add("editorial_preference", "relationship", "prefer", descriptors, "soft", 1);
    }
  }

  // Subject entities are model-resolved discovery hints, not visitor-authored
  // requirements. They must never silently harden inferred places, eras,
  // scenes, languages, or subgenres (for example, a plain `House music`
  // request expanded by the model to Chicago, New York, Detroit, and the UK).
  // Raw prompt rules above and typed guidance below are the only paths that
  // may create non-relaxable semantic scope.
  const promptDefinedAxes = new Set(parsedPromptScopeRules.map((rule) => rule.axis));
  const subjectScopeRules = coalesceAlternativeScopeRules(
    unique(brief.subjectEntities)
      .flatMap((scopeText) => parsedAxisRules(scopeText))
      .filter((rule) => !promptDefinedAxes.has(rule.axis)),
  );
  let generatedPreferenceRank = 10;
  for (const parsed of subjectScopeRules) {
    add(
      "subject_preference",
      parsed.axis,
      "prefer",
      parsed.values,
      "soft",
      generatedPreferenceRank++,
      parsed.geographyRelationship ?? null,
    );
  }
  // Model-authored title/description/include prose likewise supplies useful
  // discovery hints, but cannot invent hard requirements.
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
    // A compiled fixed list already proves that its immutable artist/title
    // identities are unique. Turning the visitor's duplicate guard into an
    // open-world per-track relationship exclusion would require evidence that
    // no duplicate exists before the list can execute. Preserve the rule in
    // the interpretation summary and enforce it through fixed-list identity,
    // manifest uniqueness, and ordered Apple reconciliation instead.
    if (fixedTrackList
      && userAuthored
      && /\bduplicates?\b/iu.test(normalized(rule))) {
      continue;
    }
    const generatedRequiredComplement = !userAuthored && constraints.some((constraint) => (
      constraint.kind === "hard"
      && !["exclude", "avoid", "maximum"].includes(constraint.operator)
      && constraint.values.some((value) => ruleNamesComplement(rule, value))
    ));
    // A generated complement such as “non-French jazz unless clearly tied to
    // the French jazz scene” restates the positive French/jazz boundary. Its
    // free-form `... scene` suffix is also liable to parse as one malformed
    // scene name. The positive hard constraints already enforce the boundary,
    // so discard the entire generated complement rather than retaining a
    // synthetic avoid-rule that can reject every valid candidate.
    if (generatedRequiredComplement) continue;
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
    const resolved = effectiveGuidanceGeographyConstraint(preference);
    if (!resolved) continue;
    for (let constraintIndex = constraints.length - 1; constraintIndex >= 0; constraintIndex -= 1) {
      const existing = constraints[constraintIndex]!;
      if (existing.kind !== "hard" || existing.geographyRelationship !== "unspecified") continue;
      if (!existing.values.some((value) => selectionGeographyValuesEquivalent(value, resolved.value))) continue;
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
    if (!effectiveGuidanceGeographyConstraint(preference)) {
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
  const conditionallyAllowed = conditionallyAllowedVersionValues(scope);
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
  const preferredRequested = requested.filter((value) => !conditionallyAllowed.has(value));
  const preferenceCandidates = conditionalRemasterFallback
    ? preferredRequested.filter((value) => value !== "remaster")
    : preferredRequested.length > 0
      ? preferredRequested
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
  const languages = unique([
    brief.relationship,
    ...brief.include,
    ...brief.subjectEntities,
  ].flatMap((value) => (
    parseSelectionGeographyConstraints(value)
      .filter(({ relationship }) => relationship === "language")
      .map(({ value: language }) => language)
  )));
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
    // Language is an exact typed relationship, never an adjective substring.
    // In particular, “French jazz” is still unresolved geography/scene/
    // language scope and must not become an unsatisfiable catalog-language
    // policy before the listener answers that question.
    languages,
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

function fixedContainerIdentity(
  prompt: string,
  brief: PlaylistBrief,
): SelectionPlan["fixedContainerIdentity"] {
  const compact = prompt.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const explicit = compact.match(
    /\b(?:from|on|off)\s+(?:the\s+)?(album|ep|lp|mixtape|soundtrack|compilation|box\s+set|playlist)\s+(?:called\s+|named\s+|titled\s+)?["“]?(.+?)["”]?(?:\s+by\s+(.+?))?(?=\s*(?:,\s*(?:exactly\s+)?\d+\s+(?:songs?|tracks?)|\s+(?:with|containing)\s+\d+\s+(?:songs?|tracks?)|[.!?]|$))/iu,
  ) ?? compact.match(
    /\b(album|ep|lp|mixtape|soundtrack|compilation|box\s+set|playlist)\s+(?:called\s+|named\s+|titled\s+)?["“]?(.+?)["”]?(?:\s+by\s+(.+?))?(?=\s*(?:,\s*(?:exactly\s+)?\d+\s+(?:songs?|tracks?)|\s+(?:with|containing)\s+\d+\s+(?:songs?|tracks?)|[.!?]|$))/iu,
  );
  if (explicit) {
    const rawKind = normalized(explicit[1] ?? "");
    const name = (explicit[2] ?? "").replace(/^["“]|["”]$/gu, "").trim();
    const artistName = (explicit[3] ?? "").replace(/[.!?]+$/gu, "").trim() || null;
    if (name) {
      return {
        kind: rawKind === "playlist" ? "playlist" : "album",
        name,
        artistName,
      };
    }
  }

  const possessive = compact.match(
    /\b(?:songs?|tracks?|recordings?)\s+(?:from|on|off)\s+(.+?)['’]s\s+(.+?)(?=\s*(?:,\s*(?:exactly\s+)?\d+\s+(?:songs?|tracks?)|[.!?]|$))/iu,
  );
  if (possessive) {
    const artistName = possessive[1]!.trim();
    const name = possessive[2]!.trim();
    if (artistName && name) return { kind: "album", name, artistName };
  }

  // A fixed scope without a deterministically compiled identity must not enter
  // canonical fixed-container execution. Subject entities remain discovery
  // hints and cannot silently become an album identity.
  void brief;
  return undefined;
}

function selectionScopeKind(
  prompt: string,
  intents: readonly ResearchIntent[],
  brief: PlaylistBrief,
  hasFixedTrackList: boolean,
): SelectionScopeKind {
  if (hasFixedTrackList) return "fixed_track_list";
  if (fixedReleaseContainerScope(prompt, brief)) return "fixed_release_container";
  if (intents.includes("factual_relationship") || intents.includes("exhaustive")) return "factual_frontier";
  if (intents.includes("artist_catalogue")) return "artist_catalogue";
  return "broad_curated";
}

/**
 * Ordering prose is often contrastive (for example, "smoothly intermixed
 * rather than strict chronology"). A bare keyword check treated the rejected
 * alternative as the requested mode. Keep chronology opt-in whenever the
 * nearby phrase explicitly negates or contrasts it.
 */
function selectionOrderingMode(
  orderingPolicy: string,
): SelectionPlan["orderingPolicy"]["mode"] {
  const chronologyMentioned = /chronolog/iu.test(orderingPolicy);
  const chronologyRejected = /\b(?:rather\s+than|instead\s+of|avoid(?:ing)?|without|not|never|no)\s+(?:(?:a|an)\s+)?(?:strict(?:ly)?\s+)?chronolog/iu
    .test(orderingPolicy);
  if (chronologyMentioned && !chronologyRejected) return "chronological";
  if (/contrast/iu.test(orderingPolicy)) return "contrast";
  if (/smooth|flow|intermix/iu.test(orderingPolicy)) return "smooth";
  return "editorial";
}

const PLAYLIST_COUNT_WORDS = new Map<string, number>([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20],
  ["single", 1],
]);

const ARTIST_TRACK_LIMIT_VALUE = "(?:\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|single)";
const ARTIST_TRACK_LIMIT_PATTERNS = [
  new RegExp(`\\b(?:no\\s+more\\s+than|at\\s+most|up\\s+to|maximum(?:\\s+of)?|max(?:imum)?(?:\\s+of)?)\\s+(${ARTIST_TRACK_LIMIT_VALUE})\\s+(?:tracks?|songs?|recordings?)\\s+(?:per|from|by)\\s+(?:any\\s+(?:one\\s+)?|each\\s+|every\\s+|(?:a\\s+)?single\\s+|the\\s+same\\s+)?artist\\b`, "iu"),
  new RegExp(`\\b(?:limit|cap)\\s+(?:each|every|any)\\s+artist(?:['’]s)?\\s+(?:to|at)\\s+(${ARTIST_TRACK_LIMIT_VALUE})\\s+(?:tracks?|songs?|recordings?)?\\b`, "iu"),
  new RegExp(`\\b(${ARTIST_TRACK_LIMIT_VALUE})\\s+(?:tracks?|songs?|recordings?)\\s+(?:maximum|max)\\s+(?:per|from|by)\\s+(?:any\\s+(?:one\\s+)?|each\\s+|every\\s+|the\\s+same\\s+)?artist\\b`, "iu"),
  new RegExp(`\\b(${ARTIST_TRACK_LIMIT_VALUE})\\s+(?:tracks?|songs?|recordings?)\\s+(?:per\\s+(?:(?:each|every)\\s+)?artist|from\\s+(?:each|every)\\s+artist)\\b`, "iu"),
  new RegExp(`\\bno\\s+artist\\s+(?:should\\s+)?(?:have|gets?|appears?\\s+with)\\s+more\\s+than\\s+(${ARTIST_TRACK_LIMIT_VALUE})\\s+(?:tracks?|songs?|recordings?)\\b`, "iu"),
];

function parsedPlaylistCount(value: string | undefined): number | null {
  if (!value) return null;
  const normalizedValue = normalized(value);
  const numeric = /^\d{1,3}$/u.test(normalizedValue)
    ? Number.parseInt(normalizedValue, 10)
    : PLAYLIST_COUNT_WORDS.get(normalizedValue);
  return Number.isSafeInteger(numeric)
    && Number(numeric) >= 1
    && Number(numeric) <= EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS
    ? Number(numeric)
    : null;
}

/**
 * An explicit visitor-authored concentration ceiling is a hard constraint,
 * unlike the default broad-playlist diversity preference. Keep the grammar
 * intentionally narrow so unrelated quantities (for example, “artists from
 * no more than two countries”) cannot silently become an artist-track cap.
 */
function explicitMaximumTracksPerArtist(prompt: string): number | null {
  for (const pattern of ARTIST_TRACK_LIMIT_PATTERNS) {
    const parsed = parsedPlaylistCount(pattern.exec(prompt)?.[1]);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function createSelectionPlanV2(input: {
  prompt: string;
  brief: PlaylistBrief;
  guidancePreferences?: readonly PlaylistGuidancePreference[];
  storefront?: string;
}): SelectionPlan {
  const guidance = input.guidancePreferences ?? [];
  const intents = intentSet(input.prompt, input.brief);
  const compiledFixedTrackList = compileFixedTrackList(input.brief);
  const scopeKind = selectionScopeKind(
    input.prompt,
    intents,
    input.brief,
    compiledFixedTrackList !== null,
  );
  const compiledFixedContainerIdentity = scopeKind === "fixed_release_container"
    ? fixedContainerIdentity(input.prompt, input.brief)
    : undefined;
  const requestedTrackCount = Math.max(1, Math.floor(input.brief.targetSize?.min ?? 50));
  const reserveTrackCount = Math.max(5, Math.ceil(requestedTrackCount * 0.1));
  const fixedScope = scopeKind !== "broad_curated";
  const explicitArtistMaximum = explicitMaximumTracksPerArtist(input.prompt);
  const maxArtist = explicitArtistMaximum
    ?? (fixedScope ? null : Math.max(1, Math.ceil(requestedTrackCount * 0.15)));
  const constraints = constraintsForBrief(
    input.prompt,
    input.brief,
    guidance,
    intents,
    compiledFixedTrackList !== null,
  );
  if (explicitArtistMaximum !== null) {
    constraints.push({
      id: "artist_concentration_hard",
      axis: "artist",
      operator: "maximum",
      values: [String(explicitArtistMaximum)],
      kind: "hard",
      geographyRelationship: null,
      relaxationRank: null,
    });
  }
  const geographyConstraints: SelectionGeographyConstraint[] = uniqueGeographyConstraints(
    constraints
      .filter((constraint) => constraint.kind === "hard"
        && !["exclude", "avoid", "maximum"].includes(constraint.operator))
      .flatMap(selectionConstraintGeography),
  );
  const orderingMode = selectionOrderingMode(input.brief.orderingPolicy);

  return {
    schemaVersion: 1,
    pipelineVersion: "catalog_first_v2",
    policyVersion: PIPELINE_V2_SELECTION_PLAN_VERSION,
    intents,
    scopeKind,
    ...(compiledFixedContainerIdentity ? {
      fixedContainerIdentity: compiledFixedContainerIdentity,
    } : {}),
    ...(compiledFixedTrackList ? {
      fixedTrackList: compiledFixedTrackList,
    } : {}),
    storefront: (input.storefront ?? "us").toLocaleLowerCase("en-US"),
    requestedTrackCount,
    minimumQualifiedTrackCount: requestedTrackCount,
    reserveTrackCount,
    constraints,
    geographyConstraints,
    similarityDimensions: intents.includes("similarity") ? similarityDimensions(input.prompt) : [],
    labels: unique(input.brief.include.filter((value) => /label|imprint/iu.test(value))),
    venues: unique(input.brief.include.filter((value) => /venue|club/iu.test(value))),
    referenceRecordings: intents.includes("similarity")
      ? unique(
          excludedReferenceArtists(input.brief).length > 0
            ? excludedReferenceArtists(input.brief)
            : input.brief.subjectEntities,
        )
      : [],
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
 * Stable rollout assignment. A server-authenticated, signed owner canary may
 * use the explicit canary gates; ordinary owner identity is deliberately not
 * an execution authority. Public and ordinary-owner traffic therefore share
 * the same sticky rollout behavior. Factual and exhaustive work has a
 * separate switch because its claim/frontier benchmark graduates
 * independently of curated genre and mood playlists.
 */
export function assignPipelineV2(input: {
  plan: SelectionPlan;
  signedOwnerCanary: boolean;
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
    if (
      input.signedOwnerCanary
      && env.PIPELINE_V2_FACTUAL_OWNER_CANARY === "true"
    ) {
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
  // Signed owner canaries are an explicit operational gate. Keeping this
  // disabled by default prevents even a signed canary from creating a V2 job
  // while pre-capability workers may still be draining a rolling deployment.
  if (
    input.signedOwnerCanary
    && env.PIPELINE_V2_OWNER_CANARY === "true"
  ) {
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
    fixedTrackList: plan.fixedTrackList,
    labels: plan.labels,
    venues: plan.venues,
    diversityGoals: plan.diversityGoals,
    evidencePolicy: plan.evidencePolicy,
    versionPolicy: plan.versionPolicy,
    contentPolicy: plan.contentPolicy,
    orderingPolicy: plan.orderingPolicy,
  };
}
