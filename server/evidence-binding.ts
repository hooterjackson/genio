import type { EvidenceClaimInput, PlaylistBrief } from "../shared/types.ts";

function normalizedBindingValue(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US")
    : "";
}

export type EvidenceSubjectBinding = Pick<EvidenceClaimInput, "subjectEntity" | "subjectRelationship">;

/**
 * Resolve a model/import claim to canonical values from the confirmed brief.
 * The server stores only this canonical pair, so a claim about a collaborator,
 * recording artist, or adjacent genre can never satisfy the requested subject.
 */
export function resolveEvidenceSubjectBinding(
  brief: Pick<PlaylistBrief, "subjectEntities" | "relationship">,
  subjectEntity: unknown,
  subjectRelationship: unknown,
): EvidenceSubjectBinding | null {
  const requestedEntity = normalizedBindingValue(subjectEntity);
  const requestedRelationship = normalizedBindingValue(subjectRelationship);
  if (!requestedEntity || !requestedRelationship) return null;

  const canonicalEntity = brief.subjectEntities.find(
    (entity) => normalizedBindingValue(entity) === requestedEntity,
  );
  if (!canonicalEntity || normalizedBindingValue(brief.relationship) !== requestedRelationship) return null;
  return {
    subjectEntity: canonicalEntity.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 240),
    subjectRelationship: brief.relationship.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 240),
  };
}
