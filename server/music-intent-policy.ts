import type { PlaylistBrief } from "../shared/types.ts";

const HOUSE_GENRE_ENTITY = "House music";
const HOUSE_GENRE_TITLE = "House Music";

// "House" is unusually dangerous in a music product because both meanings
// produce superficially plausible search results. Require musical grammar,
// rather than the bare word, before applying the deterministic genre repair.
const HOUSE_GENRE_INTENT = /(?:\bhouse\s+music\b|\b(?:acid|afro|afrobeat|balearic|bass|chicago|classic|deep|detroit|disco|electro|french|funky|garage|ghetto|hard|hip|italo|jackin(?:g)?|latin|lo[-\s]?fi|minimal|progressive|soulful|tech|tribal|tropical|uk)\s+house\b|\bhouse\s+(?:anthems?|classics?|cuts?|djs?|genre|mix(?:es)?|music|playlist|producers?|records?|scene|set|songs?|tracks?|tunes?)\b)/iu;
const STRONG_HOUSE_GENRE_INTENT = /(?:\bhouse\s+music\b|\b(?:acid|afro|afrobeat|balearic|bass|chicago|classic|deep|detroit|disco|electro|french|funky|garage|ghetto|hard|hip|italo|jackin(?:g)?|latin|lo[-\s]?fi|minimal|progressive|soulful|tech|tribal|tropical|uk)\s+house\b|\bhouse\s+(?:djs?|genre|producers?|scene)\b)/iu;

// These constructions explicitly select the ordinary-language meaning. They
// must remain available to someone who really wants songs about architecture,
// homes, or the television series rather than the dance-music genre.
const EXPLICIT_LITERAL_HOUSE_INTENT = /(?:\b(?:songs?|tracks?|recordings?|music)\s+(?:that\s+are\s+)?about\s+(?:a\s+|the\s+)?(?:apartments?|domestic\s+life|house|houses|home|homes|housing|architecture|buildings?|real\s+estate)\b|\babout\s+(?:(?:parisian|residential|suburban|urban)\s+)?(?:apartments?|domestic\s+life|house|houses|home|homes|housing|architecture|buildings?|real\s+estate)\b|\b(?:apartments?|architecture|domestic\s+life|homeownership|housing|real\s+estate|residential\s+buildings?)\s+(?:songs?|tracks?|playlist|music)\b|\b(?:tv|television)\s+(?:series|show)\s+["'“”]?house\b|\bhouse\s+m\.?d\.?\b)/iu;

const LITERAL_HOUSE_ENTITY = /^(?:(?:physical|residential)\s+)?(?:a\s+|the\s+)?(?:apartments?|domestic\s+life|house|houses|home|homes|housing|buildings?|architecture|real\s+estate)$/iu;
const ABOUT_HOUSES_ENTITY = /^(?:songs?|tracks?|recordings?|music)\s+about\s+(?:a\s+|the\s+)?(?:house|houses|home|homes|housing|buildings?|architecture|real\s+estate)$/iu;
const HOUSE_REQUEST_WRAPPER_ENTITY = /^house(?:\s+music)?\s+(?:anthems?|classics?|cuts?|mix(?:es)?|music|playlist|records?|scene|set|songs?|tracks?|tunes?)\b/iu;
const HOUSE_SUBGENRE_ENTITY = /\b(?:acid|afro|afrobeat|balearic|bass|chicago|classic|deep|detroit|disco|electro|french|funky|garage|ghetto|hard|hip|italo|jackin(?:g)?|latin|lo[-\s]?fi|minimal|progressive|soulful|tech|tribal|tropical|uk)\s+house\b/iu;
const LITERAL_HOUSE_TOPIC = /\b(?:apartments?|domestic\s+life|houses?|homes?|housing|architecture|buildings?|real\s+estate|residential)\b/iu;
const LITERAL_HOUSE_ASSERTION = /\b(?:about|concern(?:s|ed|ing)?|discuss(?:es|ed|ing)?|lyrics?|lyrical|mentions?|subject|themes?|thematic|titles?)\b/iu;
const HOUSE_GENRE_NEGATIVE_RULE = /\b(?:exclude|excluding|avoid|without|no|not|do\s+not)\b.{0,100}\bhouse\s+music\b|\bhouse\s+music\b.{0,100}\b(?:exclude|excluding|avoid|without|not|do\s+not)\b/iu;

export const HOUSE_GENRE_INCLUDE_RULE =
  "Recordings that are musically classified as house music or the house subgenres explicitly requested by the listener.";

export const HOUSE_LITERAL_EXCLUSION_RULE =
  "Do not select a recording merely because its title, lyrics, or subject concerns houses, homes, architecture, buildings, or real estate.";

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
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

function literalHouseEntity(value: string): boolean {
  const clean = value.normalize("NFKC").trim();
  return LITERAL_HOUSE_ENTITY.test(clean)
    || ABOUT_HOUSES_ENTITY.test(clean)
    || HOUSE_REQUEST_WRAPPER_ENTITY.test(clean);
}

function titleMisreadHouseLiterally(value: string): boolean {
  const title = normalized(value);
  return /^(?:a |the )?(?:house|houses|homes|housing)$/u.test(title)
    || /^(?:songs?|tracks?|music|playlist) (?:of |about )?(?:houses?|homes?|housing|architecture|buildings?|real estate)$/u.test(title)
    || /^(?:houses?|homes?) (?:songs?|tracks?|music|playlist)$/u.test(title);
}

function literalHousePositiveRule(value: string): boolean {
  return LITERAL_HOUSE_TOPIC.test(value) && LITERAL_HOUSE_ASSERTION.test(value);
}

/**
 * Repairs the highest-risk musical polysemy at both interpretation time and
 * the durable API boundary. Model instructions establish the general rule;
 * this narrow backstop ensures an explicit request for house music can never
 * turn into a keyword playlist about physical houses.
 *
 * Bare "house" remains untouched unless it occurs in musical grammar. An
 * explicit request for songs about houses, architecture, or House M.D. also
 * remains untouched. That keeps the repair deterministic and avoids guessing
 * when the listener genuinely used the ordinary-language meaning.
 */
export function applyMusicIntentPolicy(
  prompt: string,
  brief: PlaylistBrief,
): PlaylistBrief {
  const genreIntent = HOUSE_GENRE_INTENT.test(prompt);
  const explicitLiteralIntent = EXPLICIT_LITERAL_HOUSE_INTENT.test(prompt);
  // A weak wrapper such as "house songs about homes" remains literal. An
  // explicit genre marker ("house music", "French house", "house DJs") can
  // legitimately combine the genre and a lyrical theme, so preserve both.
  if (!genreIntent || (explicitLiteralIntent && !STRONG_HOUSE_GENRE_INTENT.test(prompt))) {
    return brief;
  }

  const dualGenreAndThemeIntent = genreIntent && explicitLiteralIntent;
  const repairedEntities = brief.subjectEntities.map((entity) => (
    literalHouseEntity(entity) && !dualGenreAndThemeIntent ? HOUSE_GENRE_ENTITY : entity.trim()
  ));
  const hasHouseGenreEntity = repairedEntities.some((entity) => (
    normalized(entity) === "house music" || HOUSE_SUBGENRE_ENTITY.test(entity)
  ));
  const subjectEntities = unique(dualGenreAndThemeIntent
    ? [HOUSE_GENRE_ENTITY, ...repairedEntities]
    : [...repairedEntities, ...(hasHouseGenreEntity ? [] : [HOUSE_GENRE_ENTITY])]);
  const include = dualGenreAndThemeIntent
    ? unique([...brief.include, HOUSE_GENRE_INCLUDE_RULE])
    : unique([
        ...brief.include.filter((rule) => !literalHousePositiveRule(rule)),
        HOUSE_GENRE_INCLUDE_RULE,
      ]);
  const staleLiteralDescription = literalHousePositiveRule(brief.description);

  return {
    ...brief,
    title: titleMisreadHouseLiterally(brief.title) ? HOUSE_GENRE_TITLE : brief.title,
    description: staleLiteralDescription
      ? dualGenreAndThemeIntent
        ? "A source-backed selection of house music recordings that also satisfy the requested theme about houses, homes, or architecture."
        : "A source-backed selection of recordings in the requested house music scope."
      : brief.description,
    subjectEntities,
    relationship: dualGenreAndThemeIntent
      ? "is a recording in the house music genre with the requested lyrical or thematic relationship to houses, homes, architecture, or domestic life"
      : "is a recording in the house music genre that satisfies the requested stylistic, geographic, historical, and editorial criteria",
    include,
    exclude: unique([
      ...brief.exclude.filter((rule) => !HOUSE_GENRE_NEGATIVE_RULE.test(rule)),
      HOUSE_LITERAL_EXCLUSION_RULE,
    ]),
  };
}
