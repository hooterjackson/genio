export const HISTORICAL_INFLUENCE_SEMANTIC_CLASSIFIER_VERSION_V1 =
  "historical_influence_semantics_v1" as const;

export type HistoricalInfluenceSemanticMatchV1 =
  | "influence_term"
  | "historical_change_phrase"
  | "history_scope"
  | "none";

export interface HistoricalInfluenceSemanticClassificationV1 {
  readonly version:
    typeof HISTORICAL_INFLUENCE_SEMANTIC_CLASSIFIER_VERSION_V1;
  readonly matched: boolean;
  readonly match: HistoricalInfluenceSemanticMatchV1;
}

/**
 * These words can be useful curation preferences, but none independently
 * asserts documented historical influence. Keeping the list next to the
 * positive classifier prevents preliminary, V2, and canonical compilers from
 * quietly growing different meanings for the editorial-influence route.
 */
export const SOFT_EDITORIAL_DESCRIPTOR_TERMS_V1 = Object.freeze([
  "best",
  "canonical",
  "classic",
  "definitive",
  "essential",
  "greatest",
  "iconic",
  "important",
  "ranked",
  "ranking",
  "representative",
  "top",
] as const);

const HISTORICAL_INFLUENCE_TERMS_V1 = Object.freeze([
  "influence",
  "influential",
  "foundational",
  "landmark",
  "seminal",
] as const);

const HISTORICAL_CHANGE_VERBS_V1 = new Set([
  "changed",
  "redefined",
  "revolutionized",
  "shaped",
  "transformed",
]);

const HISTORICAL_CHANGE_SUBJECTS_V1 = new Set([
  "culture",
  "genre",
  "history",
  "music",
  "scene",
  "sound",
  "world",
]);

/**
 * A historical-change verb may directly modify a named musical form rather
 * than the generic words above ("women who shaped Detroit techno"). Keep this
 * as a versioned musical vocabulary—not a protected-prompt expression—so V2,
 * V3, and canonical compilation preserve the same editorial-ranking intent.
 */
const HISTORICAL_CHANGE_MUSIC_CONTEXTS_V1 = new Set([
  "ambient",
  "classical",
  "country",
  "dembow",
  "disco",
  "drill",
  "electronic",
  "footwork",
  "funk",
  "garage",
  "grime",
  "hiphop",
  "house",
  "jazz",
  "metal",
  "punk",
  "rap",
  "reggae",
  "reggaeton",
  "rock",
  "samba",
  "soul",
  "techno",
]);

function normalizedWords(value: string): string[] {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/gu)
    .filter(Boolean);
}

function boundedEditDistance(left: string, right: string): number {
  const prior = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = prior[0]!;
    prior[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const old = prior[rightIndex]!;
      prior[rightIndex] = Math.min(
        prior[rightIndex]! + 1,
        prior[rightIndex - 1]! + 1,
        diagonal + (
          left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
        ),
      );
      diagonal = old;
    }
  }
  return prior[right.length]!;
}

function matchesInfluenceTerm(word: string): boolean {
  return HISTORICAL_INFLUENCE_TERMS_V1.some((candidate) => (
    word === candidate
    || (
      word.length >= 7
      && Math.abs(word.length - candidate.length) <= 1
      && boundedEditDistance(word, candidate) <= 1
    )
  ));
}

/**
 * General, versioned historical-influence semantics shared by every compiler
 * boundary. Typo tolerance is deliberately narrow and applies only to long
 * positive influence terms, so `Infuential` remains valid without turning
 * ordinary superlatives or catalog/version words into historical claims.
 */
export function classifyHistoricalInfluenceSemanticsV1(
  value: string,
): HistoricalInfluenceSemanticClassificationV1 {
  const words = normalizedWords(value);
  if (words.some(matchesInfluenceTerm)) {
    return {
      version: HISTORICAL_INFLUENCE_SEMANTIC_CLASSIFIER_VERSION_V1,
      matched: true,
      match: "influence_term",
    };
  }
  const wordSet = new Set(words);
  if (
    words.some((word) => HISTORICAL_CHANGE_VERBS_V1.has(word))
    && words.some((word) => (
      HISTORICAL_CHANGE_SUBJECTS_V1.has(word)
      || HISTORICAL_CHANGE_MUSIC_CONTEXTS_V1.has(word)
    ))
  ) {
    return {
      version: HISTORICAL_INFLUENCE_SEMANTIC_CLASSIFIER_VERSION_V1,
      matched: true,
      match: "historical_change_phrase",
    };
  }
  if (wordSet.has("history") && wordSet.has("of")) {
    return {
      version: HISTORICAL_INFLUENCE_SEMANTIC_CLASSIFIER_VERSION_V1,
      matched: true,
      match: "history_scope",
    };
  }
  return {
    version: HISTORICAL_INFLUENCE_SEMANTIC_CLASSIFIER_VERSION_V1,
    matched: false,
    match: "none",
  };
}

export function hasHistoricalInfluenceSemanticsV1(value: string): boolean {
  return classifyHistoricalInfluenceSemanticsV1(value).matched;
}

export function softEditorialDescriptorTermsV1(value: string): string[] {
  const allowed = new Set<string>(SOFT_EDITORIAL_DESCRIPTOR_TERMS_V1);
  return [...new Set(normalizedWords(value).filter((word) => (
    allowed.has(word)
  )))];
}
