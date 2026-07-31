import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";

type Mode = "status" | "dry-run" | "apply";

function parseMode(): { mode: Mode; receiptHash: string | null } {
  const mode = process.argv[2] ?? "status";
  if (!["status", "dry-run", "apply"].includes(mode)) {
    throw new Error(
      "usage: activate-schema20-proof-authority.ts "
      + "[status|dry-run|apply] [expected-receipt-hash]",
    );
  }
  return {
    mode: mode as Mode,
    receiptHash: process.argv[3]?.trim() || null,
  };
}

function databaseUrl(): string {
  const value = process.env.DATABASE_PUBLIC_URL?.trim()
    || process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("database_url_missing");
  return value;
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

export interface Schema20ProofAuthorityPreflight {
  schemaVersion: string | null;
  proofVersion: string | null;
  proofAuthority: string | null;
  backfillComplete: boolean;
  backfillPlanHash: string | null;
  publicAssignmentPaused: boolean;
  hardSwitchEngaged: boolean;
  activeV3Jobs: number;
  activeV3Attempts: number;
  activePublicationReconciliations: number;
  liveWorkers: Array<{
    workerId: string;
    protocolVersion: string | null;
    protocolNumber: number;
    queueClass: string | null;
    schemaVersion: string;
  }>;
  liveOldWorkerCount: number;
  liveProtocol12WorkerCount: number;
  violations: string[];
}

export async function schema20ProofAuthorityPreflight(
  client: pg.Client,
): Promise<Schema20ProofAuthorityPreflight> {
  const settings = await client.query<{ key: string; value: string }>(
    `SELECT key,value FROM settings
     WHERE key IN (
       'schema_version',
       'proof_architecture_version',
       'proof_architecture_authority',
       'schema20_backfill_complete_receipt',
       'pipeline_v3_public_assignment_paused'
     )
     ORDER BY key
     FOR UPDATE`,
  );
  const setting = new Map(settings.rows.map(({ key, value }) => [key, value]));
  const hardSwitch = await client.query<{ disabled: boolean }>(
    `SELECT disabled
     FROM pipeline_cohort_kill_switches
     WHERE route='corpus_first_v3' AND intent_group IS NULL
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
    schema_version: string;
    protocol_version: string | null;
    queue_class: string | null;
  }>(
    `SELECT worker_id,schema_version,
            metadata_json->>'protocolVersion' protocol_version,
            metadata_json->>'queueClass' queue_class
     FROM worker_heartbeats
     WHERE last_seen_at>now()-interval '5 minutes'
       AND capacity>0
     ORDER BY worker_id
     FOR SHARE`,
  );
  const liveWorkers = heartbeat.rows.map((row) => {
    const match = /^playlist-pipeline-v([0-9]+)$/u.exec(
      row.protocol_version ?? "",
    );
    return {
      workerId: row.worker_id,
      protocolVersion: row.protocol_version,
      protocolNumber: match ? Number(match[1]) : 0,
      queueClass: row.queue_class,
      schemaVersion: row.schema_version,
    };
  });
  let backfillReceipt: Record<string, unknown> | null = null;
  try {
    const raw = setting.get("schema20_backfill_complete_receipt");
    const parsed = raw ? JSON.parse(raw) : null;
    backfillReceipt = parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    backfillReceipt = null;
  }
  const result: Omit<Schema20ProofAuthorityPreflight, "violations"> = {
    schemaVersion: setting.get("schema_version") ?? null,
    proofVersion: setting.get("proof_architecture_version") ?? null,
    proofAuthority: setting.get("proof_architecture_authority") ?? null,
    backfillComplete:
      backfillReceipt?.receiptVersion
        === "schema20-proof-backfill-completion/v1"
      && typeof backfillReceipt.planHash === "string"
      && /^[0-9a-f]{64}$/u.test(backfillReceipt.planHash),
    backfillPlanHash: typeof backfillReceipt?.planHash === "string"
      ? backfillReceipt.planHash
      : null,
    publicAssignmentPaused:
      setting.get("pipeline_v3_public_assignment_paused") === "true",
    hardSwitchEngaged:
      hardSwitch.rows.length === 1 && hardSwitch.rows[0]!.disabled === true,
    activeV3Jobs: Number(jobs.rows[0]?.count ?? 0),
    activeV3Attempts: Number(attempts.rows[0]?.count ?? 0),
    activePublicationReconciliations:
      Number(reconciliations.rows[0]?.count ?? 0),
    liveWorkers,
    liveOldWorkerCount:
      liveWorkers.filter(({ protocolNumber }) => protocolNumber < 12).length,
    liveProtocol12WorkerCount:
      liveWorkers.filter(({ protocolNumber }) => protocolNumber >= 12).length,
  };
  const violations: string[] = [];
  if (result.schemaVersion !== "20") violations.push("schema_not_20");
  if (result.proofVersion !== "1") {
    violations.push("proof_architecture_marker_missing");
  }
  if (!["shadow", "native"].includes(result.proofAuthority ?? "")) {
    violations.push("proof_authority_invalid");
  }
  if (!result.backfillComplete) {
    violations.push("schema20_backfill_not_complete");
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
  if (result.liveOldWorkerCount !== 0) {
    violations.push("eligible_pre_protocol_12_worker");
  }
  if (result.liveProtocol12WorkerCount < 2) {
    violations.push("protocol_12_worker_lanes_missing");
  }
  return { ...result, violations };
}

export async function executeSchema20ProofAuthorityTransition(
  client: pg.Client,
  mode: Mode,
  expectedReceiptHash: string | null,
): Promise<Record<string, unknown>> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('schema20-native-proof-authority-v1'))",
    );
    const observed = await schema20ProofAuthorityPreflight(client);
    const receipt = {
      schemaVersion: "schema20-native-proof-authority-receipt/v1",
      observed,
      target: {
        proofAuthority: "native",
        minimumWorkerProtocol: 12,
        contentAttestationUniqueness: true,
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
        `schema20_native_preflight_failed:${
          observed.violations.join(",")
        }`,
      );
    }
    if (mode === "dry-run") {
      await client.query("ROLLBACK");
      return { mode, safeToApply: true, receiptHash, receipt };
    }
    if (!expectedReceiptHash || expectedReceiptHash !== receiptHash) {
      throw new Error("schema20_native_receipt_hash_mismatch");
    }
    await client.query(
      `UPDATE settings SET value='native',updated_at=now()
       WHERE key='proof_architecture_authority'
         AND value IN ('shadow','native')`,
    );
    await client.query("DROP INDEX IF EXISTS manifest_revision_hash_idx");
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS
         manifest_revision_content_attestation_idx
       ON manifest_revisions(
         manifest_id,content_hash,COALESCE(attestation_set_hash,'legacy')
       )`,
    );
    await client.query(
      `INSERT INTO settings(key,value)
       VALUES($1,$2)
       ON CONFLICT(key) DO NOTHING`,
      [
        `schema20_native_activation_receipt:${receiptHash}`,
        JSON.stringify(receipt),
      ],
    );
    await client.query("COMMIT");
    return {
      mode,
      applied: true,
      receiptHash,
      proofAuthority: "native",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function main(): Promise<void> {
  const { mode, receiptHash } = parseMode();
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    process.stdout.write(
      `${JSON.stringify(
        await executeSchema20ProofAuthorityTransition(client, mode, receiptHash),
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
