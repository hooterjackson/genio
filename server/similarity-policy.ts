import type { PlaylistBrief } from "../shared/types.ts";

export const REFERENCE_ARTIST_EXCLUSION_PREFIX =
  "Reference artist is a style seed; exclude recordings by: ";

const SIMILARITY_INTENT =
  /\b(?:sounds?\s+(?:a\s+lot\s+)?like|similar\s+to|similar\s+(?:mode|sound|music|artists?)|resembl(?:e|es|ing)|adjacent\s+to|in\s+(?:the\s+)?(?:style|vein)\s+of|for\s+fans\s+of|artists?\s+like|music\s+like|as\s+(?:a\s+)?(?:(?:style|sonic|musical)\s+)?reference\s+point)\b/gu;

const GENERIC_ENTITY =
  /^(?:(?:the|some|any)\s+)?(?:(?:other|similar|related|adjacent|different|new|more|these|those)\s+)?(?:artists?|bands?|acts?|musicians?|songs?|tracks?|recordings?|music|playlists?)$/u;

const QUERY_FRAGMENT_PREFIX =
  /^(?:\d+\s+)?(?:songs?|tracks?|recordings?|music|playlists?|artists?|bands?|acts?)\s+(?:(?:that|which)\s+)?(?:sounds?\s+(?:a\s+lot\s+)?like|similar\s+to|resembl(?:e|es|ing)|adjacent\s+to|in\s+(?:the\s+)?(?:style|vein)\s+of|for\s+fans\s+of|like)\s+/iu;

const COMPLEMENT_BOUNDARY =
  /\s+\b(?:but|except|excluding|without|rather\s+than|instead\s+of|while)\b.*$/iu;

const CONTEXT_BOUNDARY =
  /\b(?:but|except|excluding|without|rather\s+than|instead\s+of|while)\b/u;

const DISCOVERY_AWAY_FROM_FAVORITE_INTENT =
  /\b(?:wants?\s+to\s+discover|want\s+to\s+discover|discover(?:ing)?|looking\s+for)\s+(?:new|more|different)\s+(?:artists?|music|stuff|sounds?|tracks?|songs?)\b|\bfocused?\s+on\s+new\s+artists?\b|\bwithout\s+centering\b/u;

function normalized(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function favoriteDiscoveryReferenceSeeds(
  prompt: string,
  brief: PlaylistBrief,
): string[] {
  const normalizedPrompt = normalized(prompt);
  if (!DISCOVERY_AWAY_FROM_FAVORITE_INTENT.test(normalizedPrompt)) return [];
  return brief.subjectEntities.filter((entity) => {
    const entityText = normalized(entity);
    if (!entityText) return false;
    let entityIndex = normalizedPrompt.indexOf(entityText);
    while (entityIndex >= 0) {
      const before = normalizedPrompt.slice(
        Math.max(0, entityIndex - 100),
        entityIndex,
      );
      const after = normalizedPrompt.slice(
        entityIndex + entityText.length,
        entityIndex + entityText.length + 80,
      );
      if (
        /\b(?:(?:my|his|her|their|our|the)\s+)?favou?rite\s+(?:rapper|artist|band|musician|singer|producer|group|act)?\s*(?:is|was|:)?\s*$/u
          .test(before)
        || /^\s*(?:is|was)\s+(?:(?:my|his|her|their|our|the)\s+)?favou?rite\b/u
          .test(after)
      ) return true;
      entityIndex = normalizedPrompt.indexOf(
        entityText,
        entityIndex + entityText.length,
      );
    }
    return false;
  });
}

function shorthandSimilaritySeeds(prompt: string, brief: PlaylistBrief): string[] {
  const normalizedPrompt = normalized(prompt);
  return brief.subjectEntities.filter((entity) => {
    const entityText = normalized(entity);
    if (!entityText) return false;
    // Punctuation normalization turns both “X-style” and “X-adjacent” into
    // whitespace. “X adjacent to Y” is not shorthand: Y is the reference.
    return normalizedPrompt.includes(`${entityText} style`)
      || (normalizedPrompt.includes(`${entityText} adjacent`)
        && !normalizedPrompt.includes(`${entityText} adjacent to`));
  });
}

function uniqueRules(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalized(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Structured model output can occasionally repeat request syntax as an
 * entity (for example, “tracks that sound like Radiohead”) or promote a
 * quantifier such as “other artists” to an entity. Similarity research needs
 * canonical references, so repair those shapes before selecting style seeds
 * or exposing the brief to downstream prompts.
 */
function cleanSimilaritySubjectEntities(entities: readonly string[]): string[] {
  const repaired = entities.flatMap((entity) => {
    const trimmed = entity.trim();
    const entityText = normalized(trimmed);
    if (!entityText || GENERIC_ENTITY.test(entityText)) return [];
    if (!QUERY_FRAGMENT_PREFIX.test(entityText)) return [trimmed];

    const complement = trimmed
      .normalize("NFKC")
      .replace(QUERY_FRAGMENT_PREFIX, "")
      .replace(COMPLEMENT_BOUNDARY, "")
      .replace(/[.,;:!?]+$/u, "")
      .trim();
    return complement && !GENERIC_ENTITY.test(normalized(complement)) ? [complement] : [];
  });
  return uniqueRules(repaired);
}

function similaritySeedEntities(prompt: string, brief: PlaylistBrief): string[] {
  const normalizedPrompt = normalized(prompt);
  const matches = [...normalizedPrompt.matchAll(SIMILARITY_INTENT)];
  if (matches.length === 0) {
    // Hyphenated shorthand such as “Radiohead-style” loses its punctuation
    // during normalization, so detect the confirmed entity immediately
    // followed by “style” as the same reference-artist intent.
    return shorthandSimilaritySeeds(prompt, brief);
  }
  const explicitlyExcluded = brief.subjectEntities.filter((entity) => explicitlyExcludesSeed(prompt, entity));
  if (explicitlyExcluded.length > 0) return explicitlyExcluded;

  const contextualSeeds = brief.subjectEntities.filter((entity) => {
    const entityText = normalized(entity);
    if (!entityText) return false;
    return matches.some((match) => {
      const relationEnd = (match.index ?? 0) + match[0].length;
      const entityIndex = normalizedPrompt.indexOf(entityText, relationEnd);
      if (entityIndex < relationEnd || entityIndex - relationEnd > 160) return false;
      return !CONTEXT_BOUNDARY.test(normalizedPrompt.slice(relationEnd, entityIndex));
    });
  });
  if (contextualSeeds.length > 0) return contextualSeeds;

  const precedingSeeds = brief.subjectEntities
    .map((entity) => {
      const entityText = normalized(entity);
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const match of matches) {
        const entityIndex = normalizedPrompt.lastIndexOf(entityText, match.index ?? 0);
        if (entityIndex < 0) continue;
        nearestDistance = Math.min(nearestDistance, (match.index ?? 0) - entityIndex - entityText.length);
      }
      return { entity, nearestDistance };
    })
    .filter(({ nearestDistance }) => nearestDistance >= 0 && nearestDistance <= 200)
    .sort((left, right) => left.nearestDistance - right.nearestDistance);
  if (precedingSeeds[0]) return [precedingSeeds[0].entity];

  // The brief interpreter normally emits only the reference artist for this
  // request shape. Keep a single-entity fallback for wording such as
  // “Radiohead and similar artists,” where the relationship follows the seed.
  return brief.subjectEntities.length === 1 ? [...brief.subjectEntities] : [];
}

function explicitlyExcludesSeed(prompt: string, seed: string): boolean {
  const normalizedPrompt = normalized(prompt);
  const normalizedSeed = normalized(seed);
  if (!normalizedSeed) return false;
  let seedIndex = normalizedPrompt.indexOf(normalizedSeed);
  while (seedIndex >= 0) {
    const before = normalizedPrompt.slice(Math.max(0, seedIndex - 180), seedIndex);
    const after = normalizedPrompt.slice(seedIndex + normalizedSeed.length, seedIndex + normalizedSeed.length + 120);
    if (
      /\b(?:exclude|excluding|without|avoid|omit|no|don\s+t|do\s+not|already\s+know)\b/u.test(before)
      || /\b(?:exclude|excluding|already\s+know|already\s+have)\b/u.test(after)
    ) return true;
    seedIndex = normalizedPrompt.indexOf(normalizedSeed, seedIndex + normalizedSeed.length);
  }
  return false;
}

function explicitlyIncludesSeed(prompt: string, seed: string): boolean {
  const normalizedPrompt = normalized(prompt);
  const normalizedSeed = normalized(seed);
  if (!normalizedSeed) return false;
  let seedIndex = normalizedPrompt.indexOf(normalizedSeed);
  while (seedIndex >= 0) {
    const before = normalizedPrompt.slice(Math.max(0, seedIndex - 100), seedIndex);
    const after = normalizedPrompt.slice(seedIndex + normalizedSeed.length, seedIndex + normalizedSeed.length + 80);
    if (
      /\b(?:include|including|feature|featuring)(?:\s+(?:songs?|tracks?|music|recordings?)\s+(?:by|from))?\s*$/u.test(before)
      || /\b(?:songs?|tracks?|music|recordings?)\s+by\s*$/u.test(before)
      || /\b(?:mix|combine|blend)(?:\s+(?:in|with))?\s*$/u.test(before)
      || /^\s*(?:songs?|tracks?|music|recordings?)\b/u.test(after)
    ) return true;
    seedIndex = normalizedPrompt.indexOf(normalizedSeed, seedIndex + normalizedSeed.length);
  }
  return false;
}

function normalizedPrimaryArtistCredits(value: string): string[] {
  const primaryCredits = value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .split(/\b(?:feat(?:uring)?|ft|with)\.?\b/u, 1)[0] ?? "";
  return primaryCredits
    .replace(/\band\b/gu, "|")
    .replace(/[&,/+]/gu, "|")
    .split("|")
    // Treat a spaced “x” as a collaboration delimiter without erasing the
    // real artist named X. This also preserves punctuation-only artist names
    // such as !!! long enough for the exact-identity fallback below.
    .flatMap((credit) => credit.split(/\s+x\s+/gu))
    .map((credit) => normalized(credit) || credit.normalize("NFKC").trim().replace(/\s+/gu, " "))
    .filter(Boolean);
}

/**
 * “Music that sounds like X” uses X as a reference, not as the requested
 * recording artist. The model receives the same rule, but this deterministic
 * repair keeps the persisted brief safe when the model responds loosely.
 */
export function applySimilaritySeedPolicy(prompt: string, brief: PlaylistBrief): PlaylistBrief {
  if (brief.mode === "exhaustive") return brief;
  const structuredRelationship = normalized(brief.relationship);
  const structuredExcludedSeeds = /\b(?:style|stylistic)\s+reference\b|\bstylistically\s+similar\b/u
      .test(structuredRelationship)
    ? brief.subjectEntities.filter((entity) => explicitlyExcludesSeed(prompt, entity))
    : [];
  const hasSimilarityIntent = [...normalized(prompt).matchAll(SIMILARITY_INTENT)].length > 0
    || shorthandSimilaritySeeds(prompt, brief).length > 0
    // The interpreter can correctly classify natural wording such as
    // “for listeners who love X, but include no X” as a style reference even
    // when it does not contain one of the fixed similarity phrases above.
    // Trust that typed relationship only when the prompt also explicitly
    // excludes a confirmed entity, so direct artist requests cannot be
    // reclassified accidentally.
    || structuredExcludedSeeds.length > 0
    || favoriteDiscoveryReferenceSeeds(prompt, brief).length > 0;
  if (!hasSimilarityIntent) return brief;

  const subjectEntities = cleanSimilaritySubjectEntities(brief.subjectEntities);
  const scopedBrief = subjectEntities.length > 0
    ? { ...brief, subjectEntities }
    : brief;
  const seeds = structuredExcludedSeeds.length > 0
    ? structuredExcludedSeeds
    : favoriteDiscoveryReferenceSeeds(prompt, scopedBrief).length > 0
      ? favoriteDiscoveryReferenceSeeds(prompt, scopedBrief)
      : similaritySeedEntities(prompt, scopedBrief);
  if (seeds.length === 0) return scopedBrief;
  const excludedSeeds = seeds.filter((seed) => (
    explicitlyExcludesSeed(prompt, seed) || !explicitlyIncludesSeed(prompt, seed)
  ));
  if (excludedSeeds.length === 0) return scopedBrief;

  return {
    ...scopedBrief,
    relationship: "stylistically similar to the reference artist",
    include: uniqueRules([
      ...scopedBrief.include.filter((rule) => !excludedSeeds.some((seed) => {
        const ruleText = normalized(rule);
        const seedText = normalized(seed);
        return ruleText.includes(`${seedText} recordings`)
          || ruleText.includes(`${seedText} songs`)
          || ruleText.includes(`${seedText} tracks`)
          || ruleText.includes(`music by ${seedText}`);
      })),
      `Recordings by other artists that are stylistically similar to ${excludedSeeds.join(", ")}`,
    ]),
    exclude: uniqueRules([
      ...scopedBrief.exclude,
      ...excludedSeeds.map((seed) => `${REFERENCE_ARTIST_EXCLUSION_PREFIX}${seed}`),
    ]),
  };
}

export function excludedReferenceArtists(
  brief: Partial<Pick<PlaylistBrief, "exclude">>,
): string[] {
  return (brief.exclude ?? [])
    .filter((rule) => rule.startsWith(REFERENCE_ARTIST_EXCLUSION_PREFIX))
    .map((rule) => rule.slice(REFERENCE_ARTIST_EXCLUSION_PREFIX.length).trim())
    .filter(Boolean);
}

export function isExcludedReferenceArtist(
  brief: Partial<Pick<PlaylistBrief, "exclude">>,
  artist: string,
): boolean {
  return excludedReferenceArtists(brief)
    .some((seed) => artistCreditMatchesPrimaryArtist(artist, seed));
}

/**
 * A similarity seed excludes the named artist only when the catalog credit
 * makes that artist primary or co-primary. An explicit `feat.`, `ft.`, or
 * `with` boundary leaves later credits eligible, matching the user-visible
 * promise that featured appearances may still be discovered.
 */
export function artistCreditMatchesPrimaryArtist(
  artist: string,
  expectedPrimaryArtist: string,
): boolean {
  const seedIdentity = normalized(expectedPrimaryArtist)
    || expectedPrimaryArtist.normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .trim()
      .replace(/\s+/gu, " ");
  return Boolean(
    seedIdentity
    && normalizedPrimaryArtistCredits(artist).includes(seedIdentity),
  );
}

export function similarityResearchInstruction(
  brief: Partial<Pick<PlaylistBrief, "exclude">>,
): string {
  const seeds = excludedReferenceArtists(brief);
  if (seeds.length === 0) return "";
  return ` The confirmed scope uses ${seeds.join(", ")} only as a style reference. Treat the reference-artist exclusion as a hard rule: return recordings by other artists, never recordings whose primary artist is one of those reference artists.`;
}
