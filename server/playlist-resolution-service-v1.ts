import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { RunNextAction } from "../shared/types.ts";
import { sha256Hex, stableStringify } from "./security.ts";

export const PLAYLIST_RESOLUTION_SERVICE_VERSION = "playlist_resolution_service_v1" as const;

export type PlaylistResolutionStateV1 =
  | "accepted"
  | "needs_input"
  | "probing"
  | "executing"
  | "blocked_dependency"
  | "needs_decision"
  | "ready"
  | "publishing"
  | "completed"
  | "cancelled"
  | "quarantined";

export interface PlaylistResolutionCompanionsV1 {
  activeContractRevisionId: string | null;
  executionAttemptId: string | null;
  blockerId: string | null;
  questionSetId: string | null;
  decision: Record<string, unknown> | null;
  manifestId: string | null;
  incidentReference: string | null;
}

export interface PlaylistResolutionTransitionV1 {
  runId: string;
  expectedGeneration: number;
  fromState: PlaylistResolutionStateV1;
  toState: PlaylistResolutionStateV1;
  nextAction: RunNextAction;
  transitionKind: string;
  state: Record<string, unknown>;
  companions: PlaylistResolutionCompanionsV1;
  idempotencyKey: string;
  outbox?: {
    topic: string;
    payload: Record<string, unknown>;
    availableAt?: Date;
  } | null;
}

function nonempty(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertPlaylistResolutionCompanionsV1(input: {
  state: PlaylistResolutionStateV1;
  nextAction: RunNextAction;
  companions: PlaylistResolutionCompanionsV1;
  stateJson: Record<string, unknown>;
}): void {
  if (!nonempty(input.nextAction)) throw new Error("resolution_next_action_missing");
  const { state, companions } = input;
  const allowedActions: Record<PlaylistResolutionStateV1, readonly RunNextAction[]> = {
    accepted: ["none"],
    needs_input: ["answer_initial_guidance", "answer_rescue_guidance"],
    probing: ["none"],
    executing: ["none"],
    blocked_dependency: ["wait_for_dependency", "authorize_apple"],
    needs_decision: ["resume_research", "decide_verified_partial", "review_contract"],
    ready: ["none"],
    publishing: ["none"],
    completed: ["none"],
    cancelled: ["none"],
    quarantined: ["contact_support"],
  };
  if (!allowedActions[state].includes(input.nextAction)) {
    throw new Error("resolution_state_action_mismatch");
  }
  if ((state === "blocked_dependency" || state === "needs_input")
    && !nonempty(companions.blockerId)) {
    throw new Error("resolution_blocker_missing");
  }
  if (state === "needs_decision" && !companions.decision) {
    throw new Error("resolution_decision_missing");
  }
  if (["ready", "publishing", "completed"].includes(state)
    && !nonempty(companions.manifestId)) {
    throw new Error("resolution_manifest_missing");
  }
  if (state === "quarantined" && !nonempty(companions.incidentReference)) {
    throw new Error("resolution_incident_reference_missing");
  }
  if (state === "completed") {
    const requested = Number(input.stateJson.requestedTrackCount);
    const reconciled = Number(input.stateJson.reconciledPublishedTrackCount);
    if (!Number.isSafeInteger(requested)
      || requested < 1
      || reconciled !== requested) {
      throw new Error("resolution_exact_completion_missing");
    }
  }
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(value);
}

export async function transitionPlaylistResolutionWithClientV1(
  client: PoolClient,
  input: PlaylistResolutionTransitionV1,
): Promise<{ generation: number; transitionId: string }> {
  if (!validUuid(input.runId)
    || !Number.isSafeInteger(input.expectedGeneration)
    || input.expectedGeneration < 1
    || !input.idempotencyKey.trim()
    || input.idempotencyKey.length > 160) {
    throw new Error("invalid_resolution_transition");
  }
  assertPlaylistResolutionCompanionsV1({
    state: input.toState,
    nextAction: input.nextAction,
    companions: input.companions,
    stateJson: input.state,
  });
  const existingEvent = await client.query<{
    successor_generation: number;
    id: string;
  }>(
    `SELECT id,successor_generation
     FROM playlist_run_resolution_transitions
     WHERE idempotency_key=$1`,
    [input.idempotencyKey],
  );
  if (existingEvent.rows[0]) {
    return {
      generation: Number(existingEvent.rows[0].successor_generation),
      transitionId: existingEvent.rows[0].id,
    };
  }
  const current = await client.query<{
    generation: number;
    state: PlaylistResolutionStateV1;
    active_contract_revision_id: string | null;
  }>(
    `SELECT generation,state,active_contract_revision_id
     FROM playlist_run_resolutions
     WHERE run_id=$1 FOR UPDATE`,
    [input.runId],
  );
  const row = current.rows[0];
  if (!row
    || Number(row.generation) !== input.expectedGeneration
    || row.state !== input.fromState) {
    throw new Error("stale_resolution_generation");
  }
  if (row.active_contract_revision_id !== null
    && input.companions.activeContractRevisionId !== row.active_contract_revision_id) {
    throw new Error("stale_resolution_contract");
  }
  if (input.toState === "needs_decision") {
    await client.query(
      `UPDATE job_queue
       SET status='cancelled',completed_at=now(),updated_at=now(),
           last_error='resolution_needs_decision'
       WHERE run_id=$1 AND status='queued'
         AND kind IN ('research','matching','publication')`,
      [input.runId],
    );
    const executable = await client.query<{ count: number }>(
      `SELECT count(*)::int count FROM job_queue
       WHERE run_id=$1 AND status IN ('queued','leased')
         AND kind IN ('research','matching','publication')`,
      [input.runId],
    );
    if (Number(executable.rows[0]?.count ?? 0) !== 0) {
      throw new Error("decision_state_has_executable_work");
    }
  }
  const successorGeneration = input.expectedGeneration + 1;
  const terminalTime = new Date();
  const updated = await client.query(
    `UPDATE playlist_run_resolutions
     SET generation=$3,state=$4,next_action=$5,
         active_contract_revision_id=$6,execution_attempt_id=$7,
         blocker_id=$8,question_set_id=$9,decision_json=$10::jsonb,
         manifest_id=$11,state_json=$12::jsonb,
         provenance='resolution_service',incident_reference=$13,
         completed_at=$14,cancelled_at=$15,updated_at=now()
     WHERE run_id=$1 AND generation=$2 AND state=$16`,
    [
      input.runId,
      input.expectedGeneration,
      successorGeneration,
      input.toState,
      input.nextAction,
      input.companions.activeContractRevisionId,
      input.companions.executionAttemptId,
      input.companions.blockerId,
      input.companions.questionSetId,
      input.companions.decision ? JSON.stringify(input.companions.decision) : null,
      input.companions.manifestId,
      JSON.stringify(input.state),
      input.companions.incidentReference,
      input.toState === "completed" ? terminalTime : null,
      input.toState === "cancelled" ? terminalTime : null,
      input.fromState,
    ],
  );
  if ((updated.rowCount ?? 0) !== 1) throw new Error("stale_resolution_generation");
  const transitionId = randomUUID();
  await client.query(
    `INSERT INTO playlist_run_resolution_transitions(
       id,run_id,expected_generation,successor_generation,from_state,to_state,
       contract_revision_id,execution_attempt_id,blocker_id,
       companion_artifact_kind,companion_artifact_id,transition_kind,
       transition_json,idempotency_key)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
    [
      transitionId,
      input.runId,
      input.expectedGeneration,
      successorGeneration,
      input.fromState,
      input.toState,
      input.companions.activeContractRevisionId,
      input.companions.executionAttemptId,
      input.companions.blockerId,
      input.companions.manifestId ? "manifest" : input.companions.blockerId ? "blocker" : null,
      input.companions.manifestId ?? input.companions.blockerId,
      input.transitionKind,
      JSON.stringify({
        stateHash: sha256Hex(stableStringify(input.state)),
        nextAction: input.nextAction,
      }),
      input.idempotencyKey,
    ],
  );
  if (input.outbox) {
    await client.query(
      `INSERT INTO playlist_resolution_outbox(
         id,run_id,transition_id,topic,idempotency_key,payload_json,
         available_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,COALESCE($7::timestamptz,now()))
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        randomUUID(),
        input.runId,
        transitionId,
        input.outbox.topic,
        `resolution-outbox:${input.idempotencyKey}`,
        JSON.stringify(input.outbox.payload),
        input.outbox.availableAt ?? null,
      ],
    );
  }
  return { generation: successorGeneration, transitionId };
}

export async function transitionPlaylistResolutionV1(
  pool: Pool,
  input: PlaylistResolutionTransitionV1,
): Promise<{ generation: number; transitionId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await transitionPlaylistResolutionWithClientV1(client, input);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type ResolutionReconcilerActionV1 =
  | "none"
  | "enqueue_missing_work"
  | "resume_verified_checkpoint"
  | "wake_due_dependency"
  | "quarantine";

/**
 * The reconciler classifies only the four allowed repairs. It does not invent
 * a companion payload; the normal transition service must perform the repair.
 */
export function resolutionReconcilerActionV1(input: {
  state: PlaylistResolutionStateV1;
  hasExecutableJob: boolean;
  hasVerifiedExpiredCheckpoint: boolean;
  dependencyWakeDue: boolean;
  companionPayloadValid: boolean;
  priorRepairCount: number;
}): ResolutionReconcilerActionV1 {
  if (!input.companionPayloadValid || input.priorRepairCount >= 3) return "quarantine";
  if (input.state === "accepted" && !input.hasExecutableJob) return "enqueue_missing_work";
  if (input.state === "executing"
    && !input.hasExecutableJob
    && input.hasVerifiedExpiredCheckpoint) return "resume_verified_checkpoint";
  if (input.state === "blocked_dependency" && input.dependencyWakeDue) {
    return "wake_due_dependency";
  }
  return "none";
}

export interface ResolutionReconcilerSummaryV1 {
  audited: number;
  repaired: number;
  quarantined: number;
  skipped: boolean;
}

/**
 * Run one globally leased reconciliation pass. Repairs are derived only from
 * an existing immutable job/checkpoint; the reconciler never invents a
 * contract, question, decision, manifest, answer, or execution strategy.
 */
export async function runPlaylistResolutionReconcilerV1(
  pool: Pool,
  limit = 100,
): Promise<ResolutionReconcilerSummaryV1> {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('playlist-resolution-reconciler-v1')) locked",
    );
    if (lock.rows[0]?.locked !== true) {
      await client.query("COMMIT");
      return { audited: 0, repaired: 0, quarantined: 0, skipped: true };
    }
    const mode = await client.query<{ value: string }>(
      "SELECT value FROM settings WHERE key='playlist_resolution_authority_mode'",
    );
    if (!["authoritative", "resolution_service"].includes(
      mode.rows[0]?.value ?? "",
    )) {
      await client.query("COMMIT");
      return { audited: 0, repaired: 0, quarantined: 0, skipped: true };
    }
    const rows = await client.query<{
      run_id: string;
      generation: number;
      state: PlaylistResolutionStateV1;
      next_action: RunNextAction;
      active_contract_revision_id: string | null;
      execution_attempt_id: string | null;
      blocker_id: string | null;
      question_set_id: string | null;
      decision_json: Record<string, unknown> | null;
      manifest_id: string | null;
      state_json: Record<string, unknown>;
      incident_reference: string | null;
      has_executable_job: boolean;
      has_verified_expired_checkpoint: boolean;
      dependency_wake_due: boolean;
      prior_repair_count: number;
      source_job_id: string | null;
      source_kind: string | null;
      source_payload_json: Record<string, unknown> | null;
      source_max_attempts: number | null;
      source_pipeline_version: string | null;
      source_minimum_worker_protocol: number | null;
      source_query_plan_revision_id: string | null;
      source_stage_key: string | null;
      source_queue_class: string | null;
      source_required_executor_capability_hash: string | null;
      source_required_executor_capability_vector: Record<string, unknown> | null;
      source_required_executor_revision: string | null;
      source_required_executor_semantic_configuration_hash: string | null;
    }>(
      `SELECT resolution.run_id,resolution.generation,resolution.state,
              resolution.next_action,resolution.active_contract_revision_id,
              resolution.execution_attempt_id,resolution.blocker_id,
              resolution.question_set_id,resolution.decision_json,
              resolution.manifest_id,resolution.state_json,
              resolution.incident_reference,
              EXISTS(
                SELECT 1 FROM job_queue executable
                WHERE executable.run_id=resolution.run_id
                  AND executable.status IN ('queued','leased')
                  AND executable.kind IN ('research','matching','publication')
              ) has_executable_job,
              EXISTS(
                SELECT 1 FROM research_checkpoints checkpoint
                WHERE checkpoint.run_id=resolution.run_id
                  AND checkpoint.state_json->>'verified'='true'
                  AND checkpoint.state_json->>'expiresAt'
                    ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
                  AND (checkpoint.state_json->>'expiresAt')::timestamptz
                    <=now()
              ) has_verified_expired_checkpoint,
              COALESCE(blocker.next_retry_at<=now(),false)
                dependency_wake_due,
              COALESCE(
                NULLIF(resolution.state_json->>'reconcilerRepairCount','')::int,
                0
              ) prior_repair_count,
              source_job.id source_job_id,source_job.kind source_kind,
              source_job.payload_json source_payload_json,
              source_job.max_attempts source_max_attempts,
              source_job.pipeline_version source_pipeline_version,
              source_job.minimum_worker_protocol
                source_minimum_worker_protocol,
              source_job.query_plan_revision_id
                source_query_plan_revision_id,
              source_job.stage_key source_stage_key,
              source_job.queue_class source_queue_class,
              source_job.required_executor_capability_hash
                source_required_executor_capability_hash,
              source_job.required_executor_capability_vector
                source_required_executor_capability_vector,
              source_job.required_executor_revision
                source_required_executor_revision,
              source_job.required_executor_semantic_configuration_hash
                source_required_executor_semantic_configuration_hash
       FROM playlist_run_resolutions resolution
       LEFT JOIN playlist_run_blockers blocker
         ON blocker.id=resolution.blocker_id
       LEFT JOIN LATERAL (
         SELECT id,kind,payload_json,max_attempts,pipeline_version,
                minimum_worker_protocol,query_plan_revision_id,stage_key,
                queue_class,required_executor_capability_hash,
                required_executor_capability_vector,
                required_executor_revision,
                required_executor_semantic_configuration_hash
         FROM job_queue
         WHERE run_id=resolution.run_id
           AND kind IN ('research','matching','publication')
         ORDER BY created_at DESC,id DESC LIMIT 1
       ) source_job ON true
       WHERE resolution.state NOT IN ('completed','cancelled')
         AND (
           resolution.state='blocked_dependency'
           OR resolution.updated_at<=now()-interval '5 minutes'
         )
       ORDER BY resolution.updated_at,resolution.run_id
       LIMIT $1
       FOR UPDATE OF resolution SKIP LOCKED`,
      [boundedLimit],
    );
    let repaired = 0;
    let quarantined = 0;
    for (const row of rows.rows) {
      const companions: PlaylistResolutionCompanionsV1 = {
        activeContractRevisionId: row.active_contract_revision_id,
        executionAttemptId: row.execution_attempt_id,
        blockerId: row.blocker_id,
        questionSetId: row.question_set_id,
        decision: row.decision_json,
        manifestId: row.manifest_id,
        incidentReference: row.incident_reference,
      };
      let companionPayloadValid = true;
      try {
        assertPlaylistResolutionCompanionsV1({
          state: row.state,
          nextAction: row.next_action,
          companions,
          stateJson: row.state_json,
        });
      } catch {
        companionPayloadValid = false;
      }
      let action = resolutionReconcilerActionV1({
        state: row.state,
        hasExecutableJob: row.has_executable_job,
        hasVerifiedExpiredCheckpoint:
          row.has_verified_expired_checkpoint,
        dependencyWakeDue: row.dependency_wake_due,
        companionPayloadValid,
        priorRepairCount: Number(row.prior_repair_count),
      });
      if (action !== "none"
        && action !== "quarantine"
        && (!row.source_job_id
          || !row.source_kind
          || !row.source_payload_json
          || !row.source_pipeline_version
          || row.source_minimum_worker_protocol == null)) {
        action = "quarantine";
      }
      if (action === "none") continue;
      const repairCount = Number(row.prior_repair_count) + 1;
      const repairedState = {
        ...row.state_json,
        reconcilerRepairCount: repairCount,
        reconcilerLastAction: action,
      };
      if (action === "quarantine") {
        await transitionPlaylistResolutionWithClientV1(client, {
          runId: row.run_id,
          expectedGeneration: Number(row.generation),
          fromState: row.state,
          toState: "quarantined",
          nextAction: "contact_support",
          transitionKind: "reconciler_quarantine",
          state: repairedState,
          companions: {
            ...companions,
            blockerId: null,
            questionSetId: null,
            decision: null,
            manifestId: null,
            incidentReference:
              `resolution-reconciler:${row.run_id}:${row.generation}`.slice(
                0,
                160,
              ),
          },
          idempotencyKey:
            `resolution-reconciler:quarantine:${row.run_id}:${row.generation}`,
          outbox: {
            topic: "resolution.quarantined",
            payload: {
              runId: row.run_id,
              generation: Number(row.generation) + 1,
            },
          },
        });
        quarantined += 1;
        continue;
      }
      await client.query(
        `INSERT INTO job_queue(
           id,run_id,kind,queue_class,dedupe_key,payload_json,max_attempts,
           pipeline_version,minimum_worker_protocol,query_plan_revision_id,
           stage_key,required_executor_capability_hash,
           required_executor_capability_vector,required_executor_revision,
           required_executor_semantic_configuration_hash)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,
                $13::jsonb,$14,$15)
         ON CONFLICT(kind,dedupe_key) DO NOTHING`,
        [
          randomUUID(),
          row.run_id,
          row.source_kind,
          row.source_queue_class ?? "interactive",
          `resolution-repair:${row.run_id}:${row.generation}`.slice(0, 160),
          JSON.stringify({
            ...row.source_payload_json,
            resolutionReconcilerRepair: {
              action,
              sourceJobId: row.source_job_id,
              sourceGeneration: Number(row.generation),
            },
          }),
          Math.max(1, Number(row.source_max_attempts ?? 1)),
          row.source_pipeline_version,
          Number(row.source_minimum_worker_protocol),
          row.source_query_plan_revision_id,
          row.source_stage_key ?? "resolution_reconciler",
          row.source_required_executor_capability_hash,
          row.source_required_executor_capability_vector
            ? JSON.stringify(row.source_required_executor_capability_vector)
            : null,
          row.source_required_executor_revision,
          row.source_required_executor_semantic_configuration_hash,
        ],
      );
      await transitionPlaylistResolutionWithClientV1(client, {
        runId: row.run_id,
        expectedGeneration: Number(row.generation),
        fromState: row.state,
        toState: row.state,
        nextAction: row.next_action,
        transitionKind: `reconciler_${action}`,
        state: repairedState,
        companions,
        idempotencyKey:
          `resolution-reconciler:${action}:${row.run_id}:${row.generation}`,
        outbox: {
          topic: "resolution.repaired",
          payload: {
            runId: row.run_id,
            action,
            generation: Number(row.generation) + 1,
          },
        },
      });
      repaired += 1;
    }
    await client.query("COMMIT");
    return {
      audited: rows.rows.length,
      repaired,
      quarantined,
      skipped: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Claim and acknowledge committed resolution events with a bounded lease. */
export async function drainPlaylistResolutionOutboxV1(
  pool: Pool,
  workerId: string,
  limit = 100,
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query<{ id: string }>(
      `WITH due AS (
         SELECT id
         FROM playlist_resolution_outbox
         WHERE delivered_at IS NULL AND available_at<=now()
           AND (lease_expires_at IS NULL OR lease_expires_at<=now())
         ORDER BY available_at,created_at,id
         LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       UPDATE playlist_resolution_outbox outbox
       SET lease_owner=$1,lease_expires_at=now()+interval '1 minute',
           attempt_count=attempt_count+1,updated_at=now()
       FROM due
       WHERE outbox.id=due.id
       RETURNING outbox.id`,
      [workerId.slice(0, 160), boundedLimit],
    );
    if (claimed.rows.length > 0) {
      await client.query(
        `UPDATE playlist_resolution_outbox
         SET delivered_at=now(),lease_owner=NULL,lease_expires_at=NULL,
             last_error_class=NULL,updated_at=now()
         WHERE id=ANY($1::uuid[]) AND lease_owner=$2`,
        [claimed.rows.map((row) => row.id), workerId.slice(0, 160)],
      );
    }
    await client.query("COMMIT");
    return claimed.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
