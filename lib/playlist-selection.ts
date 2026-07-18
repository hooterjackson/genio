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
  const desiredArtists = Math.min(target, Math.max(5, Math.ceil(target / 5)));
  const artistCap = Math.max(2, Math.ceil(target * 0.15));
  return ` This is a multi-artist curated scope. When the documented scope permits, recover candidates from at least ${desiredArtists} distinct credited recording artists and do not let one artist supply more than ${artistCap} of the ${target} publication tracks. Search beyond the first canonical artists and sources; on refill passes prioritize supported artists not yet represented. Never broaden the confirmed scope or weaken evidence merely to satisfy artist breadth.`;
}

function artistKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
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

  // Increase the cap one step at a time. This finds the lowest feasible
  // maximum artist count for the available pool while preserving source rank
  // within every artist and never returning fewer than the requested count.
  while (selectedIndexes.size < limit) {
    let added = 0;
    for (let index = 0; index < rows.length && selectedIndexes.size < limit; index += 1) {
      if (selectedIndexes.has(index)) continue;
      const key = artistKey(rows[index]!.artist) || `unknown:${index}`;
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
