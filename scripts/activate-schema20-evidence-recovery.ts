import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";

type Mode = "status" | "dry-run" | "apply";

const CONSTRAINT_NAME = "playlist_qualification_candidate_required_v1";
const ROUTE_TRIGGER_NAME =
  "contract3_execution_route_receipt_required_v1";
const ROUTE_TRIGGER_FUNCTION =
  "enforce_contract3_execution_route_receipt_v1";
const LEGACY_UNBOUND_TRIGGER_NAME =
  "legacy_unbound_qualification_immutable_v1";
const LEGACY_UNBOUND_TRIGGER_FUNCTION =
  "enforce_legacy_unbound_qualification_immutable_v1";
const RECOVERY_VERSION = "3";
const RECEIPT_VERSION = "schema20-evidence-recovery-receipt/v3";
const ENFORCEMENT_POLICY =
  "new_candidate_binding_legacy_unbound_immutability_and_executable_route_receipts";
const LEGACY_ROWS_POLICY =
  "preserved_read_only_recovery_requires_linked_successor";
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const LEGACY_UNBOUND_TRIGGER_BODY = `BEGIN
  RAISE EXCEPTION
    'Legacy null-bound qualification observations are immutable'
    USING ERRCODE='23514',
          CONSTRAINT='${LEGACY_UNBOUND_TRIGGER_NAME}';
END`;
const ROUTE_TRIGGER_BODY = `BEGIN
  IF NEW.run_id IS NOT NULL
     AND NEW.kind IN ('research','matching','publication')
     AND NOT EXISTS (
       SELECT 1
       FROM research_checkpoints checkpoint
       WHERE checkpoint.run_id=NEW.run_id
         AND checkpoint.phase='execution_route_receipt_v1'
         AND checkpoint.state_json->>'version'
           ='execution_route_receipt_v1'
         AND checkpoint.state_json->>'executionRoute'
           =NEW.pipeline_version
         AND checkpoint.state_json->>'receiptHash'
           ~ '^[0-9a-f]{64}$'
     )
  THEN
    RAISE EXCEPTION
      'Executable run work requires an execution route receipt'
      USING ERRCODE='23514',
            CONSTRAINT='${ROUTE_TRIGGER_NAME}';
  END IF;
  RETURN NEW;
END`;

function workerStaleSeconds(): number {
  const configured = Number(process.env.WORKER_STALE_SECONDS ?? 90);
  return Number.isFinite(configured)
    ? Math.max(30, Math.min(Math.floor(configured), 600))
    : 90;
}

function parseMode(): {
  mode: Mode;
  receiptHash: string | null;
  expectedRevision: string | null;
  expectedSemanticConfigurationHash: string | null;
} {
  const mode = process.argv[2] ?? "status";
  if (!["status", "dry-run", "apply"].includes(mode)) {
    throw new Error(
      "usage: activate-schema20-evidence-recovery.ts "
      + "[status|dry-run|apply] [expected-receipt-hash]",
    );
  }
  const expectedRevision =
    process.env.EXPECTED_RELEASE_REVISION?.trim().toLowerCase() || null;
  const expectedSemanticConfigurationHash =
    process.env.EXPECTED_SEMANTIC_CONFIGURATION_HASH?.trim().toLowerCase()
    || null;
  return {
    mode: mode as Mode,
    receiptHash: process.argv[3]?.trim().toLowerCase() || null,
    expectedRevision,
    expectedSemanticConfigurationHash,
  };
}

export function schema20EvidenceRecoveryDatabaseConfig(): pg.ClientConfig {
  const publicUrl = process.env.DATABASE_PUBLIC_URL?.trim();
  if (publicUrl) {
    return {
      connectionString: publicUrl,
      ssl: { rejectUnauthorized: false },
    };
  }
  const internal = process.env.DATABASE_URL?.trim();
  if (internal) return { connectionString: internal };
  throw new Error("database_url_missing");
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export interface Schema20EvidenceRecoveryPreflight {
  schemaVersion: string | null;
  recoveryVersion: string | null;
  constraintPresent: boolean;
  constraintValidated: boolean;
  constraintDefinitionValid: boolean;
  routeTriggerPresent: boolean;
  routeTriggerDefinitionValid: boolean;
  legacyUnboundImmutabilityTriggerPresent: boolean;
  legacyUnboundImmutabilityTriggerDefinitionValid: boolean;
  publicAssignmentPaused: boolean;
  hardSwitchEngaged: boolean;
  activeV3Jobs: number;
  activeV3Attempts: number;
  activePublicationReconciliations: number;
  workerStaleSeconds: number;
  liveWorkers: Array<{
    workerId: string;
    protocolNumber: number;
    queueClass: string | null;
    observedSchemaVersion: string | null;
    executorRevision: string | null;
    semanticConfigurationHash: string | null;
  }>;
  violations: string[];
}

async function existingActivationReceiptHash(
  client: pg.Client,
  observed: Schema20EvidenceRecoveryPreflight,
  expectedRevision: string | null,
  expectedSemanticConfigurationHash: string | null,
): Promise<string | null> {
  if (observed.recoveryVersion !== RECOVERY_VERSION) return null;
  const active = await client.query<{ value: string }>(
    `SELECT value
     FROM settings
     WHERE key='schema20_evidence_recovery_active_receipt_hash'
     FOR UPDATE`,
  );
  const receiptHash = active.rows[0]?.value?.trim().toLowerCase() ?? "";
  if (!HASH_PATTERN.test(receiptHash)) {
    throw new Error("schema20_evidence_recovery_active_receipt_missing");
  }
  const persisted = await client.query<{ value: string }>(
    `SELECT value
     FROM settings
     WHERE key=$1
     FOR UPDATE`,
    [`schema20_evidence_recovery_receipt:${receiptHash}`],
  );
  let receipt: Record<string, unknown>;
  try {
    const parsed = JSON.parse(persisted.rows[0]?.value ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid");
    }
    receipt = parsed as Record<string, unknown>;
  } catch {
    throw new Error("schema20_evidence_recovery_receipt_missing");
  }
  const target = receipt.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("schema20_evidence_recovery_receipt_target_invalid");
  }
  const targetRecord = target as Record<string, unknown>;
  if (
    hash(receipt) !== receiptHash
    || receipt.receiptVersion !== RECEIPT_VERSION
    || targetRecord.constraint !== CONSTRAINT_NAME
    || targetRecord.routeTrigger !== ROUTE_TRIGGER_NAME
    || targetRecord.legacyUnboundImmutabilityTrigger
      !== LEGACY_UNBOUND_TRIGGER_NAME
    || targetRecord.enforcement !== ENFORCEMENT_POLICY
    || targetRecord.legacyRows !== LEGACY_ROWS_POLICY
    || targetRecord.minimumWorkerProtocol !== 12
    || targetRecord.workerStaleSeconds !== observed.workerStaleSeconds
    || targetRecord.releaseRevision !== expectedRevision
    || targetRecord.semanticConfigurationHash
      !== expectedSemanticConfigurationHash
  ) {
    throw new Error("schema20_evidence_recovery_receipt_target_mismatch");
  }
  return receiptHash;
}

export async function schema20EvidenceRecoveryPreflight(
  client: pg.Client,
  expectedRevision: string | null,
  expectedSemanticConfigurationHash: string | null,
): Promise<Schema20EvidenceRecoveryPreflight> {
  const staleSeconds = workerStaleSeconds();
  const settings = await client.query<{ key: string; value: string }>(
    `SELECT key,value FROM settings
     WHERE key IN (
       'schema_version',
       'schema20_evidence_recovery_version',
       'pipeline_v3_public_assignment_paused'
     )
     ORDER BY key
     FOR UPDATE`,
  );
  const setting = new Map(settings.rows.map(({ key, value }) => [key, value]));
  const hardSwitch = await client.query<{ disabled: boolean }>(
    `SELECT disabled
     FROM pipeline_cohort_kill_switches
     WHERE route='corpus_first_v3'
       AND intent_group='editorial_influence'
     FOR UPDATE`,
  );
  const jobs = await client.query<{ count: number }>(
    `SELECT count(*)::int count
     FROM job_queue
     WHERE pipeline_version='corpus_first_v3'
       AND status IN ('queued','retry','leased')`,
  );
  const attempts = await client.query<{ count: number }>(
    `SELECT count(*)::int count
     FROM playlist_execution_attempts attempt
     JOIN research_runs run ON run.id=attempt.run_id
     WHERE run.pipeline_version='corpus_first_v3'
       AND attempt.status='running'`,
  );
  const reconciliations = await client.query<{ count: number }>(
    `SELECT count(*)::int count
     FROM playlist_publication_reconciliations reconciliation
     JOIN manifests manifest ON manifest.id=reconciliation.manifest_id
     JOIN research_runs run ON run.id=manifest.run_id
     WHERE run.pipeline_version='corpus_first_v3'
       AND reconciliation.state NOT IN (
         'complete','cancelled','quarantined'
       )`,
  );
  const heartbeat = await client.query<{
    worker_id: string;
    protocol_number: string | null;
    queue_class: string | null;
    observed_schema_version: string | null;
    executor_revision: string | null;
    semantic_configuration_hash: string | null;
  }>(
    `SELECT worker_id,
            metadata_json->>'protocolNumber' protocol_number,
            metadata_json->>'queueClass' queue_class,
            metadata_json->>'observedSchemaVersion' observed_schema_version,
            metadata_json->>'version' executor_revision,
            metadata_json->>'semanticExecutionConfigurationHash'
              semantic_configuration_hash
     FROM worker_heartbeats
     WHERE last_seen_at>now()-($1::text || ' seconds')::interval
       AND capacity>0
     ORDER BY worker_id
     FOR SHARE`,
    [String(staleSeconds)],
  );
  const liveWorkers = heartbeat.rows.map((row) => ({
    workerId: row.worker_id,
    protocolNumber: Number(row.protocol_number ?? 0),
    queueClass: row.queue_class,
    observedSchemaVersion: row.observed_schema_version,
    executorRevision: row.executor_revision?.toLowerCase() ?? null,
    semanticConfigurationHash:
      row.semantic_configuration_hash?.toLowerCase() ?? null,
  }));
  const constraint = await client.query<{
    present: boolean;
    validated: boolean | null;
    definition_valid: boolean | null;
  }>(
    `SELECT EXISTS(
       SELECT 1
       FROM pg_constraint
       WHERE conrelid='playlist_qualification_records'::regclass
         AND conname=$1
     ) present,
     (
       SELECT convalidated
       FROM pg_constraint
       WHERE conrelid='playlist_qualification_records'::regclass
         AND conname=$1
     ) validated,
     (
       SELECT regexp_replace(
                pg_get_expr(conbin,conrelid),
                '[[:space:]]+','','g'
              )='(candidate_idISNOTNULL)'
       FROM pg_constraint
       WHERE conrelid='playlist_qualification_records'::regclass
         AND conname=$1
         AND contype='c'
     ) definition_valid`,
    [CONSTRAINT_NAME],
  );
  const constraintPresent = constraint.rows[0]?.present === true;
  const constraintValidated = constraint.rows[0]?.validated === true;
  const constraintDefinitionValid =
    constraint.rows[0]?.definition_valid === true;
  const routeTrigger = await client.query<{
    present: boolean;
    definition_valid: boolean | null;
  }>(
    `SELECT EXISTS(
       SELECT 1
       FROM pg_trigger
       WHERE tgrelid='job_queue'::regclass
         AND tgname=$1
         AND NOT tgisinternal
     ) present,
     (
       SELECT trigger.tgtype=23
          AND trigger.tgqual IS NULL
          AND procedure.proname=$2
          AND procedure.prosrc=$3
          AND (
            SELECT count(*)=3
               AND bool_and(
                 attribute.attname=ANY(
                   ARRAY['run_id','kind','pipeline_version']::name[]
                 )
               )
            FROM unnest(trigger.tgattr::smallint[])
              WITH ORDINALITY selected(attnum,ordinality)
            JOIN pg_attribute attribute
              ON attribute.attrelid=trigger.tgrelid
             AND attribute.attnum=selected.attnum
          )
       FROM pg_trigger trigger
       JOIN pg_proc procedure ON procedure.oid=trigger.tgfoid
       WHERE trigger.tgrelid='job_queue'::regclass
         AND trigger.tgname=$1
         AND NOT trigger.tgisinternal
     ) definition_valid`,
    [ROUTE_TRIGGER_NAME, ROUTE_TRIGGER_FUNCTION, ROUTE_TRIGGER_BODY],
  );
  const routeTriggerPresent = routeTrigger.rows[0]?.present === true;
  const routeTriggerDefinitionValid =
    routeTrigger.rows[0]?.definition_valid === true;
  const legacyUnboundTrigger = await client.query<{
    present: boolean;
    definition_valid: boolean | null;
  }>(
    `SELECT EXISTS(
       SELECT 1
       FROM pg_trigger
       WHERE tgrelid='playlist_qualification_records'::regclass
         AND tgname=$1
         AND NOT tgisinternal
     ) present,
     (
       SELECT trigger.tgtype=19
          AND trigger.tgqual IS NOT NULL
          AND regexp_replace(
                lower(pg_get_expr(trigger.tgqual,trigger.tgrelid)),
                '[[:space:]]+','','g'
              )='(candidate_idisnull)'
          AND procedure.proname=$2
          AND procedure.prosrc=$3
       FROM pg_trigger trigger
       JOIN pg_proc procedure ON procedure.oid=trigger.tgfoid
       WHERE trigger.tgrelid='playlist_qualification_records'::regclass
         AND trigger.tgname=$1
         AND NOT trigger.tgisinternal
     ) definition_valid`,
    [
      LEGACY_UNBOUND_TRIGGER_NAME,
      LEGACY_UNBOUND_TRIGGER_FUNCTION,
      LEGACY_UNBOUND_TRIGGER_BODY,
    ],
  );
  const legacyUnboundImmutabilityTriggerPresent =
    legacyUnboundTrigger.rows[0]?.present === true;
  const legacyUnboundImmutabilityTriggerDefinitionValid =
    legacyUnboundTrigger.rows[0]?.definition_valid === true;
  const result: Omit<Schema20EvidenceRecoveryPreflight, "violations"> = {
    schemaVersion: setting.get("schema_version") ?? null,
    recoveryVersion:
      setting.get("schema20_evidence_recovery_version") ?? null,
    constraintPresent,
    constraintValidated,
    constraintDefinitionValid,
    routeTriggerPresent,
    routeTriggerDefinitionValid,
    legacyUnboundImmutabilityTriggerPresent,
    legacyUnboundImmutabilityTriggerDefinitionValid,
    publicAssignmentPaused:
      setting.get("pipeline_v3_public_assignment_paused") === "true",
    hardSwitchEngaged:
      hardSwitch.rows.length === 1 && hardSwitch.rows[0]!.disabled === true,
    activeV3Jobs: Number(jobs.rows[0]?.count ?? 0),
    activeV3Attempts: Number(attempts.rows[0]?.count ?? 0),
    activePublicationReconciliations:
      Number(reconciliations.rows[0]?.count ?? 0),
    workerStaleSeconds: staleSeconds,
    liveWorkers,
  };
  const violations: string[] = [];
  if (result.schemaVersion !== "20") violations.push("schema_not_20");
  if (result.constraintPresent && result.constraintValidated) {
    violations.push("candidate_constraint_unexpectedly_validated");
  }
  if (result.constraintPresent && !result.constraintDefinitionValid) {
    violations.push("candidate_constraint_definition_mismatch");
  }
  if (result.routeTriggerPresent && !result.routeTriggerDefinitionValid) {
    violations.push("route_trigger_definition_mismatch");
  }
  if (result.legacyUnboundImmutabilityTriggerPresent
    && !result.legacyUnboundImmutabilityTriggerDefinitionValid) {
    violations.push("legacy_unbound_trigger_definition_mismatch");
  }
  if (!result.publicAssignmentPaused) {
    violations.push("public_assignment_not_paused");
  }
  if (!result.hardSwitchEngaged) {
    violations.push("route_hard_switch_not_engaged");
  }
  if (result.activeV3Jobs !== 0) violations.push("active_v3_jobs");
  if (result.activeV3Attempts !== 0) violations.push("active_v3_attempts");
  if (result.activePublicationReconciliations !== 0) {
    violations.push("active_publication_reconciliations");
  }
  if (liveWorkers.some(({ protocolNumber }) => protocolNumber < 12)) {
    violations.push("eligible_pre_protocol_12_worker");
  }
  if (liveWorkers.some(
    ({ observedSchemaVersion }) => observedSchemaVersion !== "20",
  )) {
    violations.push("worker_observed_schema_mismatch");
  }
  const liveLanes = new Set(liveWorkers.map(({ queueClass }) => queueClass));
  if (!liveLanes.has("interactive") || !liveLanes.has("deep")) {
    violations.push("protocol_12_worker_lanes_missing");
  }
  const interactiveCount = liveWorkers.filter(
    ({ queueClass }) => queueClass === "interactive",
  ).length;
  const deepCount = liveWorkers.filter(
    ({ queueClass }) => queueClass === "deep",
  ).length;
  if (liveWorkers.length !== 2
    || interactiveCount !== 1
    || deepCount !== 1) {
    violations.push("eligible_worker_lane_cardinality_mismatch");
  }
  if (expectedRevision === null || !REVISION_PATTERN.test(expectedRevision)) {
    violations.push("expected_release_revision_missing");
  } else if (liveWorkers.some(
    ({ executorRevision }) => executorRevision !== expectedRevision,
  )) {
    violations.push("worker_release_revision_mismatch");
  }
  if (expectedSemanticConfigurationHash === null
    || !HASH_PATTERN.test(expectedSemanticConfigurationHash)) {
    violations.push("expected_semantic_configuration_hash_missing");
  } else if (liveWorkers.some(
    ({ semanticConfigurationHash }) => (
      semanticConfigurationHash !== expectedSemanticConfigurationHash
    ),
  )) {
    violations.push("worker_semantic_configuration_mismatch");
  }
  return { ...result, violations };
}

export async function executeSchema20EvidenceRecoveryTransition(
  client: pg.Client,
  mode: Mode,
  expectedReceiptHash: string | null,
  expectedRevision: string | null,
  expectedSemanticConfigurationHash: string | null,
): Promise<Record<string, unknown>> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('schema20-evidence-recovery-v1'))",
    );
    const observed = await schema20EvidenceRecoveryPreflight(
      client,
      expectedRevision,
      expectedSemanticConfigurationHash,
    );
    const priorReceiptHash = await existingActivationReceiptHash(
      client,
      observed,
      expectedRevision,
      expectedSemanticConfigurationHash,
    );
    if (priorReceiptHash !== null) {
      if (!observed.constraintPresent
        || observed.constraintValidated
        || !observed.constraintDefinitionValid
        || !observed.routeTriggerPresent
        || !observed.routeTriggerDefinitionValid
        || !observed.legacyUnboundImmutabilityTriggerPresent
        || !observed.legacyUnboundImmutabilityTriggerDefinitionValid) {
        throw new Error(
          "schema20_evidence_recovery_existing_activation_invalid",
        );
      }
      if (mode === "apply"
        && expectedReceiptHash !== priorReceiptHash) {
        throw new Error("schema20_evidence_recovery_receipt_hash_mismatch");
      }
      await client.query("ROLLBACK");
      return mode === "apply"
        ? {
            mode,
            applied: true,
            alreadyApplied: true,
            receiptHash: priorReceiptHash,
            constraint: CONSTRAINT_NAME,
            constraintValidated: false,
            routeTrigger: ROUTE_TRIGGER_NAME,
            legacyUnboundImmutabilityTrigger:
              LEGACY_UNBOUND_TRIGGER_NAME,
          }
        : {
            mode,
            safeToApply: true,
            alreadyApplied: true,
            receiptHash: priorReceiptHash,
          };
    }
    const receipt = {
      receiptVersion: RECEIPT_VERSION,
      observed,
      target: {
        constraint: CONSTRAINT_NAME,
        routeTrigger: ROUTE_TRIGGER_NAME,
        legacyUnboundImmutabilityTrigger:
          LEGACY_UNBOUND_TRIGGER_NAME,
        enforcement: ENFORCEMENT_POLICY,
        legacyRows: LEGACY_ROWS_POLICY,
        minimumWorkerProtocol: 12,
        workerStaleSeconds: observed.workerStaleSeconds,
        releaseRevision: expectedRevision,
        semanticConfigurationHash: expectedSemanticConfigurationHash,
      },
    };
    const receiptHash = hash(receipt);
    if (mode === "status") {
      await client.query("ROLLBACK");
      return {
        mode,
        safeToApply: observed.violations.length === 0,
        receiptHash,
        receipt,
      };
    }
    if (observed.violations.length > 0) {
      throw new Error(
        `schema20_evidence_recovery_preflight_failed:${
          observed.violations.join(",")
        }`,
      );
    }
    if (mode === "dry-run") {
      await client.query("ROLLBACK");
      return { mode, safeToApply: true, receiptHash, receipt };
    }
    if (!expectedReceiptHash || expectedReceiptHash !== receiptHash) {
      throw new Error("schema20_evidence_recovery_receipt_hash_mismatch");
    }
    if (!observed.constraintPresent) {
      await client.query(
        `ALTER TABLE playlist_qualification_records
         ADD CONSTRAINT ${CONSTRAINT_NAME}
         CHECK (candidate_id IS NOT NULL) NOT VALID`,
      );
    }
    await client.query(
      `CREATE OR REPLACE FUNCTION ${LEGACY_UNBOUND_TRIGGER_FUNCTION}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $function$${LEGACY_UNBOUND_TRIGGER_BODY}$function$`,
    );
    if (!observed.legacyUnboundImmutabilityTriggerPresent) {
      await client.query(
        `CREATE TRIGGER ${LEGACY_UNBOUND_TRIGGER_NAME}
         BEFORE UPDATE ON playlist_qualification_records
         FOR EACH ROW
         WHEN (OLD.candidate_id IS NULL)
         EXECUTE FUNCTION ${LEGACY_UNBOUND_TRIGGER_FUNCTION}()`,
      );
    }
    await client.query(
      `CREATE OR REPLACE FUNCTION ${ROUTE_TRIGGER_FUNCTION}()
         RETURNS trigger
         LANGUAGE plpgsql
         AS $function$${ROUTE_TRIGGER_BODY}$function$`,
    );
    if (!observed.routeTriggerPresent) {
      await client.query(
        `CREATE TRIGGER ${ROUTE_TRIGGER_NAME}
         BEFORE INSERT OR UPDATE OF run_id,kind,pipeline_version
         ON job_queue
         FOR EACH ROW
         EXECUTE FUNCTION ${ROUTE_TRIGGER_FUNCTION}()`,
      );
    }
    await client.query(
      `INSERT INTO settings(key,value)
       VALUES('schema20_evidence_recovery_version',$1)
       ON CONFLICT(key) DO UPDATE
       SET value=EXCLUDED.value,updated_at=now()`,
      [RECOVERY_VERSION],
    );
    const serializedReceipt = JSON.stringify(receipt);
    const insertedReceipt = await client.query<{ value: string }>(
      `INSERT INTO settings(key,value)
       VALUES($1,$2)
       ON CONFLICT(key) DO NOTHING
       RETURNING value`,
      [
        `schema20_evidence_recovery_receipt:${receiptHash}`,
        serializedReceipt,
      ],
    );
    const persistedReceipt = insertedReceipt.rows[0]?.value
      ?? (await client.query<{ value: string }>(
        `SELECT value
         FROM settings
         WHERE key=$1
         FOR UPDATE`,
        [`schema20_evidence_recovery_receipt:${receiptHash}`],
      )).rows[0]?.value;
    if (persistedReceipt !== serializedReceipt) {
      throw new Error("schema20_evidence_recovery_receipt_conflict");
    }
    await client.query(
      `INSERT INTO settings(key,value)
       VALUES('schema20_evidence_recovery_active_receipt_hash',$1)
       ON CONFLICT(key) DO UPDATE
       SET value=EXCLUDED.value,updated_at=now()`,
      [receiptHash],
    );
    await client.query("COMMIT");
    return {
      mode,
      applied: true,
      receiptHash,
      constraint: CONSTRAINT_NAME,
      constraintValidated: false,
      routeTrigger: ROUTE_TRIGGER_NAME,
      legacyUnboundImmutabilityTrigger: LEGACY_UNBOUND_TRIGGER_NAME,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function main(): Promise<void> {
  const {
    mode,
    receiptHash,
    expectedRevision,
    expectedSemanticConfigurationHash,
  } = parseMode();
  const client = new pg.Client(schema20EvidenceRecoveryDatabaseConfig());
  await client.connect();
  try {
    process.stdout.write(
      `${JSON.stringify(
        await executeSchema20EvidenceRecoveryTransition(
          client,
          mode,
          receiptHash,
          expectedRevision,
          expectedSemanticConfigurationHash,
        ),
        null,
        2,
      )}\n`,
    );
  } finally {
    await client.end();
  }
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
