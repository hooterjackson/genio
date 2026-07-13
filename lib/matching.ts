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
  const flags = ["live", "remix", "edit", "acoustic", "instrumental", "re recorded", "remaster", "demo", "karaoke", "radio"];
  return new Set(flags.filter((flag) => normalized.includes(flag)));
}

function containsConflictingVersion(candidate: TrackCandidateInput, song: CatalogSong): boolean {
  const candidateFlags = versionFlags(candidate.versionLabel ?? "");
  const catalogText = normalizeMusicText(`${song.name} ${song.albumName} ${song.versionLabel ?? ""}`);
  const catalogFlags = versionFlags(catalogText);
  return [...candidateFlags].some((flag) => !catalogFlags.has(flag))
    || [...catalogFlags].some((flag) => !candidateFlags.has(flag));
}

export function rankCatalogMatches(
  candidateId: string,
  candidate: TrackCandidateInput,
  songs: CatalogSong[],
): CatalogMatchResult {
  const artist = normalizeMusicText(candidate.artist);
  const title = normalizeMusicText(candidate.title);
  const album = normalizeMusicText(candidate.album);

  const ranked = songs.map((song) => {
    let score = 0;
    const basis: string[] = [];
    const candidateIsrc = candidate.isrc?.toUpperCase() ?? null;
    const songIsrc = song.isrc?.toUpperCase() ?? null;
    const isrcMatch = Boolean(candidateIsrc && songIsrc && candidateIsrc === songIsrc);
    const isrcConflict = Boolean(candidateIsrc && songIsrc && candidateIsrc !== songIsrc);
    const artistExact = normalizeMusicText(song.artistName) === artist;
    const titleExact = normalizeMusicText(song.name) === title;
    const albumExact = !album || normalizeMusicText(song.albumName) === album;
    const durationExact = exactDuration(candidate.durationMs, song.durationInMillis);
    const versionConflict = containsConflictingVersion(candidate, song);
    const yearConflict = hasYearConflict(candidate, song);
    if (isrcMatch) {
      score += 100;
      basis.push("exact ISRC");
    }
    if (isrcConflict) score -= 200;
    if (artistExact) {
      score += 30;
      basis.push("artist");
    }
    if (titleExact) {
      score += 40;
      basis.push("title");
    }
    if (album && albumExact) {
      score += 15;
      basis.push("album");
    }
    if (durationExact) {
      score += 10;
      basis.push("duration");
    }
    if (versionConflict) score -= 100;
    if (yearConflict) score -= 60;
    const identifierCompatible = isrcMatch && artistExact && titleExact
      && compatibleDuration(candidate.durationMs, song.durationInMillis)
      && !versionConflict && !yearConflict;
    const metadataCompatible = !isrcConflict && artistExact && titleExact && albumExact
      && durationExact && !versionConflict && !yearConflict;
    return { song, score, basis: basis.join(", "), identifierCompatible, metadataCompatible };
  }).sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) {
    return { candidateId, status: "unavailable", basis: "no compatible catalog result", score: 0, song: null, alternatives: songs.slice(0, 4) };
  }

  const identifierMatches = ranked.filter((item) => item.identifierCompatible);
  const metadataMatches = ranked.filter((item) => item.metadataCompatible);
  const exactIdentifier = identifierMatches.length === 1 && identifierMatches[0].song.id === best.song.id;
  const exactMetadata = metadataMatches.length === 1 && metadataMatches[0].song.id === best.song.id;
  const hasPlausibleMetadata = normalizeMusicText(best.song.artistName) === artist && normalizeMusicText(best.song.name) === title;
  const status = exactIdentifier || exactMetadata ? "accepted" : hasPlausibleMetadata ? "review" : "unavailable";
  return {
    candidateId,
    status,
    basis: exactIdentifier ? `${best.basis}; unique compatible identifier`
      : exactMetadata ? `${best.basis}; unique exact metadata`
      : best.basis || "fuzzy metadata requires review",
    score: best.score,
    song: status === "unavailable" ? null : best.song,
    alternatives: ranked.slice(1, 5).map((item) => item.song),
  };
}

export function canonicalRecordingKey(candidate: TrackCandidateInput): string {
  if (candidate.musicbrainzId) return `mb:${candidate.musicbrainzId}`;
  if (candidate.isrc) return `isrc:${candidate.isrc.toUpperCase()}`;
  return `meta:${normalizeMusicText(candidate.artist)}|${normalizeMusicText(candidate.title)}|${candidate.durationMs ?? "?"}`;
}
