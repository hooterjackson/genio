import type {
  SelectionConstraint,
  SelectionGeographyConstraint,
  SelectionGeographyRelationship,
  SelectionPlan,
  TrackScopeBinding,
} from "../shared/types.ts";
import { normalizeMusicText } from "../lib/matching.ts";

type GeographyBindingProof = Pick<
  TrackScopeBinding,
  "scopeAxis" | "scopeValue" | "geographyRelationship" | "provenancePath" | "relationship" | "note"
>;

export const SELECTION_GEOGRAPHY_RELATIONSHIPS = new Set<SelectionGeographyRelationship>([
  "artist_origin",
  "artist_residence",
  "recording_location",
  "label_or_venue_scene",
  "language",
  "sound_association",
  "unspecified",
]);

export const SELECTION_GEOGRAPHY_TERMS: ReadonlyArray<readonly [string, RegExp]> = [
  ["American", /\b(?:american|united states|usa)\b/iu],
  // Preserve case for the ambiguous pronoun "us". Only an explicitly
  // capitalized US/U.S. immediately scoping music is geographic.
  ["American", /\bU\.?S\.?(?=\s+(?:music|songs?|tracks?|recordings?|artists?|rap|hip[ -]?hop|r\s*(?:&|and)\s*b|jazz|rock|pop|country|drill|house|techno|scene|genre))\b/u],
  ["Brazilian", /\b(?:brazilian|brazil|brasil)\b/iu],
  ["French", /(?:\bfrench\b(?![ -]language)|\bfrance\b)/iu],
  ["German", /(?:\bgerman\b(?![ -]language)|\bgermany\b)/iu],
  ["Japanese", /(?:\bjapanese\b(?![ -]language)|\bjapan\b)/iu],
  ["Irish", /\b(?:irish|ireland)\b/iu],
  ["British", /\b(?:british|united kingdom|u\.?k\.?)\b/iu],
  ["Berlin", /\bberlin\b/iu],
  ["Detroit", /\bdetroit\b/iu],
  ["Chicago", /\bchicago\b/iu],
  ["New York", /\bnew york\b/iu],
  ["Rio de Janeiro", /\brio de janeiro\b/iu],
  ["Paris", /\bparis\b/iu],
];

export const SELECTION_LANGUAGE_TERMS: ReadonlyArray<readonly [string, RegExp]> = [
  ["English", /(?:\benglish[ -]language\b|\b(?:sung|lyrics?|vocals?)\s+(?:primarily\s+)?(?:in\s+)?english\b)/iu],
  ["French", /(?:\bfrench[ -]language\b|\b(?:sung|lyrics?|vocals?)\s+(?:primarily\s+)?(?:in\s+)?french\b)/iu],
  ["Portuguese", /(?:\bportuguese[ -]language\b|\b(?:sung|lyrics?|vocals?)\s+(?:primarily\s+)?(?:in\s+)?portuguese\b)/iu],
  ["Spanish", /(?:\bspanish[ -]language\b|\b(?:sung|lyrics?|vocals?)\s+(?:primarily\s+)?(?:in\s+)?spanish\b)/iu],
  ["German", /(?:\bgerman[ -]language\b|\b(?:sung|lyrics?|vocals?)\s+(?:primarily\s+)?(?:in\s+)?german\b)/iu],
  ["Japanese", /(?:\bjapanese[ -]language\b|\b(?:sung|lyrics?|vocals?)\s+(?:primarily\s+)?(?:in\s+)?japanese\b)/iu],
  ["Arabic", /(?:\barabic[ -]language\b|\b(?:sung|lyrics?|vocals?)\s+(?:primarily\s+)?(?:in\s+)?arabic\b)/iu],
];

const PLACE_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  american: ["american", "united states", "usa", "us"],
  brazilian: ["brazilian", "brazil", "brasil"],
  french: ["french", "france"],
  german: ["german", "germany"],
  japanese: ["japanese", "japan"],
  irish: ["irish", "ireland"],
  british: ["british", "united kingdom", "uk"],
  berlin: ["berlin"],
  detroit: ["detroit"],
  chicago: ["chicago"],
  "new york": ["new york", "nyc"],
  "rio de janeiro": ["rio de janeiro", "rio"],
  paris: ["paris"],
});

function normalized(value: string): string {
  return normalizeMusicText(value).replace(/\s+/gu, " ").trim();
}

function aliasesFor(value: string): string[] {
  const key = normalized(value);
  const family = PLACE_ALIASES[key]
    ?? Object.values(PLACE_ALIASES).find((aliases) => (
      aliases.some((alias) => normalized(alias) === key)
    ));
  return [...new Set(family ?? [key])].filter(Boolean);
}

function escapedPhrase(value: string): string {
  return normalized(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");
}

/**
 * A place can describe the listener or popularity market without describing
 * the recordings themselves. “Disco a listener in Brazil may have heard” and
 * “international hits popular in Brazil” must therefore remain curation
 * preferences: neither phrase means Brazilian artists, the Brazilian scene,
 * or recordings made in Brazil.
 *
 * This intentionally applies only to otherwise-unspecified place mentions.
 * Explicit artist-origin, residence, recording-location, language, scene, and
 * sound relationships are classified before this helper is consulted. A
 * direct demonym + music-scope phrase (for example, “Brazilian disco”) also
 * remains intrinsic and non-relaxable.
 */
export function selectionGeographyIsAudienceMarketContext(
  text: string,
  value: string,
): boolean {
  const source = normalized(text);
  const aliases = aliasesFor(value).map(escapedPhrase);
  const primary = escapedPhrase(value);
  const musicScope = "(?:music|songs?|tracks?|recordings?|artists?|disco|house|jazz|techno|drill|funk|ambient|footwork|hip[ -]?hop|rock|samba|bossa|soul|metal|punk|reggae|classical|country|electronic)";

  // Demonym-scoped music is about the recording pool, not merely its target
  // audience. Country-noun titles such as “Brazil Disco Nights” are left to
  // the explicit popularity/listener prose below because they are frequently
  // display names rather than origin claims.
  const hasIntrinsicScope = new RegExp(`\\b${primary}\\s+${musicScope}\\b`, "iu").test(source)
    || aliases.some((alias) => new RegExp(
      `\\b(?:${musicScope})\\s+(?:from|originating\\s+in|recorded\\s+in)\\s+(?:the\\s+)?${alias}\\b`,
      "iu",
    ).test(source));
  if (hasIntrinsicScope) return false;

  return aliases.some((alias) => [
    // The place modifies a listener, audience, or recollection.
    `\\b(?:listeners?|audiences?|clubgoers?|people|fans?|residents?|someone|anyone|a\\s+\\d{1,3}[ -]year[ -]old\\s+listener)\\s+(?:based\\s+|living\\s+)?in\\s+(?:the\\s+)?${alias}\\b`,
    // The place is a market in which global recordings were heard or popular.
    `\\b(?:popular|heard|listened\\s+to|known|recognizable|recognised|recognized|played|broadcast|charted|successful|familiar|widely\\s+heard|radio\\s+hits?)\\s+(?:among\\s+[^.;,!?:]{0,40}\\s+)?in\\s+(?:the\\s+)?${alias}\\b`,
    `\\b(?:popular|heard|listened\\s+to|known|recognizable|recognised|recognized|played|broadcast|charted|successful|familiar)\\s+(?:among|with)\\s+(?:the\\s+)?${alias}\\s+(?:audience|listeners?|public|clubgoers?|market)\\b`,
    // Biographical listener context such as “my father listened to these
    // while growing up in Brazil” describes exposure, not recording origin.
    `\\b(?:heard|listened\\s+to|played|remembered)\\b[^.;!?]{0,100}\\b(?:growing\\s+up|living|partying|clubbing|going\\s+to\\s+(?:night\\s+)?clubs?)\\s+in\\s+(?:the\\s+)?${alias}\\b`,
    `\\b(?:grew|growing)\\s+up\\s+in\\s+(?:the\\s+)?${alias}\\b`,
    `\\b${alias}\\s+(?:audience|listeners?|public|market|charts?|airplay|radio|nightlife)\\b`,
    `\\b(?:market|charts?|airplay|radio|nightlife|club\\s+culture)\\s+in\\s+(?:the\\s+)?${alias}\\b`,
  ].some((pattern) => new RegExp(pattern, "iu").test(source)));
}

/** Treat country adjectives and country names as the same geographic value. */
export function selectionGeographyValuesEquivalent(left: string, right: string): boolean {
  const rightAliases = new Set(aliasesFor(right));
  return aliasesFor(left).some((alias) => rightAliases.has(alias));
}

function phrasePresent(text: string, phrase: string): boolean {
  return ` ${normalized(text)} `.includes(` ${normalized(phrase)} `);
}

function nearAlias(text: string, aliases: readonly string[], before: string, after: string): boolean {
  return aliases.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");
    return new RegExp(`(?:${before})\\s{0,4}${escaped}(?:${after})`, "iu").test(text);
  });
}

/**
 * Infer only relationships explicitly stated by the listener. A bare
 * adjective such as “French jazz” stays `unspecified`; the question scout can
 * then ask a material scene/origin/language/location fork instead of silently
 * choosing one meaning.
 */
export function inferSelectionGeographyRelationship(
  text: string,
  value: string,
): SelectionGeographyRelationship {
  const source = normalized(text);
  const aliases = aliasesFor(value);

  if (nearAlias(source, aliases,
    "(?:recorded|tracked|captured|made|produced|sessions?|recordings?)\\s+(?:at|in|inside)",
    "(?:\\s+(?:studios?|venues?|clubs?))?")) return "recording_location";
  if (nearAlias(source, aliases,
    "(?:artists?|musicians?|performers?|producers?)\\s+(?:based|living|residing)\\s+in|(?:based|living|residing)\\s+in",
    "")) return "artist_residence";
  if (nearAlias(source, aliases,
    "(?:artists?|musicians?|performers?|producers?)\\s+(?:from|born\\s+in|originating\\s+in)|(?:born|raised)\\s+in",
    "")) return "artist_origin";
  if (aliases.some((alias) => phrasePresent(source, `${alias} artists`)
      || phrasePresent(source, `${alias} musicians`)
      || phrasePresent(source, `${alias} producers`))) return "artist_origin";
  if (aliases.some((alias) => [
    `${alias} scene`,
    `${alias} music scene`,
    `${alias} jazz scene`,
    `${alias} labels`,
    `${alias} label`,
    `${alias} venues`,
    `${alias} venue`,
    `${alias} clubs`,
    `${alias} club scene`,
  ].some((phrase) => phrasePresent(source, phrase)))) return "label_or_venue_scene";
  if (aliases.some((alias) => [
    `${alias} sound`,
    `${alias} style`,
    `${alias} sounding`,
    `inspired by ${alias}`,
    `associated with the ${alias} sound`,
  ].some((phrase) => phrasePresent(source, phrase)))) return "sound_association";
  return "unspecified";
}

export function parseSelectionGeographyConstraints(text: string): SelectionGeographyConstraint[] {
  const languages = SELECTION_LANGUAGE_TERMS
    .filter(([, pattern]) => pattern.test(text))
    .map(([value]) => ({ value, relationship: "language" as const }));
  // “Tracks in Arabic and French” is an explicit multilingual requirement,
  // even though a bare adjective such as “French jazz” must remain a
  // geography ambiguity. Require at least two coordinated language names so
  // phrases such as “jazz in French clubs” are not misclassified.
  const languageNames = SELECTION_LANGUAGE_TERMS.map(([value]) => value);
  const coordinated = text.match(
    /\bin\s+((?:english|french|portuguese|spanish|german|japanese|arabic)(?:\s*(?:,|and|or|\/)\s*(?:english|french|portuguese|spanish|german|japanese|arabic))+)/iu,
  )?.[1] ?? "";
  for (const value of languageNames) {
    if (new RegExp(`\\b${value}\\b`, "iu").test(coordinated)) {
      languages.push({ value, relationship: "language" as const });
    }
  }
  const withoutLanguage = text
    .replace(/\b(?:english|french|portuguese|spanish|german|japanese|arabic)[ -]language\b/giu, " ")
    .replace(/\b(?:sung|lyrics?|vocals?)\s+(?:primarily\s+)?(?:in\s+)?(?:english|french|portuguese|spanish|german|japanese|arabic)\b/giu, " ");
  const places = SELECTION_GEOGRAPHY_TERMS
    .filter(([, pattern]) => pattern.test(withoutLanguage))
    .map(([value]) => ({
      value,
      relationship: inferSelectionGeographyRelationship(withoutLanguage, value),
    }));
  return uniqueGeographyConstraints([...languages, ...places]);
}

export function uniqueGeographyConstraints(
  values: readonly SelectionGeographyConstraint[],
): SelectionGeographyConstraint[] {
  const seen = new Set<string>();
  return values.filter((constraint) => {
    const key = `${normalized(constraint.value)}:${constraint.relationship}`;
    if (!normalized(constraint.value) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function selectionConstraintGeography(
  constraint: Pick<SelectionConstraint, "axis" | "values" | "geographyRelationship">,
): SelectionGeographyConstraint[] {
  if (constraint.axis === "language") {
    return constraint.values.map((value) => ({ value, relationship: "language" }));
  }
  if (!["geography", "scene", "label", "venue"].includes(constraint.axis)) return [];
  // A generic scene/label/venue rule is not automatically geographic. Only
  // the prompt parser or a guided answer may attach place semantics.
  if (!constraint.geographyRelationship) return [];
  const relationship = constraint.geographyRelationship;
  return constraint.values.map((value) => ({ value, relationship }));
}

/** Exact semantic proof: mentioning France alone cannot prove “recorded in France”. */
export function proofSupportsSelectionGeography(
  proofText: string,
  constraint: SelectionGeographyConstraint,
): boolean {
  if (!aliasesFor(constraint.value).some((alias) => phrasePresent(proofText, alias))) return false;
  if (constraint.relationship === "unspecified") return true;
  if (constraint.relationship === "language") {
    return SELECTION_LANGUAGE_TERMS.some(([value, pattern]) => (
      normalized(value) === normalized(constraint.value) && pattern.test(proofText)
    ));
  }
  return inferSelectionGeographyRelationship(proofText, constraint.value) === constraint.relationship;
}

export function bindingGeographyRelationship(
  binding: Pick<
    GeographyBindingProof,
    "scopeAxis" | "geographyRelationship" | "provenancePath" | "relationship" | "note"
  >,
): SelectionGeographyRelationship | null {
  if (binding.geographyRelationship && SELECTION_GEOGRAPHY_RELATIONSHIPS.has(binding.geographyRelationship)) {
    return binding.geographyRelationship;
  }
  const persisted = binding.provenancePath.find((step) => step.kind === "geography_relationship")?.id;
  if (persisted && SELECTION_GEOGRAPHY_RELATIONSHIPS.has(persisted as SelectionGeographyRelationship)) {
    return persisted as SelectionGeographyRelationship;
  }
  if (binding.scopeAxis === "language") return "language";
  return null;
}

export function provenancePathWithGeographyRelationship(
  path: TrackScopeBinding["provenancePath"],
  relationship: SelectionGeographyRelationship | null | undefined,
): TrackScopeBinding["provenancePath"] {
  const retained = path.filter((step) => step.kind !== "geography_relationship");
  return relationship
    ? [...retained, { kind: "geography_relationship", id: relationship }]
    : retained;
}

function bindingValueMatches(binding: GeographyBindingProof, value: string): boolean {
  return aliasesFor(value).some((alias) => phrasePresent(binding.scopeValue, alias)
    || phrasePresent(binding.relationship, alias)
    || phrasePresent(binding.note, alias));
}

/**
 * Values inside one semantic relationship are alternatives for an individual
 * track. Distinct relationships remain conjunctive: a request for artists
 * from Brazil recorded in France must prove both, while “Brazilian or French”
 * may be satisfied by either value. Playlist-level selection can still use
 * diversity goals to represent every requested alternative across the set.
 */
export function selectionGeographyBindingsSatisfied(
  plan: Pick<SelectionPlan, "geographyConstraints"> & Partial<Pick<SelectionPlan, "policyVersion">>,
  bindings: readonly GeographyBindingProof[],
): boolean {
  const constraints = Array.isArray(plan.geographyConstraints) ? plan.geographyConstraints : [];
  const bindingSatisfies = (constraint: SelectionGeographyConstraint) => bindings.some((binding) => {
    if (!bindingValueMatches(binding, constraint.value)) return false;
    if (constraint.relationship === "unspecified") {
      return ["geography", "scene", "genre_scene"].includes(binding.scopeAxis);
    }
    return bindingGeographyRelationship(binding) === constraint.relationship;
  });
  const languageConstraints = constraints.filter((constraint) => constraint.relationship === "language");
  const placeConstraints = constraints.filter((constraint) => constraint.relationship !== "language");
  // Preserve the exact persisted semantics of pre-r2 runs. Their place
  // constraints were conjunctive even when several values shared one
  // relationship; changing that behavior mid-run would violate the immutable
  // policy snapshot contract.
  if (plan.policyVersion !== "relevance_first_2026_07_r2") {
    return placeConstraints.every(bindingSatisfies)
      && (languageConstraints.length === 0 || languageConstraints.some(bindingSatisfies));
  }
  const byRelationship = new Map<SelectionGeographyRelationship, SelectionGeographyConstraint[]>();
  for (const constraint of constraints) {
    const group = byRelationship.get(constraint.relationship) ?? [];
    group.push(constraint);
    byRelationship.set(constraint.relationship, group);
  }
  return [...byRelationship.values()].every((alternatives) => alternatives.some(bindingSatisfies));
}
