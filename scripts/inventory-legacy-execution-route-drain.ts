import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  createLegacyExecutionRouteDrainV1,
  LEGACY_EXECUTION_ROUTE_DRAIN_PHASE_V1,
  LEGACY_EXECUTION_ROUTE_DRAIN_VERSION_V1,
  parseLegacyExecutionRouteDrainV1,
  type LegacyExecutionRouteDrainV1,
} from "../server/legacy-execution-route-drain-v1.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";

type Mode = "dry-run" | "apply" | "status";

const INVENTORY_VERSION =
  "legacy_execution_route_drain_inventory_v1" as const;
const LOCK_KEY = "legacy-execution-route-drain-inventory-v1";
const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const MAX_INVENTORY_JOBS = 1_000;
const MAX_INVENTORY_RUNS = 200;

export interface InventoryOptions {
  mode: Mode;
  acceptedBefore: string;
  inventoriedAt: string;
  targetReleaseRevision: string;
  targetSemanticConfigurationHash: string;
  expectedReceiptHash: string | null;
}

type QueryClient = Pick<pg.Client, "query">;

interface InventoryJobRow {
  job_id: string;
  run_id: string;
  kind: "research" | "matching" | "publication";
  query_plan_revision_id: string | null;
  query_plan_hash: string | null;
  active_query_plan_revision_id: string | null;
  contract_revision_id: string | null;
  execution_route: string;
  stage_key: string;
  created_at: Date;
  required_executor_revision: string | null;
  required_executor_semantic_configuration_hash: string | null;
}

export interface LegacyExecutionRouteDrainInventoryV1 {
  readonly version: typeof INVENTORY_VERSION;
  readonly acceptedBefore: string;
  readonly inventoriedAt: string;
  readonly targetReleaseRevision: string;
  readonly targetSemanticConfigurationHash: string;
  readonly drains: readonly LegacyExecutionRouteDrainV1[];
  readonly jobCount: number;
  readonly receiptHash: string;
}

type InventoryBody = Omit<
  LegacyExecutionRouteDrainInventoryV1,
  "receiptHash"
>;

export function legacyExecutionRouteDrainDatabaseConfig(
  env: Partial<Pick<
    NodeJS.ProcessEnv,
    "DATABASE_PUBLIC_URL" | "DATABASE_URL"
  >> = process.env,
): pg.ClientConfig {
  const publicUrl = env.DATABASE_PUBLIC_URL?.trim();
  if (publicUrl) {
    return {
      connectionString: publicUrl,
      ssl: { rejectUnauthorized: false },
    };
  }
  const internalUrl = env.DATABASE_URL?.trim();
  if (internalUrl) return { connectionString: internalUrl };
  throw new Error("database_url_missing");
}

function timestamp(value: string, name: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`legacy_route_drain_${name}_invalid`);
  }
  return new Date(parsed).toISOString();
}

function options(argv: readonly string[]): InventoryOptions {
  const mode = argv[2];
  if (mode !== "dry-run" && mode !== "apply" && mode !== "status") {
    throw new Error("legacy_route_drain_inventory_usage_invalid");
  }
  const acceptedBefore = timestamp(
    process.env.LEGACY_ROUTE_DRAIN_ACCEPTED_BEFORE?.trim() ?? "",
    "accepted_before",
  );
  const inventoriedAt = timestamp(
    process.env.LEGACY_ROUTE_DRAIN_INVENTORIED_AT?.trim() ?? "",
    "inventoried_at",
  );
  const targetReleaseRevision =
    process.env.EXPECTED_RELEASE_REVISION?.trim().toLowerCase() ?? "";
  const targetSemanticConfigurationHash =
    process.env.EXPECTED_SEMANTIC_CONFIGURATION_HASH
      ?.trim().toLowerCase() ?? "";
  const expectedReceiptHash = argv[3]?.trim().toLowerCase() || null;
  if (
    !REVISION.test(targetReleaseRevision)
    || !SHA256.test(targetSemanticConfigurationHash)
    || Date.parse(acceptedBefore) > Date.parse(inventoriedAt)
    || (
      mode !== "dry-run"
      && (
        expectedReceiptHash === null
        || !SHA256.test(expectedReceiptHash)
      )
    )
  ) {
    throw new Error("legacy_route_drain_inventory_options_invalid");
  }
  return {
    mode,
    acceptedBefore,
    inventoriedAt,
    targetReleaseRevision,
    targetSemanticConfigurationHash,
    expectedReceiptHash,
  };
}

function inventoryKey(input: InventoryOptions): string {
  return `legacy_route_drain_inventory_v1:${
    sha256Hex(stableStringify({
      acceptedBefore: input.acceptedBefore,
      inventoriedAt: input.inventoriedAt,
      targetReleaseRevision: input.targetReleaseRevision,
      targetSemanticConfigurationHash:
        input.targetSemanticConfigurationHash,
    }))
  }`;
}

export function createLegacyExecutionRouteDrainInventoryV1(
  body: InventoryBody,
): LegacyExecutionRouteDrainInventoryV1 {
  const value = {
    ...structuredClone(body),
    receiptHash: sha256Hex(stableStringify(body)),
  };
  assertLegacyExecutionRouteDrainInventoryV1(value);
  return Object.freeze(value);
}

export function assertLegacyExecutionRouteDrainInventoryV1(
  value: LegacyExecutionRouteDrainInventoryV1,
): void {
  if (
    value.version !== INVENTORY_VERSION
    || !REVISION.test(value.targetReleaseRevision)
    || !SHA256.test(value.targetSemanticConfigurationHash)
    || !SHA256.test(value.receiptHash)
  ) {
    throw new Error("legacy_route_drain_inventory_identity_invalid");
  }
  const acceptedBefore = timestamp(value.acceptedBefore, "accepted_before");
  const inventoriedAt = timestamp(value.inventoriedAt, "inventoried_at");
  if (
    acceptedBefore !== value.acceptedBefore
    || inventoriedAt !== value.inventoriedAt
    || Date.parse(acceptedBefore) > Date.parse(inventoriedAt)
    || !Array.isArray(value.drains)
    || value.drains.length > MAX_INVENTORY_RUNS
  ) {
    throw new Error("legacy_route_drain_inventory_shape_invalid");
  }
  let jobCount = 0;
  const runIds = new Set<string>();
  for (const drain of value.drains) {
    const parsed = parseLegacyExecutionRouteDrainV1(drain);
    if (
      !parsed
      || parsed.acceptedBefore !== value.acceptedBefore
      || parsed.inventoriedAt !== value.inventoriedAt
      || parsed.targetReleaseRevision !== value.targetReleaseRevision
      || parsed.targetSemanticConfigurationHash
        !== value.targetSemanticConfigurationHash
      || runIds.has(parsed.runId)
    ) {
      throw new Error("legacy_route_drain_inventory_drain_invalid");
    }
    runIds.add(parsed.runId);
    jobCount += parsed.jobs.length;
  }
  if (
    jobCount !== value.jobCount
    || jobCount > MAX_INVENTORY_JOBS
  ) {
    throw new Error("legacy_route_drain_inventory_job_count_invalid");
  }
  const sorted = [...value.drains].sort((left, right) => (
    left.runId.localeCompare(right.runId)
  ));
  if (stableStringify(sorted) !== stableStringify(value.drains)) {
    throw new Error("legacy_route_drain_inventory_not_canonical");
  }
  const { receiptHash, ...body } = value;
  if (sha256Hex(stableStringify(body)) !== receiptHash) {
    throw new Error("legacy_route_drain_inventory_hash_mismatch");
  }
}

export function parseLegacyExecutionRouteDrainInventoryV1(
  value: unknown,
): LegacyExecutionRouteDrainInventoryV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const inventory =
      structuredClone(value) as LegacyExecutionRouteDrainInventoryV1;
    assertLegacyExecutionRouteDrainInventoryV1(inventory);
    return inventory;
  } catch {
    return null;
  }
}

async function snapshot(
  client: QueryClient,
  input: InventoryOptions,
): Promise<InventoryJobRow[]> {
  const result = await client.query<InventoryJobRow>(
    `SELECT job.id job_id,
            job.run_id,
            job.kind,
            job.query_plan_revision_id,
            query.plan_hash query_plan_hash,
            active.query_plan_revision_id active_query_plan_revision_id,
            run.active_playlist_contract_revision_id contract_revision_id,
            job.pipeline_version execution_route,
            job.stage_key,
            job.created_at,
            job.required_executor_revision,
            job.required_executor_semantic_configuration_hash
     FROM job_queue job
     JOIN research_runs run ON run.id=job.run_id
     LEFT JOIN run_active_query_plans active ON active.run_id=run.id
     LEFT JOIN query_plan_revisions query
       ON query.id=job.query_plan_revision_id
      AND query.run_id=run.id
     LEFT JOIN research_checkpoints receipt
       ON receipt.run_id=run.id
      AND receipt.phase='execution_route_receipt_v1'
     WHERE job.kind IN ('research','matching','publication')
       AND job.status IN ('queued','retry','leased')
       AND job.created_at<=$1::timestamptz
       AND receipt.run_id IS NULL
     ORDER BY job.run_id,job.id
     FOR UPDATE OF job,run`,
    [input.acceptedBefore],
  );
  if (result.rows.length > MAX_INVENTORY_JOBS) {
    throw new Error("legacy_route_drain_inventory_too_large");
  }
  for (const row of result.rows) {
    if (
      !row.execution_route
      || ((row.query_plan_revision_id === null)
        !== (row.query_plan_hash === null))
      || (row.query_plan_revision_id !== null
        && row.active_query_plan_revision_id !== row.query_plan_revision_id)
      || (row.query_plan_hash !== null && !SHA256.test(row.query_plan_hash))
      || row.created_at.toISOString() > input.acceptedBefore
    ) {
      throw new Error("legacy_route_drain_inventory_job_unbindable");
    }
  }
  return result.rows;
}

function buildInventory(
  rows: readonly InventoryJobRow[],
  input: InventoryOptions,
): LegacyExecutionRouteDrainInventoryV1 {
  const grouped = new Map<string, InventoryJobRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.run_id) ?? [];
    existing.push(row);
    grouped.set(row.run_id, existing);
  }
  if (grouped.size > MAX_INVENTORY_RUNS) {
    throw new Error("legacy_route_drain_inventory_too_many_runs");
  }
  const drains = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([runId, jobs]) => {
      const executionRoutes = new Set(jobs.map((job) => job.execution_route));
      const contractRevisionIds = new Set(
        jobs.map((job) => job.contract_revision_id),
      );
      if (executionRoutes.size !== 1 || contractRevisionIds.size !== 1) {
        throw new Error("legacy_route_drain_inventory_run_authority_ambiguous");
      }
      return createLegacyExecutionRouteDrainV1({
        version: LEGACY_EXECUTION_ROUTE_DRAIN_VERSION_V1,
        runId,
        contractRevisionId: jobs[0]!.contract_revision_id,
        executionRoute: jobs[0]!.execution_route,
        targetReleaseRevision: input.targetReleaseRevision,
        targetSemanticConfigurationHash:
          input.targetSemanticConfigurationHash,
        acceptedBefore: input.acceptedBefore,
        inventoriedAt: input.inventoriedAt,
        jobs: jobs.map((job) => ({
          jobId: job.job_id,
          kind: job.kind,
          queryPlanRevisionId: job.query_plan_revision_id,
          queryPlanHash: job.query_plan_hash,
          stageKey: job.stage_key,
          createdAt: job.created_at.toISOString(),
          sourceExecutorRevision: job.required_executor_revision,
          sourceSemanticConfigurationHash:
            job.required_executor_semantic_configuration_hash,
        })),
      });
    });
  return createLegacyExecutionRouteDrainInventoryV1({
    version: INVENTORY_VERSION,
    acceptedBefore: input.acceptedBefore,
    inventoriedAt: input.inventoriedAt,
    targetReleaseRevision: input.targetReleaseRevision,
    targetSemanticConfigurationHash:
      input.targetSemanticConfigurationHash,
    drains,
    jobCount: rows.length,
  });
}

async function verifyPersistedDrains(
  client: QueryClient,
  inventory: LegacyExecutionRouteDrainInventoryV1,
): Promise<void> {
  for (const drain of inventory.drains) {
    const result = await client.query<{ state_json: unknown }>(
      `SELECT state_json
       FROM research_checkpoints
       WHERE run_id=$1 AND phase=$2
       FOR UPDATE`,
      [drain.runId, LEGACY_EXECUTION_ROUTE_DRAIN_PHASE_V1],
    );
    const persisted = parseLegacyExecutionRouteDrainV1(
      result.rows[0]?.state_json,
    );
    if (persisted?.receiptHash !== drain.receiptHash) {
      throw new Error("legacy_route_drain_inventory_checkpoint_mismatch");
    }
  }
}

async function readPersistedInventory(
  client: QueryClient,
  input: InventoryOptions,
): Promise<LegacyExecutionRouteDrainInventoryV1 | null> {
  const result = await client.query<{ value: string }>(
    "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
    [inventoryKey(input)],
  );
  if (!result.rows[0]) return null;
  let value: unknown;
  try {
    value = JSON.parse(result.rows[0].value);
  } catch {
    throw new Error("legacy_route_drain_inventory_receipt_invalid");
  }
  const inventory = parseLegacyExecutionRouteDrainInventoryV1(value);
  if (
    !inventory
    || inventory.acceptedBefore !== input.acceptedBefore
    || inventory.inventoriedAt !== input.inventoriedAt
    || inventory.targetReleaseRevision !== input.targetReleaseRevision
    || inventory.targetSemanticConfigurationHash
      !== input.targetSemanticConfigurationHash
  ) {
    throw new Error("legacy_route_drain_inventory_receipt_invalid");
  }
  await verifyPersistedDrains(client, inventory);
  return inventory;
}

async function status(
  client: QueryClient,
  inventory: LegacyExecutionRouteDrainInventoryV1,
): Promise<Record<string, unknown>> {
  await verifyPersistedDrains(client, inventory);
  const jobIds = inventory.drains.flatMap((drain) => (
    drain.jobs.map((job) => job.jobId)
  ));
  const active = await client.query<{ count: number }>(
    `SELECT count(*)::int count
     FROM job_queue
     WHERE id=ANY($1::uuid[])
       AND status IN ('queued','retry','leased')`,
    [jobIds],
  );
  const unreceipted = await client.query<{ count: number }>(
    `SELECT count(*)::int count
     FROM job_queue job
     JOIN research_runs run ON run.id=job.run_id
     LEFT JOIN research_checkpoints receipt
       ON receipt.run_id=run.id
      AND receipt.phase='execution_route_receipt_v1'
     WHERE job.kind IN ('research','matching','publication')
       AND job.status IN ('queued','retry','leased')
       AND receipt.run_id IS NULL
       AND NOT (job.id=ANY($1::uuid[]))`,
    [jobIds],
  );
  const activeJobCount = Number(active.rows[0]?.count ?? 0);
  const unreceiptedJobCount = Number(unreceipted.rows[0]?.count ?? 0);
  return {
    mode: "status",
    receiptHash: inventory.receiptHash,
    inventoryIntact: true,
    jobCount: inventory.jobCount,
    activeJobCount,
    unreceiptedJobCount,
    drained: activeJobCount === 0 && unreceiptedJobCount === 0,
  };
}

export async function executeLegacyExecutionRouteDrainInventoryV1(
  client: QueryClient,
  input: InventoryOptions,
): Promise<Record<string, unknown>> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      LOCK_KEY,
    ]);
    const existing = await readPersistedInventory(client, input);
    if (input.mode === "status") {
      if (
        !existing
        || input.expectedReceiptHash !== existing.receiptHash
      ) {
        throw new Error("legacy_route_drain_inventory_receipt_missing");
      }
      const result = await status(client, existing);
      await client.query("COMMIT");
      return result;
    }
    const inventory = existing ?? buildInventory(
      await snapshot(client, input),
      input,
    );
    if (input.mode === "dry-run") {
      await client.query("ROLLBACK");
      return {
        mode: "dry-run",
        safeToApply: true,
        receiptHash: inventory.receiptHash,
        runCount: inventory.drains.length,
        jobCount: inventory.jobCount,
      };
    }
    if (input.expectedReceiptHash !== inventory.receiptHash) {
      throw new Error("legacy_route_drain_inventory_receipt_hash_mismatch");
    }
    if (!existing) {
      for (const drain of inventory.drains) {
        const inserted = await client.query(
          `INSERT INTO research_checkpoints(run_id,phase,state_json)
           VALUES($1,$2,$3::jsonb)
           ON CONFLICT(run_id,phase) DO NOTHING
           RETURNING run_id`,
          [
            drain.runId,
            LEGACY_EXECUTION_ROUTE_DRAIN_PHASE_V1,
            JSON.stringify(drain),
          ],
        );
        if (inserted.rowCount !== 1) {
          throw new Error(
            "legacy_route_drain_inventory_checkpoint_conflict",
          );
        }
        for (const job of drain.jobs) {
          const fenced = await client.query(
            `UPDATE job_queue
             SET required_executor_revision=$6,
                 required_executor_semantic_configuration_hash=$7,
                 updated_at=now()
             WHERE id=$1
               AND run_id=$2
               AND kind=$3
               AND query_plan_revision_id IS NOT DISTINCT FROM $4
               AND stage_key=$5
               AND status IN ('queued','retry','leased')`,
            [
              job.jobId,
              drain.runId,
              job.kind,
              job.queryPlanRevisionId,
              job.stageKey,
              drain.targetReleaseRevision,
              drain.targetSemanticConfigurationHash,
            ],
          );
          if (fenced.rowCount !== 1) {
            throw new Error(
              "legacy_route_drain_inventory_job_fence_conflict",
            );
          }
        }
      }
      const inserted = await client.query(
        `INSERT INTO settings(key,value)
         VALUES($1,$2)
         ON CONFLICT(key) DO NOTHING
         RETURNING key`,
        [inventoryKey(input), JSON.stringify(inventory)],
      );
      if (inserted.rowCount !== 1) {
        throw new Error("legacy_route_drain_inventory_concurrent_conflict");
      }
    }
    await verifyPersistedDrains(client, inventory);
    await client.query("COMMIT");
    return {
      mode: "apply",
      applied: existing === null,
      receiptHash: inventory.receiptHash,
      runCount: inventory.drains.length,
      jobCount: inventory.jobCount,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function main(): Promise<void> {
  const input = options(process.argv);
  const client = new pg.Client(legacyExecutionRouteDrainDatabaseConfig());
  await client.connect();
  try {
    process.stdout.write(`${JSON.stringify(
      await executeLegacyExecutionRouteDrainInventoryV1(client, input),
      null,
      2,
    )}\n`);
  } finally {
    await client.end();
  }
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
