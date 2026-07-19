import { createHash } from "node:crypto";

/**
 * Publication preflight never edits an already-locked manifest revision.  It
 * produces the complete track list for a *new* revision (or reports that the
 * existing revision remains valid), leaving persistence to the repository.
 */
export interface PreflightCatalogIdentity {
  id: string | null;
  catalogId: string;
  recordingFamilyId: string | null;
  identityConfidence: number;
  isPreferred: boolean;
  compatible: boolean;
}

export interface PreflightManifestTrack {
  position: number;
  candidateId: string;
  catalogId: string;
  artist: string;
  title: string;
  recordingFamilyId: string | null;
  catalogIdentityId: string | null;
  alternates: PreflightCatalogIdentity[];
}

/**
 * A recording that cleared evidence, hard constraints, version policy, and
 * catalog matching before the initial manifest was locked, but was held back
 * only because the requested count had already been filled. These fields are
 * explicit so a caller cannot accidentally offer an arbitrary match as a
 * publication substitute.
 */
export interface PreflightReserveTrack extends PreflightManifestTrack {
  evidenceEligible: boolean;
  hardConstraintsSatisfied: boolean;
  versionCompatible: boolean;
  qualified: boolean;
}

export interface ManifestPreflightResult {
  state: "unchanged" | "revision_required" | "no_compatible_tracks";
  tracks: PreflightManifestTrack[];
  unavailableCatalogIds: string[];
  substituted: Array<{
    candidateId: string;
    fromCatalogId: string;
    toCatalogId: string;
    replacementCandidateId?: string;
  }>;
  omittedCandidateIds: string[];
  reserveTracks: PreflightReserveTrack[];
  reasonCodes: string[];
  contentHash: string;
}

function normalizedCatalogId(value: string): string {
  return value.trim();
}

function isCompatibleAlternate(
  track: PreflightManifestTrack,
  alternate: PreflightCatalogIdentity,
  playable: ReadonlySet<string>,
): boolean {
  const catalogId = normalizedCatalogId(alternate.catalogId);
  if (!catalogId || !playable.has(catalogId) || !alternate.compatible) return false;
  // When a family is known, a substitute must be attached to that same
  // recording family.  A metadata-similarity cluster is never sufficient.
  if (track.recordingFamilyId && alternate.recordingFamilyId !== track.recordingFamilyId) return false;
  return catalogId !== normalizedCatalogId(track.catalogId);
}

function rankedAlternate(
  track: PreflightManifestTrack,
  playable: ReadonlySet<string>,
  alreadySelected: ReadonlySet<string>,
): PreflightCatalogIdentity | null {
  const alternatives = track.alternates
    .filter((alternate) => isCompatibleAlternate(track, alternate, playable))
    .filter((alternate) => !alreadySelected.has(normalizedCatalogId(alternate.catalogId)))
    .sort((left, right) => Number(right.isPreferred) - Number(left.isPreferred)
      || right.identityConfidence - left.identityConfidence
      || normalizedCatalogId(left.catalogId).localeCompare(normalizedCatalogId(right.catalogId)));
  return alternatives[0] ?? null;
}

function qualifiedReserve(
  reserves: readonly PreflightReserveTrack[],
  playable: ReadonlySet<string>,
  alreadySelected: ReadonlySet<string>,
  blockedFamilyIds: ReadonlySet<string>,
  usedReserveCandidateIds: ReadonlySet<string>,
): PreflightReserveTrack | null {
  for (const reserve of reserves) {
    const catalogId = normalizedCatalogId(reserve.catalogId);
    const eligible = reserve.qualified
      && reserve.evidenceEligible
      && reserve.hardConstraintsSatisfied
      && reserve.versionCompatible
      && Boolean(reserve.recordingFamilyId)
      && !blockedFamilyIds.has(reserve.recordingFamilyId!)
      && !usedReserveCandidateIds.has(reserve.candidateId);
    if (!eligible) continue;
    if (catalogId && playable.has(catalogId) && !alreadySelected.has(catalogId)) {
      return { ...reserve, catalogId };
    }
    const alternate = rankedAlternate(reserve, playable, alreadySelected);
    if (alternate) {
      return {
        ...reserve,
        catalogId: normalizedCatalogId(alternate.catalogId),
        catalogIdentityId: alternate.id,
      };
    }
  }
  return null;
}

export function manifestRevisionContentHash(tracks: readonly PreflightManifestTrack[]): string {
  const ordered = tracks.map((track, index) => [
    index,
    track.candidateId,
    normalizedCatalogId(track.catalogId),
  ]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/**
 * Build the next safe publication plan from a locked revision and a fresh
 * storefront lookup.  Missing songs are substituted only with a qualified,
 * compatible identity; otherwise they are omitted.  The caller must persist
 * `revision_required` as a new locked revision before any Apple write.
 */
export function preflightManifestRevision(
  tracks: readonly PreflightManifestTrack[],
  playableCatalogIds: ReadonlySet<string>,
  reserveTracks: readonly PreflightReserveTrack[] = [],
): ManifestPreflightResult {
  const playable = new Set([...playableCatalogIds].map(normalizedCatalogId).filter(Boolean));
  const selected = new Set<string>();
  const next: PreflightManifestTrack[] = [];
  const unavailableCatalogIds: string[] = [];
  const substituted: ManifestPreflightResult["substituted"] = [];
  const omittedCandidateIds: string[] = [];
  const usedReserveCandidateIds = new Set<string>();
  // A reserve must be a genuinely different recording, not another member of
  // any recording family already selected by the locked revision.
  const blockedReserveFamilyIds = new Set(tracks
    .map((track) => track.recordingFamilyId)
    .filter((familyId): familyId is string => Boolean(familyId)));

  for (const track of tracks) {
    const currentId = normalizedCatalogId(track.catalogId);
    if (currentId && playable.has(currentId) && !selected.has(currentId)) {
      selected.add(currentId);
      next.push({ ...track, position: next.length, catalogId: currentId });
      continue;
    }

    unavailableCatalogIds.push(currentId);
    const replacement = rankedAlternate(track, playable, selected);
    if (replacement) {
      const replacementId = normalizedCatalogId(replacement.catalogId);
      selected.add(replacementId);
      next.push({
        ...track,
        position: next.length,
        catalogId: replacementId,
        catalogIdentityId: replacement.id,
      });
      substituted.push({ candidateId: track.candidateId, fromCatalogId: currentId, toCatalogId: replacementId });
    } else {
      const reserve = qualifiedReserve(
        reserveTracks,
        playable,
        selected,
        blockedReserveFamilyIds,
        usedReserveCandidateIds,
      );
      if (reserve) {
        const replacementId = normalizedCatalogId(reserve.catalogId);
        selected.add(replacementId);
        usedReserveCandidateIds.add(reserve.candidateId);
        blockedReserveFamilyIds.add(reserve.recordingFamilyId!);
        next.push({ ...reserve, position: next.length, catalogId: replacementId });
        substituted.push({
          candidateId: track.candidateId,
          replacementCandidateId: reserve.candidateId,
          fromCatalogId: currentId,
          toCatalogId: replacementId,
        });
      } else {
        omittedCandidateIds.push(track.candidateId);
      }
    }
  }

  const reasonCodes = [
    ...(substituted.some((item) => item.replacementCandidateId === undefined)
      ? ["preflight_catalog_identity_substituted"] : []),
    ...(substituted.some((item) => item.replacementCandidateId !== undefined)
      ? ["preflight_qualified_reserve_substituted"] : []),
    ...(omittedCandidateIds.length > 0 ? ["preflight_catalog_identity_unavailable"] : []),
  ];
  return {
    state: next.length === 0
      ? "no_compatible_tracks"
      : reasonCodes.length > 0
        ? "revision_required"
        : "unchanged",
    tracks: next,
    unavailableCatalogIds,
    substituted,
    omittedCandidateIds,
    reserveTracks: reserveTracks.filter((reserve) => !usedReserveCandidateIds.has(reserve.candidateId)),
    reasonCodes,
    contentHash: manifestRevisionContentHash(next),
  };
}
