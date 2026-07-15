import type { CatalogMatchResult, CatalogSong, TrackCandidateInput } from "../shared/types.ts";

export function normalizeMusicText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(feat|featuring|ft)\.?\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
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
  const flags = [
    "live", "remix", "edit", "acoustic", "instrumental", "re recorded",
    "remaster", "demo", "karaoke", "radio", "mono", "stereo", "extended",
  ];
  return new Set(flags.filter((flag) => normalized.includes(flag)));
}

function containsConflictingVersion(candidate: TrackCandidateInput, song: CatalogSong): boolean {
  const candidateFlags = versionFlags(`${candidate.title} ${candidate.album ?? ""} ${candidate.versionLabel ?? ""}`);
  const catalogText = normalizeMusicText(`${song.name} ${song.albumName} ${song.versionLabel ?? ""}`);
  const catalogFlags = versionFlags(catalogText);
  return [...candidateFlags].some((flag) => !catalogFlags.has(flag))
    || [...catalogFlags].some((flag) => !candidateFlags.has(flag));
}

interface CatalogComparison {
  song: CatalogSong;
  isrcMatch: boolean;
  isrcConflict: boolean;
  artistExact: boolean;
  titleExact: boolean;
  baseTitleExact: boolean;
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
  const album = normalizeMusicText(candidate.album);
  return {
    song,
    isrcMatch: Boolean(candidateIsrc && songIsrc && candidateIsrc === songIsrc),
    isrcConflict: Boolean(candidateIsrc && songIsrc && candidateIsrc !== songIsrc),
    artistExact: normalizeMusicText(song.artistName) === normalizeMusicText(candidate.artist),
    titleExact: songTitle === title,
    baseTitleExact: Boolean(baseTitle && songBaseTitle === baseTitle),
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
    const titleCompatible = comparison.titleExact || comparison.baseTitleExact;
    return titleCompatible && (comparison.artistExact || comparison.albumExact);
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
    }
    if (comparison.titleExact) {
      score += 40;
      basis.push("title");
    } else if (comparison.baseTitleExact) {
      score += 28;
      basis.push("base title");
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
      && (comparison.titleExact || comparison.baseTitleExact)
      && compatibleDuration(candidate.durationMs, song.durationInMillis)
      && !comparison.versionConflict && !comparison.yearConflict;
    const metadataCompatible = !comparison.isrcConflict && comparison.artistExact
      && comparison.titleExact && (!candidate.album || comparison.albumExact)
      && comparison.durationExact && !comparison.versionConflict && !comparison.yearConflict;
    const directReview = !comparison.isrcConflict && !comparison.versionConflict
      && (comparison.titleExact || comparison.baseTitleExact)
      && (comparison.artistExact || comparison.albumExact);
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
    const qualifier = directReview.titleExact ? "metadata requires review" : "parenthetical title variant requires review";
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
      basis: `${only.basis || "title"}; unique title result but artist or album attribution requires review`,
      score: only.score,
      song: only.song,
      alternatives: ranked.filter((item) => item.song.id !== only.song.id).slice(0, 4).map((item) => item.song),
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
