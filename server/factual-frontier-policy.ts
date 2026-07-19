import type { PlaylistBrief, SelectionPlan } from "../shared/types.ts";

// These relationships cannot be established by catalog identity, artist
// association, or album membership. They require an exact-track source claim
// before Apple catalog resolution may begin.
const FACTUAL_TRACK_RELATIONSHIP = /\b(?:performed\b.{0,40}\b(?:on|with)|performer\s+credit(?:s)?|performance\s+credit(?:s)?|played\b.{0,40}\b(?:on|with)|worked\b.{0,40}\b(?:on|with)|recorded\b.{0,40}\bwith|credited|credits|credit\s+(?:on|for|as)|session\s+(?:credit(?:s)?|work|player|musician)|wrote|written\s+by|songwriter\s+credit(?:s)?|composed\s+by|composer\s+credit(?:s)?|arranged\s+by|arranger\s+credit(?:s)?|sampl(?:e|ed|ing)|(?:featured|appear(?:s|ed)?)\s+on)\b/iu;

const FACTUAL_CONTRIBUTION_ACTION = /\b(?:contribut(?:e|ed|es|ing)\b.{0,40}\b(?:to|on)|contribution(?:s)?\s+(?:to|on)|contributor\s+(?:to|on)|collaborat(?:e|ed|es|ing)\s+(?:on|with)|collaboration(?:s)?\s+(?:on|with|between)|collaborator\s+(?:on|with))\b/iu;
const TRACK_SCOPE_NOUN = /\b(?:songs?|tracks?|recordings?|releases?|albums?|credits?)\b/iu;

// "Produced" is also a qualitative adjective ("well-produced ambient").
// Promote production language to claim-first research only when it asserts a
// producer/production-credit relationship to an exact recording.
const FACTUAL_PRODUCTION_RELATIONSHIP = /\b(?:produced\s+by|producer\s+(?:credit(?:s)?|on|for)|production\s+credit(?:s)?|credited\s+as\s+(?:an?\s+)?producer)\b/iu;

export function assertsFactualTrackRelationship(value: string): boolean {
  return FACTUAL_TRACK_RELATIONSHIP.test(value)
    || FACTUAL_PRODUCTION_RELATIONSHIP.test(value)
    || (FACTUAL_CONTRIBUTION_ACTION.test(value) && TRACK_SCOPE_NOUN.test(value));
}

/**
 * One compatibility predicate owns the boundary between relevance-first
 * curation and claim-first source-frontier work. Legacy V1 rows do not retain
 * a SelectionPlan, so the confirmed brief must remain sufficient to recover
 * the same route after a restart or mixed-version deployment.
 */
export function requiresFactualFrontier(
  brief: Pick<PlaylistBrief, "mode"> & Partial<Pick<PlaylistBrief, "relationship" | "evidencePolicy" | "include">>,
  selectionPlan?: Pick<SelectionPlan, "intents"> | null,
): boolean {
  if (selectionPlan?.intents.some((intent) => (
    intent === "factual_relationship" || intent === "exhaustive"
  ))) return true;

  // Hybrid is exhaustive within a bounded collection, era, or scene. It keeps
  // the same frontier-completion contract even when it has a finite target.
  if (brief.mode === "exhaustive" || brief.mode === "hybrid") return true;

  // Relationship/evidence prose asserts how the subject must be tied to an
  // exact track. Inclusion lists can contain incidental wording such as
  // "well-produced recordings" and must not silently promote an editorial
  // playlist to the much more expensive factual frontier.
  const assertedScope = [brief.relationship ?? "", brief.evidencePolicy ?? ""].join(" ");
  return assertsFactualTrackRelationship(assertedScope);
}
