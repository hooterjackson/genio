import { createHash } from "node:crypto";

export interface ManifestContentHashTrack {
  candidateId: string;
  catalogId: string;
}

/**
 * Hash the exact ordered Apple manifest payload.
 *
 * Keep this shared between manifest persistence and publication. A broader
 * research-contract digest is useful provenance, but it cannot stand in for
 * the immutable ordered-track hash that the publisher verifies before any
 * Apple write.
 */
export function manifestContentHash(tracks: readonly ManifestContentHashTrack[]): string {
  const ordered = tracks.map((track, index) => [index, track.candidateId, track.catalogId]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}
