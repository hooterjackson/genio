import type {
  SelectionConstraint,
  SelectionPlan,
  TrackScopeBinding,
} from "../shared/types.ts";
import { normalizeMusicText } from "../lib/matching.ts";
import { evidenceRelationshipIsMaterial } from "./evidence-relationship-policy.ts";
import { proofSupportsSelectionGeography } from "./selection-geography-policy.ts";

export interface EvidenceScopeDescriptor {
  scopeAxis: TrackScopeBinding["scopeAxis"];
  scopeValue: string;
  geographyRelationship: TrackScopeBinding["geographyRelationship"];
}

export interface AttestedEvidenceScopeProof {
  /** Persisted attestation identity; text without this durable join is context only. */
  citationAttestationId: string | null;
  /**
   * Provider-returned metadata for the cited source, such as the title carried
   * by the hosted-search citation annotation. Prompt, brief, SUBJECT, and
   * explanatory-note text must never be appended here.
   */
  sourceMetadataText?: string | null;
  /**
   * Source-specific assertion persisted on the evidence claim and bound to
   * the cited support line by citationTextIsLocalToClaim before this function
   * is reached. Unlike SUBJECT, RELATIONSHIP is not forced from the brief.
   */
  relationship: string;
}

const NON_PROOF_WORDS = new Set([
  "a", "an", "and", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with",
  "recording", "recordings", "song", "songs", "track", "tracks", "music",
]);

function normalized(value: string): string {
  return normalizeMusicText(value).replace(/\s+/gu, " ").trim();
}

function meaningfulTokens(value: string): string[] {
  return normalized(value).split(" ").filter((token) => token.length >= 3 && !NON_PROOF_WORDS.has(token));
}

function scopeProofSupportsValue(scopeProofText: string, value: string): boolean {
  const expected = [...new Set(meaningfulTokens(value))];
  if (expected.length === 0) return false;
  const proofTokens = new Set(meaningfulTokens(scopeProofText));
  const overlap = expected.filter((token) => proofTokens.has(token)).length;
  const required = expected.length <= 2 ? expected.length : Math.max(2, Math.ceil(expected.length / 2));
  return overlap >= required;
}

function bindingAxis(axis: SelectionConstraint["axis"]): TrackScopeBinding["scopeAxis"] | null {
  if (axis === "genre" || axis === "subgenre") return "genre";
  if (axis === "scene" || axis === "label" || axis === "venue") return "scene";
  if (axis === "era") return "era";
  if (axis === "geography") return "geography";
  if (axis === "language") return "language";
  if (axis === "mood") return "mood";
  if (axis === "activity") return "activity";
  if (axis === "theme") return "theme";
  return null;
}

function isPositiveHardConstraint(constraint: SelectionConstraint): boolean {
  return constraint.kind === "hard"
    && constraint.operator !== "exclude"
    && constraint.operator !== "avoid";
}

/**
 * Derive hard scope bindings exclusively from an attested relationship claim
 * and provider-returned source metadata.
 *
 * The model-authored brief, forced SUBJECT field, and evidence note frequently
 * repeat the requested values and therefore cannot prove them. In particular,
 * a Brazilian-disco prompt must not manufacture genre, geography, or era
 * bindings when the citation's actual relationship and source title only
 * identify a track. Every returned value is present in the persisted
 * relationship/source metadata, and exact geography semantics are checked
 * separately from a place-name mention.
 */
export function deriveAttestedHardScopeDescriptors(
  plan: Pick<SelectionPlan, "constraints"> | null,
  proof: AttestedEvidenceScopeProof,
): EvidenceScopeDescriptor[] {
  const relationship = proof.relationship.trim();
  const sourceMetadataText = proof.sourceMetadataText?.trim() ?? "";
  const scopeProofText = [relationship, sourceMetadataText].filter(Boolean).join(" \n");
  if (!plan || !proof.citationAttestationId?.trim() || !relationship
    || !evidenceRelationshipIsMaterial(relationship)) return [];

  const descriptors: EvidenceScopeDescriptor[] = [];
  const seen = new Set<string>();
  for (const constraint of plan.constraints) {
    if (!isPositiveHardConstraint(constraint)) continue;
    const scopeAxis = bindingAxis(constraint.axis);
    if (!scopeAxis) continue;

    for (const rawValue of constraint.values) {
      const scopeValue = rawValue.trim().slice(0, 240);
      if (!scopeValue || !scopeProofSupportsValue(scopeProofText, scopeValue)) continue;
      const geographyRelationship = constraint.geographyRelationship
        ?? (constraint.axis === "language" ? "language" : null);
      if (geographyRelationship
        && geographyRelationship !== "unspecified"
        && !proofSupportsSelectionGeography(scopeProofText, {
          value: scopeValue,
          relationship: geographyRelationship,
        })) continue;

      const key = `${scopeAxis}:${normalized(scopeValue)}:${geographyRelationship ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      descriptors.push({ scopeAxis, scopeValue, geographyRelationship });
    }
  }
  return descriptors;
}
