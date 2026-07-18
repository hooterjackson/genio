type UnknownObject = Record<string, unknown>;

function asObject(value: unknown): UnknownObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownObject
    : {};
}

export function apiErrorCode(payload: unknown): string | null {
  const object = asObject(payload);
  if (typeof object.code === "string") return object.code;
  const nested = asObject(object.error);
  return typeof nested.code === "string" ? nested.code : null;
}

export function shouldQuietlyClearInitialRunRestore({
  hasRunId,
  status,
  code,
}: {
  hasRunId: boolean;
  status: number;
  code?: string | null;
}): boolean {
  if (!hasRunId) return false;
  if (code === "capability_scope_mismatch") return true;
  return [400, 401, 404, 410].includes(status);
}

export function publishedTrackCountSummary(
  publishedTrackCount: number,
  requestedTrackCount?: number | null,
): string {
  const published = Math.max(0, Math.floor(publishedTrackCount));
  const requested = typeof requestedTrackCount === "number" && Number.isFinite(requestedTrackCount)
    ? Math.max(0, Math.floor(requestedTrackCount))
    : null;
  if (requested !== null && published !== requested) {
    return `${published.toLocaleString()} of ${requested.toLocaleString()} requested ${requested === 1 ? "track" : "tracks"} published.`;
  }
  return `${published.toLocaleString()} ${published === 1 ? "track" : "tracks"} published.`;
}

export function evidenceCountSummary(sourceCount: number, unresolvedGapCount: number): string {
  const sources = Math.max(0, Math.floor(sourceCount));
  const gaps = Math.max(0, Math.floor(unresolvedGapCount));
  return `Evidence: ${sources.toLocaleString()} documented ${sources === 1 ? "source" : "sources"}; ${gaps.toLocaleString()} open ${gaps === 1 ? "gap" : "gaps"}.`;
}

export function publishedResultHeading(
  publishedTrackCount: number,
  publishedWithGaps: boolean,
): string {
  if (publishedTrackCount <= 0) return "No compatible tracks found";
  return publishedWithGaps ? "Playlist published with gaps" : "Playlist published";
}
