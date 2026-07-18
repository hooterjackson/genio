import type { CatalogMatchResult, CatalogSong, TrackCandidateInput } from "../shared/types.ts";

export function normalizeMusicText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(feat|featuring|ft)\.?\b/g, " ")
    // Catalog punctuation is not stable: Apple may print "UFO's" where a
    // source prints "UFOs", or curly apostrophes where another source omits
    // them. Removing apostrophes before tokenization preserves the word.
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeMusicCompactTitle(value: string | null | undefined): string {
  return normalizeMusicText(value).replace(/\s+/g, "");
}

function normalizeMusicCompactArtist(value: string | null | undefined): string {
  return normalizeMusicText(value).replace(/\s+/g, "");
}

function normalizeMusicArtistMember(value: string | null | undefined): string {
  return normalizeMusicText(value).replace(/^the\s+/u, "");
}

/**
 * Recording credits are not printed consistently across editorial sources
 * and Apple Music. A source may use "A feat. B", while Apple places B in the
 * song title and exposes "A" as artistName; Brazilian catalog credits also
 * alternate commas, ampersands, "x", and localized role prefixes.
 *
 * Keep this parser deliberately limited to explicit credit separators. It is
 * used only alongside an exact/base-title comparison and recording-family
 * checks, never as a freestanding fuzzy artist match.
 */
function normalizeMusicCollaboratorSet(value: string | null | undefined): string[] {
  const normalizedSeparators = (value ?? "")
    .replace(/[()\[\]]/gu, " ")
    .replace(/\b(?:feat(?:uring)?|ft|with|vs)\.?\b/giu, " & ")
    .replace(/\s+(?:x|×)\s+/giu, " & ")
    // Preserve stage names such as "Tyler, The Creator" while still
    // normalizing comma-separated catalog collaborator lists.
    .replace(/,(?!\s*the\b)/giu, " & ")
    .replace(/[;/]+/gu, " & ");
  return [...new Set(normalizedSeparators
    .split(/\s*(?:&|\band\b)\s*/iu)
    .map((member) => normalizeMusicArtistMember(member))
    .filter(Boolean))]
    .sort();
}

function sameCollaboratorSet(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftMembers = normalizeMusicCollaboratorSet(left);
  const rightMembers = normalizeMusicCollaboratorSet(right);
  return leftMembers.length > 1
    && leftMembers.length === rightMembers.length
    && leftMembers.every((member, index) => member === rightMembers[index]);
}

function catalogMemberMatchesCandidate(candidateMember: string, catalogMember: string): boolean {
  return catalogMember === candidateMember
    || catalogMember === `mc ${candidateMember}`
    || catalogMember === `dj ${candidateMember}`;
}

function sameCatalogRolePrefixedCollaboratorSet(
  candidateArtist: string | null | undefined,
  catalogArtist: string | null | undefined,
): boolean {
  const candidateMembers = normalizeMusicCollaboratorSet(candidateArtist);
  const catalogMembers = normalizeMusicCollaboratorSet(catalogArtist);
  return candidateMembers.length > 1
    && candidateMembers.length === catalogMembers.length
    && candidateMembers.every((candidateMember) => catalogMembers.some(
      (catalogMember) => catalogMemberMatchesCandidate(candidateMember, catalogMember),
    ));
}

function artistCreditContainsCandidate(
  candidateArtist: string | null | undefined,
  catalogArtist: string | null | undefined,
): boolean {
  const candidateMembers = normalizeMusicCollaboratorSet(candidateArtist);
  const catalogMembers = normalizeMusicCollaboratorSet(catalogArtist);
  if (candidateMembers.length === 0 || catalogMembers.length <= candidateMembers.length) return false;
  return candidateMembers.every((candidateMember) => catalogMembers.some(
    (catalogMember) => catalogMemberMatchesCandidate(candidateMember, catalogMember),
  ));
}

function normalizeMusicPartStem(value: string | null | undefined): string {
  return normalizeMusicText(value)
    .replace(/\s+(?:(?:part|pt)\s+)?(?:\d+|[ivx]{1,4})$/u, "")
    .trim();
}

/**
 * Apple commonly appends a parenthetical subtitle to a catalog title even
 * when research sources use the shorter printed title (and vice versa).
 * Base-title equality is deliberately review-only unless a stable identifier
 * also agrees.
 */
export function normalizeMusicBaseTitle(value: string | null | undefined): string {
  let base = (value ?? "").trim();
  for (let index = 0; index < 3; index += 1) {
    const next = base.replace(/\s*[\[(][^\[\]()]{1,120}[\])\]]\s*$/u, "").trim();
    if (next === base) break;
    base = next;
  }
  base = base.replace(
    /\s+(?:-|–|—)\s+(?:(?:\d{4}\s+)?(?:remaster(?:ed)?|radio edit|single version|album version|live|acoustic|instrumental|demo|remix).*)$/iu,
    "",
  ).trim();
  return normalizeMusicText(base);
}

function featureCreditStem(value: string | null | undefined): string | null {
  const match = (value ?? "").trim().match(
    /^(.+?)\s*[\[(]\s*(?:feat(?:uring)?|ft)\.?\s+[^\[\]()]{1,120}(?:\)|\])\s*$/iu,
  );
  return match ? normalizeMusicText(match[1]) || null : null;
}

/**
 * A feature credit may move between a source's artist line and Apple's song
 * title without changing the recording. Other parenthetical suffixes (part,
 * bonus, mix, live, edit, etc.) are not equivalent and remain review-only.
 */
function isCatalogFeatureCreditTitleVariant(
  candidateTitle: string | null | undefined,
  catalogTitle: string | null | undefined,
): boolean {
  const normalizedCandidate = normalizeMusicText(candidateTitle);
  return Boolean(
    normalizedCandidate
    && !featureCreditStem(candidateTitle)
    && featureCreditStem(catalogTitle) === normalizedCandidate,
  );
}

export function mergeCatalogSongs(...groups: readonly CatalogSong[][]): CatalogSong[] {
  const merged = new Map<string, CatalogSong>();
  for (const group of groups) {
    for (const song of group) {
      if (!song.id || merged.has(song.id)) continue;
      merged.set(song.id, song);
    }
  }
  return [...merged.values()];
}

function compatibleDuration(candidateMs: number | null, songMs?: number): boolean {
  if (!candidateMs || !songMs) return true;
  return Math.abs(candidateMs - songMs) <= 3_000;
}

function exactDuration(candidateMs: number | null, songMs?: number): boolean {
  return Boolean(candidateMs && songMs && compatibleDuration(candidateMs, songMs));
}

function isSparseEditorialCandidate(candidate: TrackCandidateInput): boolean {
  // Album/container metadata does not identify a recording. Editorial
  // sources commonly cite an original album while Apple returns the same
  // recording from a compilation or reissue. Keep those candidates eligible
  // for the corroborated-family resolver; stable identifiers, duration, and
  // an explicit version label still take the stricter paths below.
  return !candidate.isrc && !candidate.durationMs && !candidate.versionLabel;
}

interface SparseCatalogMatch {
  song: CatalogSong;
  sourceIndex: number;
}

function isDerivedCatalogContext(song: CatalogSong): boolean {
  const album = ` ${normalizeMusicText(song.albumName)} `;
  const derivedMarkers = [
    " live ", " ao vivo ", " en vivo ", " remix ", " remixes ", " cirque ", " immortal ",
    " karaoke ", " tribute ", " acappella ", " a cappella ", " sped up ",
    " slowed down ", " slowed reverb ", " nightcore ", " mixed ",
  ];
  return derivedMarkers.some((marker) => album.includes(marker));
}

function isUnsafeLooseCreditContext(song: CatalogSong): boolean {
  if (isDerivedCatalogContext(song)) return true;
  const album = ` ${normalizeMusicText(song.albumName)} `;
  const additionalMarkers = [
    " cover ", " covers ", " re recorded ", " new recording ", " demo ", " demos ",
    " acoustic ", " instrumental ", " clean ", " unplugged ", " session ", " sessions ",
  ];
  return additionalMarkers.some((marker) => album.includes(marker));
}

function catalogAlbumPenalty(song: CatalogSong): number {
  const album = ` ${normalizeMusicText(song.albumName)} `;
  if (isDerivedCatalogContext(song)) return 1_000;
  const collectionMarkers = [
    " best of ", " greatest hits ", " collection ", " essential ",
    " anthology ", " indispensable ", " millennium ",
  ];
  return collectionMarkers.some((marker) => album.includes(marker)) ? 20 : 0;
}

function normalizedCatalogIsrc(song: CatalogSong): string | null {
  const value = song.isrc?.toUpperCase().replace(/[^A-Z0-9]/gu, "") ?? "";
  return value || null;
}

function durationClusters<T extends SparseCatalogMatch>(matches: readonly T[]): T[][] {
  const withDuration = matches
    .filter((item) => Boolean(item.song.durationInMillis && item.song.durationInMillis > 0))
    .sort((left, right) => (left.song.durationInMillis ?? 0) - (right.song.durationInMillis ?? 0));
  const clusters: T[][] = [];
  for (const item of withDuration) {
    const duration = item.song.durationInMillis ?? 0;
    const cluster = clusters.find((group) => {
      const durations = group.map((member) => member.song.durationInMillis ?? duration);
      return Math.max(...durations, duration) - Math.min(...durations, duration) <= 3_000;
    });
    if (cluster) cluster.push(item);
    else clusters.push([item]);
  }
  return clusters;
}

/**
 * Sparse editorial research often identifies a song without its ISRC, album,
 * or duration. Apple can then return many releases of the same recording plus
 * a shorter compilation edit or a later live/remix treatment. Requiring every
 * result to agree made common catalog abundance look like a failed match.
 *
 * Accept only a corroborated exact artist/title family: a unique result, two
 * or more results within a three-second duration window, or two or more copies
 * sharing an ISRC with compatible durations. Obvious derived album contexts
 * are excluded whenever a studio/catalog alternative exists. Two materially
 * different singleton recordings still remain review-only.
 */
function selectCanonicalSparseMatch<T extends SparseCatalogMatch>(
  matches: readonly T[],
  allowUncorroboratedSingleton = true,
): T | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return allowUncorroboratedSingleton ? matches[0] : null;

  const nonDerived = matches.filter((item) => !isDerivedCatalogContext(item.song));
  const pool = nonDerived.length > 0 ? nonDerived : [...matches];
  // Several exact results may consist of one studio/catalog recording plus
  // live, remix, karaoke, or tribute containers whose track title itself is
  // unqualified. Once those derived containers are excluded, the remaining
  // exact studio result is unambiguous without weakening title/version rules.
  if (pool.length === 1) return pool[0];
  const families: T[][] = durationClusters(pool).filter((cluster) => cluster.length >= 2);

  const byIsrc = new Map<string, T[]>();
  for (const item of pool) {
    const isrc = normalizedCatalogIsrc(item.song);
    if (!isrc) continue;
    const group = byIsrc.get(isrc) ?? [];
    group.push(item);
    byIsrc.set(isrc, group);
  }
  for (const group of byIsrc.values()) {
    if (group.length < 2) continue;
    const durations = group
      .map((item) => item.song.durationInMillis)
      .filter((value): value is number => Boolean(value && value > 0));
    if (durations.length > 1 && Math.max(...durations) - Math.min(...durations) > 10_000) continue;
    families.push(group);
  }

  const uniqueFamilies = [...new Map(families.map((family) => [
    family.map((item) => item.song.id).sort().join("|"),
    family,
  ])).values()];
  const strongest = uniqueFamilies.sort((left, right) => {
    const sizeDifference = right.length - left.length;
    if (sizeDifference !== 0) return sizeDifference;
    const leftPenalty = Math.min(...left.map((item) => catalogAlbumPenalty(item.song)));
    const rightPenalty = Math.min(...right.map((item) => catalogAlbumPenalty(item.song)));
    if (leftPenalty !== rightPenalty) return leftPenalty - rightPenalty;
    const leftDuration = Math.max(...left.map((item) => item.song.durationInMillis ?? 0));
    const rightDuration = Math.max(...right.map((item) => item.song.durationInMillis ?? 0));
    if (leftDuration !== rightDuration) return rightDuration - leftDuration;
    return Math.min(...left.map((item) => item.sourceIndex))
      - Math.min(...right.map((item) => item.sourceIndex));
  })[0];
  if (!strongest) return null;

  return [...strongest].sort((left, right) => {
    const penaltyDifference = catalogAlbumPenalty(left.song) - catalogAlbumPenalty(right.song);
    if (penaltyDifference !== 0) return penaltyDifference;
    return left.sourceIndex - right.sourceIndex;
  })[0];
}

function releaseYear(song: CatalogSong): number | null {
  const value = song.releaseDate?.slice(0, 4);
  const year = value ? Number(value) : NaN;
  return Number.isInteger(year) ? year : null;
}

function hasYearConflict(candidate: TrackCandidateInput, song: CatalogSong): boolean {
  const catalogYear = releaseYear(song);
  return Boolean(candidate.releaseYear && catalogYear && Math.abs(candidate.releaseYear - catalogYear) > 1);
}

function versionFlags(value: string): Set<string> {
  const normalized = normalizeMusicText(value);
  const padded = ` ${normalized} `;
  const flags = [
    "live", "remix", "edit", "acoustic", "instrumental", "re recorded",
    "demo", "karaoke", "radio", "extended", "sped up", "slowed down",
    "slowed reverb", "nightcore", "mixed",
  ];
  // Remasters and mono/stereo presentations generally retain the underlying
  // performance. They remain review-only through base-title matching instead
  // of being discarded as a conflicting recording. Match complete tokens so
  // titles such as "Deliver" do not accidentally acquire a "live" flag.
  const found = new Set(flags.filter((flag) => padded.includes(` ${flag} `)));
  // Apple localizes common recording qualifiers. Normalize them to the same
  // semantic flag so Portuguese/Spanish live recordings cannot bypass the
  // unqualified-versus-live conflict check.
  if (padded.includes(" ao vivo ") || padded.includes(" en vivo ")) found.add("live");
  return found;
}

function masteringFlags(value: string): Set<string> {
  const padded = ` ${normalizeMusicText(value)} `;
  const flags = new Set<string>();
  if (padded.includes(" remaster ") || padded.includes(" remastered ")) flags.add("remaster");
  if (padded.includes(" mono ")) flags.add("mono");
  if (padded.includes(" stereo ")) flags.add("stereo");
  return flags;
}

function containsConflictingVersion(candidate: TrackCandidateInput, song: CatalogSong): boolean {
  // Album editions are poor recording-version signals: a studio track may be
  // reissued on an album titled "The Remixes" or "Live & Remastered" without
  // changing the track itself. Song titles and explicit version labels remain
  // authoritative; album equality is scored separately.
  const candidateFlags = versionFlags(`${candidate.title} ${candidate.versionLabel ?? ""}`);
  const catalogText = normalizeMusicText(`${song.name} ${song.versionLabel ?? ""}`);
  const catalogFlags = versionFlags(catalogText);
  const candidateMasteringFlags = masteringFlags(`${candidate.title} ${candidate.versionLabel ?? ""}`);
  const catalogMasteringFlags = masteringFlags(catalogText);
  return [...candidateFlags].some((flag) => !catalogFlags.has(flag))
    || [...catalogFlags].some((flag) => !candidateFlags.has(flag))
    // An unqualified source title may map to Apple's currently available
    // remaster. The inverse is not safe: when the source explicitly requests
    // a remaster/mono/stereo presentation, Apple must expose that marker.
    || [...candidateMasteringFlags].some((flag) => !catalogMasteringFlags.has(flag));
}

interface CatalogComparison {
  song: CatalogSong;
  isrcMatch: boolean;
  isrcConflict: boolean;
  artistExact: boolean;
  artistCompatible: boolean;
  artistCompactExact: boolean;
  artistLeadingArticleExact: boolean;
  artistCollaboratorSetExact: boolean;
  artistCatalogRolePrefixedSetExact: boolean;
  artistCreditContainsCandidate: boolean;
  titleExact: boolean;
  baseTitleExact: boolean;
  catalogFeatureCreditTitleVariant: boolean;
  compactTitleExact: boolean;
  partStemExact: boolean;
  albumExact: boolean;
  durationExact: boolean;
  versionConflict: boolean;
  yearConflict: boolean;
}

function compareCatalogSong(candidate: TrackCandidateInput, song: CatalogSong): CatalogComparison {
  const candidateIsrc = candidate.isrc?.toUpperCase() ?? null;
  const songIsrc = song.isrc?.toUpperCase() ?? null;
  const title = normalizeMusicText(candidate.title);
  const baseTitle = normalizeMusicBaseTitle(candidate.title);
  const songTitle = normalizeMusicText(song.name);
  const songBaseTitle = normalizeMusicBaseTitle(song.name);
  const compactTitle = normalizeMusicCompactTitle(candidate.title);
  const compactBaseTitle = normalizeMusicCompactTitle(normalizeMusicBaseTitle(candidate.title));
  const songCompactTitle = normalizeMusicCompactTitle(song.name);
  const songCompactBaseTitle = normalizeMusicCompactTitle(normalizeMusicBaseTitle(song.name));
  const candidatePartStem = normalizeMusicPartStem(candidate.title);
  const songPartStem = normalizeMusicPartStem(song.name);
  const candidateHasPartSuffix = Boolean(candidatePartStem && candidatePartStem !== title);
  const songHasPartSuffix = Boolean(songPartStem && songPartStem !== songTitle);
  const album = normalizeMusicText(candidate.album);
  const candidateArtist = normalizeMusicText(candidate.artist);
  const songArtist = normalizeMusicText(song.artistName);
  const artistCompactExact = Boolean(
    candidateArtist
    && normalizeMusicCompactArtist(song.artistName) === normalizeMusicCompactArtist(candidate.artist)
  );
  const artistLeadingArticleExact = Boolean(
    candidateArtist
    && songArtist !== candidateArtist
    && normalizeMusicArtistMember(song.artistName) === normalizeMusicArtistMember(candidate.artist)
  );
  const artistCollaboratorSetExact = sameCollaboratorSet(song.artistName, candidate.artist);
  const artistCatalogRolePrefixedSetExact = sameCatalogRolePrefixedCollaboratorSet(
    candidate.artist,
    song.artistName,
  );
  const artistCreditContainsCandidateMatch = artistCreditContainsCandidate(
    candidate.artist,
    song.artistName,
  );
  return {
    song,
    isrcMatch: Boolean(candidateIsrc && songIsrc && candidateIsrc === songIsrc),
    isrcConflict: Boolean(candidateIsrc && songIsrc && candidateIsrc !== songIsrc),
    artistExact: songArtist === candidateArtist,
    // Spacing in electronic aliases is inconsistent across catalogs
    // ("Model500" vs "Model 500"). This compatibility is review-only and is
    // never sufficient for an automatic metadata match.
    artistCompatible: artistCompactExact || artistLeadingArticleExact
      || artistCollaboratorSetExact || artistCatalogRolePrefixedSetExact
      || artistCreditContainsCandidateMatch,
    artistCompactExact,
    artistLeadingArticleExact,
    artistCollaboratorSetExact,
    artistCatalogRolePrefixedSetExact,
    artistCreditContainsCandidate: artistCreditContainsCandidateMatch,
    titleExact: songTitle === title,
    baseTitleExact: Boolean(baseTitle && songBaseTitle === baseTitle),
    catalogFeatureCreditTitleVariant: isCatalogFeatureCreditTitleVariant(candidate.title, song.name),
    compactTitleExact: Boolean(
      compactTitle
      && (songCompactTitle === compactTitle
        || songCompactBaseTitle === compactTitle
        || (compactBaseTitle && songCompactTitle === compactBaseTitle)
        || (compactBaseTitle && songCompactBaseTitle === compactBaseTitle)),
    ),
    // A source may cite a parent composition while Apple exposes its numbered
    // parts as separate songs (for example "Quadrant Dub" versus I/II). This
    // is deliberately review-only and requires compatible artist metadata.
    partStemExact: Boolean(
      (songHasPartSuffix && !candidateHasPartSuffix && songPartStem === title)
      || (candidateHasPartSuffix && !songHasPartSuffix && candidatePartStem === songTitle),
    ),
    albumExact: Boolean(album && normalizeMusicText(song.albumName) === album),
    durationExact: exactDuration(candidate.durationMs, song.durationInMillis),
    versionConflict: containsConflictingVersion(candidate, song),
    yearConflict: hasYearConflict(candidate, song),
  };
}

/**
 * Determines whether another broader Apple search would be redundant. This is
 * intentionally stricter than "there is some result": a title-only result for
 * a different artist remains a review candidate, but it does not stop the
 * query ladder from looking for an artist- or album-bound result.
 */
export function hasDirectCatalogMatch(candidate: TrackCandidateInput, songs: CatalogSong[]): boolean {
  return mergeCatalogSongs(songs).some((song) => {
    const comparison = compareCatalogSong(candidate, song);
    if (comparison.isrcMatch && !comparison.versionConflict) return true;
    if (comparison.isrcConflict || comparison.versionConflict) return false;
    // Compatible punctuation, collaborator-order, and leading-article forms
    // remain useful review candidates, but must not stop the ladder before an
    // exact artist/title result can be found by a broader query. When research
    // supplied an album, an exact title on a compilation or reissue is not
    // enough either: keep going so the album-bound queries can recover the
    // intended release instead of leaving an available track in review.
    return comparison.titleExact && comparison.artistExact
      && (!candidate.album || comparison.albumExact);
  });
}

export function rankCatalogMatches(
  candidateId: string,
  candidate: TrackCandidateInput,
  songs: CatalogSong[],
): CatalogMatchResult {
  const ranked = mergeCatalogSongs(songs).map((song, sourceIndex) => {
    const comparison = compareCatalogSong(candidate, song);
    let score = 0;
    const basis: string[] = [];
    if (comparison.isrcMatch) {
      score += 100;
      basis.push("exact ISRC");
    }
    if (comparison.isrcConflict) score -= 200;
    if (comparison.artistExact) {
      score += 30;
      basis.push("artist");
    } else if (comparison.artistCompatible) {
      score += 18;
      basis.push(comparison.artistCollaboratorSetExact
        ? "order-insensitive collaborator set"
        : comparison.artistCatalogRolePrefixedSetExact
          ? "catalog role-prefixed collaborator set"
          : comparison.artistCreditContainsCandidate
            ? "catalog collaborator credit contains cited artist"
        : comparison.artistLeadingArticleExact
          ? "leading-article artist variant"
          : "punctuation-normalized artist");
    }
    if (comparison.titleExact) {
      score += 40;
      basis.push("title");
    } else if (comparison.baseTitleExact) {
      score += 28;
      basis.push("base title");
    } else if (comparison.compactTitleExact) {
      score += 24;
      basis.push("punctuation-normalized title");
    } else if (comparison.partStemExact) {
      score += 18;
      basis.push("numbered-part title");
    }
    if (comparison.albumExact) {
      score += 15;
      basis.push("album");
    }
    if (comparison.durationExact) {
      score += 10;
      basis.push("duration");
    }
    if (comparison.versionConflict) score -= 100;
    if (comparison.yearConflict) score -= 60;
    const identifierCompatible = comparison.isrcMatch && comparison.artistExact
      && (comparison.titleExact || comparison.baseTitleExact || comparison.compactTitleExact)
      && compatibleDuration(candidate.durationMs, song.durationInMillis)
      && !comparison.versionConflict && !comparison.yearConflict;
    const metadataCompatible = !comparison.isrcConflict && comparison.artistExact
      && comparison.titleExact
      // Fast cited research frequently has authoritative album metadata but
      // no duration. A unique exact artist/title/album is safe to accept, and
      // a duration can serve as the disambiguator when no album was supplied.
      // With neither field, only the stricter sparse-family path below may
      // auto-accept; version-labeled candidates must remain review-only.
      && Boolean(candidate.album || candidate.durationMs)
      && (!candidate.album || comparison.albumExact)
      && (!candidate.durationMs || comparison.durationExact)
      && !comparison.versionConflict && !comparison.yearConflict;
    const directReview = !comparison.isrcConflict && !comparison.versionConflict
      && (comparison.titleExact || comparison.baseTitleExact
        || comparison.compactTitleExact || comparison.partStemExact)
      && comparison.artistCompatible;
    const titleReview = !comparison.isrcConflict
      && (comparison.titleExact || comparison.baseTitleExact);
    return {
      ...comparison,
      song,
      score,
      basis: basis.join(", "),
      identifierCompatible,
      metadataCompatible,
      directReview,
      titleReview,
      sourceIndex,
    };
  }).sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex);

  const best = ranked[0];
  if (!best) {
    return { candidateId, status: "unavailable", basis: "no compatible catalog result", score: 0, song: null, alternatives: songs.slice(0, 4) };
  }

  const identifierMatches = ranked.filter((item) => item.identifierCompatible);
  const metadataMatches = ranked.filter((item) => item.metadataCompatible);
  const sparseExactMatches = isSparseEditorialCandidate(candidate)
    ? ranked.filter((item) => !item.isrcConflict && item.artistExact && item.titleExact
      && !item.versionConflict && !item.yearConflict)
    : [];
  const sparseStrongCreditMatches = isSparseEditorialCandidate(candidate)
    ? ranked.filter((item) => !item.isrcConflict && !item.versionConflict && !item.yearConflict
      && (
        (item.artistCollaboratorSetExact || item.artistCatalogRolePrefixedSetExact) && item.titleExact
      ))
    : [];
  const sparseLooseCreditMatches = isSparseEditorialCandidate(candidate)
    ? ranked.filter((item) => !item.isrcConflict && !item.versionConflict && !item.yearConflict
      && (
        (item.artistExact && item.catalogFeatureCreditTitleVariant)
        || (item.artistCreditContainsCandidate && item.titleExact)
      ))
    : [];
  const exactIdentifier = identifierMatches.length === 1 && identifierMatches[0].song.id === best.song.id;
  const exactMetadata = metadataMatches.length === 1 && metadataMatches[0].song.id === best.song.id;
  // If research supplied an album, prefer exact matches on that container.
  // When Apple exposes only reissues/compilations, accept a different album
  // only when multiple exact results corroborate one recording family. A
  // single exact title on an unrelated album remains review-only.
  const sparseAlbumMatches = candidate.album
    ? sparseExactMatches.filter((item) => item.albumExact)
    : sparseExactMatches;
  const canonicalSparseMetadata = selectCanonicalSparseMatch(sparseAlbumMatches)
    ?? (candidate.album
      ? selectCanonicalSparseMatch(sparseExactMatches, false)
      : null);
  // Apple frequently moves featured performers between artistName and a
  // parenthetical title credit, or expands a cited primary artist into the
  // complete catalog collaborator credit. Once exact sparse metadata fails,
  // resolve those catalog-printing variants through the same ISRC/duration
  // recording-family guard. Live/remix/edit conflicts were excluded above.
  const sparseStrongCreditAlbumMatches = candidate.album
    ? sparseStrongCreditMatches.filter((item) => item.albumExact)
    : sparseStrongCreditMatches.filter((item) => !isDerivedCatalogContext(item.song));
  const canonicalSparseStrongCredit = selectCanonicalSparseMatch(sparseStrongCreditAlbumMatches)
    ?? (candidate.album
      ? selectCanonicalSparseMatch(sparseStrongCreditMatches, false)
      : null);
  const sparseLooseCreditAlbumMatches = candidate.album
    ? sparseLooseCreditMatches.filter((item) => item.albumExact)
    : sparseLooseCreditMatches.filter((item) => !isUnsafeLooseCreditContext(item.song));
  // Feature-title moves and catalog-added collaborators are looser than an
  // exact credit set. Require two Apple releases to corroborate one ISRC or
  // duration family unless the source also supplied the exact album.
  const canonicalSparseLooseCredit = selectCanonicalSparseMatch(
    sparseLooseCreditAlbumMatches,
    Boolean(candidate.album),
  ) ?? (candidate.album
    ? selectCanonicalSparseMatch(sparseLooseCreditMatches, false)
    : null);
  const canonicalSparseCredit = canonicalSparseStrongCredit ?? canonicalSparseLooseCredit;
  // Preserve the strongest existing stable-identifier / unique exact-metadata
  // path before consulting the broader sparse recording-family resolver. The
  // selected song is normally the same, but the stronger basis remains
  // explicit in evidence and regression reports.
  const acceptedMatch = exactIdentifier || exactMetadata
    ? best
    : canonicalSparseMetadata ?? canonicalSparseCredit;
  if (acceptedMatch) {
    return {
      candidateId,
      status: "accepted",
      basis: exactIdentifier
        ? `${acceptedMatch.basis}; unique compatible identifier`
        : exactMetadata
          ? `${acceptedMatch.basis}; unique exact metadata`
          : canonicalSparseMetadata
            ? `${acceptedMatch.basis}; exact sparse metadata selects a corroborated recording family`
            : canonicalSparseCredit
              ? `${acceptedMatch.basis}; compatible sparse catalog credit selects a corroborated recording family`
            : acceptedMatch.basis,
      score: acceptedMatch.score,
      song: acceptedMatch.song,
      alternatives: ranked.filter((item) => item.song.id !== acceptedMatch.song.id).slice(0, 4).map((item) => item.song),
    };
  }

  const directReview = ranked.find((item) => item.directReview);
  if (directReview) {
    const qualifier = directReview.titleExact
      ? "metadata requires review"
      : directReview.baseTitleExact
        ? "parenthetical title variant requires review"
        : directReview.compactTitleExact
          ? "punctuation-normalized title variant requires review"
          : "numbered-part title variant requires review";
    return {
      candidateId,
      status: "review",
      basis: `${directReview.basis || "catalog metadata"}; ${qualifier}`,
      score: directReview.score,
      song: directReview.song,
      alternatives: ranked.filter((item) => item.song.id !== directReview.song.id).slice(0, 4).map((item) => item.song),
    };
  }

  const titleReviews = ranked.filter((item) => item.titleReview);
  if (titleReviews.length === 1 && !titleReviews[0].versionConflict) {
    const only = titleReviews[0];
    return {
      candidateId,
      status: "review",
      basis: `${only.basis || "title"}; unique title result has unresolved artist or album attribution`,
      score: only.score,
      // A unique Apple title is not a unique recording. Keeping a wrong-artist
      // result as the primary made it selectable and could publish a cover or
      // unrelated recording (the Drexciya failure). Retain it only as an
      // explicit alternative until artist/album evidence binds it.
      song: null,
      alternatives: [only.song, ...ranked.filter((item) => item.song.id !== only.song.id).slice(0, 3).map((item) => item.song)],
    };
  }
  if (titleReviews.length > 0) {
    return {
      candidateId,
      status: "review",
      basis: titleReviews.some((item) => item.versionConflict)
        ? "Catalog title results have recording-version conflicts and require review"
        : "Multiple catalog recordings share this title; artist or album attribution is unresolved",
      score: titleReviews[0].score,
      song: null,
      alternatives: titleReviews.slice(0, 4).map((item) => item.song),
    };
  }
  return {
    candidateId,
    status: "unavailable",
    basis: "no exact or compatible base-title catalog result",
    score: best.score,
    song: null,
    alternatives: ranked.slice(0, 4).map((item) => item.song),
  };
}

export function canonicalRecordingKey(candidate: TrackCandidateInput): string {
  if (candidate.musicbrainzId) return `mb:${candidate.musicbrainzId}`;
  if (candidate.isrc) return `isrc:${candidate.isrc.toUpperCase()}`;
  return `meta:${normalizeMusicText(candidate.artist)}|${normalizeMusicText(candidate.title)}|${candidate.durationMs ?? "?"}`;
}
