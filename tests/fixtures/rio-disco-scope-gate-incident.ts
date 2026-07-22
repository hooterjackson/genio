import type {
  SelectionConstraint,
  SelectionContentPolicy,
  SelectionDiversityGoals,
  SelectionOrderingPolicy,
  SelectionScopeKind,
  SelectionVersionPolicy,
} from "../../shared/types.ts";

/**
 * Sanitized production replay for the 2026-07 Rio disco scope-gate incident.
 *
 * The production checkpoint retained aggregate counts but not the provider's
 * complete response body. These deterministic observations preserve the
 * incident's cardinality, source-bound shape, duplicate distribution, and
 * execution gates without copying visitor or provider data into the test
 * suite. Do not replace this with model-generated data: it is a frozen
 * contract fixture for the semantic compiler and Apple-read boundary.
 */
export const RIO_DISCO_INCIDENT_PROMPT = "Rio Disco Classics: An exact 49-track playlist of iconic disco songs that someone born around 1960 in Rio de Janeiro would likely have grown up hearing in discoteques and nightlife settings. Focus on widely recognized disco-era hits and club staples from the late 1970s and early 1980s, with an emphasis on songs that were broadly popular in Rio’s dance culture rather than obscure deep cuts. Exclude modern disco revivals and non-disco genres unless they were clearly part of the era’s mainstream club rotation.";

export const RIO_DISCO_INCIDENT_REQUESTED_COUNT = 49;
export const RIO_DISCO_INCIDENT_VALID_COUNT = 142;
export const RIO_DISCO_INCIDENT_DUPLICATE_COUNT = 6;
export const RIO_DISCO_INCIDENT_APPLE_CALL_COUNT = 0;

export interface SanitizedRioDiscoObservation {
  id: string;
  artist: string;
  title: string;
  album: string;
  sourceObservationIds: string[];
  sourceUrl: string;
  relationship: "disco";
  valid: true;
  duplicateOf: string | null;
}

const uniqueObservations: SanitizedRioDiscoObservation[] = Array.from(
  { length: RIO_DISCO_INCIDENT_VALID_COUNT },
  (_, zeroBased) => {
    const ordinal = zeroBased + 1;
    const suffix = String(ordinal).padStart(3, "0");
    return {
      id: `rio-disco-observation-${suffix}`,
      artist: `Sanitized Disco Artist ${String((zeroBased % 47) + 1).padStart(2, "0")}`,
      title: `Sanitized Disco Recording ${suffix}`,
      album: `Sanitized Disco Source Volume ${String((zeroBased % 23) + 1).padStart(2, "0")}`,
      sourceObservationIds: [`rio-disco-source-observation-${suffix}`],
      sourceUrl: `https://evidence.example.test/rio-disco/${suffix}`,
      relationship: "disco",
      valid: true,
      duplicateOf: null,
    };
  },
);

const duplicateObservations: SanitizedRioDiscoObservation[] = Array.from(
  { length: RIO_DISCO_INCIDENT_DUPLICATE_COUNT },
  (_, zeroBased) => {
    const original = uniqueObservations[zeroBased]!;
    const suffix = String(zeroBased + 1).padStart(3, "0");
    return {
      ...original,
      id: `rio-disco-duplicate-${suffix}`,
      sourceObservationIds: [`rio-disco-duplicate-source-observation-${suffix}`],
      sourceUrl: `https://second-source.example.test/rio-disco/${suffix}`,
      duplicateOf: original.id,
    };
  },
);

const frozenObservations: SanitizedRioDiscoObservation[] = [
  ...uniqueObservations,
  ...duplicateObservations,
].map((observation) => Object.freeze(observation) as SanitizedRioDiscoObservation);

export const RIO_DISCO_INCIDENT_OBSERVATIONS: readonly SanitizedRioDiscoObservation[] =
  Object.freeze(frozenObservations);

export const RIO_DISCO_INCIDENT_BAD_PREDICATES = Object.freeze([
  Object.freeze({
    id: "v2:scope_1",
    kind: "genre",
    subject: "disco",
    relationship: "include",
    hard: true,
  }),
  Object.freeze({
    id: "v2:scope_2",
    kind: "geography",
    subject: "Rio de Janeiro",
    relationship: "include",
    hard: true,
  }),
  Object.freeze({
    id: "v2:version_12",
    kind: "recording_version",
    subject: "Prefer the historically canonical studio version while allowing compatible remasters.",
    relationship: "require",
    hard: true,
  }),
]);

export const RIO_DISCO_INCIDENT_BAD_HARD_CONSTRAINTS: readonly SelectionConstraint[] = Object.freeze([
  Object.freeze({
    id: "scope_1",
    axis: "genre",
    operator: "include",
    values: ["disco"],
    kind: "hard",
    geographyRelationship: null,
    relaxationRank: null,
  }),
  Object.freeze({
    id: "scope_2",
    axis: "geography",
    operator: "include",
    values: ["Rio de Janeiro"],
    kind: "hard",
    geographyRelationship: "unspecified",
    relaxationRank: null,
  }),
  Object.freeze({
    id: "version_12",
    axis: "recording_version",
    operator: "require",
    values: ["Prefer the historically canonical studio version while allowing compatible remasters."],
    kind: "hard",
    geographyRelationship: null,
    relaxationRank: null,
  }),
]);

export interface RioDiscoCompatibilityPlanFixture {
  intents: ["genre_scene", "editorial_ranking"];
  scopeKind: SelectionScopeKind;
  constraints: SelectionConstraint[];
  diversityGoals: SelectionDiversityGoals;
  orderingPolicy: SelectionOrderingPolicy;
  softGoalRelaxationOrder: string[];
  versionPolicy: SelectionVersionPolicy;
  contentPolicy: SelectionContentPolicy;
}

export function rioDiscoCompatibilityPlanFixture(): RioDiscoCompatibilityPlanFixture {
  return {
    intents: ["genre_scene", "editorial_ranking"],
    scopeKind: "broad_curated",
    constraints: RIO_DISCO_INCIDENT_BAD_HARD_CONSTRAINTS.map((constraint) => ({
      ...constraint,
      values: [...constraint.values],
    })),
    diversityGoals: {
      minimumDistinctArtists: 10,
      minimumDistinctAlbums: 12,
      minimumDistinctEras: 2,
      minimumDistinctScenes: 1,
      minimumDistinctGeographies: null,
      maximumTracksPerArtist: 8,
      maximumTracksPerAlbum: 5,
    },
    orderingPolicy: {
      mode: "editorial",
      goals: ["interleave artists and albums"],
      avoidAdjacentSameArtist: true,
      avoidAdjacentSameAlbum: true,
    },
    softGoalRelaxationOrder: [
      "sequencing_preferences",
      "album_concentration",
      "artist_concentration",
    ],
    versionPolicy: {
      preferred: ["canonical"],
      allowed: ["canonical", "clean", "explicit"],
      excludeCompilations: false,
      excludeKaraokeAndTributes: true,
    },
    contentPolicy: {
      explicitContent: "allow",
      instrumental: "allow",
      languages: [],
    },
  };
}

export const RIO_DISCO_INCIDENT_CHECKPOINT = Object.freeze({
  discovered: 148,
  validCandidates: 142,
  scopeEligible: 0,
  appleLookupCount: RIO_DISCO_INCIDENT_APPLE_CALL_COUNT,
  discardedByReason: Object.freeze({
    scope_membership_failed: 142,
    candidate_already_seen: 6,
  }),
});
