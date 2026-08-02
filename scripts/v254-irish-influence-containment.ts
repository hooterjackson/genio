import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  requireV254IrishInfluenceProtectedBinding,
  V254_IRISH_INFLUENCE_INCIDENT_BINDING,
} from "./v254-irish-influence-protected-binding.ts";

type Mode = "status" | "pause" | "contain-dry-run" | "contain-apply";

const INCIDENT = Object.freeze({
  accessId: V254_IRISH_INFLUENCE_INCIDENT_BINDING.accessId,
  runId: V254_IRISH_INFLUENCE_INCIDENT_BINDING.runId,
  contractRevisionId:
    V254_IRISH_INFLUENCE_INCIDENT_BINDING.contractRevisionId,
  queryPlanRevisionId:
    V254_IRISH_INFLUENCE_INCIDENT_BINDING.queryPlanRevisionId,
  executionAttemptId:
    V254_IRISH_INFLUENCE_INCIDENT_BINDING.executionAttemptId,
  blockerId: V254_IRISH_INFLUENCE_INCIDENT_BINDING.blockerId,
  resolutionGeneration: 3,
  observationCount: 77,
  nullCandidateCount: 77,
  candidateCount: 0,
  manifestCount: 0,
  reconciliationCount: 0,
  activeJobCount: 0,
  releaseRevision: "c5d76e9e84b6982826fcce462b049d3c05925f3b",
  semanticConfigurationHash:
    "3cad6fd7dd046292c5f19d2e19eff41422e3c5e1288639f6545ca4e7a04fa922",
});

const INCIDENT_REFERENCE = "v254-irish-influence-evidence-persistence";
const LOCK_KEY = "v254-irish-influence-containment-v1";
const SHA256 = /^[0-9a-f]{64}$/u;
export const V254_CONTAINMENT_ROUTE = "corpus_first_v3";
export const V254_CONTAINMENT_INTENT = "editorial_influence";

interface AffectedSignatureRow {
  run_id: string;
  run_status: string;
  run_phase: string;
  contract_revision_id: string | null;
  execution_attempt_id: string | null;
  resolution_generation: number;
  resolution_state: string;
  resolution_incident_reference: string | null;
  containment_receipt_hash: string | null;
  active_job_count: number;
  active_publication_job_count: number;
  unresolved_publication_work_count: number;
  reconciliation_count: number;
  apple_side_effect_count: number;
}

interface OwnerReviewDispositionAuditRow {
  run_id: string;
  actor: string;
  detail_json: Record<string, unknown>;
  occurred_at: string;
}

export interface V254OwnerReviewPromotionProofV1 {
  candidateCount: number;
  candidateSetHash: string;
  dispositionCount: number;
  dispositionSetHash: string;
  undispositionedCount: number;
  unresolvedExecutableWorkCount: number;
  unresolvedPublicationWorkCount: number;
  promotionSafe: boolean;
}

const OWNER_REVIEW_DISPOSITION_ACTION =
  "run.v254_owner_review_disposition";
const OWNER_REVIEW_DISPOSITION_SCHEMA =
  "genio-v254-owner-review-disposition/v1";
const OWNER_REVIEW_DISPOSITIONS = new Set([
  "hold_immutable_no_execution",
  "quarantined_separately",
  "cancelled_by_owner",
  "reconciled_completed",
]);

interface ContainmentMutationCountsV1 {
  jobsCancelled: number;
  blockerResolved: number;
  transitionInserted: number;
  resolutionUpdated: number;
  outboxInserted: number;
  runUpdated: number;
  auditInserted: number;
  pausesCleared: number;
}

const FIRST_APPLY_EXPECTED_MUTATIONS = Object.freeze({
  jobsCancelled: INCIDENT.activeJobCount,
  blockerResolved: 1,
  transitionInserted: 1,
  resolutionUpdated: 1,
  outboxInserted: 1,
  runUpdated: 1,
  auditInserted: 1,
  pausesCleared: 2,
} satisfies ContainmentMutationCountsV1);

const IDEMPOTENT_APPLY_EXPECTED_MUTATIONS = Object.freeze({
  jobsCancelled: 0,
  blockerResolved: 0,
  transitionInserted: 0,
  resolutionUpdated: 0,
  outboxInserted: 0,
  runUpdated: 0,
  auditInserted: 0,
  pausesCleared: 2,
} satisfies ContainmentMutationCountsV1);

const DRY_RUN_ACTUAL_MUTATIONS = Object.freeze({
  jobsCancelled: 0,
  blockerResolved: 0,
  transitionInserted: 0,
  resolutionUpdated: 0,
  outboxInserted: 0,
  runUpdated: 0,
  auditInserted: 0,
  pausesCleared: 0,
} satisfies ContainmentMutationCountsV1);

const appleSideEffectCountSql = `
  (
    (SELECT count(*)::int
     FROM playlist_publication_reconciliations reconciliation
     WHERE reconciliation.run_id=run.id
       AND (
         reconciliation.apple_playlist_id IS NOT NULL
         OR reconciliation.appended_count>0
       ))
    +
    (SELECT count(*)::int
     FROM publication_volumes volume
     JOIN manifests manifest ON manifest.id=volume.manifest_id
     WHERE manifest.run_id=run.id
       AND (
         volume.apple_playlist_id IS NOT NULL
         OR volume.apple_share_url IS NOT NULL
         OR volume.appended_count>0
       ))
    +
    (SELECT count(*)::int
     FROM orphan_playlists orphan
     JOIN manifests manifest ON manifest.id=orphan.manifest_id
     WHERE manifest.run_id=run.id
       AND orphan.cleaned_at IS NULL)
  )
`;

function databaseUrl(): string {
  const value = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
  if (!value) throw new Error("database_url_missing");
  return value;
}

function mode(): Mode {
  const value = process.argv[2] ?? "status";
  if (!["status", "pause", "contain-dry-run", "contain-apply"].includes(value)) {
    throw new Error(
      "usage: v254-irish-influence-containment.ts "
      + "[status|pause|contain-dry-run|contain-apply] [receipt-hash]",
    );
  }
  return value as Mode;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

export async function collectV254IrishInfluenceContainmentSnapshot(
  client: pg.Client,
  lock = false,
) {
  const suffix = lock ? " FOR UPDATE" : "";
  const run = await client.query<{
    access_id: string;
    run_id: string;
    status: string;
    phase: string;
    pipeline_version: string;
    active_contract_revision_id: string | null;
  }>(
    `SELECT access.id access_id,run.id run_id,run.status,run.phase,
            run.pipeline_version,
            run.active_playlist_contract_revision_id active_contract_revision_id
     FROM run_accesses access
     JOIN research_runs run ON run.id=access.run_id
     WHERE access.id=$1${suffix}`,
    [INCIDENT.accessId],
  );
  const resolution = await client.query<{
    generation: number;
    state: string;
    next_action: string;
    execution_attempt_id: string | null;
    blocker_id: string | null;
    manifest_id: string | null;
    incident_reference: string | null;
    containment_receipt_hash: string | null;
  }>(
    `SELECT generation,state,next_action,execution_attempt_id,blocker_id,
            manifest_id,incident_reference,
            state_json->>'containmentReceiptHash' containment_receipt_hash
     FROM playlist_run_resolutions
     WHERE run_id=$1${suffix}`,
    [INCIDENT.runId],
  );
  const jobs = await client.query<{
    id: string;
    status: string;
    query_plan_revision_id: string | null;
    required_executor_revision: string | null;
  }>(
    `SELECT id,status,query_plan_revision_id,required_executor_revision
     FROM job_queue
     WHERE run_id=$1 AND status IN ('queued','leased')
     ORDER BY id${suffix}`,
    [INCIDENT.runId],
  );
  const counts = await client.query<{
    observation_count: number;
    null_candidate_count: number;
    candidate_count: number;
    manifest_count: number;
    reconciliation_count: number;
    apple_side_effect_count: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM playlist_qualification_records
        WHERE run_id=$1) observation_count,
       (SELECT count(*)::int FROM playlist_qualification_records
        WHERE run_id=$1 AND candidate_id IS NULL) null_candidate_count,
       (SELECT count(*)::int FROM track_candidates
        WHERE run_id=$1) candidate_count,
       (SELECT count(*)::int FROM manifests
        WHERE run_id=$1) manifest_count,
       (SELECT count(*)::int FROM playlist_publication_reconciliations
        WHERE run_id=$1) reconciliation_count,
       (
         (SELECT count(*)::int FROM playlist_publication_reconciliations
          WHERE run_id=$1
            AND (apple_playlist_id IS NOT NULL OR appended_count>0))
         +
         (SELECT count(*)::int FROM publication_volumes volume
          JOIN manifests manifest ON manifest.id=volume.manifest_id
          WHERE manifest.run_id=$1
            AND (volume.apple_playlist_id IS NOT NULL
              OR volume.apple_share_url IS NOT NULL
              OR volume.appended_count>0))
         +
         (SELECT count(*)::int FROM orphan_playlists orphan
          JOIN manifests manifest ON manifest.id=orphan.manifest_id
          WHERE manifest.run_id=$1
            AND orphan.cleaned_at IS NULL)
       ) apple_side_effect_count`,
    [INCIDENT.runId],
  );
  const sameSignature = await client.query<AffectedSignatureRow>(
    `SELECT run.id run_id,run.status run_status,run.phase run_phase,
            run.active_playlist_contract_revision_id contract_revision_id,
            resolution.execution_attempt_id,
            resolution.generation resolution_generation,
            resolution.state resolution_state,
            resolution.incident_reference resolution_incident_reference,
            resolution.state_json->>'containmentReceiptHash'
              containment_receipt_hash,
            (SELECT count(*)::int FROM job_queue active_job
             WHERE active_job.run_id=run.id
               AND active_job.status IN ('queued','leased'))
              active_job_count,
            (SELECT count(*)::int FROM job_queue active_publication_job
             WHERE active_publication_job.run_id=run.id
               AND active_publication_job.kind='publication'
               AND active_publication_job.status IN ('queued','leased'))
              active_publication_job_count,
            (
              (SELECT count(*)::int
               FROM playlist_publication_reconciliations reconciliation
               WHERE reconciliation.run_id=run.id
                 AND reconciliation.state NOT IN (
                   'complete','cancelled','quarantined'
                 ))
              +
              (SELECT count(*)::int
               FROM publication_volumes volume
               JOIN manifests manifest ON manifest.id=volume.manifest_id
               WHERE manifest.run_id=run.id
                 AND volume.status NOT IN (
                   'complete','cancelled','quarantined'
                 ))
              +
              (SELECT count(*)::int
               FROM orphan_playlists orphan
               JOIN manifests manifest ON manifest.id=orphan.manifest_id
               WHERE manifest.run_id=run.id
                 AND orphan.cleaned_at IS NULL)
            ) unresolved_publication_work_count,
            (SELECT count(*)::int
             FROM playlist_publication_reconciliations reconciliation
             WHERE reconciliation.run_id=run.id) reconciliation_count,
            ${appleSideEffectCountSql} apple_side_effect_count
     FROM research_runs run
     JOIN playlist_run_resolutions resolution ON resolution.run_id=run.id
     JOIN run_active_query_plans active_plan ON active_plan.run_id=run.id
     WHERE run.id=$4
       AND active_plan.query_plan_revision_id=$5
       AND resolution.execution_attempt_id=$6
       AND run.pipeline_version=$1
       AND run.phase IN (
         'capability_evidence_coverage_audit',
         'v254_evidence_persistence_quarantined'
       )
       AND resolution.state NOT IN ('completed','cancelled')
       AND EXISTS (
         SELECT 1 FROM job_queue source_job
         WHERE source_job.run_id=run.id
           AND source_job.required_executor_revision=$2
           AND source_job.required_executor_semantic_configuration_hash=$3
       )
       AND (
         SELECT count(*) FROM playlist_qualification_records qualification
         WHERE qualification.run_id=run.id
       )>=10
       AND NOT EXISTS (
         SELECT 1 FROM playlist_qualification_records qualification
         WHERE qualification.run_id=run.id
           AND qualification.candidate_id IS NOT NULL
       )
       AND NOT EXISTS (
          SELECT 1 FROM track_candidates candidate
          WHERE candidate.run_id=run.id
        )
     ORDER BY run.id${lock ? " FOR UPDATE OF run,resolution" : ""}`,
    [
      V254_CONTAINMENT_ROUTE,
      INCIDENT.releaseRevision,
      INCIDENT.semanticConfigurationHash,
      INCIDENT.runId,
      INCIDENT.queryPlanRevisionId,
      INCIDENT.executionAttemptId,
    ],
  );
  // Historical rows produced before failure fingerprints and route receipts
  // cannot be proven to share this incident's stable defect identity. Keep
  // them in a read-only owner inventory; never auto-cancel or quarantine them.
  const reviewInventory = await client.query<AffectedSignatureRow>(
    `SELECT run.id run_id,run.status run_status,run.phase run_phase,
            run.active_playlist_contract_revision_id contract_revision_id,
            resolution.execution_attempt_id,
            resolution.generation resolution_generation,
            resolution.state resolution_state,
            resolution.incident_reference resolution_incident_reference,
            resolution.state_json->>'containmentReceiptHash'
              containment_receipt_hash,
            (SELECT count(*)::int FROM job_queue active_job
             WHERE active_job.run_id=run.id
               AND active_job.status IN ('queued','leased'))
              active_job_count,
            (SELECT count(*)::int FROM job_queue active_publication_job
             WHERE active_publication_job.run_id=run.id
               AND active_publication_job.kind='publication'
               AND active_publication_job.status IN ('queued','leased'))
              active_publication_job_count,
            (
              (SELECT count(*)::int
               FROM playlist_publication_reconciliations reconciliation
               WHERE reconciliation.run_id=run.id
                 AND reconciliation.state NOT IN (
                   'complete','cancelled','quarantined'
                 ))
              +
              (SELECT count(*)::int
               FROM publication_volumes volume
               JOIN manifests manifest ON manifest.id=volume.manifest_id
               WHERE manifest.run_id=run.id
                 AND volume.status NOT IN (
                   'complete','cancelled','quarantined'
                 ))
              +
              (SELECT count(*)::int
               FROM orphan_playlists orphan
               JOIN manifests manifest ON manifest.id=orphan.manifest_id
               WHERE manifest.run_id=run.id
                 AND orphan.cleaned_at IS NULL)
            ) unresolved_publication_work_count,
            (SELECT count(*)::int
             FROM playlist_publication_reconciliations reconciliation
             WHERE reconciliation.run_id=run.id) reconciliation_count,
            ${appleSideEffectCountSql} apple_side_effect_count
     FROM research_runs run
     JOIN playlist_run_resolutions resolution ON resolution.run_id=run.id
     JOIN run_active_query_plans active_plan ON active_plan.run_id=run.id
     JOIN query_plan_revisions plan
       ON plan.id=active_plan.query_plan_revision_id
     WHERE run.id<>$4
       AND run.pipeline_version=$1
       AND run.phase IN (
         'capability_evidence_coverage_audit',
         'v254_evidence_persistence_quarantined'
       )
       AND resolution.state NOT IN ('completed','cancelled')
       AND (
         plan.plan_json->'rankingObjectives'
           @> '[{"kind":"influence"}]'::jsonb
         OR plan.plan_json->'rankingObjectives'
           @> '[{"dimension":"influence"}]'::jsonb
       )
       AND EXISTS (
         SELECT 1 FROM job_queue source_job
         WHERE source_job.run_id=run.id
           AND source_job.required_executor_revision=$2
           AND source_job.required_executor_semantic_configuration_hash=$3
       )
       AND (
         SELECT count(*) FROM playlist_qualification_records qualification
         WHERE qualification.run_id=run.id
       )>=10
       AND NOT EXISTS (
         SELECT 1 FROM playlist_qualification_records qualification
         WHERE qualification.run_id=run.id
           AND qualification.candidate_id IS NOT NULL
       )
       AND NOT EXISTS (
          SELECT 1 FROM track_candidates candidate
          WHERE candidate.run_id=run.id
        )
     ORDER BY run.id${lock ? " FOR UPDATE OF run,resolution" : ""}`,
    [
      V254_CONTAINMENT_ROUTE,
      INCIDENT.releaseRevision,
      INCIDENT.semanticConfigurationHash,
      INCIDENT.runId,
    ],
  );
  const ownerReviewDispositions =
    reviewInventory.rows.length === 0
      ? { rows: [] as OwnerReviewDispositionAuditRow[] }
      : await client.query<OwnerReviewDispositionAuditRow>(
        `SELECT DISTINCT ON (audit.run_id)
                audit.run_id,audit.actor,audit.detail_json,
                audit.occurred_at::text occurred_at
         FROM audit_events audit
         WHERE audit.action=$1
           AND audit.run_id=ANY($2::uuid[])
         ORDER BY audit.run_id,audit.occurred_at DESC,audit.id DESC`,
        [
          OWNER_REVIEW_DISPOSITION_ACTION,
          reviewInventory.rows.map(({ run_id }) => run_id),
        ],
      );
  const switches = await client.query<{
    cohort_key: string;
    route: string;
    intent_group: string | null;
    disabled: boolean;
    reason_code: string | null;
  }>(
    `SELECT cohort_key,route,intent_group,disabled,reason_code
     FROM pipeline_cohort_kill_switches
     WHERE route=$1 AND intent_group=$2${suffix}`,
    [V254_CONTAINMENT_ROUTE, V254_CONTAINMENT_INTENT],
  );
  const pauses = await client.query<{ key: string; value: string }>(
    `SELECT key,value FROM settings
     WHERE key IN ('research_paused','publishing_paused')
     ORDER BY key${suffix}`,
  );
  const assignmentPauses = await client.query<{
    key: string;
    value: string;
  }>(
    `SELECT key,value FROM settings
     WHERE key IN (
       'pipeline_v3_public_assignment_paused',
       'pipeline_v3_public_assignment_paused:editorial_influence'
     )
     ORDER BY key${suffix}`,
  );
  return {
    run: run.rows[0] ?? null,
    resolution: resolution.rows[0] ?? null,
    activeJobs: jobs.rows,
    counts: counts.rows[0] ?? null,
    sameSignature: sameSignature.rows,
    reviewInventory: reviewInventory.rows,
    ownerReviewDispositions: ownerReviewDispositions.rows,
    switch: switches.rows[0] ?? null,
    pauses: pauses.rows,
    assignmentPauses: assignmentPauses.rows,
  };
}

export function v254OwnerReviewRunIdHash(runId: string): string {
  return sha256(runId);
}

export function v254OwnerReviewInventoryRowHash(
  row: AffectedSignatureRow,
): string {
  return sha256({
    runIdHash: v254OwnerReviewRunIdHash(row.run_id),
    runStatus: row.run_status,
    runPhase: row.run_phase,
    contractRevisionId: row.contract_revision_id,
    executionAttemptId: row.execution_attempt_id,
    resolutionGeneration: Number(row.resolution_generation),
    resolutionState: row.resolution_state,
    resolutionIncidentReference: row.resolution_incident_reference,
    containmentReceiptHash: row.containment_receipt_hash,
    activeJobCount: Number(row.active_job_count),
    activePublicationJobCount: Number(row.active_publication_job_count),
    unresolvedPublicationWorkCount:
      Number(row.unresolved_publication_work_count),
    reconciliationCount: Number(row.reconciliation_count),
    appleSideEffectCount: Number(row.apple_side_effect_count),
    route: V254_CONTAINMENT_ROUTE,
    intentGroup: V254_CONTAINMENT_INTENT,
    releaseRevision: INCIDENT.releaseRevision,
    semanticConfigurationHash: INCIDENT.semanticConfigurationHash,
  });
}

function ownerReviewDispositionIsApplicable(
  row: AffectedSignatureRow,
  audit: OwnerReviewDispositionAuditRow | undefined,
): boolean {
  if (!audit || audit.actor !== "owner_authorized") return false;
  const detail = audit.detail_json;
  const disposition = detail.disposition;
  if (
    detail.schemaVersion !== OWNER_REVIEW_DISPOSITION_SCHEMA
    || detail.incidentReference !== INCIDENT_REFERENCE
    || detail.route !== V254_CONTAINMENT_ROUTE
    || detail.intentGroup !== V254_CONTAINMENT_INTENT
    || detail.releaseRevision !== INCIDENT.releaseRevision
    || detail.semanticConfigurationHash
      !== INCIDENT.semanticConfigurationHash
    || detail.runIdHash !== v254OwnerReviewRunIdHash(row.run_id)
    || detail.inventoryRowHash !== v254OwnerReviewInventoryRowHash(row)
    || typeof disposition !== "string"
    || !OWNER_REVIEW_DISPOSITIONS.has(disposition)
    || detail.ownerAuthorized !== true
    || typeof detail.reasonCode !== "string"
    || !/^[a-z0-9][a-z0-9_:-]{2,119}$/u.test(detail.reasonCode)
  ) {
    return false;
  }
  if (
    disposition === "quarantined_separately"
    && row.resolution_state !== "quarantined"
  ) {
    return false;
  }
  if (
    disposition === "cancelled_by_owner"
    && row.resolution_state !== "cancelled"
  ) {
    return false;
  }
  if (
    disposition === "reconciled_completed"
    && row.resolution_state !== "completed"
  ) {
    return false;
  }
  return true;
}

export function evaluateV254OwnerReviewPromotionGate(
  reviewInventory: readonly AffectedSignatureRow[],
  dispositionAudits: readonly OwnerReviewDispositionAuditRow[],
): V254OwnerReviewPromotionProofV1 {
  const dispositionByRunId = new Map(
    dispositionAudits.map((audit) => [audit.run_id, audit]),
  );
  const applicableDispositions = reviewInventory.flatMap((row) => {
    const audit = dispositionByRunId.get(row.run_id);
    return ownerReviewDispositionIsApplicable(row, audit) && audit
      ? [{
          runIdHash: v254OwnerReviewRunIdHash(row.run_id),
          inventoryRowHash: v254OwnerReviewInventoryRowHash(row),
          actor: audit.actor,
          occurredAt: audit.occurred_at,
          disposition: audit.detail_json.disposition,
          reasonCode: audit.detail_json.reasonCode,
        }]
      : [];
  });
  const unresolvedExecutableWorkCount = reviewInventory.reduce(
    (total, row) => total + Number(row.active_job_count),
    0,
  );
  const unresolvedPublicationWorkCount = reviewInventory.reduce(
    (total, row) => total
      + Number(row.active_publication_job_count)
      + Number(row.unresolved_publication_work_count),
    0,
  );
  const candidateCount = reviewInventory.length;
  const dispositionCount = applicableDispositions.length;
  const undispositionedCount = candidateCount - dispositionCount;
  return {
    candidateCount,
    candidateSetHash: containmentRunSetHash(reviewInventory),
    dispositionCount,
    dispositionSetHash: sha256(
      applicableDispositions.map((disposition) => sha256(disposition)).sort(),
    ),
    undispositionedCount,
    unresolvedExecutableWorkCount,
    unresolvedPublicationWorkCount,
    promotionSafe: candidateCount === 0 || (
      dispositionCount === candidateCount
      && undispositionedCount === 0
      && unresolvedExecutableWorkCount === 0
      && unresolvedPublicationWorkCount === 0
    ),
  };
}

export function evaluateV254IrishInfluenceContainment(
  observed: Awaited<
    ReturnType<typeof collectV254IrishInfluenceContainmentSnapshot>
  >,
) {
  const violations: string[] = [];
  const persistedReceiptHash =
    observed.resolution?.containment_receipt_hash ?? null;
  const alreadyApplied = observed.run?.status === "failed_integrity"
    && observed.run.phase === "v254_evidence_persistence_quarantined"
    && Number(observed.resolution?.generation)
      === INCIDENT.resolutionGeneration + 1
    && observed.resolution?.state === "quarantined"
    && observed.resolution.incident_reference === INCIDENT_REFERENCE
    && typeof persistedReceiptHash === "string"
    && SHA256.test(persistedReceiptHash);
  const readyToApply = observed.run?.status === "needs_decision"
    && observed.run.phase === "capability_evidence_coverage_audit"
    && Number(observed.resolution?.generation) === INCIDENT.resolutionGeneration
    && observed.resolution?.state === "needs_decision"
    && observed.resolution.blocker_id === INCIDENT.blockerId;
  if (observed.run?.access_id !== INCIDENT.accessId
    || observed.run.run_id !== INCIDENT.runId
    || (!readyToApply && !alreadyApplied)
    || observed.run.pipeline_version !== V254_CONTAINMENT_ROUTE
    || observed.run.active_contract_revision_id !== INCIDENT.contractRevisionId) {
    violations.push("incident_run_identity_or_state_changed");
  }
  if (observed.resolution?.execution_attempt_id !== INCIDENT.executionAttemptId
    || observed.resolution.manifest_id !== null) {
    violations.push("resolution_generation_or_state_changed");
  }
  if (observed.activeJobs.length !== INCIDENT.activeJobCount) {
    violations.push("incident_has_active_jobs");
  }
  if (!observed.counts
    || Number(observed.counts.observation_count) !== INCIDENT.observationCount
    || Number(observed.counts.null_candidate_count) !== INCIDENT.nullCandidateCount
    || Number(observed.counts.candidate_count) !== INCIDENT.candidateCount
    || Number(observed.counts.manifest_count) !== INCIDENT.manifestCount
    || Number(observed.counts.reconciliation_count) !== INCIDENT.reconciliationCount
    || Number(observed.counts.apple_side_effect_count) !== 0) {
    violations.push("incident_counts_or_apple_side_effect_changed");
  }
  const incidentSignature = observed.sameSignature[0];
  if (
    observed.sameSignature.length !== 1
    || !incidentSignature
    || incidentSignature.run_id !== INCIDENT.runId
    || incidentSignature.contract_revision_id !== INCIDENT.contractRevisionId
    || incidentSignature.execution_attempt_id !== INCIDENT.executionAttemptId
    || Number(incidentSignature.reconciliation_count) !== 0
    || Number(incidentSignature.apple_side_effect_count) !== 0
    || Number(incidentSignature.active_job_count) !== 0
    || (alreadyApplied && (
      incidentSignature.resolution_state !== "quarantined"
      || incidentSignature.resolution_incident_reference !== INCIDENT_REFERENCE
    ))
  ) {
    violations.push("affected_signature_set_changed");
  }
  if (observed.switch?.disabled !== true) {
    violations.push("editorial_influence_hard_switch_not_engaged");
  }
  if (observed.pauses.length !== 2
    || observed.pauses.some(({ value }) => value !== "true")) {
    violations.push("global_pauses_not_engaged");
  }
  if (
    observed.assignmentPauses.length !== 2
    || observed.assignmentPauses.some(({ value }) => value !== "true")
  ) {
    violations.push("editorial_influence_public_pause_not_engaged");
  }
  const ownerReviewPromotionProof = evaluateV254OwnerReviewPromotionGate(
    observed.reviewInventory,
    observed.ownerReviewDispositions,
  );
  const receipt = {
    incidentVersion: LOCK_KEY,
    expected: INCIDENT,
    observed,
    ownerReviewPromotionProof,
    ownerReviewPromotionProofHash: sha256(ownerReviewPromotionProof),
    violations,
  };
  return {
    receipt,
    receiptHash: alreadyApplied ? persistedReceiptHash! : sha256(receipt),
    safeToApply: violations.length === 0,
    alreadyApplied,
    ownerReviewPromotionProof,
    ownerReviewPromotionProofHash: sha256(ownerReviewPromotionProof),
  };
}

function containmentRunSetHash(rows: readonly AffectedSignatureRow[]): string {
  return sha256(rows.map(({ run_id }) => sha256(run_id)).sort());
}

function assertContainmentMutationCounts(
  actual: ContainmentMutationCountsV1,
  expected: ContainmentMutationCountsV1,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("containment_mutation_row_count_mismatch");
  }
}

function ownerReviewPromotionResult(
  proof: V254OwnerReviewPromotionProofV1,
  proofHash: string,
) {
  return {
    ownerReviewCandidateCount: proof.candidateCount,
    ownerReviewCandidateSetHash: proof.candidateSetHash,
    ownerReviewDispositionCount: proof.dispositionCount,
    ownerReviewDispositionSetHash: proof.dispositionSetHash,
    ownerReviewUndispositionedCount: proof.undispositionedCount,
    ownerReviewUnresolvedExecutableWorkCount:
      proof.unresolvedExecutableWorkCount,
    ownerReviewUnresolvedPublicationWorkCount:
      proof.unresolvedPublicationWorkCount,
    ownerReviewPromotionSafe: proof.promotionSafe,
    ownerReviewPromotionProof: proof,
    ownerReviewPromotionProofHash: proofHash,
  };
}

export async function pauseV254IrishInfluenceContainment(
  client: pg.Client,
) {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [LOCK_KEY]);
    await client.query(
      `INSERT INTO settings(key,value,updated_at)
       VALUES
         ('research_paused','true',now()),
         ('publishing_paused','true',now()),
         ('pipeline_v3_public_assignment_paused','true',now()),
         ('pipeline_v3_public_assignment_paused:editorial_influence','true',now())
       ON CONFLICT(key) DO UPDATE
         SET value=excluded.value,updated_at=now()`,
    );
    await client.query(
      `INSERT INTO pipeline_cohort_kill_switches(
         cohort_key,route,intent_group,disabled,reason_code,changed_by,changed_at)
       VALUES(
         'v254-irish-influence-editorial-containment',
         $1,$2,true,
         'v254_evidence_persistence_containment',
         'codex_plan_authorized',now())
       ON CONFLICT(route,intent_group) DO UPDATE SET
         cohort_key=excluded.cohort_key,
         disabled=true,
         reason_code=excluded.reason_code,
         changed_by=excluded.changed_by,
         changed_at=now()`,
      [V254_CONTAINMENT_ROUTE, V254_CONTAINMENT_INTENT],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return collectV254IrishInfluenceContainmentSnapshot(client);
}

export async function executeV254IrishInfluenceContainment(
  client: pg.Client,
  selectedMode: "contain-dry-run" | "contain-apply",
  expectedReceiptHash: string | undefined,
) {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [LOCK_KEY]);
    const preflight = evaluateV254IrishInfluenceContainment(
      await collectV254IrishInfluenceContainmentSnapshot(client, true),
    );
    if (!preflight.safeToApply) {
      throw new Error(
        `containment_preflight_failed:${preflight.receipt.violations.join(",")}`,
      );
    }
    if (selectedMode === "contain-dry-run") {
      await client.query("ROLLBACK");
      const expectedMutationCounts = preflight.alreadyApplied
        ? IDEMPOTENT_APPLY_EXPECTED_MUTATIONS
        : FIRST_APPLY_EXPECTED_MUTATIONS;
      const observedCounts = preflight.receipt.observed.counts;
      const affectedRows = preflight.receipt.observed.sameSignature;
      return {
        mode: selectedMode,
        safeToApply: preflight.safeToApply,
        alreadyApplied: preflight.alreadyApplied,
        receiptHash: preflight.receiptHash,
        affectedRunCount: affectedRows.length,
        affectedRunSetHash: containmentRunSetHash(affectedRows),
        observedCounts,
        observedCountsHash: sha256(observedCounts),
        ...ownerReviewPromotionResult(
          preflight.ownerReviewPromotionProof,
          preflight.ownerReviewPromotionProofHash,
        ),
        expectedMutationCounts,
        expectedMutationCountsHash: sha256(expectedMutationCounts),
        actualMutationCounts: DRY_RUN_ACTUAL_MUTATIONS,
        actualMutationCountsHash: sha256(DRY_RUN_ACTUAL_MUTATIONS),
      };
    }
    if (!expectedReceiptHash || expectedReceiptHash !== preflight.receiptHash) {
      throw new Error("containment_receipt_hash_mismatch");
    }
    if (preflight.alreadyApplied) {
      const resumed = await client.query(
        `UPDATE settings SET value='false',updated_at=now()
         WHERE key IN ('research_paused','publishing_paused')`,
      );
      const mutationCounts: ContainmentMutationCountsV1 = {
        jobsCancelled: 0,
        blockerResolved: 0,
        transitionInserted: 0,
        resolutionUpdated: 0,
        outboxInserted: 0,
        runUpdated: 0,
        auditInserted: 0,
        pausesCleared: resumed.rowCount ?? 0,
      };
      assertContainmentMutationCounts(
        mutationCounts,
        IDEMPOTENT_APPLY_EXPECTED_MUTATIONS,
      );
      await client.query("COMMIT");
      return {
        mode: selectedMode,
        applied: false,
        receiptHash: preflight.receiptHash,
        incidentReference: INCIDENT_REFERENCE,
        affectedRunCount: 1,
        affectedRunSetHash: containmentRunSetHash(
          preflight.receipt.observed.sameSignature,
        ),
        ...ownerReviewPromotionResult(
          preflight.ownerReviewPromotionProof,
          preflight.ownerReviewPromotionProofHash,
        ),
        observedCountsHash: sha256(preflight.receipt.observed.counts),
        expectedMutationCounts: IDEMPOTENT_APPLY_EXPECTED_MUTATIONS,
        expectedMutationCountsHash:
          sha256(IDEMPOTENT_APPLY_EXPECTED_MUTATIONS),
        actualMutationCounts: mutationCounts,
        actualMutationCountsHash: sha256(mutationCounts),
        mutationCounts,
        mutationCountsHash: sha256(mutationCounts),
        hardSwitchRemainsEngaged: true,
        intentPublicPauseRemainsEngaged: true,
        safeRoutesResumed: true,
      };
    }

    const affectedRows = preflight.receipt.observed.sameSignature;
    const jobs = await client.query(
      `UPDATE job_queue
       SET status='cancelled',completed_at=now(),updated_at=now(),
           lease_owner=NULL,lease_expires_at=NULL,
           last_error='v254_evidence_persistence_containment'
       WHERE run_id=$1
         AND status IN ('queued','leased')
         AND kind IN ('research','matching','publication')`,
      [INCIDENT.runId],
    );
    const successorGeneration = INCIDENT.resolutionGeneration + 1;
    const transitionId = randomUUID();
    const blocker = await client.query(
      `UPDATE playlist_run_blockers
       SET resolved_at=now(),updated_at=now()
       WHERE id=$1 AND run_id=$2 AND resolved_at IS NULL`,
      [INCIDENT.blockerId, INCIDENT.runId],
    );
    const transition = await client.query(
      `INSERT INTO playlist_run_resolution_transitions(
         id,run_id,expected_generation,successor_generation,
         from_state,to_state,contract_revision_id,execution_attempt_id,
         companion_artifact_kind,transition_kind,transition_json,
         idempotency_key)
       VALUES(
         $1,$2,$3,$4,'needs_decision','quarantined',$5,$6,
         'incident_reference','technical_quarantine',$7::jsonb,$8)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        transitionId,
        INCIDENT.runId,
        INCIDENT.resolutionGeneration,
        successorGeneration,
        INCIDENT.contractRevisionId,
        INCIDENT.executionAttemptId,
        JSON.stringify({
          incidentReference: INCIDENT_REFERENCE,
          receiptHash: preflight.receiptHash,
          observationCount: INCIDENT.observationCount,
          nullCandidateCount: INCIDENT.nullCandidateCount,
          materializedCandidateCount: INCIDENT.candidateCount,
          reconciledPublishedTrackCount: 0,
          repairAction: "replay_after_repair",
        }),
        `v254-containment:${INCIDENT.runId}`,
      ],
    );
    const resolution = await client.query(
      `UPDATE playlist_run_resolutions
       SET generation=$2,state='quarantined',next_action='contact_support',
           active_contract_revision_id=$3,execution_attempt_id=$4,
           blocker_id=NULL,question_set_id=NULL,decision_json=NULL,
           manifest_id=NULL,
           state_json=$5::jsonb,provenance='owner_repair',
           incident_reference=$6,completed_at=NULL,cancelled_at=NULL,
           updated_at=now()
       WHERE run_id=$1 AND generation=$7 AND state='needs_decision'
       RETURNING generation,state`,
      [
        INCIDENT.runId,
        successorGeneration,
        INCIDENT.contractRevisionId,
        INCIDENT.executionAttemptId,
        JSON.stringify({
          requestedTrackCount: 25,
          observationCount: INCIDENT.observationCount,
          uniqueLeadCount: 80,
          materializedCandidateCount: 0,
          appleResolvedCount: 73,
          versionCompatibleCount: 73,
          storefrontPlayableCount: 73,
          evidenceQualifiedCount: 0,
          selectedTrackCount: null,
          manifestedTrackCount: null,
          appendedTrackCount: 0,
          reconciledPublishedTrackCount: 0,
          publishedTrackCount: 0,
          workMotion: "none",
          incidentCode: "evidence_persistence_candidate_binding_defect",
          containmentReceiptHash: preflight.receiptHash,
          repairAction: {
            kind: "replay_after_repair",
            incidentRef: INCIDENT_REFERENCE,
            available: false,
          },
        }),
        INCIDENT_REFERENCE,
        INCIDENT.resolutionGeneration,
      ],
    );
    if (resolution.rowCount !== 1) {
      throw new Error("resolution_compare_and_swap_failed");
    }
    const outbox = await client.query(
      `INSERT INTO playlist_resolution_outbox(
         id,run_id,transition_id,topic,idempotency_key,payload_json)
       VALUES($1,$2,$3,'resolution.transition',$4,$5::jsonb)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        randomUUID(),
        INCIDENT.runId,
        transitionId,
        `resolution-outbox:v254-containment:${INCIDENT.runId}:${successorGeneration}`,
        JSON.stringify({
          runId: INCIDENT.runId,
          generation: successorGeneration,
          state: "quarantined",
          nextAction: "contact_support",
        }),
      ],
    );
    const run = await client.query(
      `UPDATE research_runs
       SET status='failed_integrity',
           phase='v254_evidence_persistence_quarantined',
           error='Evidence persistence could not bind evaluated candidates.',
           completed_at=now(),updated_at=now()
       WHERE id=$1 AND status='needs_decision'
         AND phase='capability_evidence_coverage_audit'`,
      [INCIDENT.runId],
    );
    const audit = await client.query(
      `INSERT INTO audit_events(run_id,actor,action,detail_json)
       VALUES($1,'codex_plan_authorized','run.technical_quarantined',$2::jsonb)`,
      [
        INCIDENT.runId,
        JSON.stringify({
          incidentReference: INCIDENT_REFERENCE,
          receiptHash: preflight.receiptHash,
          accessIdHash: sha256(INCIDENT.accessId),
          observationCount: INCIDENT.observationCount,
          nullCandidateCount: INCIDENT.nullCandidateCount,
          reconciledPublishedTrackCount: 0,
        }),
      ],
    );
    const resumed = await client.query(
      `UPDATE settings SET value='false',updated_at=now()
       WHERE key IN ('research_paused','publishing_paused')`,
    );
    const mutationCounts: ContainmentMutationCountsV1 = {
      jobsCancelled: jobs.rowCount ?? 0,
      blockerResolved: blocker.rowCount ?? 0,
      transitionInserted: transition.rowCount ?? 0,
      resolutionUpdated: resolution.rowCount ?? 0,
      outboxInserted: outbox.rowCount ?? 0,
      runUpdated: run.rowCount ?? 0,
      auditInserted: audit.rowCount ?? 0,
      pausesCleared: resumed.rowCount ?? 0,
    };
    assertContainmentMutationCounts(
      mutationCounts,
      FIRST_APPLY_EXPECTED_MUTATIONS,
    );
    await client.query("COMMIT");
    return {
      mode: selectedMode,
      applied: true,
      receiptHash: preflight.receiptHash,
      incidentReference: INCIDENT_REFERENCE,
      affectedRunCount: affectedRows.length,
      affectedRunSetHash: containmentRunSetHash(affectedRows),
      ...ownerReviewPromotionResult(
        preflight.ownerReviewPromotionProof,
        preflight.ownerReviewPromotionProofHash,
      ),
      observedCountsHash: sha256(preflight.receipt.observed.counts),
      expectedMutationCounts: FIRST_APPLY_EXPECTED_MUTATIONS,
      expectedMutationCountsHash: sha256(FIRST_APPLY_EXPECTED_MUTATIONS),
      actualMutationCounts: mutationCounts,
      actualMutationCountsHash: sha256(mutationCounts),
      mutationCounts,
      mutationCountsHash: sha256(mutationCounts),
      hardSwitchRemainsEngaged: true,
      intentPublicPauseRemainsEngaged: true,
      safeRoutesResumed: true,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runV254IrishInfluenceContainment(
  selectedMode: Mode,
  expectedReceiptHash?: string,
): Promise<unknown> {
  requireV254IrishInfluenceProtectedBinding();
  const client = new pg.Client({
    connectionString: databaseUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    if (selectedMode === "pause") {
      const observed = await pauseV254IrishInfluenceContainment(client);
      return {
        mode: selectedMode,
        route: V254_CONTAINMENT_ROUTE,
        intentGroup: V254_CONTAINMENT_INTENT,
        hardSwitchEngaged: observed.switch?.disabled === true,
        globalPausesEngaged: observed.pauses.length === 2
          && observed.pauses.every(({ value }) => value === "true"),
        editorialPublicPauseEngaged:
          observed.assignmentPauses.length === 2
          && observed.assignmentPauses.every(({ value }) => value === "true"),
      };
    }
    if (selectedMode === "contain-dry-run"
      || selectedMode === "contain-apply") {
      return await executeV254IrishInfluenceContainment(
        client,
        selectedMode,
        expectedReceiptHash,
      );
    }
    const observed = await collectV254IrishInfluenceContainmentSnapshot(client);
    const ownerReviewPromotionProof = evaluateV254OwnerReviewPromotionGate(
      observed.reviewInventory,
      observed.ownerReviewDispositions,
    );
    return {
      mode: selectedMode,
      route: V254_CONTAINMENT_ROUTE,
      intentGroup: V254_CONTAINMENT_INTENT,
      hardSwitchEngaged: observed.switch?.disabled === true,
      globalPausesEngaged: observed.pauses.length === 2
        && observed.pauses.every(({ value }) => value === "true"),
      editorialPublicPauseEngaged:
        observed.assignmentPauses.length === 2
          && observed.assignmentPauses.every(({ value }) => value === "true"),
      affectedRunCount: observed.sameSignature.length,
      ...ownerReviewPromotionResult(
        ownerReviewPromotionProof,
        sha256(ownerReviewPromotionProof),
      ),
      affectedRunSetHash: sha256(
        observed.sameSignature.map(({ run_id }) => sha256(run_id)).sort(),
      ),
    };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const selectedMode = mode();
  const result = await runV254IrishInfluenceContainment(
    selectedMode,
    process.argv[3],
  );
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    const code = error instanceof Error
      && /^[0-9A-Za-z_,:-]{1,500}$/u.test(error.message)
      ? error.message
      : "v254_irish_influence_containment_failed";
    console.error(code);
    process.exitCode = 1;
  });
}
