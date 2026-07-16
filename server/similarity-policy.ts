import type { PlaylistBrief } from "../shared/types.ts";

export const REFERENCE_ARTIST_EXCLUSION_PREFIX =
  "Reference artist is a style seed; exclude recordings by: ";

const SIMILARITY_INTENT =
  /\b(?:sounds?\s+(?:a\s+lot\s+)?like|similar\s+to|similar\s+(?:mode|sound|music|artists?)|resembl(?:e|es|ing)|adjacent\s+to|in\s+(?:the\s+)?(?:style|vein)\s+of|for\s+fans\s+of|artists?\s+like|music\s+like)\b/gu;

const GENERIC_ENTITY =
  /^(?:(?:the|some|any)\s+)?(?:(?:other|similar|related|adjacent|different|new|more|these|those)\s+)?(?:artists?|bands?|acts?|musicians?|songs?|tracks?|recordings?|music|playlists?)$/u;

const QUERY_FRAGMENT_PREFIX =
  /^(?:\d+\s+)?(?:songs?|tracks?|recordings?|music|playlists?|artists?|bands?|acts?)\s+(?:(?:that|which)\s+)?(?:sounds?\s+(?:a\s+lot\s+)?like|similar\s+to|resembl(?:e|es|ing)|adjacent\s+to|in\s+(?:the\s+)?(?:style|vein)\s+of|for\s+fans\s+of|like)\s+/iu;

const COMPLEMENT_BOUNDARY =
  /\s+\b(?:but|except|excluding|without|rather\s+than|instead\s+of|while)\b.*$/iu;

const CONTEXT_BOUNDARY =
  /\b(?:but|except|excluding|without|rather\s+than|instead\s+of|while)\b/u;

function normalized(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
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
    return brief.subjectEntities.filter((entity) => {
      const entityText = normalized(entity);
      return Boolean(entityText && normalizedPrompt.includes(`${entityText} style`));
    });
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

function normalizedArtistCredits(value: string): string[] {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/\b(?:feat(?:uring)?|ft|with|and|x)\.?\b/gu, "|")
    .replace(/[&,/+]/gu, "|")
    .split("|")
    .map((credit) => normalized(credit))
    .filter(Boolean);
}

/**
 * “Music that sounds like X” uses X as a reference, not as the requested
 * recording artist. The model receives the same rule, but this deterministic
 * repair keeps the persisted brief safe when the model responds loosely.
 */
export function applySimilaritySeedPolicy(prompt: string, brief: PlaylistBrief): PlaylistBrief {
  if (brief.mode === "exhaustive") return brief;
  const hasSimilarityIntent = [...normalized(prompt).matchAll(SIMILARITY_INTENT)].length > 0
    || brief.subjectEntities.some((entity) => normalized(prompt).includes(`${normalized(entity)} style`));
  if (!hasSimilarityIntent) return brief;

  const subjectEntities = cleanSimilaritySubjectEntities(brief.subjectEntities);
  const scopedBrief = subjectEntities.length > 0
    ? { ...brief, subjectEntities }
    : brief;
  const seeds = similaritySeedEntities(prompt, scopedBrief);
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
  const candidateCredits = normalizedArtistCredits(artist);
  return candidateCredits.length > 0 && excludedReferenceArtists(brief)
    .some((seed) => candidateCredits.includes(normalized(seed)));
}

export function similarityResearchInstruction(
  brief: Partial<Pick<PlaylistBrief, "exclude">>,
): string {
  const seeds = excludedReferenceArtists(brief);
  if (seeds.length === 0) return "";
  return ` The confirmed scope uses ${seeds.join(", ")} only as a style reference. Treat the reference-artist exclusion as a hard rule: return recordings by other artists, never recordings whose primary artist is one of those reference artists.`;
}
