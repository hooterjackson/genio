import type { ManifestRevisionTrack } from "../shared/types.ts";
import {
  centralQualityCriterionObservationsForPolicyV3,
  validateCanonicalPublicationSetV3,
  type EvidenceBindingReferenceV3,
  type PlaylistOptimizationSignalsV3,
  type QualifiedTrackV3,
  type RetrievalUpstreamDependencyIdV3,
} from "./pipeline-v3-retrieval.ts";
import type { SelectionPlanV3 } from "./selection-plan-v3.ts";

export const CANONICAL_PUBLICATION_REVALIDATION_ERROR =
  "canonical_publication_revalidation_required" as const;

export class CanonicalPublicationRevalidationRequiredErrorV1 extends Error {
  readonly name = "CanonicalPublicationRevalidationRequiredErrorV1";
  readonly code = CANONICAL_PUBLICATION_REVALIDATION_ERROR;

  constructor(readonly reasonCodes: readonly string[]) {
    const reasons = [...new Set(reasonCodes)].slice(0, 32);
    super(
      `The repaired manifest no longer proves the active playlist contract: ${
        reasons.join(",") || "canonical_qualification_projection_missing"
      }`,
    );
    this.reasonCodes = reasons;
  }
}

export interface PersistedCanonicalQualificationV1 {
  candidateId: string;
  artist: string;
  title: string;
  album: string | null;
  recordingFamilyKey: string;
  decision: string;
  revokedAt: string | Date | null;
  predicateResults: unknown;
  evidenceRecordIds: unknown;
  evidenceBindings?: readonly EvidenceBindingReferenceV3[];
  qualityResult: unknown;
  catalogResult: unknown;
}

export interface CanonicalManifestRevalidationResultV1 {
  valid: boolean;
  reasonCodes: readonly string[];
  tracks: readonly QualifiedTrackV3[];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => (
        typeof item === "string" && item.trim().length > 0
      )).map((item) => item.trim()))]
    : [];
}

function dependencyIdArray(value: unknown): RetrievalUpstreamDependencyIdV3[] {
  const allowed = new Set<RetrievalUpstreamDependencyIdV3>([
    "orchestration_local",
    "apple_catalog",
    "hosted_web",
    "governed_evidence_graph",
  ]);
  return stringArray(value).filter(
    (item): item is RetrievalUpstreamDependencyIdV3 => (
      allowed.has(item as RetrievalUpstreamDependencyIdV3)
    ),
  );
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is number => (
        typeof item === "number" && Number.isFinite(item)
      )))].sort((left, right) => left - right)
    : [];
}

function rankingSignals(value: unknown): QualifiedTrackV3["rankingSignals"] {
  const row = objectValue(value);
  if (!row) return {};
  return Object.fromEntries(Object.entries(row).flatMap(([key, item]) => (
    typeof item === "number" && Number.isFinite(item)
      ? [[key, item]]
      : []
  ))) as QualifiedTrackV3["rankingSignals"];
}

function optimizationSignals(value: unknown): PlaylistOptimizationSignalsV3 | undefined {
  const row = objectValue(value);
  if (!row) return undefined;
  const result: PlaylistOptimizationSignalsV3 = {
    familiarityScore: optionalNumber(row.familiarityScore),
    discoveryScore: optionalNumber(row.discoveryScore),
    eraKeys: stringArray(row.eraKeys),
    sceneKeys: stringArray(row.sceneKeys),
    geographyKeys: stringArray(row.geographyKeys),
    energy: optionalNumber(row.energy),
    tempo: optionalNumber(row.tempo),
    chronologyPosition: optionalNumber(row.chronologyPosition),
  };
  return result;
}

function reconstructTrack(
  manifestTrack: ManifestRevisionTrack,
  qualification: PersistedCanonicalQualificationV1,
  qualityPolicy: SelectionPlanV3["playlistQualityPolicy"],
): QualifiedTrackV3 | null {
  if (qualification.decision !== "qualified"
    || qualification.revokedAt !== null
    || qualification.candidateId !== manifestTrack.candidateId
    || !manifestTrack.catalogId.trim()
    || !qualification.recordingFamilyKey.trim()) return null;

  const predicate = objectValue(qualification.predicateResults);
  const canonical = objectValue(predicate?.canonicalContract);
  const assessments = objectValue(canonical?.assessments);
  const quality = objectValue(qualification.qualityResult);
  const provenance = objectValue(quality?.provenance);
  const evidence = objectValue(quality?.evidence);
  const catalogEnvelope = objectValue(qualification.catalogResult);
  const nestedCatalog = objectValue(catalogEnvelope?.catalog);
  const nestedVersion = objectValue(catalogEnvelope?.version);
  const catalog = nestedCatalog ?? catalogEnvelope;
  if (!assessments || !catalog) return null;

  const appleSongId = typeof catalog.appleSongId === "string"
    ? catalog.appleSongId.trim()
    : "";
  const recordingFamilyKey = typeof catalog.recordingFamilyKey === "string"
    ? catalog.recordingFamilyKey.trim()
    : qualification.recordingFamilyKey.trim();
  if (appleSongId !== manifestTrack.catalogId.trim()
    || recordingFamilyKey !== qualification.recordingFamilyKey.trim()) return null;

  const evidenceRecordIds = stringArray(qualification.evidenceRecordIds);
  const projectedSignals = optimizationSignals(
    quality?.playlistOptimizationSignals,
  );
  const centralQualityCriterionObservations = qualityPolicy
    ? centralQualityCriterionObservationsForPolicyV3({
        observations: quality?.centralQualityCriterionObservations,
        policy: qualityPolicy,
        artist: qualification.artist,
        title: qualification.title,
        album: qualification.album,
        appleSongId,
        recordingFamilyKey,
      })
    : [];
  return {
    candidateId: manifestTrack.candidateId,
    title: qualification.title,
    artist: qualification.artist,
    album: qualification.album,
    appleSongId,
    recordingFamilyKey,
    catalogReleaseYear: optionalNumber(catalog.releaseYear),
    catalogCompatibleReleaseYears: numberArray(catalog.compatibleReleaseYears),
    catalogGenreNames: stringArray(catalog.genreNames),
    sourceObservationIds: [],
    evidenceBindingIds: evidenceRecordIds,
    evidenceBindings: structuredClone(qualification.evidenceBindings ?? []),
    discoveryDependencyIds: dependencyIdArray(provenance?.dependencyIds),
    provenanceRoots: stringArray(provenance?.provenanceRoots),
    ...([
      "live",
      "fresh_cache",
      "governed_snapshot",
      "orchestration_local",
    ].includes(String(provenance?.cacheOrigin ?? "")) ? {
      cacheOrigin: provenance!.cacheOrigin as QualifiedTrackV3["cacheOrigin"],
      sourceFreshUntil: typeof provenance?.sourceFreshUntil === "string"
        ? provenance.sourceFreshUntil
        : null,
    } : {}),
    canonicalClauseAssessments:
      structuredClone(assessments) as QualifiedTrackV3["canonicalClauseAssessments"],
    ...(projectedSignals ? {
      playlistOptimizationSignals: projectedSignals,
    } : {}),
    ...(qualityPolicy ? {
      centralQualityCriterionObservations,
    } : {}),
    evidenceStrength: finiteNumber(
      quality?.evidenceStrength ?? evidence?.strength,
      0,
    ),
    scopeFit: finiteNumber(objectValue(predicate?.scope)?.fit, 0),
    independentProvenanceRoots: Math.max(
      0,
      Math.floor(finiteNumber(
        quality?.independentProvenanceRoots
          ?? evidence?.independentProvenanceRoots,
        0,
      )),
    ),
    versionConfidence: finiteNumber(
      catalog.versionConfidence ?? nestedVersion?.confidence,
      0,
    ),
    catalogConfidence: finiteNumber(catalog.catalogConfidence ?? catalog.confidence, 0),
    rankingSignals: rankingSignals(quality?.rankingSignals),
    sourceRank: Math.max(
      0,
      finiteNumber(quality?.sourceRank, Number.MAX_SAFE_INTEGER),
    ),
  };
}

/**
 * Rebuild the exact qualification projection used by the canonical selector,
 * then re-run count, membership, quota, central-quality, diversity, and
 * sequencing checks against the repaired ordered manifest.
 *
 * The caller is responsible for loading qualification records through the
 * active database contract revision. This helper intentionally fails closed
 * if any selected row cannot be reconstructed from a current, non-revoked
 * qualification.
 */
export function revalidateCanonicalManifestRevisionV1(input: {
  plan: SelectionPlanV3;
  manifestTracks: readonly ManifestRevisionTrack[];
  qualifications: readonly PersistedCanonicalQualificationV1[];
  partialPublicationAuthorized?: boolean;
}): CanonicalManifestRevalidationResultV1 {
  if (!input.plan.canonicalContractPolicy) {
    return { valid: true, reasonCodes: [], tracks: [] };
  }
  const reasons: string[] = [];
  const ordered = [...input.manifestTracks].sort(
    (left, right) => left.position - right.position,
  );
  if (ordered.some((track, index) => track.position !== index)) {
    reasons.push("canonical_manifest_positions_invalid");
  }
  const qualificationsByCandidate = new Map<string, PersistedCanonicalQualificationV1>();
  for (const qualification of input.qualifications) {
    if (qualificationsByCandidate.has(qualification.candidateId)) {
      reasons.push("canonical_qualification_projection_ambiguous");
      continue;
    }
    qualificationsByCandidate.set(qualification.candidateId, qualification);
  }
  const reconstructed = ordered.flatMap((manifestTrack) => {
    const qualification = qualificationsByCandidate.get(manifestTrack.candidateId);
    if (!qualification) {
      reasons.push("canonical_qualification_projection_missing");
      return [];
    }
    const track = reconstructTrack(
      manifestTrack,
      qualification,
      input.plan.playlistQualityPolicy,
    );
    if (!track) {
      reasons.push("canonical_qualification_projection_invalid");
      return [];
    }
    return [track];
  });
  if (reconstructed.length !== ordered.length) {
    reasons.push("canonical_qualification_projection_incomplete");
  }
  if (reasons.length === 0) {
    try {
      const validation = validateCanonicalPublicationSetV3({
        plan: input.plan,
        tracks: reconstructed,
        partialPublicationAuthorized: input.partialPublicationAuthorized,
      });
      reasons.push(...validation.reasonCodes);
    } catch {
      reasons.push("canonical_publication_validation_error");
    }
  }
  return {
    valid: reasons.length === 0,
    reasonCodes: [...new Set(reasons)],
    tracks: reconstructed,
  };
}

export function assertCanonicalManifestRevisionV1(input: {
  plan: SelectionPlanV3;
  manifestTracks: readonly ManifestRevisionTrack[];
  qualifications: readonly PersistedCanonicalQualificationV1[];
  partialPublicationAuthorized?: boolean;
}): readonly QualifiedTrackV3[] {
  const result = revalidateCanonicalManifestRevisionV1(input);
  if (!result.valid) {
    throw new CanonicalPublicationRevalidationRequiredErrorV1(
      result.reasonCodes,
    );
  }
  return result.tracks;
}
