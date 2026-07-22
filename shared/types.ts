export type PlaylistMode = "exhaustive" | "curated" | "hybrid";
export type EvidenceState = "verified" | "corroborated" | "editorial" | "inferred" | "disputed";
export type RunStatus =
  | "draft"
  | "awaiting_guidance"
  | "queued"
  | "awaiting_budget"
  | "researching"
  | "ready_for_matching"
  | "matching"
  | "resolving_catalog"
  | "review"
  | "visitor_review"
  | "partial_ready"
  | "continuing_research"
  | "manifest_ready"
  | "publishing"
  | "waiting_for_apple_authorization"
  | "waiting_for_corpus_review"
  | "complete"
  | "partial"
  | "no_compatible_tracks"
  | "cancelled"
  | "failed"
  | "failed_system"
  | "failed_integrity"
  | "expired"
  | "deleted";

export type JobKind =
  | "brief"
  | "research"
  | "matching"
  | "publication"
  | "retention"
  | "notification"
  | "apple_authorization"
  | "pipeline_observability";
export type JobStatus = "queued" | "leased" | "retry" | "complete" | "failed" | "cancelled";
export type MatchStatus = "accepted" | "review" | "unavailable" | "rejected" | "duplicate" | "unsupported" | "overflow";
export type PublicationStatus = "queued" | "creating" | "appending" | "waiting_for_share_url" | "complete" | "orphaned" | "waiting_for_owner" | "failed";

/**
 * Durable pipeline identifiers. Existing rows are explicitly marked legacy so
 * a mixed-version deployment can read old work without pretending it was
 * produced by the catalog-first policy.
 */
export type PipelineVersion = "legacy_v1" | "catalog_first_v2" | "corpus_first_v3" | "pipeline_v2";
export type PipelinePolicyVersion =
  | "legacy_v1"
  | "catalog_first_v2_policy_v1"
  | "corpus_first_v3_policy_v1"
  | "relevance_first_2026_07"
  | "relevance_first_2026_07_r2";

/** Primary research intents. Several may coexist in one request. */
export type ResearchIntent =
  | "genre_scene"
  | "similarity"
  | "mood_activity"
  | "theme"
  | "artist_catalogue"
  | "editorial_ranking"
  | "factual_relationship"
  | "exhaustive";

export type ResearchArchetype =
  | "genre_scene"
  | "similarity"
  | "mood_theme_activity"
  | "artist_catalog"
  | "editorial_ranked"
  | "factual_relationship"
  | "exhaustive";

export type SelectionConstraintKind = "hard" | "soft";
export type SelectionConstraintAxis =
  | "genre"
  | "scene"
  | "subgenre"
  | "era"
  | "geography"
  | "language"
  | "mood"
  | "activity"
  | "theme"
  | "artist"
  | "album"
  | "track"
  | "label"
  | "venue"
  | "recording_version"
  | "content"
  | "evidence"
  | "relationship";
export type SelectionConstraintOperator =
  | "include"
  | "exclude"
  | "prefer"
  | "avoid"
  | "require"
  | "within"
  | "before"
  | "after"
  | "between"
  | "maximum";

/** One independently enforceable rule, with an explicit relaxation contract. */
export interface SelectionConstraint {
  id: string;
  axis: SelectionConstraintAxis;
  operator: SelectionConstraintOperator;
  values: string[];
  kind: SelectionConstraintKind;
  /** Exact place/language semantics; `unspecified` preserves real ambiguity. */
  geographyRelationship?: SelectionGeographyRelationship | null;
  /** Null for hard constraints; unique ascending rank for soft goals. */
  relaxationRank: number | null;
}

export type SelectionGeographyRelationship =
  | "artist_origin"
  | "artist_residence"
  | "recording_location"
  | "label_or_venue_scene"
  | "language"
  | "sound_association"
  | "unspecified";

export interface SelectionEraConstraint {
  label: string;
  startYear: number | null;
  endYear: number | null;
}

export interface SelectionGeographyConstraint {
  value: string;
  relationship: SelectionGeographyRelationship;
}

/**
 * Orthogonal constraints survive strategy selection. A ResearchArchetype may
 * choose an execution path, but it must never flatten a similarity + mood +
 * era + exclusion request into one lossy label.
 */
export interface SelectionConstraints {
  genres: string[];
  scenes: string[];
  subgenres: string[];
  eras: SelectionEraConstraint[];
  geographies: SelectionGeographyConstraint[];
  languages: string[];
  moods: string[];
  themes: string[];
  activities: string[];
  seedArtists: string[];
  seedTracks: string[];
  hardIncludes: string[];
  hardExcludes: string[];
}

export interface SelectionDiversityGoals {
  minimumDistinctArtists: number | null;
  minimumDistinctAlbums: number | null;
  minimumDistinctEras: number | null;
  minimumDistinctScenes: number | null;
  minimumDistinctGeographies: number | null;
  maximumTracksPerArtist: number | null;
  maximumTracksPerAlbum: number | null;
}

export interface SelectionOrderingPolicy {
  mode: "editorial" | "smooth" | "contrast" | "chronological" | "source_order";
  goals: string[];
  avoidAdjacentSameArtist: boolean;
  avoidAdjacentSameAlbum: boolean;
}

export interface SelectionVersionPolicy {
  preferred: RecordingVersionClass[];
  allowed: RecordingVersionClass[];
  excludeCompilations: boolean;
  excludeKaraokeAndTributes: boolean;
}

export interface SelectionContentPolicy {
  explicitContent: "allow" | "prefer_clean" | "clean_only";
  instrumental: "allow" | "prefer" | "exclude";
  languages: string[];
}

/**
 * Structural scope of a playlist request. This is intentionally distinct from
 * research intent: a curated request can still name one fixed release, whose
 * album identity must not be discarded during catalog matching.
 */
export type SelectionScopeKind =
  | "broad_curated"
  | "artist_catalogue"
  | "fixed_release_container"
  | "factual_frontier";

export interface SelectionPlan {
  schemaVersion: 1;
  pipelineVersion: PipelineVersion;
  policyVersion: PipelinePolicyVersion;
  intents: ResearchIntent[];
  /** Optional only so plans persisted before this discriminator remain readable. */
  scopeKind?: SelectionScopeKind;
  /** Compatibility routing hints only; constraints and intents are authoritative. */
  archetypes?: ResearchArchetype[];
  storefront: string;
  requestedTrackCount: number;
  minimumQualifiedTrackCount: number;
  reserveTrackCount: number;
  constraints: SelectionConstraint[];
  /** Typed place/language semantics retained independently of prose. */
  geographyConstraints: SelectionGeographyConstraint[];
  similarityDimensions: string[];
  labels: string[];
  venues: string[];
  referenceRecordings: string[];
  softGoalRelaxationOrder: string[];
  diversityGoals: SelectionDiversityGoals;
  evidencePolicy: string;
  versionPolicy: SelectionVersionPolicy;
  orderingPolicy: SelectionOrderingPolicy;
  contentPolicy: SelectionContentPolicy;
  /** Original v1 axis bags, retained only while legacy workers are drained. */
  legacyConstraintAxes?: SelectionConstraints;
}

/**
 * Immutable execution plan for the corpus-first pipeline. This is deliberately
 * separate from SelectionPlan: V3 evaluates normalized graph assertions and
 * catalog identities instead of reinterpreting mutable prompt prose at every
 * stage.
 */
export type QueryPlanV3Engine =
  | "curated_genre_scene"
  | "mood_activity_theme"
  | "similarity"
  | "artist_catalogue"
  | "fixed_container"
  | "factual_relationship"
  | "exhaustive";

export interface QueryPlanV3Predicate {
  id: string;
  kind: string;
  subject: string;
  relationship: string;
  hard: boolean;
}

/**
 * Query-plan schema 2 persists the scope compiler's typed clause contract.
 * `QueryPlanV3Predicate` remains as a compatibility projection for schema-1
 * workers and governed-graph readers; schema-2 workers execute these clauses
 * directly and never split the legacy `subject` presentation string.
 */
export type QueryPlanV3ClauseRole =
  | "membership"
  | "catalog_policy"
  | "context"
  | "ranking"
  | "diversity_sequencing"
  | "discovery_hint";

export type QueryPlanV3ClauseSource =
  | "raw_prompt"
  | "guided_answer"
  | "v2_compatibility"
  | "system_default";

export interface QueryPlanV3SemanticClause {
  id: string;
  role: QueryPlanV3ClauseRole;
  axis: string;
  operator: string;
  values: string[];
  source: QueryPlanV3ClauseSource;
  explicitUserAuthored: boolean;
  geographyRelationship: SelectionGeographyRelationship | null;
  reason: string;
}

export interface QueryPlanV3RecordingPolicy {
  allowedVersions: (
    | "canonical"
    | "clean"
    | "explicit"
    | "live"
    | "remix"
    | "radio_edit"
    | "extended"
    | "acoustic"
    | "instrumental"
  )[];
  preferCanonicalStudio: boolean;
  excludeKaraokeTributeAndCovers: boolean;
}

/** Compact compiler audit: enough to reject semantic drift without copying prompt prose. */
export interface QueryPlanV3SemanticAuditMetadata {
  semanticPolicyVersion: string;
  /** Exact server-owned music-concept registry used by the semantic compiler. */
  musicConceptPolicyVersion: string;
  passed: boolean;
  hardConstraintHash: string;
  explicitUserConstraintHash: string;
  clauseCount: number;
  membershipClauseCount: number;
  contextClauseCount: number;
  catalogPolicyClauseCount: number;
  aliasCollapses: string[];
  contradictions: string[];
}

export interface QueryPlanV3RankingObjective {
  id: string;
  kind: string;
  description: string;
  weight: number;
  /**
   * Optional for query plans written before objective seed persistence.
   * Similarity plans use this to retain the reference artist/recording across
   * the database and worker boundary.
   */
  values?: string[];
}

/**
 * Immutable authorization for the single V3 continuation pass. The successor
 * query-plan revision binds the work to the exact partial outcome and source
 * checkpoint that exposed the remaining server-approved strategies.
 */
export interface QueryPlanV3Continuation {
  sourceQueryPlanRevisionId: string;
  sourceQueryPlanHash: string;
  sourceStageKey: string;
  sourceOutcomeHash: string;
  sourceOutcomeVersion: number;
  strategyIds: string[];
}

/**
 * Immutable proof that an owner reviewed a cold factual/exhaustive corpus
 * batch and activated a successor graph snapshot. The marker belongs on the
 * successor query-plan revision; the source revision remains unchanged.
 */
export interface QueryPlanV3CorpusReview {
  sourceQueryPlanRevisionId: string;
  sourceQueryPlanHash: string;
  sourceStageKey: string;
  sourceCheckpointHash: string;
  reviewedGraphSnapshotId: string;
  enumerationComplete: boolean;
  reviewedAt: string;
}

/**
 * A bounded discovery lead captured from the provider-returned guidance
 * scout response. This is intentionally not evidence: retrieval must fetch
 * the URL again, and the exact URL must be returned by that retrieval
 * response before it may support a track.
 */
export interface PipelineV3SourceDiscoveryHint {
  url: string;
  title: string;
  excerpt: string;
  attestation: "guidance_scout_provider_response";
}

export interface QueryPlanV3 {
  schemaVersion: 1 | 2 | 3;
  pipelineVersion: "corpus_first_v3";
  policyVersion: "corpus_first_v3_policy_v1" | "corpus_first_v3_policy_v2";
  engine: QueryPlanV3Engine;
  /** Composite requests may use several engines; `engine` is the durable primary queue class. */
  engines: QueryPlanV3Engine[];
  /** Hash of the immutable confirmed selection-plan revision used to build this query plan. */
  selectionPlanHash: string;
  graphSnapshotId: string;
  membershipPredicates: QueryPlanV3Predicate[];
  rankingObjectives: QueryPlanV3RankingObjective[];
  targetTrackCount: number | null;
  storefront: string;
  hardConstraints: SelectionConstraint[];
  softPreferences: SelectionConstraint[];
  sourceDiscoveryHints: PipelineV3SourceDiscoveryHint[];
  /**
   * Optional only for query plans written before V3 selection-policy
   * persistence shipped. New plans always carry these fields; workers use
   * conservative engine-derived defaults when draining an older plan.
   */
  scopeKind?: SelectionScopeKind;
  diversityGoals?: SelectionDiversityGoals;
  orderingPolicy?: SelectionOrderingPolicy;
  softGoalRelaxationOrder?: string[];
  /**
   * Schema-2 semantic execution contract. These are absent from historical
   * schema-1 plans, which continue to decode through the legacy projection.
   */
  semanticPolicyVersion?: string;
  /** Required on schema-2 plans; absent from historical schema-1 plans. */
  musicConceptPolicyVersion?: string;
  semanticClauses?: QueryPlanV3SemanticClause[];
  contextSignals?: QueryPlanV3SemanticClause[];
  catalogPolicies?: QueryPlanV3SemanticClause[];
  recordingPolicy?: QueryPlanV3RecordingPolicy;
  explicitUserConstraintHash?: string;
  /** Legacy-compatible top-level audit hash retained for fast integrity checks. */
  hardConstraintHash?: string;
  semanticAuditMetadata?: QueryPlanV3SemanticAuditMetadata;
  /** Contract-2 fencing metadata required by query-plan schema 3. */
  briefContractVersion?: PlaylistBriefContractVersion;
  guidancePolicyVersion?: string;
  evidencePolicyVersion?: string;
  executionDeltaHash?: string;
  continuation?: QueryPlanV3Continuation;
  corpusReview?: QueryPlanV3CorpusReview;
}

/**
 * The fully resolved execution contract captured when a Pipeline V2 run is
 * created.  Resumed work must consume this value instead of re-reading mutable
 * process environment configuration.
 */
export type PipelineExecutionPolicySnapshot =
  | {
    kind: "fast_curated";
    version: string;
    model: string;
    runDeadlineMs: number;
    matchingReserveMs: number;
    targetMinimum: number;
    targetMaximum: number;
    candidateGoal: number;
    candidateLimit: number;
    maxPasses: number;
    maxWebToolCalls: number;
    maxSynthesisTokens: number;
    maxExtractionTokens: number;
    searchContextSize: "low" | "medium";
    modelRoute: {
      version: string;
      tier: "luna" | "terra";
      modelSnapshot: string;
      reason: string;
      scoutConfidence: "high" | "medium" | "low";
      structuredRepairFailures: number;
    };
  }
  | {
    kind: "deep";
    version: string;
    model: string;
  }
  | {
    kind: "corpus_first_v3";
    version: "corpus_first_v3_policy_v1";
    model: string;
    modelRoute: {
      version: "pipeline_v3_model_route_v2";
      tier: "baseline" | "escalation";
      providerModelId: string;
      baselineProviderModelId: string;
      escalationProviderModelId: string;
      resolutionMode: "provider_managed_alias";
      modelCatalogValidatedAt: string;
      reason: "baseline" | "interpretation_low_confidence" | "structured_repair_failed";
      interpretationConfidence: "high" | "medium" | "low";
      structuredRepairFailures: number;
      /** V3 permits no more than one higher-capability attempt. */
      escalationCount: 0 | 1;
    };
    maximumGlobalRounds: number;
    maximumRawCandidates: number;
    reservePercent: number;
    maximumCostUsd: number;
  };

export interface PipelinePolicySnapshot {
  schemaVersion: 1;
  pipelineVersion: PipelineVersion;
  policyVersion: PipelinePolicyVersion;
  selectionPlanVersion: string;
  capturedAt: string;
  storefront: string;
  executionPolicy: PipelineExecutionPolicySnapshot;
  requestLimits: {
    maxToolCalls: number | null;
    maxHostedSearchCalls: number | null;
    maxSynthesisTokens: number | null;
    maxExtractionTokens: number | null;
  };
  costLimits: {
    scoutUsd: number;
    curatedRunUsd: number | null;
    factualApprovalGateUsd: number;
    postMatchRefillUsd: number;
  };
  catalogLimits: {
    appleConcurrencyInitial: number;
    appleConcurrencyMinimum: number;
    appleConcurrencyMaximum: number;
    catalogRecoveryDeadlineMs: number;
    catalogLookupTimeoutMs: number;
    musicBrainzMaxUncachedRequests: number;
    maximumRawDiscoveryGoal: number;
    catalogResourceCacheTtlSeconds: number;
    catalogSearchCacheTtlSeconds: number;
    playlistMembershipCacheTtlSeconds: number;
  };
  durableResearchLimits: {
    gapPasses: number;
    turnsPerSegment: number;
    segmentsPerPass: number;
  };
  evidencePolicy: string;
}

export type TrackScopeBindingKind =
  | "track_specific_source"
  | "scoped_container_membership"
  | "catalog_editorial_membership"
  | "catalog_genre_metadata"
  | "artist_scope"
  | "album_scope"
  | "lexical_match"
  | "manual_import";

export type TrackScopeBindingEligibility =
  | "qualifying"
  | "supporting"
  | "discovery_only"
  | "rejected";

/** Auditable reason that one exact recording belongs in the requested scope. */
export interface TrackScopeBinding {
  bindingKind: TrackScopeBindingKind;
  eligibility: TrackScopeBindingEligibility;
  scopeAxis: ResearchArchetype | "genre" | "scene" | "era" | "geography" | "language" | "mood" | "theme" | "activity";
  scopeValue: string;
  /** Exact place/language relationship established by this source. */
  geographyRelationship?: SelectionGeographyRelationship | null;
  relationship: string;
  confidence: number;
  sourceUrl: string | null;
  sourceRecordId: string | null;
  researchContainerId: string | null;
  citationAttestationId: string | null;
  provenancePath: Array<{ kind: string; id: string; label?: string }>;
  note: string;
}

/** Independently auditable proof layers retained by Pipeline V2. */
export type EvidenceLayer =
  | "catalog_identity"
  | "scope_binding"
  | "track_claim"
  | "factual_claim";

export type CandidateStage =
  | "discovered"
  | "identity_resolved"
  | "scope_qualified"
  | "claim_verified"
  | "version_compatible"
  | "playable"
  | "canonicalized"
  | "catalog_resolved"
  | "eligible"
  | "quota_eligible"
  | "sequenced"
  | "manifested"
  | "published"
  | "selected"
  | "rejected"
  | "exhausted";

export interface CandidateStageEvent {
  candidateId: string;
  fromStage: CandidateStage | null;
  toStage: CandidateStage;
  reasonCode: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

export type PipelineDeficitKind =
  | "candidate_pool"
  | "scope_relevance"
  | "catalog_availability"
  | "recording_identity"
  | "evidence"
  | "artist_breadth"
  | "album_cap"
  | "version_policy"
  | "source_frontier"
  | "provider_unavailable";

export type PipelineDeficitStatus = "open" | "resolved" | "exhausted" | "waived";

export interface PipelineDeficitLedgerEntry {
  stage: CandidateStage;
  kind: PipelineDeficitKind;
  status: PipelineDeficitStatus;
  requiredCount: number;
  actualCount: number;
  deficitCount: number;
  reasonCode: string;
  detail: Record<string, unknown>;
  observedAt: string;
}

export type RecordingVersionClass =
  | "canonical"
  | "remaster"
  | "radio_edit"
  | "extended"
  | "remix"
  | "live"
  | "acoustic"
  | "clean"
  | "explicit"
  | "instrumental"
  | "karaoke"
  | "cover"
  | "alternate"
  | "unknown";

export interface AlternateCatalogIdentity {
  id: string;
  recordingFamilyId: string;
  provider: "apple" | "musicbrainz" | "discogs" | "import";
  storefront: string | null;
  catalogId: string;
  isPreferred: boolean;
  identityConfidence: number;
  artist: string;
  title: string;
  album: string | null;
  isrc: string | null;
  musicbrainzId: string | null;
  durationMs: number | null;
  versionLabel: string | null;
  metadata: Record<string, unknown>;
}

export interface RecordingFamily {
  id: string;
  runId: string;
  pipelineVersion: PipelineVersion;
  policyVersion: PipelinePolicyVersion;
  familyKey: string;
  canonicalArtist: string;
  canonicalTitle: string;
  versionClass: RecordingVersionClass;
  metadata: Record<string, unknown>;
  candidateIds: string[];
  catalogIdentities: AlternateCatalogIdentity[];
}

export type ManifestRevisionStatus = "draft" | "locked" | "superseded" | "published" | "abandoned";

export interface ManifestRevisionTrack {
  position: number;
  candidateId: string;
  recordingFamilyId: string | null;
  catalogIdentityId: string | null;
  catalogId: string;
  artist: string;
  title: string;
}

export interface ManifestRevisionReserveTrack extends ManifestRevisionTrack {
  evidenceEligible: boolean;
  hardConstraintsSatisfied: boolean;
  versionCompatible: boolean;
  qualified: boolean;
}

export interface ManifestRevision {
  id: string;
  manifestId: string;
  revision: number;
  parentRevisionId: string | null;
  status: ManifestRevisionStatus;
  reason: string;
  contentHash: string;
  pipelineVersion: PipelineVersion;
  policyVersion: PipelinePolicyVersion;
  /** Immutable V3 bindings; absent/null on historical V1/V2 revisions. */
  selectionPlanId?: string | null;
  queryPlanRevisionId?: string | null;
  graphSnapshotId?: string | null;
  runSpecHash?: string | null;
  selectionPlanSnapshot: SelectionPlan | null;
  policySnapshot: PipelinePolicySnapshot | null;
  outcomeSnapshot: PipelineOutcome | null;
  deficitSnapshot: PipelineDeficitLedgerEntry[];
  lockedAt: string | null;
  createdAt: string;
  tracks: ManifestRevisionTrack[];
  /** Immutable qualified overflow captured when this revision was locked. */
  reserveTracks?: ManifestRevisionReserveTrack[];
}

export type PipelineOutcomeStatus =
  | "complete"
  | "partial_frontier_exhausted"
  | "partial_evidence_shortfall"
  | "partial_catalog_degraded"
  | "partial_timed_out"
  | "partial_policy_conflict"
  | "no_compatible_tracks"
  | "waiting_for_owner_authorization"
  | "cancelled"
  | "failed_system"
  | "failed_integrity";

export interface PipelineOutcome {
  schemaVersion: 1;
  pipelineVersion: PipelineVersion;
  policyVersion: PipelinePolicyVersion;
  status: PipelineOutcomeStatus;
  targetTrackCount: number;
  discoveredTrackCount: number;
  qualifiedTrackCount: number;
  selectedTrackCount: number;
  publishedTrackCount: number;
  exactCountSatisfied: boolean;
  frontierExhausted: boolean;
  providerUnavailable: boolean;
  reasonCodes: string[];
  deficits: PipelineDeficitLedgerEntry[];
  completedAt: string;
}

export interface PlaylistBrief {
  title: string;
  description: string;
  mode: PlaylistMode;
  subjectEntities: string[];
  relationship: string;
  include: string[];
  exclude: string[];
  versionPolicy: string;
  evidencePolicy: string;
  orderingPolicy: string;
  targetSize: { min: number; max: number } | null;
  ambiguities: string[];
  /** Stable, exact acknowledgements added only when a visitor confirms material ambiguities. */
  ambiguityAcceptance?: string[];
}

export type PlaylistBriefContractVersion = 1 | 2;

export type PlaylistGuidanceRequestClassification =
  | "precise"
  | "broad_curated"
  | "critical_ambiguity"
  | "preference_ambiguity";

export type PlaylistGuidanceQuestionCriticality = "required" | "optional";
export type PlaylistGuidanceSelectionMode = "single" | "multiple";
export type PlaylistGuidanceFeasibility = "broad" | "moderate" | "narrow";

/**
 * Server-owned execution change compiled from a contract-2 answer. The model
 * may propose display copy, but it cannot invent fields outside this typed
 * boundary or mutate the immutable requested count and raw prompt.
 */
export interface PlaylistGuidancePlanDelta {
  version: 1;
  membershipConstraints: SelectionConstraint[];
  discoveryFocus: string[];
  rankingObjectives: Array<{
    dimension: "relevance" | "influence" | "popularity" | "obscurity" | "chronology" | "source_rank";
    weight: number;
    values: string[];
  }>;
  diversityGoals: Partial<SelectionDiversityGoals>;
  sequencingPreference: SelectionOrderingPolicy["mode"] | null;
  versionContentPreferences: {
    allowedVersions?: RecordingVersionClass[];
    explicitContent?: SelectionContentPolicy["explicitContent"];
    instrumental?: SelectionContentPolicy["instrumental"];
  };
}

export interface PlaylistGuidanceOption {
  /** Stable server-owned identifier. */
  id: string;
  label: string;
  description: string;
  /** Exactly the first option is recommended. */
  recommended: boolean;
  /** Estimated breadth after applying this option. Required by contract 2. */
  feasibility?: PlaylistGuidanceFeasibility;
  /** Deterministic server-owned execution change. Required by contract 2. */
  planDelta?: PlaylistGuidancePlanDelta;
  /**
   * Machine-readable effect of selecting this answer. Optional only so runs
   * created before the grounded question scout remain readable.
   */
  effect?: PlaylistGuidanceEffect;
}

export type PlaylistGuidanceEffectKind =
  | "research_preference"
  | "version_preference"
  | "familiarity_bias"
  | "subscene_focus"
  | "ordering_behavior";

export type PlaylistGuidanceOrderingBehavior =
  | "smooth"
  | "contrast"
  | "chronological"
  | "editorial";

export interface PlaylistGuidanceEffect {
  kind: PlaylistGuidanceEffectKind;
  value: string;
  /** Non-null only when kind is ordering_behavior. */
  orderingBehavior: PlaylistGuidanceOrderingBehavior | null;
  /** Typed resolution when the option answers a place/language ambiguity. */
  geographyConstraint?: SelectionGeographyConstraint | null;
}

export interface PlaylistGuidanceGrounding {
  /** Short model-written explanation of the documented fork in the subject. */
  summary: string;
  /** URLs must also appear in the provider-returned scout sources. */
  sourceUrls: string[];
}

export interface PlaylistGuidanceQuestion {
  /** Stable server-owned identifier. */
  id: string;
  /** Short mobile-screen label. */
  header: string;
  question: string;
  /** Contract-2 questions declare their interaction and blocking behavior. */
  selectionMode?: PlaylistGuidanceSelectionMode;
  criticality?: PlaylistGuidanceQuestionCriticality;
  allowCustom?: boolean;
  /** Stable semantic axis, for example `detroit_second_wave_emphasis`. */
  decisionKey?: string;
  /** Why selecting an answer will materially change the resulting tracks. */
  whyMaterial?: string;
  /** Provider-attested web grounding. Optional only for legacy saved runs. */
  grounding?: PlaylistGuidanceGrounding;
  /** Server-owned questions may use an explicit inference instead of a URL. */
  groundingMode?: "grounded" | "inference";
  /** The API always returns exactly three mutually exclusive options. */
  options: PlaylistGuidanceOption[];
}

export interface PlaylistGuidanceSourceHint {
  url: string;
  title: string;
  /** A short provider-attested excerpt when one is available. */
  excerpt: string;
}

export type PlaylistGuidanceGenerationMode =
  | "grounded_scout"
  | "deterministic_critical"
  | "no_material_questions"
  | "scout_unavailable"
  | "balanced_default"
  | "guidance_unavailable";

export interface PlaylistGuidanceTelemetry {
  generationMode: PlaylistGuidanceGenerationMode;
  requestClassification?: PlaylistGuidanceRequestClassification;
  guidancePolicyVersion?: string;
  questionSetHash?: string | null;
  proposedQuestionCount: number;
  acceptedQuestionCount: number;
  webSearchCalls: number;
  validationIssues: string[];
}

export interface PlaylistGuidanceQuestionSetContract {
  questionSetHash: string;
  requestClassification: PlaylistGuidanceRequestClassification;
  generationMode: PlaylistGuidanceGenerationMode;
  guidancePolicyVersion: string;
  locale: string;
  storefront: string;
  targetTrackCount: number;
  explicitConstraintHash: string;
  rejectedQuestionReasons: string[];
}

export interface PlaylistGuidanceScoutResult {
  questions: PlaylistGuidanceQuestion[];
  sourceHints: PlaylistGuidanceSourceHint[];
  telemetry: PlaylistGuidanceTelemetry;
  /** End-to-end scout wall time, including the optional no-search repair. */
  durationMs: number;
  usage: Record<string, unknown>;
  costUsd: number;
}

export interface PlaylistGuidanceAnswer {
  questionId: string;
  /** Select one returned option, or omit this and provide customText. */
  optionId?: string;
  /** A bounded custom answer, mutually exclusive with optionId. */
  customText?: string;
  /** Contract-2 optional questions may be skipped explicitly. */
  skipped?: boolean;
}

export interface SourceRecordInput {
  url: string;
  title: string;
  sourceClass: "web" | "musicbrainz" | "discogs" | "apple" | "import";
  provenanceRoot: string;
  note: string;
}

/**
 * A server-attested URL citation emitted by the OpenAI Responses API. The
 * excerpt is the exact bounded output-text line surrounding the provider's
 * citation location. The server derives it from the provider response; it is
 * never accepted from model-supplied evidence metadata on its own.
 */
export interface CitationAttestationInput {
  responseId: string;
  outputItemId: string;
  contentIndex: number;
  startIndex: number;
  endIndex: number;
  excerpt: string;
}

export interface EvidenceClaimInput {
  sourceUrl: string;
  state: EvidenceState;
  /**
   * Scope asserted when the claim was ingested. High-confidence evidence is
   * accepted only when the source explicitly supports the individual track.
   */
  supportScope: "track" | "album" | "session" | "collection" | "editorial";
  /** Exact canonical subject copied from PlaylistBrief.subjectEntities. */
  subjectEntity: string;
  /** Exact canonical relationship copied from PlaylistBrief.relationship. */
  subjectRelationship: string;
  /** Source-specific wording for the assertion or contradiction. */
  relationship: string;
  note: string;
  /** Server-owned source classification, populated when evidence is read. */
  sourceClass?: SourceRecordInput["sourceClass"];
  /** Exact provider-attested citation support, when this is a hosted-web claim. */
  citationSupport?: CitationAttestationInput | null;
}

export interface TrackCandidateInput {
  /** One-based editorial order from a curated research pass, when applicable. */
  selectionRank?: number | null;
  artist: string;
  title: string;
  album: string | null;
  releaseYear: number | null;
  durationMs: number | null;
  isrc: string | null;
  musicbrainzId: string | null;
  versionLabel: string | null;
  evidence: EvidenceClaimInput[];
  /** Pipeline V2 fields are optional so legacy research rows remain readable. */
  candidateStage?: CandidateStage;
  recordingFamilyId?: string | null;
  scopeBindings?: TrackScopeBinding[];
}

/**
 * Exact Apple recording discovered inside an independently identifiable
 * editorial container. The repository replaces the nullable source/container
 * references with durable run-owned IDs before the binding can qualify a
 * candidate. Apple search results without this source context never use this
 * persistence path.
 */
export interface CatalogDiscoveredCandidateInput {
  song: CatalogSong;
  source: SourceRecordInput;
  container: {
    providerId: string;
    title: string;
    metadata: Record<string, unknown>;
  };
  /** One independently auditable binding for every proven hard scope axis. */
  bindings: Array<Omit<
    TrackScopeBinding,
    "sourceRecordId" | "researchContainerId" | "citationAttestationId" | "provenancePath"
  >>;
}

export interface CatalogDiscoveredCandidateResult {
  candidateId: string;
  appleSongId: string;
  inserted: boolean;
  scopeBindings: TrackScopeBinding[];
}

export interface SourceFrontierItem {
  sourceClass: string;
  strategy: string;
  cursor: string | null;
  status: "pending" | "complete" | "inaccessible" | "unresolved";
  discoveredCount: number;
  recoveredCount: number;
  note: string;
}

/** A bounded, public-safe source label used by the live run status view. */
export interface RunProgressRecentSource {
  title: string;
  /** Hostname only. Paths, query strings, and provider identifiers are excluded. */
  domain: string;
  sourceClass: string;
}

/**
 * Aggregate progress exposed to a capability-authenticated visitor while a
 * run is active. This deliberately contains counts and bounded labels only;
 * provider requests, cursors, costs, model details, and raw errors stay on
 * the owner/internal side of the API boundary.
 */
export interface RunProgressView {
  targetTrackCount: number | null;
  latestActivityAt: string | null;
  sourceSummary: {
    total: number;
    recentSources: RunProgressRecentSource[];
  };
  frontierSummary: {
    total: number;
    complete: number;
    active: number;
    unresolved: number;
    inaccessible: number;
    discoveredCount: number;
    recoveredCount: number;
  };
  containerSummary: {
    total: number;
    complete: number;
    active: number;
    unresolved: number;
    inaccessible: number;
    advertisedCount: number;
    recoveredCount: number;
  };
  matchSummary: {
    attempted: number;
    accepted: number;
    review: number;
    unavailable: number;
    duplicate: number;
    rejected: number;
    unsupported: number;
    overflow: number;
    shortfall: number | null;
  };
  publicationSummary: {
    volumeCount: number;
    completedVolumes: number;
    totalTracks: number;
    appendedTracks: number;
    currentVolume: number | null;
    status: string | null;
  };
  /** Additive V3.2 diagnostics; absent for historical V1/V2/schema-1 runs. */
  semanticPolicyVersion?: string;
  queryPlanSchemaVersion?: number;
  explicitConstraintHash?: string;
  contextSignals?: QueryPlanV3SemanticClause[];
  rejectedByPredicate?: Record<string, number>;
  /** Candidate-level catalog-resolution attempts, retained for compatibility. */
  appleLookupCount?: number;
  /** Actual Apple provider read invocations made during qualification. */
  appleProviderRequestCount?: number;
  rootCause?: string | null;
  semanticRecovery?: {
    attempted: boolean;
    attemptCount: number;
    repaired: boolean;
  };
  activePlanRevision?: number;
}

export interface ResearchPassReport {
  phase:
    | "scope_resolution"
    | "source_discovery"
    | "container_discovery"
    | "container_enumeration"
    | "track_verification"
    | "catalog_enrichment"
    | "gap_analysis";
  summary: string;
  newCandidateCount: number;
  frontierItems: SourceFrontierItem[];
}

export interface CatalogSong {
  id: string;
  name: string;
  artistName: string;
  albumName: string;
  genreNames?: string[];
  releaseDate?: string;
  durationInMillis?: number;
  isrc?: string;
  url?: string;
  artworkUrl?: string;
  versionLabel?: string;
  /** Apple catalog content rating. Absence means Apple did not classify it. */
  contentRating?: "clean" | "explicit";
}

export interface CatalogMatchResult {
  candidateId: string;
  status: MatchStatus;
  basis: string;
  score: number;
  song: CatalogSong | null;
  alternatives: CatalogSong[];
}

export interface ManifestTrack {
  position: number;
  candidateId: string;
  catalogId: string;
  artist: string;
  title: string;
}

export interface PlaylistManifest {
  id: string;
  runId: string;
  name: string;
  description: string;
  contentHash: string;
  lockedAt: string;
  createdAt: string;
  tracks: ManifestTrack[];
  pipelineVersion?: PipelineVersion;
  policyVersion?: PipelinePolicyVersion;
  selectionPlan?: SelectionPlan | null;
  revision?: ManifestRevision | null;
}

export interface PublicationVolume {
  id: string;
  manifestId: string;
  index: number;
  total: number;
  name: string;
  startPosition: number;
  endPosition: number;
  status: PublicationStatus;
  applePlaylistId: string | null;
  shareUrl: string | null;
  appendedCount: number;
  error: string | null;
}

export interface PublicationResult {
  manifestId: string;
  status: "publishing" | "complete" | "partial" | "waiting_for_owner" | "failed";
  volumes: PublicationVolume[];
}

/** Public-safe Apple Music metadata retained independently of a research run. */
export interface PublicPlaylistDirectoryVolume {
  volumeNumber: number;
  name: string;
  trackCount: number;
  shareUrl: string;
}

export interface PublicPlaylistDirectoryItem {
  id: string;
  title: string;
  trackCount: number;
  volumeCount: number;
  publishedAt: string;
  volumes: PublicPlaylistDirectoryVolume[];
}

export interface PublicPlaylistDirectoryPage {
  items: PublicPlaylistDirectoryItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SetupStatus {
  openai: { connected: boolean; model: string };
  apple: { configured: boolean; authorized: boolean; storefront: string };
  requirements: string[];
}

export interface ResearchRunView {
  id: string;
  prompt: string;
  brief: PlaylistBrief;
  status: RunStatus;
  estimatedCostUsd: number;
  actualCostUsd: number;
  approvedBudgetUsd: number;
  phase: string;
  autoPublish?: boolean;
  error: string | null;
  candidateCount: number;
  sourceCount: number;
  unresolvedCount: number;
  exceptionCount?: number;
  manifestId?: string | null;
  capabilityUrl?: string;
  frontier: SourceFrontierItem[];
  pipelineVersion?: PipelineVersion;
  policyVersion?: PipelinePolicyVersion;
  selectionPlan?: SelectionPlan | null;
  /** Internal immutable V3 execution contract; public projections omit it. */
  queryPlan?: QueryPlanV3 | null;
  pipelinePolicySnapshot?: PipelinePolicySnapshot | null;
  pipelineOutcome?: PipelineOutcome | null;
  candidateStageCounts?: Partial<Record<CandidateStage, number>>;
  progress?: RunProgressView;
  partialAction?: PartialPublicationActionView | null;
  explore?: ExplorePreferenceView | null;
}

/** Public-safe, hash-bound action required before publishing an underfilled manifest. */
export interface PartialPublicationActionView {
  kind: "partial_publication";
  targetTrackCount: number;
  qualifiedTrackCount: number;
  remainingStrategyCount: number;
  canContinueResearch: boolean;
  reasonCode: string | null;
  outcomeVersion: number;
  outcomeHash: string;
  manifestId?: string;
  manifestHash?: string;
}

/** Visitor-controlled Explore visibility for a validated Apple publication. */
export interface ExplorePreferenceView {
  eligible: boolean;
  listed: boolean;
  canChange: boolean;
  reason: string | null;
}

/**
 * Capability-authenticated browser view of a research run.
 *
 * This is intentionally a positive allowlist instead of an `Omit` from the
 * owner/internal view. New private accounting or policy fields added to
 * `ResearchRunView` therefore cannot silently cross the public API boundary.
 */
export interface PublicResearchRunView {
  id: string;
  prompt: string;
  brief: PlaylistBrief;
  status: RunStatus;
  phase: string;
  autoPublish?: boolean;
  error: string | null;
  candidateCount: number;
  sourceCount: number;
  unresolvedCount: number;
  frontier: SourceFrontierItem[];
  pipelineVersion?: PipelineVersion;
  policyVersion?: PipelinePolicyVersion;
  selectionPlan?: SelectionPlan | null;
  pipelineOutcome?: PipelineOutcome | null;
  candidateStageCounts?: Partial<Record<CandidateStage, number>>;
  progress?: RunProgressView;
  partialAction?: PartialPublicationActionView | null;
  explore?: ExplorePreferenceView | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
}

/** Public status payload for prompt interpretation; estimates are owner-only. */
export interface PublicBriefStatusView {
  requestId: string;
  prompt: string;
  requestedTrackCount: number | null;
  status: string;
  briefContractVersion?: PlaylistBriefContractVersion;
  questionSetHash?: string | null;
  brief?: PlaylistBrief;
  questions: PlaylistGuidanceQuestion[];
  answers?: PlaylistGuidanceAnswer[];
  error?: string;
}

export interface RunResultView {
  run: PublicResearchRunView;
  publication: PublicationResult | null;
  outcomes: Record<MatchStatus, number>;
  evidenceExpiresAt: string | null;
}

export interface JobLease {
  id: string;
  runId: string | null;
  kind: JobKind;
  status: JobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  availableAt: string;
}

export interface CostReservation {
  id: string;
  runId: string | null;
  provider: "openai" | "apple" | "discogs";
  category: string;
  reservedUsd: number;
  actualUsd: number | null;
  status: "reserved" | "reconciled" | "reconciled_overrun" | "released";
}

export interface AppleAuthorizationView {
  configured: boolean;
  authorized: boolean;
  storefront: string | null;
  validatedAt: string | null;
  needsReauthorization: boolean;
}

export interface OwnerHealthView {
  ok: boolean;
  paused: boolean;
  database: "ready" | "down";
  worker: "healthy" | "stale" | "missing";
  apple: AppleAuthorizationView;
  queuedJobs: number;
  activeJobs: number;
  monthSpendUsd: number;
  monthReservedUsd: number;
  notificationBacklog: number;
  orphanedPlaylists: number;
}

export interface CapabilityExchangeResponse {
  runId: string;
  expiresAt: string;
}

export interface PaginatedExceptions {
  page: number;
  pageSize: number;
  total: number;
  items: Array<{
    candidateId: string;
    artist: string;
    title: string;
    album: string | null;
    status: MatchStatus;
    basis: string;
    song: CatalogSong | null;
    alternatives: CatalogSong[];
  }>;
}

export interface SourceAdapterResult {
  records: SourceRecordInput[];
  items: unknown[];
  nextCursor: string | null;
  complete: boolean;
  note: string;
  advertisedTotal: number;
  /** Containers discovered by a structured source. These are persisted by
   * the server before the model sees the tool result. */
  containers: SourceAdapterContainer[];
  /** Server-normalized evidence capabilities. Structured metadata is never
   * silently upgraded into relationship proof. */
  evidence: SourceAdapterEvidence[];
}

export type SourceAdapterId = "musicbrainz" | "discogs" | "apple";
export type SourceAdapterAction = "discover" | "enumerate" | "lookup";
export type SourceAdapterEntity = "artist" | "release" | "recording" | "catalog";

export interface SourceAdapterContainer {
  containerType: "artist" | "release" | "session" | "collection";
  /** Provider-stable and adapter-namespaced, so IDs from different providers
   * cannot collide in the research frontier. */
  providerId: string;
  title: string;
  advertisedTotal: number | null;
  metadata: Record<string, unknown>;
}

export interface SourceAdapterContainerRef extends SourceAdapterContainer {
  id: string;
  status: "discovered" | "enumerating" | "complete" | "inaccessible" | "unresolved";
  cursor: string | null;
  recoveredTotal: number;
}

export interface SourceAdapterEvidence {
  sourceUrl: string;
  evidenceKind: "metadata" | "track_credit" | "container_credit";
  supportScope: "track" | "album" | "session" | "collection" | "editorial";
  subject: string | null;
  relationship: string;
  trackTitle: string | null;
  note: string;
  /** Structured adapter evidence remains inferred until a claim-bound policy
   * explicitly promotes it. Generic search metadata is always false. */
  eligibleForAutomaticVerification: boolean;
}

export interface SourceAdapterContext {
  action: SourceAdapterAction;
  entity: SourceAdapterEntity;
  query: string | null;
  container: SourceAdapterContainerRef | null;
  providerId: string | null;
}

export interface SourceAdapter {
  id: SourceAdapterId;
  supports(brief: PlaylistBrief): number;
  discover(entity: SourceAdapterEntity, query: string, cursor: string | null, signal?: AbortSignal): Promise<SourceAdapterResult>;
  enumerate(container: SourceAdapterContainerRef, cursor: string | null, signal?: AbortSignal): Promise<SourceAdapterResult>;
  lookup(entity: SourceAdapterEntity, providerId: string, signal?: AbortSignal): Promise<SourceAdapterResult>;
  normalizeEvidence(result: SourceAdapterResult, context: SourceAdapterContext): SourceAdapterEvidence[];
}

export interface ApiErrorPayload {
  error: string;
  code?: string;
  retryAfterSeconds?: number;
}
