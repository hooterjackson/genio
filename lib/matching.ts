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

function normalizeMusicCollaboratorSet(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/\s*(?:&|\band\b)\s*/iu)
    .map((member) => normalizeMusicArtistMember(member))
    .filter(Boolean)
    .sort();
}

function sameCollaboratorSet(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftMembers = normalizeMusicCollaboratorSet(left);
  const rightMembers = normalizeMusicCollaboratorSet(right);
  return leftMembers.length > 1
    && leftMembers.length === rightMembers.length
    && leftMembers.every((member, index) => member === rightMembers[index]);
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
    "demo", "karaoke", "radio", "extended",
  ];
  // Remasters and mono/stereo presentations generally retain the underlying
  // performance. They remain review-only through base-title matching instead
  // of being discarded as a conflicting recording. Match complete tokens so
  // titles such as "Deliver" do not accidentally acquire a "live" flag.
  return new Set(flags.filter((flag) => padded.includes(` ${flag} `)));
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
  titleExact: boolean;
  baseTitleExact: boolean;
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
  return {
    song,
    isrcMatch: Boolean(candidateIsrc && songIsrc && candidateIsrc === songIsrc),
    isrcConflict: Boolean(candidateIsrc && songIsrc && candidateIsrc !== songIsrc),
    artistExact: songArtist === candidateArtist,
    // Spacing in electronic aliases is inconsistent across catalogs
    // ("Model500" vs "Model 500"). This compatibility is review-only and is
    // never sufficient for an automatic metadata match.
    artistCompatible: artistCompactExact || artistLeadingArticleExact
      || artistCollaboratorSetExact,
    artistCompactExact,
    artistLeadingArticleExact,
    artistCollaboratorSetExact,
    titleExact: songTitle === title,
    baseTitleExact: Boolean(baseTitle && songBaseTitle === baseTitle),
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
    const titleCompatible = comparison.titleExact || comparison.baseTitleExact
      || comparison.compactTitleExact || comparison.partStemExact;
    // Album/title agreement alone cannot bind a recording to a different
    // credited artist. Compilations, covers, and similarly named releases are
    // common, so keep searching for an artist-compatible result.
    return titleCompatible && comparison.artistCompatible;
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
      && comparison.titleExact && (!candidate.album || comparison.albumExact)
      && comparison.durationExact && !comparison.versionConflict && !comparison.yearConflict;
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
  const exactIdentifier = identifierMatches.length === 1 && identifierMatches[0].song.id === best.song.id;
  const exactMetadata = metadataMatches.length === 1 && metadataMatches[0].song.id === best.song.id;
  if (exactIdentifier || exactMetadata) {
    return {
      candidateId,
      status: "accepted",
      basis: exactIdentifier ? `${best.basis}; unique compatible identifier` : `${best.basis}; unique exact metadata`,
      score: best.score,
      song: best.song,
      alternatives: ranked.slice(1, 5).map((item) => item.song),
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
