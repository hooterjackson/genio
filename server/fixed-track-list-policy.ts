import type {
  CatalogSong,
  PlaylistBrief,
  SelectionFixedTrackIdentity,
} from "../shared/types.ts";

const ORDER_IS_IMMUTABLE =
  /\b(?:exact|same|specified|provided|requested|listed|original|user[- ]specified)\b[^.\n]{0,80}\border\b|\border\b[^.\n]{0,80}\b(?:exact|same|specified|provided|requested|listed|original|user[- ]specified)\b/iu;

function normalizedIdentityText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function parseFixedTrack(value: string): SelectionFixedTrackIdentity | null {
  const match = value.normalize("NFKC").trim().match(/^(.+?)\s+(?:—|–|-)\s+(.+)$/u);
  if (!match) return null;
  const artist = match[1]!.trim();
  const title = match[2]!.trim();
  if (!artist || !title) return null;
  return { artist, title };
}

/**
 * Compile only an unambiguous closed artist/title list. A list is fixed when
 * its exact count equals the number of typed pairs and the brief explicitly
 * preserves the supplied order. Broad include examples must never enter this
 * path merely because they happen to contain a dash.
 */
export function compileFixedTrackList(
  brief: PlaylistBrief,
): SelectionFixedTrackIdentity[] | null {
  const minimum = Number(brief.targetSize?.min);
  const maximum = Number(brief.targetSize?.max);
  if (brief.mode !== "curated"
    || !Number.isInteger(minimum)
    || minimum < 1
    || minimum !== maximum
    || brief.include.length !== minimum
    || !ORDER_IS_IMMUTABLE.test(`${brief.relationship} ${brief.orderingPolicy}`)) {
    return null;
  }
  const entries = brief.include.map(parseFixedTrack);
  if (entries.some((entry) => entry === null)) return null;
  const fixed = entries as SelectionFixedTrackIdentity[];
  const identities = new Set(fixed.map((entry) => (
    `${normalizedIdentityText(entry.artist)}\u0000${normalizedIdentityText(entry.title)}`
  )));
  return identities.size === fixed.length ? fixed : null;
}

export function fixedTrackListEntryIndex(
  entries: readonly SelectionFixedTrackIdentity[],
  candidate: Pick<SelectionFixedTrackIdentity, "artist" | "title">,
  song: Pick<CatalogSong, "artistName" | "name">,
): number {
  const candidateArtist = normalizedIdentityText(candidate.artist);
  const candidateTitle = normalizedIdentityText(candidate.title);
  const songArtist = normalizedIdentityText(song.artistName);
  const songTitle = normalizedIdentityText(song.name);
  return entries.findIndex((entry) => {
    const artist = normalizedIdentityText(entry.artist);
    const title = normalizedIdentityText(entry.title);
    return candidateArtist === artist
      && candidateTitle === title
      && songArtist === artist
      && songTitle === title;
  });
}
