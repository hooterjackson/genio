import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";

type Mode = "status" | "dry-run" | "apply";

interface Arguments {
  mode: Mode;
  expectedPlanHash: string | null;
  idempotencyKey: string | null;
}

function parseArguments(): Arguments {
  const mode = process.argv[2] ?? "status";
  if (!["status", "dry-run", "apply"].includes(mode)) {
    throw new Error(
      "usage: backfill-schema20-proof-architecture.ts "
      + "[status|dry-run|apply] [expected-plan-hash] [idempotency-key]",
    );
  }
  return {
    mode: mode as Mode,
    expectedPlanHash: process.argv[3]?.trim() || null,
    idempotencyKey: process.argv[4]?.trim() || null,
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

interface LegacyManifestRow {
  manifest_revision_id: string;
  resolution_state: string | null;
  proof_kind: string | null;
  selection_set_id: string | null;
  attestation_set_hash: string | null;
  complete_reconciliation_count: number;
  valid_reconciliation_count: number;
  invalid_reconciliation_count: number;
  distinct_reconciliation_hash_count: number;
  expected_ordered_ids_hash: string | null;
  observed_ordered_ids_hash: string | null;
  reconciled_count: number | null;
  published_volume_count: number;
  appended_volume_count: number;
  existing_receipt_hash: string | null;
}

interface LegacyPublishedReceiptPlan {
  manifestRevisionId: string;
  receiptHash: string;
  expectedOrderedIdsHash: string | null;
  observedOrderedIdsHash: string | null;
  reconciledCount: number | null;
  receipt: {
    receiptVersion: "schema20-legacy-published-receipt/v1";
    verification:
      | "verified_ordered_apple_readback"
      | "legacy_publication_not_natively_verified";
    expectedOrderedIdsHash: string | null;
    observedOrderedIdsHash: string | null;
    reconciledCount: number | null;
    legacyAppendedCount: number;
    nativeAttestationAuthority: false;
  };
}

export interface Schema20BackfillPlan {
  schemaVersion: string | null;
  proofVersion: string | null;
  proofAuthority: string | null;
  publicAssignmentPaused: boolean;
  hardSwitchEngaged: boolean;
  activeV3Jobs: number;
  activeV3Attempts: number;
  activePublicationReconciliations: number;
  nativeManifestCount: number;
  legacyPublishedVerifiedCount: number;
  legacyPublishedUnverifiedCount: number;
  terminalUnpublishedCount: number;
  successorRequiredCount: number;
  ambiguousOrTamperedCount: number;
  existingReceiptCount: number;
  plannedReceiptCount: number;
  manifestInventoryCommitment: string;
  receiptCommitment: string;
  violations: string[];
}

interface Schema20BackfillInternalPlan {
  publicPlan: Schema20BackfillPlan;
  receipts: LegacyPublishedReceiptPlan[];
}

function integer(value: unknown): number {
  return Math.max(0, Math.floor(Number(value ?? 0) || 0));
}

async function buildSchema20BackfillPlan(
  client: pg.Client,
): Promise<Schema20BackfillInternalPlan> {
  const settings = await client.query<{ key: string; value: string }>(
    `SELECT key,value FROM settings
     WHERE key IN (
       'schema_version',
       'proof_architecture_version',
       'proof_architecture_authority',
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
  const manifestRows = await client.query<LegacyManifestRow>(
    `SELECT
       revision.id manifest_revision_id,
       resolution.state resolution_state,
       revision.proof_kind,
       revision.selection_set_id,
       revision.attestation_set_hash,
       COALESCE(reconciliation.complete_count,0)::int
         complete_reconciliation_count,
       COALESCE(reconciliation.valid_count,0)::int
         valid_reconciliation_count,
       COALESCE(reconciliation.invalid_count,0)::int
         invalid_reconciliation_count,
       COALESCE(reconciliation.distinct_hash_count,0)::int
         distinct_reconciliation_hash_count,
       reconciliation.expected_ordered_ids_hash,
       reconciliation.observed_ordered_ids_hash,
       reconciliation.reconciled_count,
       (
         COALESCE(legacy_volume.published_count,0)
         + COALESCE(revision_volume.published_count,0)
       )::int published_volume_count,
       (
         COALESCE(legacy_volume.appended_count,0)
         + COALESCE(revision_volume.appended_count,0)
       )::int appended_volume_count,
       receipt.receipt_hash existing_receipt_hash
     FROM manifest_revisions revision
     JOIN manifests manifest ON manifest.id=revision.manifest_id
     LEFT JOIN playlist_run_resolutions resolution
       ON resolution.run_id=manifest.run_id
     LEFT JOIN LATERAL (
       SELECT
         count(*) FILTER (WHERE state='complete')::int complete_count,
         count(*) FILTER (
           WHERE state='complete'
             AND observed_ordered_ids_hash=expected_ordered_ids_hash
             AND appended_count=expected_count
         )::int valid_count,
         count(*) FILTER (
           WHERE state='complete'
             AND (
               observed_ordered_ids_hash IS NULL
               OR observed_ordered_ids_hash<>expected_ordered_ids_hash
               OR appended_count<>expected_count
             )
         )::int invalid_count,
         count(DISTINCT (
           expected_ordered_ids_hash,
           observed_ordered_ids_hash,
           expected_count,
           appended_count
         )) FILTER (WHERE state='complete')::int distinct_hash_count,
         max(expected_ordered_ids_hash)
           FILTER (WHERE state='complete')
           expected_ordered_ids_hash,
         max(observed_ordered_ids_hash)
           FILTER (WHERE state='complete')
           observed_ordered_ids_hash,
         max(expected_count)
           FILTER (WHERE state='complete')
           reconciled_count
       FROM playlist_publication_reconciliations
       WHERE manifest_revision_id=revision.id
     ) reconciliation ON true
     LEFT JOIN LATERAL (
       SELECT
         count(*) FILTER (WHERE published_at IS NOT NULL)::int published_count,
         COALESCE(sum(appended_count),0)::int appended_count
       FROM publication_volumes
       WHERE manifest_revision_id=revision.id
     ) legacy_volume ON true
     LEFT JOIN LATERAL (
       SELECT
         count(*) FILTER (WHERE volume.published_at IS NOT NULL)::int
           published_count,
         COALESCE(sum(volume.appended_count),0)::int appended_count
       FROM publication_revision_attempts attempt
       JOIN publication_revision_volumes volume
         ON volume.publication_attempt_id=attempt.id
       WHERE attempt.manifest_revision_id=revision.id
     ) revision_volume ON true
     LEFT JOIN legacy_published_receipts receipt
       ON receipt.manifest_revision_id=revision.id
     WHERE revision.pipeline_version='corpus_first_v3'
     ORDER BY revision.id`,
  );

  let nativeManifestCount = 0;
  let successorRequiredCount = 0;
  let ambiguousOrTamperedCount = 0;
  let existingReceiptCount = 0;
  let legacyPublishedVerifiedCount = 0;
  let legacyPublishedUnverifiedCount = 0;
  let terminalUnpublishedCount = 0;
  const receipts: LegacyPublishedReceiptPlan[] = [];
  const inventory: Array<Record<string, unknown>> = [];

  for (const row of manifestRows.rows) {
    const completeProof = row.selection_set_id !== null
      && row.attestation_set_hash !== null
      && ["shadow", "native"].includes(row.proof_kind ?? "");
    const partialProof = [
      row.selection_set_id,
      row.attestation_set_hash,
      row.proof_kind,
    ].filter((value) => value !== null).length;
    const published = integer(row.complete_reconciliation_count) > 0
      || integer(row.published_volume_count) > 0;
    let classification: string;

    if (completeProof && row.proof_kind === "native") {
      nativeManifestCount += 1;
      classification = "native";
    } else if (partialProof > 0 && !completeProof) {
      ambiguousOrTamperedCount += 1;
      classification = "partial_proof_binding";
    } else if (
      integer(row.invalid_reconciliation_count) > 0
      || integer(row.distinct_reconciliation_hash_count) > 1
    ) {
      ambiguousOrTamperedCount += 1;
      classification = "publication_reconciliation_mismatch";
    } else if (published) {
      const verified = integer(row.valid_reconciliation_count) > 0;
      if (verified) legacyPublishedVerifiedCount += 1;
      else legacyPublishedUnverifiedCount += 1;
      classification = verified
        ? "legacy_published_verified"
        : "legacy_published_unverified";
      const receipt = {
        receiptVersion: "schema20-legacy-published-receipt/v1" as const,
        verification: verified
          ? "verified_ordered_apple_readback" as const
          : "legacy_publication_not_natively_verified" as const,
        expectedOrderedIdsHash: verified
          ? row.expected_ordered_ids_hash
          : null,
        observedOrderedIdsHash: verified
          ? row.observed_ordered_ids_hash
          : null,
        reconciledCount: verified ? integer(row.reconciled_count) : null,
        legacyAppendedCount: Math.max(
          integer(row.appended_volume_count),
          verified ? integer(row.reconciled_count) : 0,
        ),
        nativeAttestationAuthority: false as const,
      };
      const receiptHash = hash({
        domain: "genio/schema20/legacy-published-receipt/v1",
        manifestRevisionId: row.manifest_revision_id,
        receipt,
      });
      if (row.existing_receipt_hash) {
        existingReceiptCount += 1;
        if (row.existing_receipt_hash !== receiptHash) {
          ambiguousOrTamperedCount += 1;
          classification = "legacy_receipt_conflict";
        }
      } else {
        receipts.push({
          manifestRevisionId: row.manifest_revision_id,
          receiptHash,
          expectedOrderedIdsHash: receipt.expectedOrderedIdsHash,
          observedOrderedIdsHash: receipt.observedOrderedIdsHash,
          reconciledCount: receipt.reconciledCount,
          receipt,
        });
      }
    } else if (
      row.resolution_state === "quarantined"
      || row.resolution_state === "cancelled"
      || row.resolution_state === "needs_decision"
    ) {
      terminalUnpublishedCount += 1;
      classification = `legacy_unpublished_${row.resolution_state}`;
    } else {
      successorRequiredCount += 1;
      classification = completeProof && row.proof_kind === "shadow"
        ? "shadow_successor_required"
        : "legacy_successor_required";
    }
    inventory.push({
      revisionCommitment: hash({
        domain: "genio/schema20/manifest-inventory/v1",
        manifestRevisionId: row.manifest_revision_id,
      }),
      classification,
      completeReconciliationCount:
        integer(row.complete_reconciliation_count),
      publishedVolumeCount: integer(row.published_volume_count),
    });
  }

  const base = {
    schemaVersion: setting.get("schema_version") ?? null,
    proofVersion: setting.get("proof_architecture_version") ?? null,
    proofAuthority: setting.get("proof_architecture_authority") ?? null,
    publicAssignmentPaused:
      setting.get("pipeline_v3_public_assignment_paused") === "true",
    hardSwitchEngaged:
      hardSwitch.rows.length === 1 && hardSwitch.rows[0]!.disabled === true,
    activeV3Jobs: integer(jobs.rows[0]?.count),
    activeV3Attempts: integer(attempts.rows[0]?.count),
    activePublicationReconciliations:
      integer(reconciliations.rows[0]?.count),
    nativeManifestCount,
    legacyPublishedVerifiedCount,
    legacyPublishedUnverifiedCount,
    terminalUnpublishedCount,
    successorRequiredCount,
    ambiguousOrTamperedCount,
    existingReceiptCount,
    plannedReceiptCount: receipts.length,
    manifestInventoryCommitment: hash(inventory),
    receiptCommitment: hash(receipts.map(({ receiptHash }) => receiptHash)),
  };
  const violations: string[] = [];
  if (base.schemaVersion !== "20") violations.push("schema_not_20");
  if (base.proofVersion !== "1") {
    violations.push("proof_architecture_marker_missing");
  }
  if (base.proofAuthority !== "shadow") {
    violations.push("proof_authority_not_shadow");
  }
  if (!base.publicAssignmentPaused) {
    violations.push("public_assignment_not_paused");
  }
  if (!base.hardSwitchEngaged) {
    violations.push("route_hard_switch_not_engaged");
  }
  if (base.activeV3Jobs !== 0) violations.push("active_v3_jobs");
  if (base.activeV3Attempts !== 0) violations.push("active_v3_attempts");
  if (base.activePublicationReconciliations !== 0) {
    violations.push("active_publication_reconciliations");
  }
  if (base.ambiguousOrTamperedCount !== 0) {
    violations.push("ambiguous_or_tampered_manifest");
  }
  if (base.successorRequiredCount !== 0) {
    violations.push("unpublished_manifest_successor_required");
  }
  return {
    publicPlan: { ...base, violations },
    receipts,
  };
}

export async function schema20BackfillPreflight(
  client: pg.Client,
): Promise<Schema20BackfillPlan> {
  return (await buildSchema20BackfillPlan(client)).publicPlan;
}

export async function executeSchema20ProofBackfill(
  client: pg.Client,
  mode: Mode,
  expectedPlanHash: string | null,
  idempotencyKey: string | null,
): Promise<Record<string, unknown>> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('schema20-proof-backfill-v1'))",
    );
    const { publicPlan, receipts } = await buildSchema20BackfillPlan(client);
    const planHash = hash({
      planVersion: "schema20-proof-backfill-plan/v1",
      plan: publicPlan,
    });
    if (mode === "status") {
      await client.query("ROLLBACK");
      return {
        mode,
        safeToApply: publicPlan.violations.length === 0,
        planHash,
        plan: publicPlan,
      };
    }
    if (publicPlan.violations.length > 0) {
      throw new Error(
        `schema20_backfill_preflight_failed:${
          publicPlan.violations.join(",")
        }`,
      );
    }
    if (mode === "dry-run") {
      await client.query("ROLLBACK");
      return { mode, safeToApply: true, planHash, plan: publicPlan };
    }
    if (!expectedPlanHash || expectedPlanHash !== planHash) {
      throw new Error("schema20_backfill_plan_hash_mismatch");
    }
    if (!idempotencyKey || !/^[a-zA-Z0-9._:-]{8,120}$/u.test(idempotencyKey)) {
      throw new Error("schema20_backfill_idempotency_key_invalid");
    }

    for (const receipt of receipts) {
      await client.query(
        `INSERT INTO legacy_published_receipts(
           manifest_revision_id,receipt_hash,expected_ordered_ids_hash,
           observed_ordered_ids_hash,reconciled_count,receipt_json
         ) VALUES($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT(manifest_revision_id) DO NOTHING`,
        [
          receipt.manifestRevisionId,
          receipt.receiptHash,
          receipt.expectedOrderedIdsHash,
          receipt.observedOrderedIdsHash,
          receipt.reconciledCount,
          JSON.stringify(receipt.receipt),
        ],
      );
    }
    const completionReceipt = {
      receiptVersion: "schema20-proof-backfill-completion/v1",
      planHash,
      idempotencyKey,
      manifestInventoryCommitment: publicPlan.manifestInventoryCommitment,
      receiptCommitment: publicPlan.receiptCommitment,
      legacyPublishedVerifiedCount:
        publicPlan.legacyPublishedVerifiedCount,
      legacyPublishedUnverifiedCount:
        publicPlan.legacyPublishedUnverifiedCount,
      terminalUnpublishedCount: publicPlan.terminalUnpublishedCount,
      nativeManifestCount: publicPlan.nativeManifestCount,
    };
    await client.query(
      `INSERT INTO settings(key,value)
       VALUES('schema20_backfill_complete_receipt',$1)
       ON CONFLICT(key) DO UPDATE SET
         value=CASE
           WHEN settings.value=excluded.value THEN settings.value
           ELSE settings.value
         END,
         updated_at=CASE
           WHEN settings.value=excluded.value THEN settings.updated_at
           ELSE settings.updated_at
         END`,
      [JSON.stringify(completionReceipt)],
    );
    const stored = await client.query<{ value: string }>(
      `SELECT value FROM settings
       WHERE key='schema20_backfill_complete_receipt'
       FOR UPDATE`,
    );
    if (stored.rows[0]?.value !== JSON.stringify(completionReceipt)) {
      throw new Error("schema20_backfill_idempotency_conflict");
    }
    await client.query("COMMIT");
    return {
      mode,
      applied: true,
      planHash,
      receiptCount: receipts.length,
      completionReceiptHash: hash(completionReceipt),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function main(): Promise<void> {
  const { mode, expectedPlanHash, idempotencyKey } = parseArguments();
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    process.stdout.write(
      `${JSON.stringify(
        await executeSchema20ProofBackfill(
          client,
          mode,
          expectedPlanHash,
          idempotencyKey,
        ),
        null,
        2,
      )}\n`,
    );
  } finally {
    await client.end();
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
