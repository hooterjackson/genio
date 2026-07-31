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

const FIXED_TRACK_VERSION_QUALIFIER =
  /\s*\((?:original studio (?:recording|version)|studio (?:recording|version))\)\s*$/iu;

/**
 * Brief compilation may annotate an otherwise exact artist/title identity
 * with a version-policy label. The label is not part of the catalog title:
 * version eligibility is enforced independently by the immutable recording
 * policy. Strip only this narrow, server-understood suffix so genuine title
 * parentheticals remain part of the identity.
 */
function canonicalFixedTrackTitle(value: string): string {
  return value.replace(FIXED_TRACK_VERSION_QUALIFIER, "").trim();
}

function parseFixedTrack(value: string): SelectionFixedTrackIdentity | null {
  const compact = value.normalize("NFKC").trim();
  const artistDashTitle = compact.match(/^(.+?)\s+(?:—|–|-)\s+(.+)$/u);
  if (artistDashTitle) {
    const artist = artistDashTitle[1]!.trim();
    const title = canonicalFixedTrackTitle(artistDashTitle[2]!.trim());
    return artist && title ? { artist, title } : null;
  }
  // Brief compilation commonly preserves visitor-authored fixed identities as
  // `"Title" by Artist`. The quotes make this form unambiguous; accepting an
  // unquoted `by` form would misclassify broad prose and artist biographies as
  // closed track identities.
  const quotedTitleByArtist = compact.match(/^["“](.+?)["”]\s+by\s+(.+)$/iu);
  if (!quotedTitleByArtist) return null;
  const title = canonicalFixedTrackTitle(quotedTitleByArtist[1]!.trim());
  const artist = quotedTitleByArtist[2]!.trim();
  if (!artist || !title) return null;
  return { artist, title };
}

/**
 * Compile only an unambiguous closed artist/title list. A list is fixed when
 * its exact count equals the number of typed pairs and the brief explicitly
 * preserves the supplied order. The compiler may add supplemental include
 * prose (for example, "original studio recordings only") alongside those
 * pairs; that prose does not change the closed membership set. Broad include
 * examples must never enter this path merely because they happen to contain a
 * dash.
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
    || !ORDER_IS_IMMUTABLE.test(`${brief.relationship} ${brief.orderingPolicy}`)) {
    return null;
  }
  const fixed = brief.include
    .map(parseFixedTrack)
    .filter((entry): entry is SelectionFixedTrackIdentity => entry !== null);
  if (fixed.length !== minimum) return null;
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
