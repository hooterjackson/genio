import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  SMOOTH_REGGAETON_HEAT_PROMPT,
  compileGuidanceSelectionV3,
} from "../server/adaptive-guidance-v3.ts";
import {
  guidanceDecisionV3FromPublicQuestion,
  guidanceDecisionV5FromPublicQuestion,
} from "../server/adaptive-guidance-contract-bridge.ts";
import { compileGuidanceSelectionV5 } from "../server/adaptive-guidance-v5.ts";
import type { PlaylistGuidanceQuestion } from "../shared/types.ts";
import {
  validateSitesControlPlaneTrustPolicyV1,
  validateSitesControlPlaneVerificationKeyV1,
  verifySitesControlPlaneAttestation,
} from "../shared/sites-control-plane-attestation.ts";
import {
  validateSitesProductionRollbackTargetV1,
  type SitesProductionRollbackTargetV1,
} from "../shared/sites-production-rollback.ts";
import {
  exactObject,
  verifyStrictSignedEnvelope,
} from "../shared/signed-artifact.ts";
import {
  evaluateSemanticRankingReviewV1,
  type SemanticRankingReviewArtifactV1,
  validateSemanticRankingReviewBindingsV2,
  validateSemanticRankingBlindScorecardV1,
  validateSemanticRankingProtectedBaselineMetadataV1,
  validateSemanticRankingReviewerAttestationV1,
  validateSemanticRankingReviewerTrustPolicyV1,
  validateSemanticRankingReviewerVerificationKeyV1,
  validateSemanticRankingReviewReportV1,
  verifySemanticRankingReviewerAttestationV1,
} from "../lib/semantic-ranking-review.ts";
import {
  validateStableReleaseVerificationKeyV1,
} from "./authorize-stable-release.ts";
import {
  HISTORICAL_STABLE_PREDECESSOR_DEFAULT_BRANCH,
  HISTORICAL_STABLE_PREDECESSOR_REPOSITORY,
  verifyHistoricalStablePredecessor,
} from "./historical-stable-predecessor.ts";
import {
  type PublicRolloutIntentGroup,
} from "../shared/public-rollout-evidence.ts";
import {
  buildReleaseConvergenceEvidence,
  type ReleaseConvergenceObservation,
} from "./verify-release-convergence.ts";
import { validateIrishInfluenceReleaseProofV1 } from "./irish-influence-release-proof.ts";

/**
 * Release fixtures are code-owned product contracts. A live canary may accept
 * arbitrary prompts for diagnosis, but only an exact match for one of these
 * definitions can contribute to signed promotion evidence.
 */
export const RELEASE_FIXTURE_SCHEMA_V1 = "genio-release-fixture/v1" as const;
export const RELEASE_GATE_ARTIFACT_SCHEMA_V1 =
  "genio-release-gate-artifact/v1" as const;
export const RELEASE_GATE_PROOF_SCHEMA_V1 =
  "genio-release-gate-proof/v1" as const;

export const RELEASE_FIXTURE_IDS = [
  "fixed-three-track-control-v1",
  "smooth-reggaeton-heat-50-v1",
  "french-jazz-guided-constraint-25-v1",
  "irish-influence-recovery-25-v1",
] as const;

export type ReleaseFixtureId = typeof RELEASE_FIXTURE_IDS[number];
export type ReleaseFixtureGuidanceMode = "not_applicable" | "recommended";
export type ReleaseGateEnvironment = "offline" | "staging" | "production";
export type ReleaseGateCacheMode = "reuse_disabled" | "not_applicable";
export type ReleaseGateBudgetStatus = "within_cap" | "not_applicable";

export const RELEASE_GATE_ENVIRONMENTS = Object.freeze({
  offline_suite: "offline",
  staging_provider_manifest: "staging",
  staging_historical_replay: "staging",
  staging_fixed_three_track: "staging",
  staging_affected_regression: "staging",
  staging_guided_constraint: "staging",
  semantic_ranking_blinded_review: "staging",
  production_fixed_three_track: "production",
  production_affected_regression: "production",
  backend_release_convergence: "production",
  release_convergence: "production",
  final_custom_domain_browser: "production",
} as const);

export type ReleaseGateName = keyof typeof RELEASE_GATE_ENVIRONMENTS;

interface ReleaseFixtureGuidanceSemanticsV1 {
  questionId: string;
  question: string;
  optionIds: readonly string[];
  selectedOptionId: string;
  required: true;
  minimumCoreRatio: number | null;
  hardConstraintLabels: readonly string[];
}

interface ReleaseFixtureDefinitionV1 {
  schemaVersion: typeof RELEASE_FIXTURE_SCHEMA_V1;
  id: ReleaseFixtureId;
  prompt: string;
  targetTrackCount: number;
  guidanceMode: ReleaseFixtureGuidanceMode;
  guidanceSemantics: ReleaseFixtureGuidanceSemanticsV1 | null;
  promotable: true;
}

export interface ReleaseFixtureDescriptorV1 {
  fixtureId: ReleaseFixtureId;
  fixtureHash: string;
  promptHash: string;
  targetTrackCount: number;
  guidanceMode: ReleaseFixtureGuidanceMode;
  guidanceSemanticsHash: string | null;
}

export interface ReleaseFixtureBindingV1 extends ReleaseFixtureDescriptorV1 {
  /**
   * The active contract's persisted answer lineage. It is deliberately a hash:
   * raw answers and custom text are forbidden in release artifacts.
   */
  guidanceLineageHash: string | null;
}

export interface ReleaseGateCandidateBindingV1 {
  tag: string;
  version: string;
  sourceRevision: string;
  imageDigest: string;
  sitesSourceRevision: string;
}

export interface FinalPublicAssignmentProbeFixtureV1 {
  fixtureId: string;
  intentGroup: PublicRolloutIntentGroup;
  prompt: string;
  targetTrackCount: number;
}

/**
 * Immutable compatibility corpus for already-signed final-browser v2
 * evidence. Historical evidence is verified against this snapshot rather
 * than being reinterpreted through the current rollout registry.
 */
export const LEGACY_FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1 = Object.freeze([
  Object.freeze({
    fixtureId: "final-public-assignment-genre-scene-v1",
    intentGroup: "genre_scene",
    prompt:
      "[GENIO PUBLIC ASSIGNMENT CANARY:genre_scene:v1] Create 3 polished reggaeton tracks.",
    targetTrackCount: 3,
  }),
  Object.freeze({
    fixtureId: "final-public-assignment-mood-activity-theme-v1",
    intentGroup: "mood_activity_theme",
    prompt:
      "[GENIO PUBLIC ASSIGNMENT CANARY:mood_activity_theme:v1] Create 3 calm, nocturnal tracks for sleep.",
    targetTrackCount: 3,
  }),
  Object.freeze({
    fixtureId: "final-public-assignment-similarity-v1",
    intentGroup: "similarity",
    prompt:
      "[GENIO PUBLIC ASSIGNMENT CANARY:similarity:v1] Create 3 tracks similar to Radiohead while excluding Radiohead.",
    targetTrackCount: 3,
  }),
  Object.freeze({
    fixtureId: "final-public-assignment-artist-catalogue-v1",
    intentGroup: "artist_catalogue",
    prompt:
      "[GENIO PUBLIC ASSIGNMENT CANARY:artist_catalogue:v1] Create 3 songs by Bjork.",
    targetTrackCount: 3,
  }),
  Object.freeze({
    fixtureId: "final-public-assignment-fixed-container-v1",
    intentGroup: "fixed_container",
    prompt:
      "[GENIO PUBLIC ASSIGNMENT CANARY:fixed_container:v1] Create 3 tracks from the album \"Kind of Blue\".",
    targetTrackCount: 3,
  }),
  Object.freeze({
    fixtureId: "final-public-assignment-factual-relationship-v1",
    intentGroup: "factual_relationship",
    prompt:
      "[GENIO PUBLIC ASSIGNMENT CANARY:factual_relationship:v1] Create 3 tracks performed by Paulinho da Costa.",
    targetTrackCount: 3,
  }),
  Object.freeze({
    fixtureId: "final-public-assignment-exhaustive-v1",
    intentGroup: "exhaustive",
    prompt:
      "[GENIO PUBLIC ASSIGNMENT CANARY:exhaustive:v1] Create an exhaustive selection of 3 Nigerian boogie tracks.",
    targetTrackCount: 3,
  }),
] as const satisfies readonly FinalPublicAssignmentProbeFixtureV1[]);

/**
 * These prompts are deliberately recognizable as release canaries while still
 * exercising the ordinary anonymous public-assignment path. Raw prompts never
 * enter release evidence; only the code-owned fixture ID, group, and count do.
 */
export const FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1 = Object.freeze([
  Object.freeze({
    fixtureId: "final-public-assignment-editorial-influence-typo-v1",
    intentGroup: "editorial_influence",
    prompt: "Infuential irish music",
    targetTrackCount: 25,
  }),
  Object.freeze({
    fixtureId: "final-public-assignment-editorial-influence-corrected-v1",
    intentGroup: "editorial_influence",
    prompt: "Influential Irish music",
    targetTrackCount: 25,
  }),
] as const satisfies readonly FinalPublicAssignmentProbeFixtureV1[]);

/**
 * Immutable compatibility snapshot for already-produced final-browser v5
 * evidence. V6 adds the corrected public prompt and switches both anonymous
 * probes to the database-fenced manifest-only boundary.
 */
const FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V5 = Object.freeze([
  Object.freeze({
    fixtureId: "final-public-assignment-editorial-influence-v1",
    intentGroup: "editorial_influence",
    prompt:
      "[GENIO PUBLIC ASSIGNMENT CANARY:editorial_influence:v2] Infuential irish music",
    targetTrackCount: 25,
  }),
] as const satisfies readonly FinalPublicAssignmentProbeFixtureV1[]);

export interface ReleaseGateProofV1 {
  schemaVersion: typeof RELEASE_GATE_PROOF_SCHEMA_V1;
  generatedAt: string;
  passed: true;
  assertions: Record<string, true>;
  proofHash: string;
}

export interface ReleaseGateArtifactV1 {
  schemaVersion: typeof RELEASE_GATE_ARTIFACT_SCHEMA_V1;
  gate: ReleaseGateName;
  environment: ReleaseGateEnvironment;
  completedAt: string;
  candidate: ReleaseGateCandidateBindingV1;
  configurationHash: string;
  runtimeHash: string;
  cacheMode: ReleaseGateCacheMode;
  budgetStatus: ReleaseGateBudgetStatus;
  fixtures: ReleaseFixtureBindingV1[];
  sources: Record<string, unknown>;
  proof: ReleaseGateProofV1;
  evidenceHash: string;
}

export interface ReleaseGateProducerAttestationV1 {
  schemaVersion: "genio-release-gate-producer-attestation/v1";
  gate: ReleaseGateName;
  evidenceHash: string;
  signature: {
    algorithm: "Ed25519";
    keyId: string;
    value: string;
  };
}

type JsonRecord = Record<string, unknown>;

const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SAFE_KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,159}$/u;
const HISTORICAL_REPLAY_SUBMISSION_COUNT = 73;
const HISTORICAL_REPLAY_MAXIMUM_RESEARCH_BUDGET_USD = 59.25;
const HISTORICAL_REPLAY_REQUIRED_OTHER_CANARY_RESERVE_USD = 3;
const HISTORICAL_REPLAY_REQUIRED_BUDGET_RESERVATION_USD = 62.25;
const HISTORICAL_REPLAY_PER_RUN_DEADLINE_MS = 15 * 60_000;
const HISTORICAL_REPLAY_MAXIMUM_PER_RUN_BUDGET_USD = 3;
const HISTORICAL_REPLAY_MAXIMUM_CONCURRENCY = 4;
const HISTORICAL_REPLAY_EVIDENCE_TTL_MS = 24 * 60 * 60_000;
const HISTORICAL_REPLAY_CORPUS_COMMITMENT_SHA256 =
  "cec24d3d2c78185ccf1fcb8dfe646193c83ef7f26819f473bca34cd6fbc5eefd";
const HISTORICAL_REPLAY_PAYLOAD_SCHEMA =
  "genio-historical-browser-replay-evidence/v1";
const SIGNED_HISTORICAL_REPLAY_SCHEMA =
  "genio-signed-historical-browser-replay-evidence/v1";
const HISTORICAL_REPLAY_VERIFICATION_KEY_SCHEMA =
  "genio-historical-browser-replay-verification-key/v1";

const FIXED_THREE_TRACK_PROMPT = [
  "Build a playlist containing exactly these three original studio recordings, in this order:",
  "1. Michael Jackson — Billie Jean",
  "2. Madonna — La Isla Bonita",
  "3. Earth, Wind & Fire — September",
  "Exclude remixes, live versions, radio edits, covers, re-recordings, and duplicates.",
].join("\n");

const FRENCH_JAZZ_GUIDED_CONSTRAINT_PROMPT = [
  "Create exactly 25 French jazz tracks.",
  "Use clean original studio recordings only, exclude live recordings and remixes,",
  "and order the playlist from intimate acoustic performances to more energetic modern jazz.",
].join(" ");

const IRISH_INFLUENCE_RECOVERY_PROMPT = "Infuential irish music";

const FIXTURE_DEFINITIONS: Readonly<Record<ReleaseFixtureId, ReleaseFixtureDefinitionV1>> =
  Object.freeze({
    "fixed-three-track-control-v1": Object.freeze({
      schemaVersion: RELEASE_FIXTURE_SCHEMA_V1,
      id: "fixed-three-track-control-v1",
      prompt: FIXED_THREE_TRACK_PROMPT,
      targetTrackCount: 3,
      guidanceMode: "not_applicable",
      guidanceSemantics: null,
      promotable: true,
    }),
    "smooth-reggaeton-heat-50-v1": Object.freeze({
      schemaVersion: RELEASE_FIXTURE_SCHEMA_V1,
      id: "smooth-reggaeton-heat-50-v1",
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      targetTrackCount: 50,
      guidanceMode: "recommended",
      guidanceSemantics: Object.freeze({
        questionId: "guidance:reggaeton:adjacent-latin-urban-scope",
        question: "How far should “adjacent Latin urban” extend?",
        optionIds: Object.freeze([
          "core_reggaeton_only",
          "reggaeton_dembow_latin_urban",
          "broader_latin_crossover",
        ]),
        selectedOptionId: "reggaeton_dembow_latin_urban",
        required: true,
        minimumCoreRatio: 0.7,
        hardConstraintLabels: Object.freeze([
          "genre:reggaeton",
          "genre:dembow",
          "genre:latin-urban",
        ]),
      }),
      promotable: true,
    }),
    "french-jazz-guided-constraint-25-v1": Object.freeze({
      schemaVersion: RELEASE_FIXTURE_SCHEMA_V1,
      id: "french-jazz-guided-constraint-25-v1",
      prompt: FRENCH_JAZZ_GUIDED_CONSTRAINT_PROMPT,
      targetTrackCount: 25,
      guidanceMode: "recommended",
      guidanceSemantics: Object.freeze({
        questionId: "guidance:french-jazz:relationship",
        question: "What should “French” mean for this jazz playlist?",
        optionIds: Object.freeze([
          "french_jazz_scene",
          "french_artist_origin",
          "recorded_in_france",
          "french_language_jazz",
        ]),
        selectedOptionId: "french_jazz_scene",
        required: true,
        minimumCoreRatio: null,
        hardConstraintLabels: Object.freeze([
          "scene:french-jazz",
          "genre:jazz",
          "recording:clean",
          "recording:original-studio",
          "exclude:live",
          "exclude:remix",
        ]),
      }),
      promotable: true,
    }),
    "irish-influence-recovery-25-v1": Object.freeze({
      schemaVersion: RELEASE_FIXTURE_SCHEMA_V1,
      id: "irish-influence-recovery-25-v1",
      prompt: IRISH_INFLUENCE_RECOVERY_PROMPT,
      targetTrackCount: 25,
      guidanceMode: "recommended",
      guidanceSemantics: Object.freeze({
        questionId: "v5-nuance:influence-scope",
        question: "Which kind of influence should lead the playlist?",
        optionIds: Object.freeze([
          "within_scope_cultural_impact",
          "global_influence",
          "balanced_influence",
          "keep_current_interpretation",
        ]),
        selectedOptionId: "balanced_influence",
        required: true,
        minimumCoreRatio: null,
        hardConstraintLabels: Object.freeze([
          "artist_origin:Irish",
          "ranking:historical_influence",
        ]),
      }),
      promotable: true,
    }),
  });

const GATE_FIXTURE_IDS = {
  offline_suite: [],
  staging_provider_manifest: ["smooth-reggaeton-heat-50-v1"],
  staging_historical_replay: [],
  staging_fixed_three_track: ["fixed-three-track-control-v1"],
  staging_affected_regression: ["smooth-reggaeton-heat-50-v1"],
  staging_guided_constraint: ["french-jazz-guided-constraint-25-v1"],
  semantic_ranking_blinded_review: [
    "fixed-three-track-control-v1",
    "smooth-reggaeton-heat-50-v1",
    "french-jazz-guided-constraint-25-v1",
  ],
  production_fixed_three_track: ["fixed-three-track-control-v1"],
  production_affected_regression: ["irish-influence-recovery-25-v1"],
  backend_release_convergence: [],
  release_convergence: [],
  final_custom_domain_browser: [],
} as const satisfies Readonly<Record<ReleaseGateName, readonly ReleaseFixtureId[]>>;

export const RELEASE_GATE_ASSERTIONS: Readonly<Record<ReleaseGateName, readonly string[]>> =
  Object.freeze({
    offline_suite: Object.freeze([
      "artifact_identity",
      "release_metadata",
      "lint",
      "build",
      "policy",
      "database",
      "unit_and_integration",
      "browser",
      "stitched_system_browser",
    ]),
    staging_provider_manifest: Object.freeze([
      "live_provider_execution",
      "exact_qualified_count",
      "canonical_contract_binding",
      "guidance_lineage_binding",
      "qualified_evidence_policy",
      "worker_identity_binding",
      "database_write_fence",
      "zero_apple_write_artifacts",
    ]),
    staging_historical_replay: Object.freeze([
      "all_historical_submissions_replayed",
      "original_prompt_and_count_unchanged",
      "no_unexplained_dead_ends",
      "result_reuse_disabled",
      "privacy_safe_aggregate_only",
      "qa_budget_reserved",
      "exact_candidate_runtime_configuration",
    ]),
    staging_fixed_three_track: Object.freeze([
      "immutable_manifest_exact_count",
      "apple_ordered_ids_independently_verified",
      "public_playlist_browser_verified",
      "worker_identity_binding",
    ]),
    staging_affected_regression: Object.freeze([
      "immutable_manifest_exact_count",
      "reggaeton_question_semantics",
      "recommended_core_quota_at_least_70_percent",
      "guidance_lineage_binding",
      "apple_ordered_ids_independently_verified",
      "public_playlist_browser_verified",
      "worker_identity_binding",
    ]),
    staging_guided_constraint: Object.freeze([
      "immutable_manifest_exact_count",
      "required_ambiguity_resolved",
      "hard_constraints_preserved",
      "guidance_lineage_binding",
      "apple_ordered_ids_independently_verified",
      "public_playlist_browser_verified",
      "worker_identity_binding",
    ]),
    semantic_ranking_blinded_review: Object.freeze([
      "blinded_review",
      "independent_reviewer_attested",
      "all_release_fixtures_reviewed",
      "protected_last_proven_baseline",
      "ordered_outputs_bound",
      "blinded_package_mapping_bound",
      "candidate_medians_at_least_four",
      "no_fixture_dimension_regression",
      "no_material_regression",
    ]),
    production_fixed_three_track: Object.freeze([
      "immutable_manifest_exact_count",
      "apple_ordered_ids_independently_verified",
      "public_playlist_browser_verified",
      "worker_identity_binding",
    ]),
    production_affected_regression: Object.freeze([
      "immutable_manifest_exact_count",
      "signed_owner_editorial_assignment",
      "influence_scope_question_semantics",
      "guidance_lineage_binding",
      "successor_query_plan_binding",
      "worker_guidance_consumption",
      "candidate_first_recovery_classification",
      "false_scarcity_rejected",
      "owner_real_ui_publication",
      "apple_ordered_ids_independently_verified",
      "public_playlist_browser_verified",
      "worker_identity_binding",
    ]),
    backend_release_convergence: Object.freeze([
      "two_overlap_window_samples",
      "prior_sites_identity_preserved",
      "backend_source_identity",
      "worker_lane_heartbeats",
      "two_fresh_heartbeats_per_lane",
      "no_eligible_old_worker",
      "configuration_stable",
      "runtime_contract_stable",
    ]),
    release_convergence: Object.freeze([
      "two_overlap_window_samples",
      "sites_and_backend_source_identity",
      "worker_lane_heartbeats",
      "two_fresh_heartbeats_per_lane",
      "no_eligible_old_worker",
      "configuration_stable",
      "runtime_contract_stable",
    ]),
    final_custom_domain_browser: Object.freeze([
      "custom_domain_tls",
      "release_identity_visible",
      "anonymous_playlist_directory",
      "public_playlist_contents_visible",
      "privacy_projection",
      "public_editorial_influence_v5_flow",
      "typo_and_corrected_real_ui_prompts",
      "public_editorial_influence_exact_manifest",
      "worker_consumed_query_plan",
      "database_fenced_zero_apple_writes",
      "zero_publication_orphans",
      "unrelated_v3_intents_unchanged",
    ]),
  });

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => (
        left < right ? -1 : left > right ? 1 : 0
      ))
      .map(([key, item]) => [key, sortedJsonValue(item)]),
  );
}

export function stableReleaseFixtureJson(value: unknown): string {
  return JSON.stringify(sortedJsonValue(value));
}

export function releaseFixtureSha256(value: unknown): string {
  return createHash("sha256").update(stableReleaseFixtureJson(value)).digest("hex");
}

function normalizePrompt(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function descriptor(definition: ReleaseFixtureDefinitionV1): ReleaseFixtureDescriptorV1 {
  return Object.freeze({
    fixtureId: definition.id,
    fixtureHash: releaseFixtureSha256(definition),
    promptHash: releaseFixtureSha256(normalizePrompt(definition.prompt)),
    targetTrackCount: definition.targetTrackCount,
    guidanceMode: definition.guidanceMode,
    guidanceSemanticsHash: definition.guidanceSemantics
      ? releaseFixtureSha256(definition.guidanceSemantics)
      : null,
  });
}

export const RELEASE_FIXTURES: Readonly<Record<ReleaseFixtureId, ReleaseFixtureDescriptorV1>> =
  Object.freeze(Object.fromEntries(
    RELEASE_FIXTURE_IDS.map((fixtureId) => [
      fixtureId,
      descriptor(FIXTURE_DEFINITIONS[fixtureId]),
    ]),
  ) as Record<ReleaseFixtureId, ReleaseFixtureDescriptorV1>);

export function releaseFixturePrompt(fixtureId: ReleaseFixtureId): string {
  return FIXTURE_DEFINITIONS[fixtureId].prompt;
}

export function matchPromotableReleaseFixture(input: {
  prompt: string;
  targetTrackCount: number;
  guidanceMode: ReleaseFixtureGuidanceMode;
}): ReleaseFixtureDescriptorV1 | null {
  const normalized = normalizePrompt(input.prompt);
  const match = RELEASE_FIXTURE_IDS.find((fixtureId) => {
    const definition = FIXTURE_DEFINITIONS[fixtureId];
    return normalizePrompt(definition.prompt) === normalized
      && definition.targetTrackCount === input.targetTrackCount
      && definition.guidanceMode === input.guidanceMode;
  });
  return match ? RELEASE_FIXTURES[match] : null;
}

export interface ReleaseFixtureGuidanceValidationV1 {
  fixtureId: ReleaseFixtureId;
  questionSetHash: string;
  questionHash: string;
  selectedOptionId: string;
  executionDeltaHash: string;
  affectedClauseIds: string[];
}

export interface ReleaseFixtureExecutionProofV1 {
  schemaVersion: "genio-release-fixture-execution-proof/v1";
  fixtureId: ReleaseFixtureId;
  fixtureHash: string;
  promptHash: string;
  targetTrackCount: number;
  guidanceMode: ReleaseFixtureGuidanceMode;
  guidanceSemanticsHash: string | null;
  guidanceLineageHash: string | null;
  questionSetHash: string | null;
  questionHash: string | null;
  selectedOptionId: string | null;
  executionDeltaHash: string | null;
  affectedClauseIds: string[];
  /**
   * A promotable guided fixture carries the server-owned public question so
   * artifact verification can recompile the selected patch. A caller-supplied
   * summary is never accepted as proof that guidance semantics executed.
   */
  guidancePayload: {
    questionSetHash: string;
    questions: PlaylistGuidanceQuestion[];
  } | null;
  evidenceHash: string;
}

/**
 * Verify the executable server-owned question/patch, not merely its display
 * wording. The returned execution-delta hash is the exact value expected in
 * persisted public guidance lineage after the recommended answer is accepted.
 */
export function validateReleaseFixtureGuidancePayload(
  fixtureId:
    | "smooth-reggaeton-heat-50-v1"
    | "french-jazz-guided-constraint-25-v1"
    | "irish-influence-recovery-25-v1",
  payloadValue: unknown,
): ReleaseFixtureGuidanceValidationV1 {
  const payload = asRecord(payloadValue, "release fixture guidance payload");
  exactKeys(
    payload,
    ["questionSetHash", "questions"],
    "release fixture guidance payload",
  );
  const questionSetHash = digest(
    payload.questionSetHash,
    "release fixture guidance questionSetHash",
  );
  if (!Array.isArray(payload.questions) || payload.questions.length !== 1) {
    throw new Error(`release fixture ${fixtureId} requires exactly one guidance question`);
  }
  const publicQuestion = payload.questions[0] as PlaylistGuidanceQuestion;
  const expected = FIXTURE_DEFINITIONS[fixtureId].guidanceSemantics!;
  if (fixtureId === "irish-influence-recovery-25-v1") {
    const decision = guidanceDecisionV5FromPublicQuestion(publicQuestion);
    if (
      decision.id !== expected.questionId
      || decision.question !== expected.question
      || decision.mode !== "nuance_optional"
      || decision.criticality !== "optional"
      || decision.axis !== "influence_scope"
      || decision.rolloutGroup !== "editorial_influence"
      || decision.selectionMode !== "single"
      || decision.options.length !== expected.optionIds.length
      || decision.options.some(
        (option, index) => option.id !== expected.optionIds[index],
      )
      || decision.options.filter(({ recommended }) => recommended).length !== 1
      || decision.options.find(({ recommended }) => recommended)?.id
        !== expected.selectedOptionId
      || decision.options.find(
        ({ id }) => id === "keep_current_interpretation",
      )?.patch.operations.length !== 0
    ) {
      throw new Error(
        "release Irish-influence Guidance V5.1 semantics do not match",
      );
    }
    const selectedSimulation = decision.simulations.find(
      ({ optionId }) => optionId === expected.selectedOptionId,
    );
    if (
      !selectedSimulation?.executionEffect
      || !selectedSimulation.consumerReceipt
      || selectedSimulation.executionEffect.field !== "rankingObjectives"
      || selectedSimulation.executionEffect.consumerId
        !== selectedSimulation.consumerReceipt.consumerId
      || selectedSimulation.successorSemanticHash === null
      || selectedSimulation.baseRolloutGroup !== "editorial_influence"
      || selectedSimulation.successorRolloutGroup !== "editorial_influence"
    ) {
      throw new Error(
        "release Irish-influence guidance lacks a worker-consumable editorial simulation",
      );
    }
    const compiled = compileGuidanceSelectionV5(decision, {
      optionIds: [expected.selectedOptionId],
    });
    const serialized = stableReleaseFixtureJson(compiled.operations);
    if (
      compiled.state !== "accepted"
      || !serialized.includes("guidance:v5:influence-scope:balanced_influence")
      || !serialized.includes('"axis":"influence"')
      || !serialized.includes("balance Irish cultural impact with global influence")
      || compiled.operations.some((operation) => (
        operation.op === "remove_clause"
        || operation.op === "replace_clause"
        || operation.op === "set_playlist_constraints"
        || operation.op === "set_quality_policy"
      ))
    ) {
      throw new Error(
        "release Irish-influence guidance does not preserve membership and count while changing ranking",
      );
    }
    return {
      fixtureId,
      questionSetHash,
      questionHash: decision.questionHash,
      selectedOptionId: expected.selectedOptionId,
      executionDeltaHash: releaseFixtureSha256(compiled.operations),
      affectedClauseIds: [...compiled.affectedClauseIds],
    };
  }
  const decision = guidanceDecisionV3FromPublicQuestion(publicQuestion);
  if (
    decision.id !== expected.questionId
    || decision.question !== expected.question
    || decision.criticality !== "required"
    || decision.selectionMode !== "single"
    || decision.options.length !== expected.optionIds.length
    || decision.options.some((option, index) => option.id !== expected.optionIds[index])
    || decision.options.filter(({ recommended }) => recommended).length !== 1
    || decision.options.find(({ recommended }) => recommended)?.id !== expected.selectedOptionId
  ) {
    throw new Error(`release fixture ${fixtureId} guidance semantics do not match`);
  }
  const compiled = compileGuidanceSelectionV3(decision, {
    optionIds: [expected.selectedOptionId],
  });
  if (compiled.state !== "accepted") {
    throw new Error(`release fixture ${fixtureId} recommended guidance was not executable`);
  }
  const serialized = stableReleaseFixtureJson(compiled.operations);
  if (fixtureId === "smooth-reggaeton-heat-50-v1") {
    const hasCoreQuota = compiled.operations.some((operation) => {
      if (operation.op !== "set_playlist_constraints") return false;
      return operation.constraints.some((constraint) => (
        constraint.id === "quota:genre:core-reggaeton-share"
        && constraint.minimumRatio === 0.7
        && constraint.maximumRatio === 1
      ));
    });
    if (!hasCoreQuota
      || !serialized.includes("genre:reggaeton")
      || !serialized.includes("genre:dembow")
      || !serialized.includes("genre:latin-urban")
      || serialized.includes("genre:latin-pop")) {
      throw new Error("release reggaeton guidance does not preserve the recommended >=70% core semantics");
    }
  } else {
    const protectedClauseIds = [
      "genre:jazz",
      "recording:clean",
      "recording:original-studio",
      "exclude:live",
      "exclude:remix",
    ];
    const removesProtectedClause = compiled.operations.some((operation) => (
      (operation.op === "remove_clause" || operation.op === "replace_clause")
      && protectedClauseIds.includes(operation.clauseId)
    ));
    const replacement = compiled.operations.find((operation) => (
      operation.op === "replace_track_predicate"
    ));
    const predicateJson = replacement?.op === "replace_track_predicate"
      ? stableReleaseFixtureJson(replacement.predicate)
      : "";
    if (
      !serialized.includes("guidance:french-jazz:relationship")
      || !serialized.includes("French jazz scene")
      || !serialized.includes("relationship:label_or_venue_scene")
      || !serialized.includes('"axis":"scene"')
      || removesProtectedClause
      || protectedClauseIds.some((clauseId) => (
        !predicateJson.includes(`"clauseId":"${clauseId}"`)
      ))
    ) {
      throw new Error("release French-jazz guidance does not match the server scene relationship patch or preserve every hard constraint");
    }
  }
  return {
    fixtureId,
    questionSetHash,
    questionHash: decision.questionHash,
    selectedOptionId: expected.selectedOptionId,
    executionDeltaHash: releaseFixtureSha256(compiled.operations),
    affectedClauseIds: [...compiled.affectedClauseIds],
  };
}

export function createReleaseFixtureExecutionProof(input: {
  fixtureId: ReleaseFixtureId;
  guidanceLineageHash?: string | null;
  guidancePayload?: {
    questionSetHash: string;
    questions: PlaylistGuidanceQuestion[];
  } | null;
}): ReleaseFixtureExecutionProofV1 {
  const fixture = RELEASE_FIXTURES[input.fixtureId];
  const lineage = input.guidanceLineageHash ?? null;
  const guidancePayload = input.guidancePayload
    ? structuredClone(input.guidancePayload)
    : null;
  const validation = fixture.guidanceMode === "recommended" && guidancePayload
    ? validateReleaseFixtureGuidancePayload(
      input.fixtureId as
        | "smooth-reggaeton-heat-50-v1"
        | "french-jazz-guided-constraint-25-v1"
        | "irish-influence-recovery-25-v1",
      guidancePayload,
    )
    : null;
  if (fixture.guidanceMode === "recommended") {
    if (!SHA256.test(lineage ?? "")
      || !validation
      || validation.fixtureId !== input.fixtureId) {
      throw new Error(`release fixture ${input.fixtureId} requires validated guidance execution`);
    }
  } else if (lineage !== null || validation !== null) {
    throw new Error(`release fixture ${input.fixtureId} must not invent guidance execution`);
  }
  const unsigned = {
    schemaVersion: "genio-release-fixture-execution-proof/v1" as const,
    ...fixture,
    guidanceLineageHash: lineage,
    questionSetHash: validation?.questionSetHash ?? null,
    questionHash: validation?.questionHash ?? null,
    selectedOptionId: validation?.selectedOptionId ?? null,
    executionDeltaHash: validation?.executionDeltaHash ?? null,
    affectedClauseIds: validation ? [...validation.affectedClauseIds].sort() : [],
    guidancePayload,
  };
  return {
    ...unsigned,
    evidenceHash: releaseFixtureSha256(unsigned),
  };
}

export function releaseFixtureBindingsForGate(
  gate: ReleaseGateName,
  guidanceLineageHashes: Partial<Record<ReleaseFixtureId, string>> = {},
): ReleaseFixtureBindingV1[] {
  return GATE_FIXTURE_IDS[gate].map((fixtureId) => {
    const fixture = RELEASE_FIXTURES[fixtureId];
    const guidanceLineageHash = fixture.guidanceMode === "recommended"
      ? guidanceLineageHashes[fixtureId] ?? ""
      : null;
    if (fixture.guidanceMode === "recommended" && !SHA256.test(guidanceLineageHash ?? "")) {
      throw new Error(`release fixture ${fixtureId} requires a guidance lineage hash`);
    }
    return {
      ...fixture,
      guidanceLineageHash,
    };
  });
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unapproved fields`);
  }
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function candidateBinding(value: unknown): ReleaseGateCandidateBindingV1 {
  const candidate = asRecord(value, "release gate candidate");
  exactKeys(candidate, [
    "tag",
    "version",
    "sourceRevision",
    "imageDigest",
    "sitesSourceRevision",
  ], "release gate candidate");
  if (typeof candidate.version !== "string" || !VERSION.test(candidate.version)) {
    throw new Error("release gate candidate.version is invalid");
  }
  if (typeof candidate.tag !== "string"
    || !new RegExp(`^v${candidate.version.replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`, "u")
      .test(candidate.tag)) {
    throw new Error("release gate candidate.tag is invalid");
  }
  if (typeof candidate.sourceRevision !== "string"
    || !SOURCE_REVISION.test(candidate.sourceRevision)
    || candidate.sitesSourceRevision !== candidate.sourceRevision) {
    throw new Error("release gate candidate source revisions are invalid");
  }
  if (typeof candidate.imageDigest !== "string"
    || !IMAGE_DIGEST.test(candidate.imageDigest)) {
    throw new Error("release gate candidate.imageDigest is invalid");
  }
  return candidate as unknown as ReleaseGateCandidateBindingV1;
}

export function validateReleaseFixtureBindingsForGate(
  gate: ReleaseGateName,
  value: unknown,
): ReleaseFixtureBindingV1[] {
  if (!Array.isArray(value)) throw new Error("release gate fixtures must be an array");
  const expectedIds = GATE_FIXTURE_IDS[gate];
  if (value.length !== expectedIds.length) {
    throw new Error(`release gate ${gate} has the wrong fixture set`);
  }
  return value.map((item, index) => {
    const fixture = asRecord(item, `release gate fixture[${index}]`);
    exactKeys(fixture, [
      "fixtureId",
      "fixtureHash",
      "promptHash",
      "targetTrackCount",
      "guidanceMode",
      "guidanceSemanticsHash",
      "guidanceLineageHash",
    ], `release gate fixture[${index}]`);
    const fixtureId = expectedIds[index];
    if (fixture.fixtureId !== fixtureId) {
      throw new Error(`release gate ${gate} has the wrong fixture set`);
    }
    const expected = RELEASE_FIXTURES[fixtureId]!;
    for (const field of [
      "fixtureHash",
      "promptHash",
      "targetTrackCount",
      "guidanceMode",
      "guidanceSemanticsHash",
    ] as const) {
      if (fixture[field] !== expected[field]) {
        throw new Error(`release fixture ${fixtureId} does not match its immutable definition`);
      }
    }
    if (expected.guidanceMode === "recommended") {
      digest(fixture.guidanceLineageHash, `release fixture ${fixtureId} guidanceLineageHash`);
    } else if (fixture.guidanceLineageHash !== null) {
      throw new Error(`release fixture ${fixtureId} must not invent guidance lineage`);
    }
    return fixture as unknown as ReleaseFixtureBindingV1;
  });
}

function validateFixtureExecutionProof(
  value: unknown,
  expected: ReleaseFixtureBindingV1,
): ReleaseFixtureExecutionProofV1 {
  const proof = asRecord(value, "release fixture execution proof");
  exactKeys(proof, [
    "schemaVersion",
    "fixtureId",
    "fixtureHash",
    "promptHash",
    "targetTrackCount",
    "guidanceMode",
    "guidanceSemanticsHash",
    "guidanceLineageHash",
    "questionSetHash",
    "questionHash",
    "selectedOptionId",
    "executionDeltaHash",
    "affectedClauseIds",
    "guidancePayload",
    "evidenceHash",
  ], "release fixture execution proof");
  if (proof.schemaVersion !== "genio-release-fixture-execution-proof/v1") {
    throw new Error("release fixture execution proof uses an unsupported schema");
  }
  for (const field of [
    "fixtureId",
    "fixtureHash",
    "promptHash",
    "targetTrackCount",
    "guidanceMode",
    "guidanceSemanticsHash",
    "guidanceLineageHash",
  ] as const) {
    if (proof[field] !== expected[field]) {
      throw new Error("release fixture execution proof does not bind the immutable fixture");
    }
  }
  if (expected.guidanceMode === "recommended") {
    const validation = validateReleaseFixtureGuidancePayload(
      expected.fixtureId as
        | "smooth-reggaeton-heat-50-v1"
        | "french-jazz-guided-constraint-25-v1"
        | "irish-influence-recovery-25-v1",
      proof.guidancePayload,
    );
    for (const field of ["questionSetHash", "questionHash", "executionDeltaHash"]) {
      digest(proof[field], `release fixture execution proof ${field}`);
    }
    if (typeof proof.selectedOptionId !== "string"
      || !proof.selectedOptionId
      || !Array.isArray(proof.affectedClauseIds)
      || proof.affectedClauseIds.length < 1) {
      throw new Error("release fixture execution proof has no executable guidance delta");
    }
    for (const field of [
      "fixtureId",
      "questionSetHash",
      "questionHash",
      "selectedOptionId",
      "executionDeltaHash",
    ] as const) {
      if (proof[field] !== validation[field]) {
        throw new Error("release fixture execution proof guidance summary was not derived from its typed payload");
      }
    }
    if (stableReleaseFixtureJson(proof.affectedClauseIds)
      !== stableReleaseFixtureJson([...validation.affectedClauseIds].sort())) {
      throw new Error("release fixture execution proof affected clauses do not match its typed payload");
    }
  } else if (
    proof.questionSetHash !== null
    || proof.questionHash !== null
    || proof.selectedOptionId !== null
    || proof.executionDeltaHash !== null
    || !Array.isArray(proof.affectedClauseIds)
    || proof.affectedClauseIds.length !== 0
    || proof.guidancePayload !== null
  ) {
    throw new Error("fixed release fixture execution proof invented guidance");
  }
  recomputeHash(proof, "evidenceHash", "release fixture execution proof");
  return proof as unknown as ReleaseFixtureExecutionProofV1;
}

function recomputeHash(
  record: JsonRecord,
  hashField: string,
  label: string,
  mode: "stable" | "insertion" = "stable",
  insertionOrder?: readonly string[],
  normalizeInsertionValue?: (value: JsonRecord) => JsonRecord,
): void {
  const expected = digest(record[hashField], `${label}.${hashField}`);
  const unsigned = { ...record };
  delete unsigned[hashField];
  const orderedInsertionValue = Object.fromEntries(
    (insertionOrder ?? Object.keys(unsigned)).map((key) => [
        key,
        unsigned[key],
      ]),
  );
  const actual = mode === "stable"
    ? releaseFixtureSha256(unsigned)
    : createHash("sha256").update(JSON.stringify(
      normalizeInsertionValue
        ? normalizeInsertionValue(orderedInsertionValue)
        : orderedInsertionValue,
    )).digest("hex");
  if (expected !== actual) throw new Error(`${label} hash does not match its contents`);
}

function safeStringArray(value: unknown, label: string, pattern = SHA256): string[] {
  if (!Array.isArray(value)
    || value.some((item) => typeof item !== "string" || !pattern.test(item))) {
    throw new Error(`${label} is invalid`);
  }
  return value as string[];
}

function validateIndependentAppleSource(
  value: unknown,
  expected: {
    environment: ReleaseGateEnvironment;
    sourceRevision: string;
    targetTrackCount: number;
    canaryId: string;
  },
): JsonRecord {
  const evidence = asRecord(value, "independent Apple/browser evidence");
  exactKeys(evidence, [
    "schemaVersion",
    "canaryId",
    "environment",
    "candidateRevision",
    "observedAt",
    "verifierCredentialVersionHash",
    "verifierCredentialIdentityHash",
    "playlistCount",
    "targetTrackCount",
    "expectedOrderedIdsHash",
    "observedOrderedIdsHash",
    "exactOrderedReadback",
    "publicNamesHash",
    "browserChecks",
    "evidenceHash",
  ], "independent Apple/browser evidence");
  if (
    evidence.schemaVersion !== "genio-independent-apple-release-evidence/v1"
    || evidence.canaryId !== expected.canaryId
    || evidence.environment !== expected.environment
    || evidence.candidateRevision !== expected.sourceRevision
    || Number(evidence.targetTrackCount) !== expected.targetTrackCount
    || evidence.exactOrderedReadback !== true
    || evidence.expectedOrderedIdsHash !== evidence.observedOrderedIdsHash
    || !Number.isSafeInteger(Number(evidence.playlistCount))
    || Number(evidence.playlistCount) < 1
  ) {
    throw new Error("independent Apple/browser evidence does not bind the release gate");
  }
  timestamp(evidence.observedAt, "independent Apple/browser observedAt");
  for (const field of [
    "verifierCredentialVersionHash",
    "verifierCredentialIdentityHash",
    "expectedOrderedIdsHash",
    "observedOrderedIdsHash",
    "publicNamesHash",
  ]) digest(evidence[field], `independent Apple/browser ${field}`);
  if (!Array.isArray(evidence.browserChecks)
    || evidence.browserChecks.length !== Number(evidence.playlistCount)) {
    throw new Error("independent Apple/browser evidence has the wrong browser checks");
  }
  evidence.browserChecks.forEach((value, index) => {
    const check = asRecord(value, `independent Apple/browser check ${index}`);
    exactKeys(check, [
      "volumeIndex",
      "screenshotHash",
      "titleVisible",
      "firstTrackVisible",
      "lastTrackVisible",
      "countVisible",
    ], `independent Apple/browser check ${index}`);
    if (
      Number(check.volumeIndex) !== index + 1
      || check.titleVisible !== true
      || check.firstTrackVisible !== true
      || check.lastTrackVisible !== true
      || check.countVisible !== true
    ) throw new Error("independent Apple/browser visibility proof is incomplete");
    digest(check.screenshotHash, `independent Apple/browser screenshot ${index}`);
  });
  recomputeHash(evidence, "evidenceHash", "independent Apple/browser evidence");
  return evidence;
}

function validateHostedPublicationSource(
  value: unknown,
  expected: {
    targetTrackCount: number;
    guidanceLineageHash: string | null;
    ownerUiPublicationRequired: boolean;
  },
): JsonRecord {
  const hosted = asRecord(value, "hosted publication evidence");
  const hostedV2 =
    hosted.schemaVersion === "genio-hosted-publication-smoke/v2";
  const hostedV1 =
    hosted.schemaVersion === "genio-hosted-publication-smoke/v1";
  const hostedPrefixFields = [
    "schemaVersion",
    "canaryId",
    "cacheMode",
    "targetTrackCount",
    "manifestContentHash",
    "contractHash",
    "answerLineageHash",
    "queryPlanRevisionHash",
    "guidanceLineageHash",
    "guidanceRevisionCount",
    "executorRevisions",
    "executorIdentityHashes",
    "configurationHashes",
    "completedAttemptCount",
    "allAttemptsComplete",
    "serverReportedOrderedAppleReconciliation",
    "orderedAppleIdsHash",
  ] as const;
  const hostedSuffixFields = [
    "independentAppleEvidenceHash",
    "volumes",
    "evidenceHash",
  ] as const;
  const hostedFields: readonly string[] = hostedV2
    ? [...hostedPrefixFields, "ownerUiPublication", ...hostedSuffixFields]
    : [...hostedPrefixFields, ...hostedSuffixFields];
  exactKeys(
    hosted,
    hostedFields,
    "hosted publication evidence",
  );
  if (
    (!hostedV1 && !hostedV2)
    || hosted.cacheMode !== "reuse_disabled"
    || Number(hosted.targetTrackCount) !== expected.targetTrackCount
    || hosted.allAttemptsComplete !== true
    || Number(hosted.completedAttemptCount) < 1
    || hosted.serverReportedOrderedAppleReconciliation !== true
  ) throw new Error("hosted publication evidence did not prove exact publication");
  if (expected.ownerUiPublicationRequired) {
    if (!hostedV2) {
      throw new Error(
        "production regression lacks owner UI publication evidence",
      );
    }
    const ownerUi = asRecord(
      hosted.ownerUiPublication,
      "owner UI publication evidence",
    );
    exactKeys(ownerUi, [
      "schemaVersion",
      "exercised",
      "publishRequestObserved",
      "publishResponseStatus",
      "selectedTrackCount",
      "completedUiVisible",
      "directoryEntryVisible",
      "runAccessIdHash",
      "screenshotHash",
      "evidenceHash",
    ], "owner UI publication evidence");
    if (
      ownerUi.schemaVersion !== "genio-owner-ui-publication/v1"
      || ownerUi.exercised !== true
      || ownerUi.publishRequestObserved !== true
      || ![200, 201, 202].includes(Number(ownerUi.publishResponseStatus))
      || Number(ownerUi.selectedTrackCount) !== expected.targetTrackCount
      || ownerUi.completedUiVisible !== true
      || ownerUi.directoryEntryVisible !== true
    ) {
      throw new Error(
        "production regression did not publish through the real owner UI",
      );
    }
    digest(ownerUi.runAccessIdHash, "owner UI run access ID hash");
    digest(ownerUi.screenshotHash, "owner UI screenshot hash");
    recomputeHash(ownerUi, "evidenceHash", "owner UI publication evidence");
  } else if (hostedV2 && hosted.ownerUiPublication !== null) {
    throw new Error(
      "non-owner publication fixture unexpectedly contains owner UI evidence",
    );
  }
  for (const field of [
    "manifestContentHash",
    "contractHash",
    "answerLineageHash",
    "queryPlanRevisionHash",
    "guidanceLineageHash",
    "orderedAppleIdsHash",
    "independentAppleEvidenceHash",
  ]) digest(hosted[field], `hosted publication ${field}`);
  if (expected.guidanceLineageHash) {
    if (hosted.guidanceLineageHash !== expected.guidanceLineageHash
      || Number(hosted.guidanceRevisionCount) < 1) {
      throw new Error("hosted publication guidance lineage does not bind the fixture");
    }
  } else if (Number(hosted.guidanceRevisionCount) !== 0) {
    throw new Error("fixed release fixture unexpectedly used guidance");
  }
  safeStringArray(hosted.executorRevisions, "hosted publication executor revisions", SOURCE_REVISION);
  safeStringArray(hosted.executorIdentityHashes, "hosted publication executor identities");
  safeStringArray(hosted.configurationHashes, "hosted publication worker configurations");
  if (!Array.isArray(hosted.volumes) || hosted.volumes.length < 1) {
    throw new Error("hosted publication evidence has no volumes");
  }
  let total = 0;
  hosted.volumes.forEach((value, index) => {
    const volume = asRecord(value, `hosted publication volume ${index}`);
    exactKeys(volume, ["index", "trackCount", "appendedCount", "shareUrl"], `hosted publication volume ${index}`);
    if (Number(volume.index) !== index + 1
      || Number(volume.trackCount) !== Number(volume.appendedCount)
      || !Number.isSafeInteger(Number(volume.trackCount))
      || Number(volume.trackCount) < 1
      || typeof volume.shareUrl !== "string"
      || !volume.shareUrl.startsWith("https://music.apple.com/")) {
      throw new Error("hosted publication volume proof is invalid");
    }
    total += Number(volume.trackCount);
  });
  if (total !== expected.targetTrackCount) {
    throw new Error("hosted publication volume count does not bind the fixture");
  }
  recomputeHash(
    hosted,
    "evidenceHash",
    "hosted publication evidence",
    "insertion",
    hostedFields.filter((field) => field !== "evidenceHash"),
    (ordered) => ({
      ...ordered,
      volumes: (ordered.volumes as JsonRecord[]).map((volume) => ({
        index: volume.index,
        trackCount: volume.trackCount,
        appendedCount: volume.appendedCount,
        shareUrl: volume.shareUrl,
      })),
    }),
  );
  return hosted;
}

function validatePublicationSources(
  sources: JsonRecord,
  input: {
    environment: ReleaseGateEnvironment;
    candidate: ReleaseGateCandidateBindingV1;
    fixtures: ReleaseFixtureBindingV1[];
  },
): void {
  const fixture = input.fixtures[0]!;
  exactKeys(
    sources,
    fixture.fixtureId === "irish-influence-recovery-25-v1"
      ? [
          "hostedPublication",
          "independentApple",
          "fixtureExecution",
          "irishInfluenceRecovery",
        ]
      : ["hostedPublication", "independentApple", "fixtureExecution"],
    "publication gate sources",
  );
  const fixtureExecution = validateFixtureExecutionProof(
    sources.fixtureExecution,
    fixture,
  );
  const hosted = validateHostedPublicationSource(sources.hostedPublication, {
    targetTrackCount: fixture.targetTrackCount,
    guidanceLineageHash: fixture.guidanceLineageHash,
    ownerUiPublicationRequired:
      fixture.fixtureId === "irish-influence-recovery-25-v1",
  });
  const independent = validateIndependentAppleSource(sources.independentApple, {
    environment: input.environment,
    sourceRevision: input.candidate.sourceRevision,
    targetTrackCount: fixture.targetTrackCount,
    canaryId: String(hosted.canaryId),
  });
  if (hosted.independentAppleEvidenceHash !== independent.evidenceHash
    || hosted.orderedAppleIdsHash !== independent.observedOrderedIdsHash) {
    throw new Error("hosted and independent Apple evidence are not cross-bound");
  }
  if (fixture.fixtureId === "irish-influence-recovery-25-v1") {
    validateIrishInfluenceReleaseProofV1(sources.irishInfluenceRecovery, {
      version: input.candidate.version,
      sourceRevision: input.candidate.sourceRevision,
      workerConfigurationHashes: safeStringArray(
        hosted.configurationHashes,
        "Irish-influence hosted worker configurations",
      ),
      contractHash: digest(
        hosted.contractHash,
        "Irish-influence hosted contract hash",
      ),
      questionSetHash: digest(
        fixtureExecution.questionSetHash,
        "Irish-influence fixture question-set hash",
      ),
      questionHash: digest(
        fixtureExecution.questionHash,
        "Irish-influence fixture question hash",
      ),
      queryPlanRevisionHash: digest(
        hosted.queryPlanRevisionHash,
        "Irish-influence hosted query-plan revision hash",
      ),
      orderedAppleIdsHash: digest(
        independent.observedOrderedIdsHash,
        "Irish-influence independent ordered Apple IDs hash",
      ),
    });
  }
}

function validateOfflineSource(
  sources: JsonRecord,
  candidate: ReleaseGateCandidateBindingV1,
): void {
  exactKeys(sources, ["offlineSuite"], "offline gate sources");
  const source = asRecord(sources.offlineSuite, "offline suite source");
  exactKeys(source, [
    "schemaVersion",
    "candidateTag",
    "sourceRevision",
    "imageDigest",
    "completedAt",
    "workflow",
    "checks",
    "evidenceHash",
  ], "offline suite source");
  if (
    source.schemaVersion !== "genio-release-offline-suite/v2"
    || source.candidateTag !== candidate.tag
    || source.sourceRevision !== candidate.sourceRevision
    || source.imageDigest !== candidate.imageDigest
  ) throw new Error("offline suite source does not bind the candidate artifact");
  timestamp(source.completedAt, "offline suite completedAt");
  const workflow = asRecord(source.workflow, "offline suite workflow provenance");
  exactKeys(
    workflow,
    ["provider", "repository", "workflow", "runId", "runAttempt", "sha", "refName"],
    "offline suite workflow provenance",
  );
  if (
    workflow.provider !== "github_actions"
    || workflow.repository !== "hooterjackson/genio"
    || workflow.workflow !== "release-candidate.yml"
    || typeof workflow.runId !== "string"
    || !/^[1-9]\d{0,19}$/u.test(workflow.runId)
    || typeof workflow.runAttempt !== "string"
    || !/^[1-9]\d{0,5}$/u.test(workflow.runAttempt)
    || workflow.sha !== candidate.sourceRevision
    || workflow.refName !== candidate.tag
  ) throw new Error("offline suite is not bound to the GitHub release-candidate run");
  const checks = asRecord(source.checks, "offline suite checks");
  exactKeys(checks, [
    "releaseMetadata",
    "lint",
    "build",
    "fixtureContract",
    "policy",
    "database",
    "unitAndIntegration",
    "browser",
    "stitchedSystemBrowser",
  ], "offline suite checks");
  if (Object.values(checks).some((passed) => passed !== true)) {
    throw new Error("offline suite source has a failed check");
  }
  recomputeHash(source, "evidenceHash", "offline suite source");
}

function validateManifestSource(
  sources: JsonRecord,
  candidate: ReleaseGateCandidateBindingV1,
  fixture: ReleaseFixtureBindingV1,
): void {
  exactKeys(sources, ["manifestCanary", "fixtureExecution"], "manifest gate sources");
  validateFixtureExecutionProof(sources.fixtureExecution, fixture);
  const report = asRecord(sources.manifestCanary, "manifest canary report");
  exactKeys(report, [
    "schemaVersion",
    "candidate",
    "runtimeSnapshotHash",
    "evidence",
    "evidenceHash",
  ], "manifest canary report");
  const reportCandidate = asRecord(report.candidate, "manifest canary candidate");
  exactKeys(reportCandidate, ["version", "sourceRevision"], "manifest canary candidate");
  if (
    report.schemaVersion !== "genio-staging-manifest-canary/v1"
    || reportCandidate.version !== candidate.version
    || reportCandidate.sourceRevision !== candidate.sourceRevision
  ) throw new Error("manifest canary report does not bind the candidate");
  digest(report.runtimeSnapshotHash, "manifest canary runtimeSnapshotHash");
  const evidence = asRecord(report.evidence, "manifest canary evidence");
  if (
    evidence.schemaVersion !== "genio-release-manifest-canary-evidence/v1"
    || evidence.environment !== "staging"
    || evidence.cacheMode !== "reuse_disabled"
    || evidence.sourceRevision !== candidate.sourceRevision
    || evidence.outcome !== "exact_ready"
    || Number(evidence.requestedTrackCount) !== fixture.targetTrackCount
    || Number(evidence.selectedTrackCount) !== fixture.targetTrackCount
  ) throw new Error("manifest canary evidence does not prove the fixture");
  const zeroWrite = asRecord(evidence.zeroWriteProof, "manifest canary zero-write proof");
  if (zeroWrite.autoPublish !== false
    || [
      "manifestRows",
      "matchingJobs",
      "publicationJobs",
      "publicationVolumeRows",
      "orphanPlaylistRows",
    ]
      .some((field) => Number(zeroWrite[field]) !== 0)) {
    throw new Error("manifest canary did not prove the database write fence");
  }
  const selection = asRecord(evidence.selectionValidation, "manifest canary selection validation");
  if (selection.canonicalPublicationValid !== true
    || (selection.centralQualityRequired === true && selection.centralQualityPassed !== true)
    || (selection.playlistOptimizationRequired === true && selection.playlistOptimizationExact !== true)) {
    throw new Error("manifest canary selection policy did not pass");
  }
  recomputeHash(evidence, "evidenceHash", "manifest canary evidence");
  recomputeHash(report, "evidenceHash", "manifest canary report");
}

function validateSemanticReviewSources(
  sources: JsonRecord,
  candidate: ReleaseGateCandidateBindingV1,
): void {
  exactKeys(
    sources,
    [
      "reviewArtifact",
      "reviewReport",
      "protectedBaselineMetadata",
      "protectedBaselineFinalizationEvidence",
      "protectedBaselineReleaseVerificationKey",
      "protectedBaselineStableAuthorization",
      "protectedBaselineStableAuthorizerVerificationKey",
      "protectedBaselineVerification",
      "protectedBaselineImageAttestation",
      "protectedBaselineStoredConsumer",
      "protectedBaselineGithubAttestationVerification",
      "protectedBaselineLineage",
      "blindedPackage",
      "blindScorecard",
      "blindMapping",
      "reviewerAttestation",
      "reviewerTrustPolicy",
      "reviewerVerificationKey",
    ],
    "semantic review gate sources",
  );
  const artifact = sources.reviewArtifact as SemanticRankingReviewArtifactV1;
  const evaluated = evaluateSemanticRankingReviewV1(artifact);
  const report = validateSemanticRankingReviewReportV1(
    sources.reviewReport,
    artifact,
  );
  const blindScorecard = validateSemanticRankingBlindScorecardV1(
    sources.blindScorecard,
  );
  const reviewerAttestation = validateSemanticRankingReviewerAttestationV1(
    sources.reviewerAttestation,
    blindScorecard,
  );
  const reviewerVerificationKey =
    validateSemanticRankingReviewerVerificationKeyV1(
      sources.reviewerVerificationKey,
    );
  const reviewerTrustPolicy = validateSemanticRankingReviewerTrustPolicyV1(
    sources.reviewerTrustPolicy,
  );
  const releaseVerificationKey =
    validateStableReleaseVerificationKeyV1(
      sources.protectedBaselineReleaseVerificationKey,
    );
  const stableAuthorizerVerificationKey =
    validateStableReleaseVerificationKeyV1(
      sources.protectedBaselineStableAuthorizerVerificationKey,
    );
  const protectedBaselineMetadata =
    validateSemanticRankingProtectedBaselineMetadataV1(
      sources.protectedBaselineMetadata,
    );
  const predecessorVerification = asRecord(
    sources.protectedBaselineVerification,
    "semantic review predecessor verification context",
  );
  exactKeys(predecessorVerification, [
    "schemaVersion",
    "mode",
    "repository",
    "defaultBranch",
    "controllerSourceRevision",
    "successorRcTag",
    "successorSourceRevision",
  ], "semantic review predecessor verification context");
  if (
    predecessorVerification.schemaVersion
      !== "genio-historical-stable-predecessor-verification-context/v1"
    || (
      predecessorVerification.mode !== "normal"
      && predecessorVerification.mode !== "bootstrap"
    )
    || predecessorVerification.repository
      !== HISTORICAL_STABLE_PREDECESSOR_REPOSITORY
    || predecessorVerification.defaultBranch
      !== HISTORICAL_STABLE_PREDECESSOR_DEFAULT_BRANCH
    || predecessorVerification.successorRcTag !== candidate.tag
    || predecessorVerification.successorSourceRevision
      !== candidate.sourceRevision
    || (
      predecessorVerification.mode === "normal"
      && (
        predecessorVerification.controllerSourceRevision !== null
        || sources.protectedBaselineImageAttestation !== null
        || sources.protectedBaselineGithubAttestationVerification !== null
      )
    )
    || (
      predecessorVerification.mode === "bootstrap"
      && (
        typeof predecessorVerification.controllerSourceRevision !== "string"
        || !SOURCE_REVISION.test(
          predecessorVerification.controllerSourceRevision,
        )
        || !sources.protectedBaselineImageAttestation
        || typeof sources.protectedBaselineImageAttestation !== "object"
        || !sources.protectedBaselineGithubAttestationVerification
        || typeof sources.protectedBaselineGithubAttestationVerification
          !== "object"
      )
    )
  ) {
    throw new Error(
      "semantic review predecessor verification context is invalid",
    );
  }
  const protectedBaselineVerification =
    verifyHistoricalStablePredecessor({
      evidence: sources.protectedBaselineFinalizationEvidence,
      protectedBaselineMetadata,
      releaseVerificationKey: releaseVerificationKey.key,
      approvedReleaseKeySha256:
        reviewerTrustPolicy.approvedBaselineReleaseKeySha256,
      authorization:
        sources.protectedBaselineStableAuthorization,
      stableAuthorizationVerificationKey:
        stableAuthorizerVerificationKey.key,
      approvedStableAuthorizerKeyId:
        reviewerTrustPolicy.approvedBaselineStableAuthorizerKeyId,
      approvedStableAuthorizerKeySha256:
        reviewerTrustPolicy
          .approvedBaselineStableAuthorizerKeySha256,
      imageAttestation: sources.protectedBaselineImageAttestation,
      storedConsumer: sources.protectedBaselineStoredConsumer,
      githubAttestationVerification:
        sources.protectedBaselineGithubAttestationVerification,
      expectedPredecessorRcTag: protectedBaselineMetadata.rcTag,
      expectedPredecessorVersion: protectedBaselineMetadata.version,
      expectedPredecessorRevision: protectedBaselineMetadata.sourceRevision,
      expectedPredecessorImageDigest: protectedBaselineMetadata.imageDigest,
      expectedPredecessorImageReference:
        protectedBaselineMetadata.imageReference,
      expectedSuccessorRcTag: candidate.tag,
      expectedSuccessorSourceRevision: candidate.sourceRevision,
      expectedRepository: String(predecessorVerification.repository),
      expectedDefaultBranch:
        String(predecessorVerification.defaultBranch),
      expectedControllerSourceRevision:
        predecessorVerification.mode === "bootstrap"
          ? String(predecessorVerification.controllerSourceRevision)
          : candidate.sourceRevision,
      now: artifact.reviewedAt,
    });
  if (protectedBaselineVerification.mode !== predecessorVerification.mode) {
    throw new Error(
      "semantic review predecessor schema mode does not match its protected context",
    );
  }
  const protectedBaselineLineage =
    protectedBaselineVerification.lineage;
  if (
    stableReleaseFixtureJson(protectedBaselineLineage)
      !== stableReleaseFixtureJson(sources.protectedBaselineLineage)
    || protectedBaselineLineage.protectedBaselineMetadataHash
      !== reviewerTrustPolicy.approvedBaselineMetadataSha256
    || protectedBaselineLineage.candidate.stableTag
      !== reviewerTrustPolicy.approvedBaselineStableTag
  ) {
    throw new Error(
      "semantic review protected baseline lineage is not canonical",
    );
  }
  validateSemanticRankingReviewBindingsV2({
    artifact,
    protectedBaselineMetadata,
    blindedPackage: sources.blindedPackage,
    blindScorecard,
    blindMapping: sources.blindMapping,
    approvedBaselineMetadataSha256:
      protectedBaselineLineage.protectedBaselineMetadataHash,
    expectedCandidate: {
      sourceRevision: candidate.sourceRevision,
      imageDigest: candidate.imageDigest,
    },
  });
  if (
    reviewerAttestation.reviewerVerificationKeySha256
      !== reviewerVerificationKey.source.sha256
    || reviewerTrustPolicy.approvedKeySha256
      !== reviewerVerificationKey.source.sha256
    || reviewerTrustPolicy.approvedKeyId
      !== reviewerAttestation.signature.keyId
  ) {
    throw new Error(
      "semantic review reviewer key does not bind the approved trust policy",
    );
  }
  verifySemanticRankingReviewerAttestationV1({
    value: reviewerAttestation,
    blindScorecard,
    verificationKey: reviewerVerificationKey.key,
  });
  if (stableReleaseFixtureJson(report) !== stableReleaseFixtureJson(evaluated)
    || evaluated.passed !== true
    || artifact.candidate.sourceRevision !== candidate.sourceRevision
    || artifact.candidate.imageDigest !== candidate.imageDigest
    || artifact.pairs.length
      !== GATE_FIXTURE_IDS.semantic_ranking_blinded_review.length
    || artifact.pairs.some(
      (pair, index) => pair.fixtureId
        !== GATE_FIXTURE_IDS.semantic_ranking_blinded_review[index],
    )) {
    throw new Error("semantic review source does not prove every immutable release fixture");
  }
}

function validateConvergenceSource(
  sources: JsonRecord,
  candidate: ReleaseGateCandidateBindingV1,
  requiredScope: "backend" | "full",
): void {
  exactKeys(sources, ["convergence"], "release convergence gate sources");
  const evidence = asRecord(sources.convergence, "release convergence evidence");
  exactKeys(evidence, [
    "schemaVersion",
    "generatedAt",
    "expiresAt",
    "origin",
    "scope",
    "expected",
    "passed",
    "violations",
    "observations",
    "observationSpanMs",
    "evidenceHash",
  ], "release convergence evidence");
  const expected = asRecord(evidence.expected, "release convergence expected");
  exactKeys(expected, [
    "backend",
    "sites",
    "samples",
    "minimumObservationSpanMs",
    "configurationHashes",
  ], "release convergence expected");
  const backend = asRecord(
    expected.backend,
    "release convergence expected backend",
  );
  exactKeys(
    backend,
    ["revision", "version"],
    "release convergence expected backend",
  );
  const sites = asRecord(
    expected.sites,
    "release convergence expected Sites",
  );
  exactKeys(
    sites,
    ["revision", "version", "candidateMatched"],
    "release convergence expected Sites",
  );
  const configurationHashes = asRecord(
    expected.configurationHashes,
    "release convergence expected configuration hashes",
  );
  exactKeys(configurationHashes, [
    "api",
    "interactiveWorker",
    "deepWorker",
    "semanticExecution",
  ], "release convergence expected configuration hashes");
  for (const field of [
    "api",
    "interactiveWorker",
    "deepWorker",
    "semanticExecution",
  ]) {
    digest(
      configurationHashes[field],
      `release convergence expected configuration ${field}`,
    );
  }
  if (
    evidence.schemaVersion !== "genio-release-convergence/v2"
    || evidence.scope !== requiredScope
    || evidence.passed !== true
    || !Array.isArray(evidence.violations)
    || evidence.violations.length !== 0
    || backend.revision !== candidate.sourceRevision
    || backend.version !== candidate.version
    || typeof sites.version !== "string"
    || !VERSION.test(sites.version)
    || typeof sites.revision !== "string"
    || !SOURCE_REVISION.test(sites.revision)
    || sites.candidateMatched !== (requiredScope === "full")
    || (
      requiredScope === "full"
      && (
        sites.revision !== candidate.sitesSourceRevision
        || sites.version !== candidate.version
      )
    )
    || (
      requiredScope === "backend"
      && (
        sites.revision === candidate.sitesSourceRevision
        && sites.version === candidate.version
      )
    )
    || Number(expected.samples) < 2
    || expected.minimumObservationSpanMs !== 30_000
    || Number(evidence.observationSpanMs) < 30_000
    || !Array.isArray(evidence.observations)
    || evidence.observations.length !== Number(expected.samples)
  ) throw new Error("release convergence source did not pass");
  timestamp(evidence.generatedAt, "release convergence generatedAt");
  timestamp(evidence.expiresAt, "release convergence expiresAt");
  const recomputed = buildReleaseConvergenceEvidence({
    origin: String(evidence.origin),
    scope: requiredScope,
    expectedRevision: candidate.sourceRevision,
    expectedVersion: candidate.version,
    expectedSitesRevision: String(sites.revision),
    expectedSitesVersion: String(sites.version),
    expectedSamples: Number(expected.samples),
    expectedConfigurationHashes: {
      api: String(configurationHashes.api),
      interactiveWorker: String(configurationHashes.interactiveWorker),
      deepWorker: String(configurationHashes.deepWorker),
      semanticExecution: String(configurationHashes.semanticExecution),
    },
    observations:
      evidence.observations as ReleaseConvergenceObservation[],
    generatedAt: String(evidence.generatedAt),
  });
  if (
    stableReleaseFixtureJson(recomputed)
      !== stableReleaseFixtureJson(evidence)
  ) {
    throw new Error(
      "release convergence source is not the canonical recomputation",
    );
  }
}

export function validateSitesControlPlaneSource(
  value: unknown,
  candidate: ReleaseGateCandidateBindingV1,
): SitesProductionRollbackTargetV1 {
  const source = asRecord(value, "Sites control-plane evidence");
  exactKeys(source, [
    "schemaVersion",
    "projectId",
    "versionId",
    "versionNumber",
    "archiveSha256",
    "deploymentId",
    "commitSha",
    "buildVersion",
    "productionUrl",
    "status",
    "deploymentRequestedAt",
    "observedAt",
    "rollbackTarget",
    "evidenceHash",
  ], "Sites control-plane evidence");
  const rollbackTarget = validateSitesProductionRollbackTargetV1(
    source.rollbackTarget,
  );
  const deploymentRequestedAt = timestamp(
    source.deploymentRequestedAt,
    "Sites control-plane deploymentRequestedAt",
  );
  const observedAt = timestamp(
    source.observedAt,
    "Sites control-plane observedAt",
  );
  if (
    source.schemaVersion !== "genio-sites-control-plane-deployment/v2"
    || typeof source.projectId !== "string"
    || !source.projectId
    || source.projectId !== rollbackTarget.projectId
    || typeof source.versionId !== "string"
    || !source.versionId
    || source.versionId === rollbackTarget.previous.versionId
    || !Number.isSafeInteger(source.versionNumber)
    || Number(source.versionNumber) < 1
    || Number(source.versionNumber) <= rollbackTarget.previous.versionNumber
    || typeof source.archiveSha256 !== "string"
    || !SHA256.test(source.archiveSha256)
    || typeof source.deploymentId !== "string"
    || !source.deploymentId
    || source.deploymentId === rollbackTarget.previous.deploymentId
    || source.commitSha !== candidate.sitesSourceRevision
    || source.buildVersion !== candidate.version
    || source.productionUrl !== "https://9enio.com"
    || source.productionUrl !== rollbackTarget.productionUrl
    || (source.status !== "ready" && source.status !== "succeeded")
    || rollbackTarget.plannedCandidate.commitSha
      !== candidate.sitesSourceRevision
    || rollbackTarget.plannedCandidate.buildVersion !== candidate.version
    || Date.parse(rollbackTarget.capturedAt)
      >= Date.parse(deploymentRequestedAt)
    || Date.parse(deploymentRequestedAt) > Date.parse(observedAt)
  ) throw new Error("Sites control-plane evidence does not bind the production candidate");
  recomputeHash(source, "evidenceHash", "Sites control-plane evidence");
  return rollbackTarget;
}

function validateFinalBrowserSources(
  sources: JsonRecord,
  candidate: ReleaseGateCandidateBindingV1,
): void {
  exactKeys(sources, [
    "browser",
    "sitesControlPlane",
    "sitesControlPlaneAttestation",
    "sitesControlPlaneTrust",
    "sitesControlPlaneVerificationKey",
    "sitesControlPlaneTrustPolicy",
  ], "final browser gate sources");
  validateSitesControlPlaneSource(sources.sitesControlPlane, candidate);
  const sitesReceipt = asRecord(
    sources.sitesControlPlane,
    "Sites control-plane evidence",
  );
  const sitesAttestation = asRecord(
    sources.sitesControlPlaneAttestation,
    "signed Sites control-plane attestation",
  );
  exactKeys(sitesAttestation, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed Sites control-plane attestation");
  if (sitesAttestation.schemaVersion
    !== "genio-signed-sites-control-plane-attestation/v1") {
    throw new Error("signed Sites control-plane attestation uses an unsupported schema");
  }
  const sitesAttestationPayload = asRecord(
    sitesAttestation.payload,
    "Sites control-plane attestation payload",
  );
  exactKeys(sitesAttestationPayload, [
    "schemaVersion",
    "generatedAt",
    "expiresAt",
    "issuer",
    "operation",
    "receiptHash",
  ], "Sites control-plane attestation payload");
  const sitesAttestationGeneratedAt = timestamp(
    sitesAttestationPayload.generatedAt,
    "Sites control-plane attestation generatedAt",
  );
  const sitesAttestationExpiresAt = timestamp(
    sitesAttestationPayload.expiresAt,
    "Sites control-plane attestation expiresAt",
  );
  if (
    sitesAttestationPayload.schemaVersion
      !== "genio-sites-control-plane-attestation/v1"
    || sitesAttestationPayload.issuer !== "openai-sites-control-plane"
    || sitesAttestationPayload.operation !== "production_deployment_ready"
    || sitesAttestationPayload.receiptHash !== sitesReceipt.evidenceHash
    || sitesAttestation.payloadHash
      !== releaseFixtureSha256(sitesAttestationPayload)
    || Date.parse(sitesAttestationExpiresAt)
      <= Date.parse(sitesAttestationGeneratedAt)
    || Date.parse(sitesAttestationExpiresAt)
      - Date.parse(sitesAttestationGeneratedAt) > 24 * 60 * 60_000
  ) {
    throw new Error("Sites control-plane attestation does not bind the deployment receipt");
  }
  digest(
    sitesAttestation.payloadHash,
    "Sites control-plane attestation payloadHash",
  );
  const sitesSignature = asRecord(
    sitesAttestation.signature,
    "Sites control-plane attestation signature",
  );
  exactKeys(
    sitesSignature,
    ["algorithm", "keyId", "value"],
    "Sites control-plane attestation signature",
  );
  if (
    sitesSignature.algorithm !== "Ed25519"
    || typeof sitesSignature.keyId !== "string"
    || !/^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u.test(sitesSignature.keyId)
    || typeof sitesSignature.value !== "string"
    || !/^[0-9A-Za-z_-]{64,256}$/u.test(sitesSignature.value)
  ) {
    throw new Error("Sites control-plane attestation signature is malformed");
  }
  const sitesTrust = asRecord(
    sources.sitesControlPlaneTrust,
    "Sites control-plane trust verification",
  );
  exactKeys(sitesTrust, [
    "schemaVersion",
    "receiptHash",
    "attestationPayloadHash",
    "trustedKeyId",
    "verificationKeyFingerprint",
    "verifiedAt",
    "evidenceHash",
  ], "Sites control-plane trust verification");
  if (
    sitesTrust.schemaVersion
      !== "genio-sites-control-plane-trust-verification/v1"
    || sitesTrust.receiptHash !== sitesReceipt.evidenceHash
    || sitesTrust.attestationPayloadHash !== sitesAttestation.payloadHash
    || sitesTrust.trustedKeyId !== sitesSignature.keyId
  ) {
    throw new Error("Sites control-plane trust verification is not cross-bound");
  }
  digest(
    sitesTrust.verificationKeyFingerprint,
    "Sites control-plane trusted key fingerprint",
  );
  timestamp(sitesTrust.verifiedAt, "Sites control-plane trust verifiedAt");
  recomputeHash(
    sitesTrust,
    "evidenceHash",
    "Sites control-plane trust verification",
  );
  const sitesVerificationKey = validateSitesControlPlaneVerificationKeyV1(
    sources.sitesControlPlaneVerificationKey,
  );
  const sitesTrustPolicy = validateSitesControlPlaneTrustPolicyV1(
    sources.sitesControlPlaneTrustPolicy,
  );
  if (
    sitesVerificationKey.source.sha256
      !== sitesTrustPolicy.approvedKeySha256
    || sitesTrust.verificationKeyFingerprint
      !== sitesTrustPolicy.approvedKeySha256
    || sitesSignature.keyId !== sitesTrustPolicy.approvedKeyId
  ) {
    throw new Error("Sites control-plane embedded trust policy is not cross-bound");
  }
  verifySitesControlPlaneAttestation({
    value: sitesAttestation,
    verificationKey: sitesVerificationKey.key,
    expectedReceiptHash: String(sitesReceipt.evidenceHash),
    expectedKeyId: sitesTrustPolicy.approvedKeyId,
    expectedKeyFingerprint: sitesTrustPolicy.approvedKeySha256,
    now: String(sitesTrust.verifiedAt),
  });
  const browser = asRecord(sources.browser, "final custom-domain browser evidence");
  const browserV2 =
    browser.schemaVersion === "genio-final-custom-domain-browser/v2";
  const browserV5 =
    browser.schemaVersion === "genio-final-custom-domain-browser/v5";
  const browserV6 =
    browser.schemaVersion === "genio-final-custom-domain-browser/v6";
  const browserV7 =
    browser.schemaVersion === "genio-final-custom-domain-browser/v7";
  const browserV8 =
    browser.schemaVersion === "genio-final-custom-domain-browser/v8";
  const commonBrowserFields = [
    "schemaVersion",
    "origin",
    "candidateRevision",
    "observedAt",
    "tlsValid",
    "releaseIdentityVisible",
    "anonymousPlaylistDirectory",
    "publicPlaylistContentsVisible",
    "privacyProjectionPassed",
    "screenshotHashes",
    "publicAssignmentProbes",
    "evidenceHash",
  ];
  exactKeys(
    browser,
    browserV5 || browserV6 || browserV7 || browserV8
      ? [
        ...commonBrowserFields,
        "noDirectRailwayRequests",
        ...(browserV7 || browserV8 ? ["assignmentMode"] : []),
        ...(browserV8
          ? ["exposureClass", "organicReliabilityProven"]
          : []),
      ]
      : commonBrowserFields,
    "final custom-domain browser evidence",
  );
  const publicAssignmentProbes = Array.isArray(browser.publicAssignmentProbes)
    ? browser.publicAssignmentProbes
    : [];
  const probeFixtures: readonly FinalPublicAssignmentProbeFixtureV1[] =
    browserV2
      ? LEGACY_FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1
      : browserV5
        ? FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V5
        : FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1;
  if (
    (!browserV2 && !browserV5 && !browserV6 && !browserV7 && !browserV8)
    || browser.origin !== "https://9enio.com"
    || browser.candidateRevision !== candidate.sourceRevision
    || browser.tlsValid !== true
    || browser.releaseIdentityVisible !== true
    || browser.anonymousPlaylistDirectory !== true
    || browser.publicPlaylistContentsVisible !== true
    || browser.privacyProjectionPassed !== true
    || (browserV7
      && browser.assignmentMode !== "pre_exposure_release_canary")
    || (browserV8 && (
      browser.assignmentMode !== "direct_exposure"
      || browser.exposureClass !== "fully_exposed_unproven"
      || browser.organicReliabilityProven !== false
    ))
    || ((browserV5 || browserV6 || browserV7 || browserV8)
      && browser.noDirectRailwayRequests !== true)
    || safeStringArray(
      browser.screenshotHashes,
      "final browser screenshots",
    ).length < (browserV5 || browserV6 || browserV7 || browserV8 ? 3 : 1)
    || publicAssignmentProbes.length !== probeFixtures.length
  ) throw new Error("final custom-domain browser evidence did not pass");
  const fixturesById = new Map<string, FinalPublicAssignmentProbeFixtureV1>(
    probeFixtures.map((fixture) => [
      fixture.fixtureId,
      fixture,
    ]),
  );
  const seenFixtureIds = new Set<string>();
  const seenIntentGroups = new Set<string>();
  const rolloutEvidenceHashes = new Set<string>();
  const rolloutStages = new Set<string>();
  const assignmentHashes = new Set<string>();
  for (const [index, probeValue] of publicAssignmentProbes.entries()) {
    const probe = asRecord(
      probeValue,
      `final public assignment probe ${index}`,
    );
    const commonProbeFields = [
      "fixtureId",
      "intentGroup",
      "targetTrackCount",
      "rolloutEvidenceHash",
      "rolloutStage",
      "assignmentHash",
      "contractVersion",
    ];
    exactKeys(
      probe,
      browserV5
        ? [
          ...commonProbeFields,
          "guidancePolicyVersion",
          "questionSetHash",
          "questionHash",
          "axis",
          "selectedOptionId",
          "answerAccepted",
          "successorContractHash",
          "executionRouteReceiptHash",
          "runResolutionState",
          "runAccessIdHash",
          "workerConsumptionReceiptHash",
          "workerExecutionEffectHash",
          "workerResultEffectHash",
          "manifestContentHash",
          "expectedOrderedIdsHash",
          "observedOrderedIdsHash",
          "selectedTrackCount",
          "manifestedTrackCount",
          "appendedTrackCount",
          "reconciledPublishedTrackCount",
          "runReused",
          "realUiPath",
        ]
        : browserV6 || browserV7 || browserV8
          ? [
            ...commonProbeFields,
            ...(browserV7 || browserV8
              ? [
                "assignmentAuthority",
                "assignmentReceiptHash",
                "publicPercentageBypass",
                "organicAssignment",
              ]
              : []),
            "guidancePolicyVersion",
            "questionSetHash",
            "questionHash",
            "axis",
            "selectedOptionId",
            "answerAccepted",
            "successorContractHash",
            ...(browserV7 || browserV8 ? ["queryPlanHash"] : []),
            "executionRouteReceiptHash",
            "runAccessIdHash",
            "workerConsumptionReceiptHash",
            "workerExecutionEffectHash",
            "workerResultEffectHash",
            "manifestCanaryEvidenceHash",
            "qualifiedManifestHash",
            "selectedTrackCount",
            "reserveTrackCount",
            "attemptCount",
            "executorIdentityHashes",
            "configurationHashes",
            "manifestOnly",
            "appleWriteAccess",
            "autoPublish",
            "manifestRows",
            "matchingJobs",
            "publicationJobs",
            "publicationVolumeRows",
            "orphanPlaylistRows",
            "noPublishedUi",
            "runReused",
            "realUiPath",
          ]
        : [...commonProbeFields, "cleanupStatus"],
      `final public assignment probe ${index}`,
    );
    const fixture = typeof probe.fixtureId === "string"
      ? fixturesById.get(probe.fixtureId)
      : undefined;
    const rolloutStage = typeof probe.rolloutStage === "string"
      ? probe.rolloutStage
      : "";
    if (
      !fixture
      || seenFixtureIds.has(fixture.fixtureId)
      || (!browserV6 && !browserV7 && !browserV8
        && seenIntentGroups.has(fixture.intentGroup))
      || probe.intentGroup !== fixture.intentGroup
      || probe.targetTrackCount !== fixture.targetTrackCount
      || probe.contractVersion !== 3
      || (browserV7
        ? (
          probe.rolloutEvidenceHash !== null
          || probe.rolloutStage !== null
          || probe.assignmentHash !== null
          || probe.assignmentAuthority !== "signed_release_canary"
          || !/^[0-9a-f]{64}$/u.test(
            String(probe.assignmentReceiptHash),
          )
          || probe.publicPercentageBypass !== true
          || probe.organicAssignment !== false
        )
        : browserV8
          ? (
            !/^[0-9a-f]{64}$/u.test(String(probe.rolloutEvidenceHash))
            || probe.rolloutStage
              !== "editorial_influence:0->100:fully_exposed_unproven"
            || !/^[0-9a-f]{64}$/u.test(String(probe.assignmentHash))
            || probe.assignmentAuthority
              !== "signed_public_direct_exposure"
            || probe.assignmentReceiptHash !== probe.assignmentHash
            || probe.publicPercentageBypass !== false
            || probe.organicAssignment !== false
          )
          : (
          !/^[0-9a-f]{64}$/u.test(String(probe.rolloutEvidenceHash))
          || !/^[0-9a-f]{64}$/u.test(String(probe.assignmentHash))
        ))
      || (
        browserV2
          ? (
            probe.cleanupStatus !== 204
            || !/^(?:genre_scene|mood_activity_theme|similarity|artist_catalogue|fixed_container|factual_relationship|exhaustive):(?:0|1|10|50|100)->100$/u
              .test(rolloutStage)
          )
          : browserV5
            ? (
            probe.guidancePolicyVersion !== "adaptive_guidance_v5"
            || probe.axis !== "influence_scope"
            || probe.selectedOptionId !== "balanced_influence"
            || probe.answerAccepted !== true
            || probe.realUiPath !== true
            || !/^[0-9a-f]{64}$/u.test(String(probe.questionSetHash))
            || !/^[0-9a-f]{64}$/u.test(String(probe.questionHash))
            || !/^[0-9a-f]{64}$/u.test(
              String(probe.successorContractHash),
            )
            || !/^[0-9a-f]{64}$/u.test(
              String(probe.executionRouteReceiptHash),
            )
            || !/^[0-9a-f]{64}$/u.test(String(probe.runAccessIdHash))
            || !/^[0-9a-f]{64}$/u.test(
              String(probe.workerConsumptionReceiptHash),
            )
            || !/^[0-9a-f]{64}$/u.test(
              String(probe.workerExecutionEffectHash),
            )
            || !/^[0-9a-f]{64}$/u.test(
              String(probe.workerResultEffectHash),
            )
            || !/^[0-9a-f]{64}$/u.test(
              String(probe.manifestContentHash),
            )
            || !/^[0-9a-f]{64}$/u.test(
              String(probe.expectedOrderedIdsHash),
            )
            || probe.expectedOrderedIdsHash
              !== probe.observedOrderedIdsHash
            || probe.runResolutionState !== "completed"
            || probe.selectedTrackCount !== fixture.targetTrackCount
            || probe.manifestedTrackCount !== fixture.targetTrackCount
            || probe.appendedTrackCount !== fixture.targetTrackCount
            || probe.reconciledPublishedTrackCount
              !== fixture.targetTrackCount
            || probe.runReused !== false
            || !/^editorial_influence:(?:0|1|10|50|100)->100$/u
              .test(rolloutStage)
          )
            : (
              probe.guidancePolicyVersion !== "adaptive_guidance_v5"
              || probe.axis !== "influence_scope"
              || probe.selectedOptionId !== "balanced_influence"
              || probe.answerAccepted !== true
              || probe.realUiPath !== true
              || probe.manifestOnly !== true
              || probe.appleWriteAccess !== "forbidden"
              || probe.noPublishedUi !== true
              || probe.autoPublish !== false
              || probe.manifestRows !== 0
              || probe.matchingJobs !== 0
              || probe.publicationJobs !== 0
              || probe.publicationVolumeRows !== 0
              || probe.orphanPlaylistRows !== 0
              || !/^[0-9a-f]{64}$/u.test(String(probe.questionSetHash))
              || !/^[0-9a-f]{64}$/u.test(String(probe.questionHash))
              || !/^[0-9a-f]{64}$/u.test(
                String(probe.successorContractHash),
              )
              || ((browserV7 || browserV8) && !/^[0-9a-f]{64}$/u.test(
                String(probe.queryPlanHash),
              ))
              || !/^[0-9a-f]{64}$/u.test(
                String(probe.executionRouteReceiptHash),
              )
              || !/^[0-9a-f]{64}$/u.test(String(probe.runAccessIdHash))
              || !/^[0-9a-f]{64}$/u.test(
                String(probe.workerConsumptionReceiptHash),
              )
              || !/^[0-9a-f]{64}$/u.test(
                String(probe.workerExecutionEffectHash),
              )
              || !/^[0-9a-f]{64}$/u.test(
                String(probe.workerResultEffectHash),
              )
              || !/^[0-9a-f]{64}$/u.test(
                String(probe.manifestCanaryEvidenceHash),
              )
              || !/^[0-9a-f]{64}$/u.test(
                String(probe.qualifiedManifestHash),
              )
              || probe.selectedTrackCount !== fixture.targetTrackCount
              || !Number.isSafeInteger(probe.reserveTrackCount)
              || Number(probe.reserveTrackCount) < 1
              || !Number.isSafeInteger(probe.attemptCount)
              || Number(probe.attemptCount) < 1
              || safeStringArray(
                probe.executorIdentityHashes,
                `final public assignment probe ${index} executor identities`,
              ).length < 1
              || safeStringArray(
                probe.configurationHashes,
                `final public assignment probe ${index} configurations`,
              ).length !== 1
              || probe.runReused !== false
              || (browserV7
                ? rolloutStage !== ""
                : browserV8
                  ? rolloutStage
                    !== "editorial_influence:0->100:fully_exposed_unproven"
                : !/^editorial_influence:(?:0|1|10|50|100)->100$/u
                  .test(rolloutStage))
            )
      )
    ) {
      throw new Error(
        `final public assignment probe ${index} did not prove its code-owned V3 assignment`,
      );
    }
    seenFixtureIds.add(fixture.fixtureId);
    seenIntentGroups.add(fixture.intentGroup);
    rolloutEvidenceHashes.add(String(probe.rolloutEvidenceHash));
    rolloutStages.add(rolloutStage);
    assignmentHashes.add(String(probe.assignmentHash));
  }
  if (
    seenFixtureIds.size !== probeFixtures.length
    || seenIntentGroups.size !== (
      browserV6 || browserV7 || browserV8 ? 1 : probeFixtures.length
    )
    || rolloutEvidenceHashes.size !== 1
    || rolloutStages.size !== 1
    || assignmentHashes.size !== probeFixtures.length
    || (
      browserV2
        ? LEGACY_FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1.some(
          (fixture) => !seenIntentGroups.has(fixture.intentGroup),
        )
        : (
          seenIntentGroups.size !== 1
          || !seenIntentGroups.has("editorial_influence")
        )
    )
  ) {
    throw new Error(
      "final public assignment probes do not bind one exact signed rollout state",
    );
  }
  timestamp(browser.observedAt, "final custom-domain browser observedAt");
  recomputeHash(browser, "evidenceHash", "final custom-domain browser evidence");
}

function historicalReplayPublicKeyFingerprint(key: KeyObject): string {
  if (key.asymmetricKeyType !== "ed25519" || key.type !== "public") {
    throw new Error("historical replay verification key must be Ed25519 public key material");
  }
  return createHash("sha256")
    .update(key.export({ format: "der", type: "spki" }))
    .digest("hex");
}

function historicalReplayCount(value: unknown, label: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return count;
}

function validateHistoricalReplayPayload(
  value: unknown,
  input: {
    candidate: ReleaseGateCandidateBindingV1;
    configurationHash: string;
    runtimeHash: string;
    completedAt: string;
  },
): JsonRecord {
  const payload = exactObject(value, [
    "schemaVersion",
    "generatedAt",
    "expiresAt",
    "environment",
    "candidate",
    "staging",
    "corpus",
    "browser",
    "outcomes",
    "passed",
  ], "historical replay evidence payload");
  if (
    payload.schemaVersion !== HISTORICAL_REPLAY_PAYLOAD_SCHEMA
    || payload.environment !== "staging"
    || payload.passed !== true
  ) {
    throw new Error("historical replay evidence did not pass in staging");
  }
  const generatedAt = timestamp(
    payload.generatedAt,
    "historical replay generatedAt",
  );
  const expiresAt = timestamp(
    payload.expiresAt,
    "historical replay expiresAt",
  );
  const completedAt = timestamp(
    input.completedAt,
    "historical replay gate completedAt",
  );
  if (
    Date.parse(expiresAt) - Date.parse(generatedAt)
      !== HISTORICAL_REPLAY_EVIDENCE_TTL_MS
    || Date.parse(generatedAt) > Date.parse(completedAt) + 5 * 60_000
    || Date.parse(completedAt) >= Date.parse(expiresAt)
  ) {
    throw new Error("historical replay evidence is stale or has an invalid lifetime");
  }

  const candidate = exactObject(payload.candidate, [
    "tag",
    "version",
    "sourceRevision",
    "imageDigest",
  ], "historical replay candidate");
  if (
    candidate.tag !== input.candidate.tag
    || candidate.version !== input.candidate.version
    || candidate.sourceRevision !== input.candidate.sourceRevision
    || candidate.imageDigest !== input.candidate.imageDigest
  ) {
    throw new Error("historical replay evidence does not bind the release candidate");
  }

  const staging = exactObject(payload.staging, [
    "originHash",
    "runtimeSnapshotHash",
    "configurationHash",
    "runtimeHash",
    "controlPlaneEvidenceHash",
    "serviceInventoryHash",
  ], "historical replay staging binding");
  for (const [field, value] of Object.entries(staging)) {
    digest(value, `historical replay staging ${field}`);
  }
  if (
    staging.configurationHash !== input.configurationHash
    || staging.runtimeHash !== input.runtimeHash
  ) {
    throw new Error(
      "historical replay evidence does not bind the gate runtime configuration",
    );
  }

  const corpus = exactObject(payload.corpus, [
    "commitmentHash",
    "submissionCount",
    "maximumResearchBudgetUsd",
    "requiredOtherCanaryReserveUsd",
    "requiredBudgetReservationUsd",
  ], "historical replay corpus binding");
  if (
    digest(
      corpus.commitmentHash,
      "historical replay corpus commitment",
    ) !== HISTORICAL_REPLAY_CORPUS_COMMITMENT_SHA256
    || historicalReplayCount(
      corpus.submissionCount,
      "historical replay submission count",
    ) !== HISTORICAL_REPLAY_SUBMISSION_COUNT
    || Number(corpus.maximumResearchBudgetUsd)
      !== HISTORICAL_REPLAY_MAXIMUM_RESEARCH_BUDGET_USD
    || Number(corpus.requiredOtherCanaryReserveUsd)
      !== HISTORICAL_REPLAY_REQUIRED_OTHER_CANARY_RESERVE_USD
    || Number(corpus.requiredBudgetReservationUsd)
      !== HISTORICAL_REPLAY_REQUIRED_BUDGET_RESERVATION_USD
  ) {
    throw new Error("historical replay evidence does not bind the approved corpus and budget");
  }

  const browser = exactObject(payload.browser, [
    "engine",
    "maximumConcurrency",
    "perRunDeadlineMs",
    "perRunBudgetCapUsd",
    "cacheMode",
    "traceCount",
    "screenshotCount",
    "videoCount",
    "rawArtifactCount",
  ], "historical replay browser proof");
  const maximumConcurrency = historicalReplayCount(
    browser.maximumConcurrency,
    "historical replay maximum concurrency",
  );
  if (
    browser.engine !== "chromium"
    || maximumConcurrency < 1
    || maximumConcurrency > HISTORICAL_REPLAY_MAXIMUM_CONCURRENCY
    || Number(browser.perRunDeadlineMs)
      !== HISTORICAL_REPLAY_PER_RUN_DEADLINE_MS
    || Number(browser.perRunBudgetCapUsd)
      !== HISTORICAL_REPLAY_MAXIMUM_PER_RUN_BUDGET_USD
    || browser.cacheMode !== "reuse_disabled"
    || historicalReplayCount(browser.traceCount, "historical replay trace count") !== 0
    || historicalReplayCount(
      browser.screenshotCount,
      "historical replay screenshot count",
    ) !== 0
    || historicalReplayCount(browser.videoCount, "historical replay video count") !== 0
    || historicalReplayCount(
      browser.rawArtifactCount,
      "historical replay raw artifact count",
    ) !== 0
  ) {
    throw new Error("historical replay browser proof is incomplete or unsafe");
  }

  const outcomes = exactObject(payload.outcomes, [
    "completedSubmissionCount",
    "exactOriginalCount",
    "exactAfterGuidanceCount",
    "actionableDecisionCount",
    "visibleRetryCount",
    "guidanceSubmissionCount",
    "briefMarkerCount",
    "runMarkerCount",
    "freshRunCount",
    "countIntegrityCheckCount",
    "unexplainedTerminalCount",
    "countViolationCount",
    "integrityViolationCount",
    "budgetExhaustionCount",
    "transcriptCommitmentHash",
  ], "historical replay outcomes");
  const counts = Object.fromEntries(
    Object.entries(outcomes)
      .filter(([field]) => field.endsWith("Count"))
      .map(([field, count]) => [
        field,
        historicalReplayCount(count, `historical replay ${field}`),
      ]),
  );
  const exactCount = counts.exactOriginalCount!
    + counts.exactAfterGuidanceCount!;
  const categorizedCount = exactCount
    + counts.actionableDecisionCount!
    + counts.visibleRetryCount!;
  if (
    counts.completedSubmissionCount !== HISTORICAL_REPLAY_SUBMISSION_COUNT
    || categorizedCount !== HISTORICAL_REPLAY_SUBMISSION_COUNT
    || counts.briefMarkerCount! < HISTORICAL_REPLAY_SUBMISSION_COUNT
    || counts.runMarkerCount! < HISTORICAL_REPLAY_SUBMISSION_COUNT
    || counts.freshRunCount !== counts.runMarkerCount
    || counts.countIntegrityCheckCount !== exactCount
    || counts.unexplainedTerminalCount !== 0
    || counts.countViolationCount !== 0
    || counts.integrityViolationCount !== 0
    || counts.budgetExhaustionCount !== 0
  ) {
    throw new Error("historical replay outcomes do not prove all bounded outcomes");
  }
  digest(
    outcomes.transcriptCommitmentHash,
    "historical replay transcript commitment",
  );
  return payload;
}

function validateHistoricalReplaySources(
  sources: JsonRecord,
  input: {
    candidate: ReleaseGateCandidateBindingV1;
    configurationHash: string;
    runtimeHash: string;
    completedAt: string;
  },
): void {
  exactKeys(sources, [
    "historicalReplay",
    "historicalReplayVerificationKey",
    "historicalReplayTrust",
  ], "historical replay gate sources");
  const verificationKey = exactObject(
    sources.historicalReplayVerificationKey,
    [
      "schemaVersion",
      "algorithm",
      "keyId",
      "publicKeyPem",
      "publicKeySha256",
    ],
    "historical replay verification key",
  );
  if (
    verificationKey.schemaVersion
      !== HISTORICAL_REPLAY_VERIFICATION_KEY_SCHEMA
    || verificationKey.algorithm !== "Ed25519"
    || typeof verificationKey.keyId !== "string"
    || !SAFE_KEY_ID.test(verificationKey.keyId)
    || typeof verificationKey.publicKeyPem !== "string"
  ) {
    throw new Error("historical replay verification key descriptor is invalid");
  }
  let parsedKey: KeyObject;
  try {
    parsedKey = createPublicKey(verificationKey.publicKeyPem);
  } catch {
    throw new Error("historical replay verification key cannot be parsed");
  }
  const canonicalPem = parsedKey.export({
    format: "pem",
    type: "spki",
  }).toString();
  const keyFingerprint = historicalReplayPublicKeyFingerprint(parsedKey);
  if (
    canonicalPem !== verificationKey.publicKeyPem
    || digest(
      verificationKey.publicKeySha256,
      "historical replay verification key fingerprint",
    ) !== keyFingerprint
  ) {
    throw new Error("historical replay verification key descriptor is not canonical");
  }

  const trust = exactObject(sources.historicalReplayTrust, [
    "schemaVersion",
    "approvedKeyId",
    "approvedKeySha256",
  ], "historical replay trust policy");
  if (
    trust.schemaVersion
      !== "genio-release-gate-producer-trust-policy/v1"
    || trust.approvedKeyId !== verificationKey.keyId
    || trust.approvedKeySha256 !== keyFingerprint
  ) {
    throw new Error("historical replay producer is not approved by the embedded trust policy");
  }

  const verified = verifyStrictSignedEnvelope({
    value: sources.historicalReplay,
    verificationKey: parsedKey,
    envelopeSchemaVersion: SIGNED_HISTORICAL_REPLAY_SCHEMA,
    payloadLabel: "historical browser replay evidence",
    validatePayload: (value) => validateHistoricalReplayPayload(value, input),
  });
  if (verified.keyId !== verificationKey.keyId) {
    throw new Error("historical replay signature used an unapproved key ID");
  }
}

function deriveGateAssertions(input: {
  gate: ReleaseGateName;
  candidate: ReleaseGateCandidateBindingV1;
  completedAt: string;
  configurationHash: string;
  runtimeHash: string;
  fixtures: ReleaseFixtureBindingV1[];
  sources: unknown;
}): Record<string, true> {
  const sources = asRecord(input.sources, `release gate ${input.gate} sources`);
  if (input.gate === "offline_suite") validateOfflineSource(sources, input.candidate);
  else if (input.gate === "staging_provider_manifest") {
    validateManifestSource(sources, input.candidate, input.fixtures[0]!);
  } else if (input.gate === "staging_historical_replay") {
    validateHistoricalReplaySources(sources, input);
  } else if (input.gate === "semantic_ranking_blinded_review") {
    validateSemanticReviewSources(sources, input.candidate);
  } else if (input.gate === "backend_release_convergence") {
    validateConvergenceSource(sources, input.candidate, "backend");
  } else if (input.gate === "release_convergence") {
    validateConvergenceSource(sources, input.candidate, "full");
  } else if (input.gate === "final_custom_domain_browser") {
    validateFinalBrowserSources(sources, input.candidate);
  } else {
    validatePublicationSources(sources, {
      environment: RELEASE_GATE_ENVIRONMENTS[input.gate],
      candidate: input.candidate,
      fixtures: input.fixtures,
    });
  }
  return Object.fromEntries(
    RELEASE_GATE_ASSERTIONS[input.gate].map((assertion) => [assertion, true]),
  ) as Record<string, true>;
}

function gateSourceTimestamps(gate: ReleaseGateName, sourcesValue: unknown): string[] {
  const sources = asRecord(sourcesValue, `release gate ${gate} sources`);
  if (gate === "offline_suite") {
    return [timestamp(asRecord(sources.offlineSuite, "offline suite").completedAt, "offline suite completedAt")];
  }
  if (gate === "staging_provider_manifest") {
    const report = asRecord(sources.manifestCanary, "manifest canary report");
    return [timestamp(
      asRecord(report.evidence, "manifest canary evidence").completedAt,
      "manifest canary completedAt",
    )];
  }
  if (gate === "staging_historical_replay") {
    const envelope = asRecord(
      sources.historicalReplay,
      "historical replay signed evidence",
    );
    return [timestamp(
      asRecord(
        envelope.payload,
        "historical replay evidence payload",
      ).generatedAt,
      "historical replay generatedAt",
    )];
  }
  if (gate === "semantic_ranking_blinded_review") {
    return [timestamp(
      asRecord(sources.reviewArtifact, "semantic review artifact").reviewedAt,
      "semantic review reviewedAt",
    )];
  }
  if (
    gate === "backend_release_convergence"
    || gate === "release_convergence"
  ) {
    return [timestamp(
      asRecord(sources.convergence, "release convergence evidence").generatedAt,
      "release convergence generatedAt",
    )];
  }
  if (gate === "final_custom_domain_browser") {
    const sitesControlPlane = asRecord(
      sources.sitesControlPlane,
      "Sites control-plane evidence",
    );
    const rollbackTarget = asRecord(
      sitesControlPlane.rollbackTarget,
      "Sites production rollback target",
    );
    return [
      timestamp(
        asRecord(sources.browser, "final browser evidence").observedAt,
        "final browser observedAt",
      ),
      timestamp(
        sitesControlPlane.observedAt,
        "Sites control-plane observedAt",
      ),
      timestamp(
        sitesControlPlane.deploymentRequestedAt,
        "Sites control-plane deploymentRequestedAt",
      ),
      timestamp(
        rollbackTarget.capturedAt,
        "Sites rollback target capturedAt",
      ),
      timestamp(
        asRecord(
          asRecord(
            sources.sitesControlPlaneAttestation,
            "Sites control-plane attestation",
          ).payload,
          "Sites control-plane attestation payload",
        ).generatedAt,
        "Sites control-plane attestation generatedAt",
      ),
      timestamp(
        asRecord(
          sources.sitesControlPlaneTrust,
          "Sites control-plane trust verification",
        ).verifiedAt,
        "Sites control-plane trust verifiedAt",
      ),
    ];
  }
  return [timestamp(
    asRecord(sources.independentApple, "independent Apple evidence").observedAt,
    "independent Apple observedAt",
  )];
}

export function createOfflineReleaseGateArtifact(input: {
  candidate: ReleaseGateCandidateBindingV1;
  completedAt: string;
  workflow: {
    repository: string;
    runId: string;
    runAttempt: string;
    sha: string;
    refName: string;
  };
}): ReleaseGateArtifactV1 {
  const sourceUnsigned = {
    schemaVersion: "genio-release-offline-suite/v2",
    candidateTag: input.candidate.tag,
    sourceRevision: input.candidate.sourceRevision,
    imageDigest: input.candidate.imageDigest,
    completedAt: input.completedAt,
    workflow: {
      provider: "github_actions",
      repository: input.workflow.repository,
      workflow: "release-candidate.yml",
      runId: input.workflow.runId,
      runAttempt: input.workflow.runAttempt,
      sha: input.workflow.sha,
      refName: input.workflow.refName,
    },
    checks: {
      releaseMetadata: true,
      lint: true,
      build: true,
      fixtureContract: true,
      policy: true,
      database: true,
      unitAndIntegration: true,
      browser: true,
      stitchedSystemBrowser: true,
    },
  };
  const offlineSuite = {
    ...sourceUnsigned,
    evidenceHash: releaseFixtureSha256(sourceUnsigned),
  };
  return createReleaseGateArtifactFromSources({
    gate: "offline_suite",
    completedAt: input.completedAt,
    candidate: input.candidate,
    configurationHash: releaseFixtureSha256({
      kind: "offline-build-configuration",
      sourceRevision: input.candidate.sourceRevision,
      imageDigest: input.candidate.imageDigest,
    }),
    runtimeHash: releaseFixtureSha256({
      kind: "offline-release-contract",
      databaseCapabilityVersion: "2",
      releaseManifestCanaryGuardsVersion: "1",
      canonicalExecutionHardeningVersion: "1",
      databaseSchemaVersion: "20",
      proofArchitectureMode: "native",
      proofArchitectureVersion: "1",
      proofArchitectureAuthority: "native",
      workerProtocol: "playlist-pipeline-v12",
      briefContractVersion: "3",
      queryPlanSchemaVersion: "6",
    }),
    fixtures: [],
    sources: { offlineSuite },
  });
}

export function createReleaseGateArtifactFromSources(input: {
  gate: ReleaseGateName;
  completedAt: string;
  candidate: ReleaseGateCandidateBindingV1;
  configurationHash: string;
  runtimeHash: string;
  fixtures: ReleaseFixtureBindingV1[];
  sources: Record<string, unknown>;
}): ReleaseGateArtifactV1 {
  const environment = RELEASE_GATE_ENVIRONMENTS[input.gate];
  const generatedAt = input.completedAt;
  validateReleaseFixtureBindingsForGate(input.gate, input.fixtures);
  const assertions = deriveGateAssertions({
    ...input,
    completedAt: input.completedAt,
    configurationHash: input.configurationHash,
    runtimeHash: input.runtimeHash,
  });
  const proofUnsigned = {
    schemaVersion: RELEASE_GATE_PROOF_SCHEMA_V1,
    generatedAt,
    passed: true as const,
    assertions,
  };
  const proof: ReleaseGateProofV1 = {
    ...proofUnsigned,
    proofHash: releaseFixtureSha256(proofUnsigned),
  };
  const unsigned = {
    schemaVersion: RELEASE_GATE_ARTIFACT_SCHEMA_V1,
    gate: input.gate,
    environment,
    completedAt: input.completedAt,
    candidate: input.candidate,
    configurationHash: input.configurationHash,
    runtimeHash: input.runtimeHash,
    cacheMode: environment === "offline"
      ? "not_applicable" as const
      : "reuse_disabled" as const,
    budgetStatus: environment === "staging"
      ? "within_cap" as const
      : "not_applicable" as const,
    fixtures: input.fixtures,
    sources: input.sources,
    proof,
  };
  return {
    ...unsigned,
    evidenceHash: releaseFixtureSha256(unsigned),
  };
}

export function validateReleaseGateArtifact(value: unknown): ReleaseGateArtifactV1 {
  const artifact = asRecord(value, "release gate artifact");
  exactKeys(artifact, [
    "schemaVersion",
    "gate",
    "environment",
    "completedAt",
    "candidate",
    "configurationHash",
    "runtimeHash",
    "cacheMode",
    "budgetStatus",
    "fixtures",
    "sources",
    "proof",
    "evidenceHash",
  ], "release gate artifact");
  if (artifact.schemaVersion !== RELEASE_GATE_ARTIFACT_SCHEMA_V1) {
    throw new Error("release gate artifact uses an unsupported schema");
  }
  if (typeof artifact.gate !== "string" || !(artifact.gate in RELEASE_GATE_ENVIRONMENTS)) {
    throw new Error("release gate artifact has an unapproved gate");
  }
  const gate = artifact.gate as ReleaseGateName;
  const environment = RELEASE_GATE_ENVIRONMENTS[gate];
  if (artifact.environment !== environment) {
    throw new Error(`release gate ${gate} has the wrong environment`);
  }
  timestamp(artifact.completedAt, "release gate completedAt");
  candidateBinding(artifact.candidate);
  digest(artifact.configurationHash, "release gate configurationHash");
  digest(artifact.runtimeHash, "release gate runtimeHash");
  const expectedCacheMode = environment === "offline"
    ? "not_applicable"
    : "reuse_disabled";
  if (artifact.cacheMode !== expectedCacheMode) {
    throw new Error(`release gate ${gate} does not prove result reuse was disabled`);
  }
  const expectedBudgetStatus = environment === "staging"
    ? "within_cap"
    : "not_applicable";
  if (artifact.budgetStatus !== expectedBudgetStatus) {
    throw new Error(`release gate ${gate} does not prove the required QA budget state`);
  }
  const fixtures = validateReleaseFixtureBindingsForGate(gate, artifact.fixtures);
  const candidate = candidateBinding(artifact.candidate);
  const derivedAssertions = deriveGateAssertions({
    gate,
    candidate,
    completedAt: String(artifact.completedAt),
    configurationHash: String(artifact.configurationHash),
    runtimeHash: String(artifact.runtimeHash),
    fixtures,
    sources: artifact.sources,
  });
  const completedMs = Date.parse(String(artifact.completedAt));
  for (const sourceTimestamp of gateSourceTimestamps(gate, artifact.sources)) {
    const sourceMs = Date.parse(sourceTimestamp);
    if (sourceMs > completedMs + 5 * 60_000
      || completedMs - sourceMs > 24 * 60 * 60_000) {
      throw new Error(`release gate ${gate} source evidence is outside the gate time window`);
    }
  }

  const proof = asRecord(artifact.proof, "release gate proof");
  exactKeys(proof, [
    "schemaVersion",
    "generatedAt",
    "passed",
    "assertions",
    "proofHash",
  ], "release gate proof");
  if (proof.schemaVersion !== RELEASE_GATE_PROOF_SCHEMA_V1 || proof.passed !== true) {
    throw new Error(`release gate ${gate} proof did not pass`);
  }
  if (timestamp(proof.generatedAt, "release gate proof generatedAt") !== artifact.completedAt) {
    throw new Error(`release gate ${gate} proof timestamp does not match its envelope`);
  }
  const assertions = asRecord(proof.assertions, "release gate assertions");
  exactKeys(assertions, RELEASE_GATE_ASSERTIONS[gate], "release gate assertions");
  if (Object.values(assertions).some((outcome) => outcome !== true)) {
    throw new Error(`release gate ${gate} has an unsuccessful assertion`);
  }
  if (stableReleaseFixtureJson(assertions) !== stableReleaseFixtureJson(derivedAssertions)) {
    throw new Error(`release gate ${gate} assertions were not derived from source evidence`);
  }
  const proofUnsigned = {
    schemaVersion: proof.schemaVersion,
    generatedAt: proof.generatedAt,
    passed: proof.passed,
    assertions: proof.assertions,
  };
  if (digest(proof.proofHash, "release gate proofHash")
    !== releaseFixtureSha256(proofUnsigned)) {
    throw new Error(`release gate ${gate} proof hash does not match its typed contents`);
  }
  const unsigned = {
    schemaVersion: artifact.schemaVersion,
    gate: artifact.gate,
    environment: artifact.environment,
    completedAt: artifact.completedAt,
    candidate: artifact.candidate,
    configurationHash: artifact.configurationHash,
    runtimeHash: artifact.runtimeHash,
    cacheMode: artifact.cacheMode,
    budgetStatus: artifact.budgetStatus,
    fixtures: artifact.fixtures,
    sources: artifact.sources,
    proof: artifact.proof,
  };
  if (digest(artifact.evidenceHash, "release gate evidenceHash")
    !== releaseFixtureSha256(unsigned)) {
    throw new Error(`release gate ${gate} evidence hash does not match its typed contents`);
  }
  return artifact as unknown as ReleaseGateArtifactV1;
}

function producerAttestationMaterial(
  gate: ReleaseGateName,
  evidenceHash: string,
  keyId: string,
): string {
  return stableReleaseFixtureJson({
    schemaVersion: "genio-release-gate-producer-attestation/v1",
    gate,
    evidenceHash,
    keyId,
  });
}

function producerKeyId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._:-]{2,79}$/u.test(value)) {
    throw new Error("release gate producer key ID is invalid");
  }
  return value;
}

export function attestReleaseGateArtifact(
  artifactValue: unknown,
  signingKey: string | Buffer | KeyObject,
  keyIdValue: string,
): ReleaseGateProducerAttestationV1 {
  const artifact = validateReleaseGateArtifact(artifactValue);
  const keyId = producerKeyId(keyIdValue);
  return {
    schemaVersion: "genio-release-gate-producer-attestation/v1",
    gate: artifact.gate,
    evidenceHash: artifact.evidenceHash,
    signature: {
      algorithm: "Ed25519",
      keyId,
      value: sign(
        null,
        Buffer.from(producerAttestationMaterial(artifact.gate, artifact.evidenceHash, keyId)),
        signingKey instanceof KeyObject ? signingKey : createPrivateKey(signingKey),
      ).toString("base64url"),
    },
  };
}

export function verifyReleaseGateProducerAttestation(
  value: unknown,
  artifact: ReleaseGateArtifactV1,
  verificationKey: string | Buffer | KeyObject,
): ReleaseGateProducerAttestationV1 {
  const root = asRecord(value, "release gate producer attestation");
  exactKeys(
    root,
    ["schemaVersion", "gate", "evidenceHash", "signature"],
    "release gate producer attestation",
  );
  if (
    root.schemaVersion !== "genio-release-gate-producer-attestation/v1"
    || root.gate !== artifact.gate
    || root.evidenceHash !== artifact.evidenceHash
  ) throw new Error("release gate producer attestation does not bind the gate artifact");
  const signature = asRecord(root.signature, "release gate producer signature");
  exactKeys(signature, ["algorithm", "keyId", "value"], "release gate producer signature");
  const keyId = producerKeyId(signature.keyId);
  if (signature.algorithm !== "Ed25519"
    || typeof signature.value !== "string"
    || !/^[0-9A-Za-z_-]{64,256}$/u.test(signature.value)
    || !verify(
      null,
      Buffer.from(producerAttestationMaterial(artifact.gate, artifact.evidenceHash, keyId)),
      verificationKey instanceof KeyObject ? verificationKey : createPublicKey(verificationKey),
      Buffer.from(signature.value, "base64url"),
    )) {
    throw new Error("release gate producer attestation signature is invalid");
  }
  return root as unknown as ReleaseGateProducerAttestationV1;
}

function cliOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "offline") {
    throw new Error(
      "Usage: release-fixtures offline --candidate-tag vX.Y.Z-rc.N "
      + "--source-revision <sha> --image-digest sha256:<digest> --output <json>",
    );
  }
  const tag = cliOption(args, "--candidate-tag");
  const versionMatch = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-rc\.[1-9]\d*$/u
    .exec(tag);
  if (!versionMatch) throw new Error("--candidate-tag is not an RC tag");
  const sourceRevision = cliOption(args, "--source-revision").toLowerCase();
  const imageDigest = cliOption(args, "--image-digest").toLowerCase();
  const output = cliOption(args, "--output");
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("offline release evidence must be produced by the trusted GitHub Actions workflow");
  }
  const candidate: ReleaseGateCandidateBindingV1 = {
    tag,
    version: versionMatch[1]!,
    sourceRevision,
    imageDigest,
    sitesSourceRevision: sourceRevision,
  };
  candidateBinding(candidate);
  const artifact = createOfflineReleaseGateArtifact({
    candidate,
    completedAt: new Date().toISOString(),
    workflow: {
      repository: process.env.GITHUB_REPOSITORY ?? "",
      runId: process.env.GITHUB_RUN_ID ?? "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
      sha: process.env.RELEASE_WORKFLOW_CANDIDATE_SHA ?? "",
      refName: process.env.RELEASE_WORKFLOW_CANDIDATE_REF_NAME ?? "",
    },
  });
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    gate: artifact.gate,
    evidenceHash: artifact.evidenceHash,
    output,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "release_fixture_failed",
      message: error instanceof Error ? error.message : "Release fixture command failed",
    })}\n`);
    process.exitCode = 1;
  });
}
