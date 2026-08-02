import { createHash } from "node:crypto";
import pg from "pg";
import {
  createLegacyRepairAuthorityV1,
  LEGACY_REPAIR_AUTHORITY_PHASE_V1,
  parseLegacyRepairAuthorityV1,
  validateLegacyRepairAuthorityFenceV1,
  type LegacyRepairAuthorityV1,
  type ObservedLegacyRepairFenceV1,
} from "../server/legacy-repair-authority-v1.ts";
import { stableStringify } from "../server/security.ts";
import {
  requireV254IrishInfluenceProtectedBinding,
  V254_IRISH_INFLUENCE_INCIDENT_BINDING,
} from "./v254-irish-influence-protected-binding.ts";

type Mode = "dry-run" | "apply";

const INCIDENT = Object.freeze({
  runId: V254_IRISH_INFLUENCE_INCIDENT_BINDING.runId,
  accessId: V254_IRISH_INFLUENCE_INCIDENT_BINDING.accessId,
  briefRequestId: V254_IRISH_INFLUENCE_INCIDENT_BINDING.briefRequestId,
  resolutionGeneration: 4,
  incidentReference: "v254-irish-influence-evidence-persistence",
  contractRevisionId:
    V254_IRISH_INFLUENCE_INCIDENT_BINDING.contractRevisionId,
  contractSemanticHash:
    "171be48c5ff9e2cf264d039ace1b8f8656f62bc7f518666f93c84fcda048f5a7",
  queryPlanRevisionId:
    V254_IRISH_INFLUENCE_INCIDENT_BINDING.queryPlanRevisionId,
  queryPlanHash:
    "f498a3957af9f7b093457020540cc390295a4ef80b9d41d7ba9a1a1f200affc9",
  queryPlanSchema: 6,
  sourceJobId: V254_IRISH_INFLUENCE_INCIDENT_BINDING.sourceJobId,
  sourceReleaseRevision: "c5d76e9e84b6982826fcce462b049d3c05925f3b",
  sourceSemanticConfigurationHash:
    "3cad6fd7dd046292c5f19d2e19eff41422e3c5e1288639f6545ca4e7a04fa922",
});

const LOCK_KEY = "v254-legacy-repair-authority-v1";
const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

interface Options {
  mode: Mode;
  targetRevision: string;
  targetSemanticConfigurationHash: string;
  authorizedBySubjectHash: string;
  expectedPreflightHash: string | null;
}

interface SnapshotRow {
  run_id: string;
  access_id: string;
  brief_request_id: string;
  run_status: string;
  run_phase: string;
  pipeline_version: string;
  brief_contract_version: number;
  resolution_generation: number;
  resolution_state: string;
  incident_reference: string | null;
  containment_receipt_hash: string | null;
  contract_revision_id: string;
  contract_status: string;
  contract_hash: string;
  contract_semantic_hash: string | null;
  query_plan_revision_id: string;
  query_plan_hash: string;
  query_plan_schema: string | number | null;
  source_job_id: string;
  source_job_status: string;
  source_job_revision: string | null;
  source_job_semantic_configuration_hash: string | null;
  source_public_assignment_present: boolean;
  source_route_receipt_present: boolean;
  source_release_canary_marker_present: boolean;
  active_executable_job_count: number;
  apple_side_effect_count: number;
  has_published_reconciliation: boolean;
  route_hard_disabled: boolean;
  existing_authority: unknown | null;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function option(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0 || index === argv.length - 1) return null;
  return argv[index + 1]?.trim() || null;
}

function options(argv: readonly string[]): Options {
  const mode = argv[2];
  if (mode !== "dry-run" && mode !== "apply") {
    throw new Error("legacy_repair_authority_usage_invalid");
  }
  const targetRevision = option(argv, "--target-revision")?.toLowerCase()
    ?? "";
  const targetSemanticConfigurationHash = option(
    argv,
    "--target-semantic-configuration-hash",
  )?.toLowerCase() ?? "";
  const authorizedBySubjectHash = option(
    argv,
    "--authorized-by-subject-hash",
  )?.toLowerCase() ?? "";
  const expectedPreflightHash = option(
    argv,
    "--expected-preflight-hash",
  )?.toLowerCase() ?? null;
  if (
    !REVISION.test(targetRevision)
    || !SHA256.test(targetSemanticConfigurationHash)
    || !SHA256.test(authorizedBySubjectHash)
    || (mode === "apply" && !expectedPreflightHash)
    || (expectedPreflightHash !== null && !SHA256.test(expectedPreflightHash))
  ) {
    throw new Error("legacy_repair_authority_options_invalid");
  }
  return {
    mode,
    targetRevision,
    targetSemanticConfigurationHash,
    authorizedBySubjectHash,
    expectedPreflightHash,
  };
}

function databaseUrl(): string {
  const value = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
  if (!value) throw new Error("database_url_missing");
  return value;
}

async function snapshot(
  client: pg.Client,
  lock: boolean,
): Promise<SnapshotRow> {
  const lockClause = lock
    ? " FOR UPDATE OF run,resolution,contract,plan,access,brief,source_job"
    : "";
  const result = await client.query<SnapshotRow>(
    `SELECT run.id run_id,access.id access_id,
            brief.id brief_request_id,run.status run_status,
            run.phase run_phase,run.pipeline_version,
            run.brief_contract_version,
            resolution.generation resolution_generation,
            resolution.state resolution_state,
            resolution.incident_reference,
            resolution.state_json->>'containmentReceiptHash'
              containment_receipt_hash,
            contract.id contract_revision_id,
            contract.status contract_status,
            contract.contract_hash,
            contract.contract_json->>'semanticHash' contract_semantic_hash,
            plan.id query_plan_revision_id,plan.plan_hash query_plan_hash,
            plan.plan_json->>'schemaVersion' query_plan_schema,
            source_job.id source_job_id,source_job.status source_job_status,
            source_job.required_executor_revision source_job_revision,
            source_job.required_executor_semantic_configuration_hash
              source_job_semantic_configuration_hash,
            (brief.public_rollout_assignment_json IS NOT NULL)
              source_public_assignment_present,
            EXISTS(
              SELECT 1 FROM research_checkpoints route
              WHERE route.run_id=run.id
                AND route.phase='execution_route_receipt_v1'
            ) source_route_receipt_present,
            EXISTS(
              SELECT 1 FROM release_canary_markers marker
              WHERE marker.run_id=run.id OR marker.brief_request_id=brief.id
            ) source_release_canary_marker_present,
            (SELECT count(*)::int FROM job_queue active_job
             WHERE active_job.run_id=run.id
               AND active_job.status IN ('queued','leased'))
              active_executable_job_count,
            (
              (SELECT count(*)::int
               FROM playlist_publication_reconciliations reconciliation
               WHERE reconciliation.run_id=run.id
                 AND (
                   reconciliation.apple_playlist_id IS NOT NULL
                   OR reconciliation.appended_count>0
                 ))
              +
              (SELECT count(*)::int FROM publication_volumes volume
               JOIN manifests manifest ON manifest.id=volume.manifest_id
               WHERE manifest.run_id=run.id
                 AND (
                   volume.apple_playlist_id IS NOT NULL
                   OR volume.apple_share_url IS NOT NULL
                   OR volume.appended_count>0
                 ))
            ) apple_side_effect_count,
            EXISTS(
              SELECT 1
              FROM playlist_publication_reconciliations reconciliation
              WHERE reconciliation.run_id=run.id
                AND reconciliation.state='complete'
            ) has_published_reconciliation,
            EXISTS(
              SELECT 1 FROM pipeline_cohort_kill_switches hard_switch
              WHERE hard_switch.route='corpus_first_v3'
                AND hard_switch.intent_group='editorial_influence'
                AND hard_switch.disabled
            ) route_hard_disabled,
            (
              SELECT checkpoint.state_json
              FROM research_checkpoints checkpoint
              WHERE checkpoint.run_id=run.id AND checkpoint.phase=$7
            ) existing_authority
     FROM research_runs run
     JOIN run_accesses access
       ON access.run_id=run.id AND access.id=$2
     JOIN brief_requests brief
       ON brief.id=access.brief_request_id AND brief.id=$3
     JOIN playlist_run_resolutions resolution ON resolution.run_id=run.id
     JOIN playlist_contract_revisions contract
       ON contract.id=run.active_playlist_contract_revision_id
      AND contract.id=$4
     JOIN run_active_query_plans active_plan ON active_plan.run_id=run.id
     JOIN query_plan_revisions plan
       ON plan.id=active_plan.query_plan_revision_id AND plan.id=$5
     JOIN job_queue source_job
       ON source_job.run_id=run.id AND source_job.id=$6
     WHERE run.id=$1${lockClause}`,
    [
      INCIDENT.runId,
      INCIDENT.accessId,
      INCIDENT.briefRequestId,
      INCIDENT.contractRevisionId,
      INCIDENT.queryPlanRevisionId,
      INCIDENT.sourceJobId,
      LEGACY_REPAIR_AUTHORITY_PHASE_V1,
    ],
  );
  if (result.rowCount !== 1 || !result.rows[0]) {
    throw new Error("legacy_repair_source_fence_missing");
  }
  return result.rows[0];
}

function observedFence(
  row: SnapshotRow,
  input: Options,
): ObservedLegacyRepairFenceV1 {
  return {
    sourceRunId: row.run_id,
    sourceAccessId: row.access_id,
    sourceBriefRequestId: row.brief_request_id,
    sourceResolutionGeneration: Number(row.resolution_generation),
    sourceResolutionState: row.resolution_state,
    sourceRunStatus: row.run_status,
    sourceRunPhase: row.run_phase,
    incidentReference: row.incident_reference ?? "",
    sourceContractRevisionId: row.contract_revision_id,
    sourceContractSemanticHash: row.contract_hash,
    sourceContractStatus: row.contract_status,
    sourceQueryPlanRevisionId: row.query_plan_revision_id,
    sourceQueryPlanHash: row.query_plan_hash,
    sourceQueryPlanSchema: Number(row.query_plan_schema),
    sourceExecutionRoute: row.pipeline_version,
    sourceReleaseRevision: row.source_job_revision ?? "",
    sourceExecutorSemanticConfigurationHash:
      row.source_job_semantic_configuration_hash ?? "",
    sourcePublicAssignmentPresent: row.source_public_assignment_present,
    sourceRouteReceiptPresent: row.source_route_receipt_present,
    sourceReleaseCanaryMarkerPresent:
      row.source_release_canary_marker_present,
    containmentReceiptHash: row.containment_receipt_hash ?? "",
    activeRepairReleaseRevision: input.targetRevision,
    activeRepairExecutorSemanticConfigurationHash:
      input.targetSemanticConfigurationHash,
    activeExecutableJobCount: Number(row.active_executable_job_count),
    appleSideEffectCount: Number(row.apple_side_effect_count),
    hasPublishedReconciliation: row.has_published_reconciliation,
  };
}

function preflight(row: SnapshotRow, input: Options) {
  const violations: string[] = [];
  if (
    row.run_id !== INCIDENT.runId
    || row.access_id !== INCIDENT.accessId
    || row.brief_request_id !== INCIDENT.briefRequestId
    || row.run_status !== "failed_integrity"
    || row.run_phase !== "v254_evidence_persistence_quarantined"
    || row.pipeline_version !== "corpus_first_v3"
    || Number(row.brief_contract_version) !== 3
  ) violations.push("source_run_fence_changed");
  if (
    Number(row.resolution_generation) !== INCIDENT.resolutionGeneration
    || row.resolution_state !== "quarantined"
    || row.incident_reference !== INCIDENT.incidentReference
    || !SHA256.test(row.containment_receipt_hash ?? "")
  ) violations.push("source_resolution_fence_changed");
  if (
    row.contract_revision_id !== INCIDENT.contractRevisionId
    || row.contract_status !== "active"
    || row.contract_hash !== INCIDENT.contractSemanticHash
    || row.contract_semantic_hash !== INCIDENT.contractSemanticHash
  ) violations.push("source_contract_fence_changed");
  if (
    row.query_plan_revision_id !== INCIDENT.queryPlanRevisionId
    || row.query_plan_hash !== INCIDENT.queryPlanHash
    || Number(row.query_plan_schema) !== INCIDENT.queryPlanSchema
  ) violations.push("source_query_plan_fence_changed");
  if (
    row.source_job_id !== INCIDENT.sourceJobId
    || row.source_job_status !== "complete"
    || row.source_job_revision !== INCIDENT.sourceReleaseRevision
    || row.source_job_semantic_configuration_hash
      !== INCIDENT.sourceSemanticConfigurationHash
  ) violations.push("source_executor_fence_changed");
  if (
    row.source_public_assignment_present
    || row.source_route_receipt_present
    || row.source_release_canary_marker_present
  ) violations.push("historical_authority_state_changed");
  if (
    Number(row.active_executable_job_count) !== 0
    || Number(row.apple_side_effect_count) !== 0
    || row.has_published_reconciliation
  ) violations.push("source_has_active_work_or_apple_side_effect");
  if (!row.route_hard_disabled) {
    violations.push("editorial_influence_hard_switch_not_engaged");
  }

  const existing = row.existing_authority === null
    ? null
    : parseLegacyRepairAuthorityV1(row.existing_authority);
  if (row.existing_authority !== null && !existing) {
    violations.push("existing_authority_invalid");
  }
  if (existing) {
    const decision = validateLegacyRepairAuthorityFenceV1({
      authority: existing,
      observed: observedFence(row, input),
      now: new Date().toISOString(),
    });
    if (!decision.eligible) violations.push(decision.reasonCode);
    if (existing.authorizedBySubjectHash !== input.authorizedBySubjectHash) {
      violations.push("existing_authorizer_changed");
    }
  }

  const receipt = {
    version: "v254-legacy-repair-authority-preflight/v1",
    source: INCIDENT,
    observed: {
      runStatus: row.run_status,
      runPhase: row.run_phase,
      resolutionGeneration: Number(row.resolution_generation),
      resolutionState: row.resolution_state,
      contractHash: row.contract_hash,
      queryPlanHash: row.query_plan_hash,
      sourceJobRevision: row.source_job_revision,
      sourceJobSemanticConfigurationHash:
        row.source_job_semantic_configuration_hash,
      historicalAssignmentPresent: row.source_public_assignment_present,
      historicalRouteReceiptPresent: row.source_route_receipt_present,
      historicalCanaryPresent: row.source_release_canary_marker_present,
      activeExecutableJobCount: Number(row.active_executable_job_count),
      appleSideEffectCount: Number(row.apple_side_effect_count),
      hasPublishedReconciliation: row.has_published_reconciliation,
      routeHardDisabled: row.route_hard_disabled,
    },
    target: {
      releaseRevision: input.targetRevision,
      semanticConfigurationHash: input.targetSemanticConfigurationHash,
      guidanceVersion: "adaptive_guidance_v5",
      successorKind: "v5_1_planning_successor",
      trafficClass: "replay",
      route: "corpus_first_v3",
      intentGroup: "editorial_influence",
      authorizedBySubjectHash: input.authorizedBySubjectHash,
    },
    violations: [...violations].sort(),
  };
  return {
    safeToApply: violations.length === 0,
    violations,
    preflightHash: sha256(receipt),
    existing,
  };
}

function authority(
  row: SnapshotRow,
  input: Options,
  authorizedAt: Date,
): LegacyRepairAuthorityV1 {
  return createLegacyRepairAuthorityV1({
    version: "legacy_repair_authority_v1",
    provenanceKind: "forward_owner_repair_not_historical_admission",
    authorizationKind: "authenticated_owner_control_plane",
    sourceRunId: row.run_id,
    sourceAccessId: row.access_id,
    sourceBriefRequestId: row.brief_request_id,
    sourceResolutionGeneration: Number(row.resolution_generation),
    sourceResolutionState: "quarantined",
    sourceRunStatus: "failed_integrity",
    sourceRunPhase: "v254_evidence_persistence_quarantined",
    incidentReference: row.incident_reference!,
    sourceContractRevisionId: row.contract_revision_id,
    sourceContractSemanticHash: row.contract_hash,
    sourceContractStatus: "active",
    sourceQueryPlanRevisionId: row.query_plan_revision_id,
    sourceQueryPlanHash: row.query_plan_hash,
    sourceQueryPlanSchema: Number(row.query_plan_schema),
    sourceExecutionRoute: "corpus_first_v3",
    sourceReleaseRevision: row.source_job_revision!,
    sourceExecutorSemanticConfigurationHash:
      row.source_job_semantic_configuration_hash!,
    sourcePublicAssignmentPresent: false,
    sourceRouteReceiptPresent: false,
    sourceReleaseCanaryMarkerPresent: false,
    containmentReceiptHash: row.containment_receipt_hash!,
    targetTrafficClass: "replay",
    targetSuccessorKind: "v5_1_planning_successor",
    targetGuidanceVersion: "adaptive_guidance_v5",
    targetExecutionRoute: "corpus_first_v3",
    targetIntentGroup: "editorial_influence",
    repairReleaseRevision: input.targetRevision,
    repairExecutorSemanticConfigurationHash:
      input.targetSemanticConfigurationHash,
    resultReuse: false,
    autoPublication: false,
    maximumUses: 1,
    authorizedBySubjectHash: input.authorizedBySubjectHash,
    authorizedAt: authorizedAt.toISOString(),
    expiresAt: new Date(
      authorizedAt.getTime() + 24 * 60 * 60 * 1_000,
    ).toISOString(),
  });
}

async function run(input: Options) {
  const client = new pg.Client({
    connectionString: databaseUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      LOCK_KEY,
    ]);
    const row = await snapshot(client, input.mode === "apply");
    const checked = preflight(row, input);
    if (!checked.safeToApply) {
      throw new Error("legacy_repair_authority_preflight_failed");
    }
    if (input.mode === "dry-run") {
      await client.query("ROLLBACK");
      return {
        mode: input.mode,
        safeToApply: true,
        preflightHash: checked.preflightHash,
        checkpointPresent: checked.existing !== null,
      };
    }
    if (input.expectedPreflightHash !== checked.preflightHash) {
      throw new Error("legacy_repair_authority_preflight_hash_mismatch");
    }
    if (checked.existing) {
      await client.query("COMMIT");
      return {
        mode: input.mode,
        applied: false,
        checkpointPresent: true,
      };
    }
    const created = authority(row, input, new Date());
    const inserted = await client.query(
      `INSERT INTO research_checkpoints(run_id,phase,state_json)
       VALUES($1,$2,$3::jsonb)
       ON CONFLICT(run_id,phase) DO NOTHING
       RETURNING run_id`,
      [
        INCIDENT.runId,
        LEGACY_REPAIR_AUTHORITY_PHASE_V1,
        JSON.stringify(created),
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new Error("legacy_repair_authority_concurrent_conflict");
    }
    await client.query(
      `INSERT INTO audit_events(run_id,actor,action,detail_json)
       VALUES($1,'authenticated_owner_control_plane',
         'run.legacy_repair_authorized',$2::jsonb)`,
      [
        INCIDENT.runId,
        JSON.stringify({
          version: created.version,
          authorityHash: created.authorityHash,
          containmentReceiptHash: created.containmentReceiptHash,
          repairReleaseRevision: created.repairReleaseRevision,
          targetSuccessorKind: created.targetSuccessorKind,
          resultReuse: false,
          autoPublication: false,
        }),
      ],
    );
    await client.query("COMMIT");
    return {
      mode: input.mode,
      applied: true,
      checkpointPresent: true,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

try {
  requireV254IrishInfluenceProtectedBinding();
  const result = await run(options(process.argv));
  // Authority contents, owner identity, and source identifiers are never
  // emitted. The dry-run hash is only a compare-and-swap preflight receipt.
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const code = error instanceof Error
    && /^[0-9A-Za-z_:-]{1,160}$/u.test(error.message)
    ? error.message
    : "legacy_repair_authority_failed";
  console.error(code);
  process.exitCode = 1;
}
