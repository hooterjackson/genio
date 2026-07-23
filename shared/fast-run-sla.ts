export type FastRunServiceTier = "standard" | "extended" | "large" | "owner_large";

export interface FastRunServiceLevel {
  tier: FastRunServiceTier;
  maximumTracks: number;
  windowMinutes: number;
  runDeadlineMs: number;
  matchingReserveMs: number;
}

const SERVICE_LEVELS: readonly FastRunServiceLevel[] = [
  {
    tier: "standard",
    maximumTracks: 100,
    windowMinutes: 2,
    runDeadlineMs: 120_000,
    matchingReserveMs: 40_000,
  },
  {
    tier: "extended",
    maximumTracks: 200,
    windowMinutes: 4,
    runDeadlineMs: 240_000,
    matchingReserveMs: 60_000,
  },
  {
    tier: "large",
    maximumTracks: 300,
    windowMinutes: 6,
    runDeadlineMs: 360_000,
    matchingReserveMs: 90_000,
  },
  {
    // Internal owner/deep execution ceiling. The anonymous UI never advertises
    // this as a completion estimate; two minutes remains the interaction SLO
    // and fifteen active minutes is the immutable compute boundary.
    tier: "owner_large",
    maximumTracks: 1_000,
    windowMinutes: 15,
    runDeadlineMs: 900_000,
    matchingReserveMs: 180_000,
  },
] as const;

/**
 * Return the honest, bounded research-and-catalog window for a public curated
 * request. This is not a publication ETA: queueing and Apple's playlist-write
 * response can add time after the bounded research route.
 */
export function fastRunServiceLevel(trackCount: number): FastRunServiceLevel {
  const normalized = Number.isFinite(trackCount) ? Math.max(1, Math.floor(trackCount)) : 1;
  return SERVICE_LEVELS.find((level) => normalized <= level.maximumTracks)
    ?? SERVICE_LEVELS[SERVICE_LEVELS.length - 1]!;
}

export function fastRunWindowLabel(trackCount: number): string {
  return `${fastRunServiceLevel(trackCount).windowMinutes} MIN`;
}

export function fastRunWindowPhrase(trackCount: number): string {
  return `${fastRunServiceLevel(trackCount).windowMinutes}-minute`;
}

export function isSupportedFastRouteTiming(runDeadlineMs: number, matchingReserveMs: number): boolean {
  return SERVICE_LEVELS.some((level) =>
    level.runDeadlineMs === runDeadlineMs && level.matchingReserveMs === matchingReserveMs
  );
}
