import { sha256Hex, stableStringify } from "./security.ts";
import type { RunSpecV3, SemanticPlanClauseV32 } from "./selection-plan-v3.ts";

export const MUSIC_INTENT_ENVELOPE_VERSION = 1 as const;

export interface MusicIntentEnvelopeV1 {
  version: typeof MUSIC_INTENT_ENVELOPE_VERSION;
  requestedTrackCount: number;
  storefront: string;
  intents: readonly string[];
  membership: readonly {
    axis: string;
    operator: string;
    values: readonly string[];
  }[];
  preferences: readonly {
    axis: string;
    operator: string;
    values: readonly string[];
  }[];
  unresolvedAxes: readonly string[];
  envelopeHash: string;
}

const SAFE_VALUE_AXES = new Set([
  "content",
  "era",
  "genre",
  "instrumental",
  "language",
  "mood",
  "popularity",
  "recording_version",
  "scene",
  "tempo",
]);

function safeValues(clause: SemanticPlanClauseV32): string[] {
  if (!SAFE_VALUE_AXES.has(clause.axis)) return [];
  return clause.values
    .map((value) => value.normalize("NFKC").replace(/\s+/gu, " ").trim())
    .filter((value) => value.length > 0 && value.length <= 80)
    .slice(0, 6);
}

function projectedClause(clause: SemanticPlanClauseV32) {
  return {
    axis: clause.axis,
    operator: clause.operator,
    values: safeValues(clause),
  };
}

/**
 * The scout sees executable music semantics only. Narrative context, raw
 * prompt spans, named people, audience locations, custom answers, and model
 * discovery leads never cross this boundary.
 */
export function musicIntentEnvelopeV1(spec: RunSpecV3): MusicIntentEnvelopeV1 {
  const executable = spec.semanticClauses.filter((clause) => (
    clause.role !== "context"
    && clause.role !== "discovery_hint"
    && clause.source !== "guided_answer"
  ));
  const body = {
    version: MUSIC_INTENT_ENVELOPE_VERSION,
    requestedTrackCount: spec.requestedTrackCount,
    storefront: spec.storefront,
    intents: [...spec.intents].sort(),
    membership: executable
      .filter(({ role }) => role === "membership" || role === "catalog_policy")
      .map(projectedClause),
    preferences: executable
      .filter(({ role }) => role === "ranking" || role === "diversity_sequencing")
      .map(projectedClause),
    unresolvedAxes: [...new Set(spec.criticalAmbiguities.map(({ key }) => key))].sort(),
  };
  return {
    ...body,
    envelopeHash: sha256Hex(stableStringify(body)),
  };
}
