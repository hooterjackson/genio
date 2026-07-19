export interface PlaylistSelectionRow {
  artist: string;
}

export interface PlaylistSelectionResult<T extends PlaylistSelectionRow> {
  selected: T[];
  overflow: T[];
}

export interface PlaylistSelectionOptions {
  diversifyArtists?: boolean;
  maximumInitialArtistShare?: number;
  minimumDistinctArtists?: number;
}

/**
 * Keep model/source rank stable while moving one strongest row from every
 * newly discovered artist ahead of repeat rows. This is used only by a
 * measured diversity refill; it does not alter direct-artist research.
 */
export function prioritizeUnrepresentedArtistRows<T extends PlaylistSelectionRow>(
  rows: readonly T[],
  representedArtists: readonly string[],
): T[] {
  const represented = new Set(representedArtists.map(playlistArtistKey).filter(Boolean));
  const seeded = new Set<string>();
  const prioritizedIndexes = new Set<number>();
  const output: T[] = [];
  rows.forEach((row, index) => {
    const key = playlistArtistKey(row.artist);
    if (!key || represented.has(key) || seeded.has(key)) return;
    seeded.add(key);
    prioritizedIndexes.add(index);
    output.push(row);
  });
  rows.forEach((row, index) => {
    if (!prioritizedIndexes.has(index)) output.push(row);
  });
  return output;
}

export interface ArtistDiversityBrief {
  mode: string;
  relationship: string;
  description?: string;
  include?: readonly string[];
  orderingPolicy?: string;
}

function isDirectRecordingArtistCatalogue(relationship: string): boolean {
  const normalized = normalizedPolicyText(relationship);
  return normalized === "primary artist"
    || normalized === "main artist"
    || normalized === "recording artist"
    || /\b(?:songs?|tracks?|recordings?|music|releases?)\s+(?:(?:recorded|released|performed|sung|made)\s+)?by\b/u.test(normalized)
    || /\b(?:recorded|released|performed|sung)\s+by\b/u.test(normalized)
    || /\b(?:artist(?:'s)?|performer(?:'s)?)\s+(?:discograph\w*|catalog(?:ue)?|recordings?|songs?|tracks?)\b/u.test(normalized)
    || /\b(?:discograph\w*|catalog(?:ue)?)\b/u.test(normalized);
}

function normalizedPolicyText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

/**
 * Detect a confirmed editorial request for artist breadth without broadening
 * the policy to ordinary single-artist catalogues. Similarity requests have a
 * separate, stronger trigger; this predicate covers briefs whose confirmed
 * inclusion rules explicitly ask for artist diversity.
 */
export function briefExplicitlyRequestsArtistDiversity(
  brief: ArtistDiversityBrief,
): boolean {
  if (brief.mode !== "curated") return false;

  if (isDirectRecordingArtistCatalogue(brief.relationship)) return false;

  const policy = normalizedPolicyText([
    brief.description ?? "",
    ...(brief.include ?? []),
    brief.orderingPolicy ?? "",
  ].join(" "));
  return /\b(?:diverse|varied|balanced|representative)\s+(?:credited\s+)?artists?\b/u.test(policy)
    || /\b(?:diverse|varied|balanced|representative)\s+(?:artist|performer|act)\s+(?:selection|mix|set|pool|representation)\b/u.test(policy)
    || /\b(?:diverse|varied|broad|wide|balanced|representative)\s+(?:range|mix|selection|cross\s+section)\s+of\s+(?:credited\s+)?artists?\b/u.test(policy)
    || /\b(?:artist|performer|act)\s+(?:diversity|variety|breadth|balance)\b/u.test(policy)
    || /\b(?:many|multiple|different)\s+(?:credited\s+)?artists?\b/u.test(policy);
}

/**
 * Curated genre, scene, place, theme, influence, and recommendation requests
 * are multi-artist by default. Requiring the model to write the word
 * "diverse" made an ordinary request such as "French jazz" silently inherit
 * the first source's artist concentration. Keep direct recording-artist
 * catalogues unchanged, but make every other curated selection use the
 * deterministic progressive artist cap.
 */
export function briefShouldDiversifyArtists(brief: ArtistDiversityBrief): boolean {
  return brief.mode === "curated"
    && !isDirectRecordingArtistCatalogue(brief.relationship);
}

/**
 * Broad curated playlists need enough distinct credited artists to function
 * as a scene or genre survey instead of an accidental stack of mini-
 * discographies. Keep the goal proportional for larger requests, while an
 * eight-artist floor prevents a normal 25-track playlist from collapsing to
 * the first two or three canonical names returned by search.
 */
export function desiredPlaylistArtistCount(
  brief: ArtistDiversityBrief,
  requestedTrackCount: number,
): number {
  if (!briefShouldDiversifyArtists(brief)) return 0;
  const target = Number.isFinite(requestedTrackCount)
    ? Math.max(1, Math.floor(requestedTrackCount))
    : 50;
  return Math.min(target, Math.max(8, Math.ceil(target * 0.4)));
}

/**
 * Give research a measurable breadth target before deterministic selection.
 * The wording remains conditional because a genuinely narrow documented
 * scope must never be broadened with unsupported recordings merely to hit a
 * quota.
 */
export function artistDiversityResearchInstruction(
  brief: ArtistDiversityBrief,
  requestedTrackCount: number,
): string {
  if (!briefShouldDiversifyArtists(brief)) return "";
  const target = Number.isFinite(requestedTrackCount)
    ? Math.max(1, Math.floor(requestedTrackCount))
    : 50;
  const desiredArtists = desiredPlaylistArtistCount(brief, target);
  const artistCap = Math.max(2, Math.ceil(target * 0.15));
  return ` This is a multi-artist curated scope. When the documented scope permits, recover candidates from at least ${desiredArtists} distinct credited recording artists and do not let one artist supply more than ${artistCap} of the ${target} publication tracks. Search beyond the first canonical artists and sources; on refill passes prioritize supported artists not yet represented. Never broaden the confirmed scope or weaken evidence merely to satisfy artist breadth.`;
}

export function playlistArtistKey(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  // A small number of credited artist names intentionally contain only
  // punctuation or symbols (for example “!!!”). Preserve those as distinct
  // identities instead of collapsing them into an unknown empty bucket.
  return normalized || value.normalize("NFKC").toLocaleLowerCase("en-US").trim().replace(/\s+/gu, " ");
}

/**
 * Select an exact-size ranked pool before transition sequencing.
 *
 * Similarity research frequently returns a reserve dominated by one adjacent
 * artist. Taking the first N rows turns that research ordering into a
 * near-discography even when enough other supported artists are available.
 * This progressive-cap pass keeps the strongest-ranked rows from every artist
 * and relaxes the cap only as much as necessary to fill the exact target.
 * Direct-artist and fixed catalogue requests retain the original first-N
 * behavior by leaving diversifyArtists disabled.
 */
export function selectRankedPlaylistRows<T extends PlaylistSelectionRow>(
  rows: readonly T[],
  maximumTracks: number,
  options: PlaylistSelectionOptions = {},
): PlaylistSelectionResult<T> {
  if (!Number.isFinite(maximumTracks)) return { selected: [...rows], overflow: [] };
  const limit = Math.max(0, Math.min(rows.length, Math.floor(maximumTracks)));
  if (limit === 0) return { selected: [], overflow: [...rows] };
  if (!options.diversifyArtists || rows.length <= limit) {
    return { selected: rows.slice(0, limit), overflow: rows.slice(limit) };
  }

  const configuredShare = options.maximumInitialArtistShare ?? 0.15;
  const initialShare = Number.isFinite(configuredShare)
    ? Math.max(0.01, Math.min(1, configuredShare))
    : 0.15;
  let artistCap = Math.max(1, Math.ceil(limit * initialShare));
  const selectedIndexes = new Set<number>();
  const artistCounts = new Map<string, number>();
  const configuredMinimumDistinctArtists = options.minimumDistinctArtists ?? 0;
  const minimumDistinctArtists = Number.isFinite(configuredMinimumDistinctArtists)
    ? Math.max(0, Math.min(limit, Math.floor(configuredMinimumDistinctArtists)))
    : 0;

  // Preserve the research/matching diversity contract in the immutable
  // manifest. Ranked results commonly arrive grouped by artist, so applying
  // only a per-artist cap can fill the target before later artists are ever
  // reached. Seed the strongest row from each distinct artist first, then
  // complete the playlist under the progressive cap below.
  if (minimumDistinctArtists > 0) {
    const seededArtists = new Set<string>();
    for (let index = 0; index < rows.length && seededArtists.size < minimumDistinctArtists; index += 1) {
      const key = playlistArtistKey(rows[index]!.artist);
      if (!key || seededArtists.has(key)) continue;
      seededArtists.add(key);
      selectedIndexes.add(index);
      artistCounts.set(key, 1);
    }
  }

  // Increase the cap one step at a time. This finds the lowest feasible
  // maximum artist count for the available pool while preserving source rank
  // within every artist and never returning fewer than the requested count.
  while (selectedIndexes.size < limit) {
    let added = 0;
    for (let index = 0; index < rows.length && selectedIndexes.size < limit; index += 1) {
      if (selectedIndexes.has(index)) continue;
      const key = playlistArtistKey(rows[index]!.artist) || `unknown:${index}`;
      const count = artistCounts.get(key) ?? 0;
      if (count >= artistCap) continue;
      selectedIndexes.add(index);
      artistCounts.set(key, count + 1);
      added += 1;
    }
    if (selectedIndexes.size >= limit) break;
    if (added === 0 && artistCap >= limit) break;
    artistCap += 1;
  }

  // Defensive exact-count fallback. It should be unreachable because a cap
  // of `limit` accepts every remaining row, but keeping it explicit makes a
  // future policy edit fail safe instead of silently returning a short list.
  if (selectedIndexes.size < limit) {
    for (let index = 0; index < rows.length && selectedIndexes.size < limit; index += 1) {
      selectedIndexes.add(index);
    }
  }

  const selected: T[] = [];
  const overflow: T[] = [];
  rows.forEach((row, index) => {
    if (selectedIndexes.has(index)) selected.push(row);
    else overflow.push(row);
  });
  return { selected, overflow };
}
