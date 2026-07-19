import type { PlaylistBrief, SelectionPlan } from "../shared/types.ts";

// These relationships cannot be established by catalog identity, artist
// association, or album membership. They require an exact-track source claim
// before Apple catalog resolution may begin.
const FACTUAL_TRACK_RELATIONSHIP = /\b(?:perform(?:ed|er|ance|ing)?|play(?:ed|ing)?(?:\s+(?:on|with))?|credit(?:ed|s)?|session(?:\s+(?:credit|work|player|musician))?|contribut(?:e|ed|es|ion|ions|or)|collaborat(?:e|ed|es|ion|ions|or)|produc(?:e|ed|er|tion)|wrote|written|songwrit(?:er|ing)|compos(?:e|ed|er|ition)|arrang(?:e|ed|er|ement)|sampl(?:e|ed|ing)|(?:featured|appear(?:s|ed)?)\s+on)\b/iu;

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
  return FACTUAL_TRACK_RELATIONSHIP.test(assertedScope);
}
