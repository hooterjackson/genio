import { normalizeMusicText } from "./matching.ts";

export interface BenchmarkTrack {
  artist: string;
  title: string;
  citationUrls?: string[];
}

export interface MatchAuditRow {
  autoAccepted: boolean;
  correct: boolean;
  storefrontAvailable: boolean;
  resolved: boolean;
}

export interface CuratedRatings {
  citationQuality: number;
  historicalRelevance: number;
  berlinSceneFit: number;
  eraDiversity: number;
  artistDiversity: number;
  duplicateAvoidance: number;
  playlistCoherence: number;
}

/**
 * A 99.5% catalog-identity claim is not statistically credible from the old
 * 100-row fixture. Release evidence requires roughly 600 independently
 * reviewed, auto-accepted rows with zero observed identity errors before that
 * claim may be made.
 */
export const MINIMUM_FACTUAL_MATCH_SAMPLE = 600;

function trackKey(track: Pick<BenchmarkTrack, "artist" | "title">): string {
  return `${normalizeMusicText(track.artist)}\u0000${normalizeMusicText(track.title)}`;
}

export function evaluateHoldoutRecovery(expected: BenchmarkTrack[], actual: BenchmarkTrack[]) {
  const actualKeys = new Set(actual.map(trackKey));
  const missing = expected.filter((track) => !actualKeys.has(trackKey(track)));
  const recovered = expected.length - missing.length;
  const recall = expected.length === 0 ? 1 : recovered / expected.length;
  return { expected: expected.length, recovered, recall, missing, passed: recall === 1 };
}

export function evaluateMatchingQuality(rows: MatchAuditRow[], minimumSampleSize = MINIMUM_FACTUAL_MATCH_SAMPLE) {
  const accepted = rows.filter((row) => row.autoAccepted);
  const available = rows.filter((row) => row.storefrontAvailable);
  const precision = accepted.length === 0 ? null : accepted.filter((row) => row.correct).length / accepted.length;
  const resolvability = available.length === 0 ? null : available.filter((row) => row.resolved).length / available.length;
  return {
    autoAccepted: accepted.length,
    sampleSize: rows.length,
    minimumSampleSize,
    storefrontAvailable: available.length,
    precision,
    resolvability,
    passed: rows.length >= minimumSampleSize
      && accepted.length >= minimumSampleSize
      && precision === 1
      && resolvability !== null && resolvability >= 0.95,
  };
}

export function evaluateCuratedPlaylist(
  tracks: BenchmarkTrack[],
  ratings: CuratedRatings,
  target: { min: number; max: number } = { min: 50, max: 100 },
) {
  const keys = tracks.map(trackKey);
  const uniqueCount = new Set(keys).size;
  const citedCount = tracks.filter((track) => (track.citationUrls?.length ?? 0) > 0).length;
  const artistCounts = new Map<string, number>();
  for (const track of tracks) {
    const artist = normalizeMusicText(track.artist);
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
  }
  const maximumArtistShare = tracks.length === 0 ? 0 : Math.max(0, ...artistCounts.values()) / tracks.length;
  const ratingEntries = Object.entries(ratings);
  const ratingsValid = ratingEntries.length === 7
    && ratingEntries.every(([, score]) => Number.isFinite(score) && score >= 0 && score <= 5);
  const lowRatings = ratingEntries.filter(([, score]) => score < 4).map(([dimension]) => dimension);
  const citationCoverage = tracks.length === 0 ? 0 : citedCount / tracks.length;
  return {
    trackCount: tracks.length,
    uniqueCount,
    citationCoverage,
    maximumArtistShare,
    lowRatings,
    passed: tracks.length >= target.min
      && tracks.length <= target.max
      && uniqueCount === tracks.length
      && citationCoverage === 1
      && maximumArtistShare <= 0.15
      && ratingsValid
      && lowRatings.length === 0,
  };
}
