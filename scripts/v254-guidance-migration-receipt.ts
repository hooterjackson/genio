import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

export const V254_GUIDANCE_MIGRATION_RECEIPT_SCHEMA =
  "genio-v254-guidance-migration-receipt/v1" as const;
export const V254_GUIDANCE_MIGRATION_TAG =
  "0024_guidance_v5_execution_decision" as const;

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

type JsonRecord = Record<string, unknown>;

export interface V254GuidanceMigrationReceiptV1 {
  schemaVersion: typeof V254_GUIDANCE_MIGRATION_RECEIPT_SCHEMA;
  sourceRevision: string;
  migrationTag: typeof V254_GUIDANCE_MIGRATION_TAG;
  migrationFileSha256: string;
  drizzleMigrationHash: string;
  databaseSchemaVersion: "20";
  guidanceCheckpointVersion: "5.1";
  constraintName: "guidance_question_sets_checkpoint_mode_valid";
  constraintValidated: true;
  executionDecisionAccepted: true;
  verifiedAt: string;
  receiptHash: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function sha256(value: unknown): string {
  const bytes = typeof value === "string"
    ? value
    : JSON.stringify(stable(value));
  return createHash("sha256").update(bytes).digest("hex");
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) throw new Error(`${label} is invalid`);
  return value;
}

export function validateV254GuidanceMigrationReceiptV1(
  value: unknown,
  expected: { sourceRevision: string; migrationFileSha256?: string },
): V254GuidanceMigrationReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("v2.5.4 guidance migration receipt is invalid");
  }
  const receipt = value as JsonRecord;
  const fields = [
    "schemaVersion", "sourceRevision", "migrationTag",
    "migrationFileSha256", "drizzleMigrationHash",
    "databaseSchemaVersion", "guidanceCheckpointVersion",
    "constraintName", "constraintValidated", "executionDecisionAccepted",
    "verifiedAt", "receiptHash",
  ];
  if (
    Object.keys(receipt).sort().join("\0") !== fields.sort().join("\0")
    || receipt.schemaVersion !== V254_GUIDANCE_MIGRATION_RECEIPT_SCHEMA
    || receipt.sourceRevision !== expected.sourceRevision
    || !SHA1.test(String(receipt.sourceRevision ?? ""))
    || receipt.migrationTag !== V254_GUIDANCE_MIGRATION_TAG
    || !SHA256.test(String(receipt.migrationFileSha256 ?? ""))
    || receipt.drizzleMigrationHash !== receipt.migrationFileSha256
    || (expected.migrationFileSha256 !== undefined
      && receipt.migrationFileSha256 !== expected.migrationFileSha256)
    || receipt.databaseSchemaVersion !== "20"
    || receipt.guidanceCheckpointVersion !== "5.1"
    || receipt.constraintName
      !== "guidance_question_sets_checkpoint_mode_valid"
    || receipt.constraintValidated !== true
    || receipt.executionDecisionAccepted !== true
  ) throw new Error("v2.5.4 guidance migration receipt does not bind activation");
  timestamp(receipt.verifiedAt, "guidance migration verifiedAt");
  const unsigned = { ...receipt };
  delete unsigned.receiptHash;
  if (receipt.receiptHash !== sha256(unsigned)) {
    throw new Error("v2.5.4 guidance migration receipt hash is invalid");
  }
  return receipt as unknown as V254GuidanceMigrationReceiptV1;
}

export function v254GuidanceMigrationDatabaseConfig(
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
  throw new Error("guidance_migration_database_url_missing");
}

function option(argv: readonly string[], name: string): string {
  const indices = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indices.length !== 1) throw new Error(`${name} must occur exactly once`);
  const value = argv[indices[0]! + 1]?.trim() ?? "";
  if (!value || value.startsWith("--") || value.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error("guidance migration receipt output already exists");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function produceV254GuidanceMigrationReceiptV1(input: {
  sourceRevision: string;
  migrationFilePath: string;
  outputPath: string;
  databaseConfig: pg.ClientConfig;
  now?: Date;
}): Promise<V254GuidanceMigrationReceiptV1> {
  if (!SHA1.test(input.sourceRevision)) {
    throw new Error("guidance migration source revision is invalid");
  }
  await requireAbsent(input.outputPath);
  const migrationSql = await readFile(input.migrationFilePath, "utf8");
  const migrationFileSha256 = sha256(migrationSql);
  const client = new pg.Client(input.databaseConfig);
  await client.connect();
  try {
    const observed = await client.query<{
      schema_version: string | null;
      checkpoint_version: string | null;
      constraint_validated: boolean;
      constraint_definition: string | null;
      migration_hash: string | null;
    }>(
      `SELECT
         (SELECT value FROM settings WHERE key='schema_version') schema_version,
         (SELECT value FROM settings WHERE key='guidance_checkpoint_version')
           checkpoint_version,
         COALESCE((
           SELECT convalidated FROM pg_constraint
           WHERE conrelid='guidance_question_sets'::regclass
             AND conname='guidance_question_sets_checkpoint_mode_valid'
         ),false) constraint_validated,
         (SELECT pg_get_constraintdef(oid) FROM pg_constraint
          WHERE conrelid='guidance_question_sets'::regclass
            AND conname='guidance_question_sets_checkpoint_mode_valid')
           constraint_definition,
         (SELECT hash FROM drizzle.__drizzle_migrations
          ORDER BY created_at DESC LIMIT 1) migration_hash`,
    );
    const row = observed.rows[0];
    if (
      !row
      || row.schema_version !== "20"
      || row.checkpoint_version !== "5.1"
      || row.constraint_validated !== true
      || !String(row.constraint_definition ?? "")
        .includes("'execution_decision'::text")
      || row.migration_hash !== migrationFileSha256
    ) {
      throw new Error(
        "v2.5.4 guidance migration is not durably active at schema 20",
      );
    }
    const verifiedAt = (input.now ?? new Date()).toISOString();
    const unsigned = {
      schemaVersion: V254_GUIDANCE_MIGRATION_RECEIPT_SCHEMA,
      sourceRevision: input.sourceRevision,
      migrationTag: V254_GUIDANCE_MIGRATION_TAG,
      migrationFileSha256,
      drizzleMigrationHash: row.migration_hash,
      databaseSchemaVersion: "20" as const,
      guidanceCheckpointVersion: "5.1" as const,
      constraintName:
        "guidance_question_sets_checkpoint_mode_valid" as const,
      constraintValidated: true as const,
      executionDecisionAccepted: true as const,
      verifiedAt,
    };
    const receipt = {
      ...unsigned,
      receiptHash: sha256(unsigned),
    };
    const validated = validateV254GuidanceMigrationReceiptV1(receipt, {
      sourceRevision: input.sourceRevision,
      migrationFileSha256,
    });
    await writeFile(input.outputPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return validated;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sourceRevision = option(argv, "--source-revision").toLowerCase();
  const migrationFilePath = option(argv, "--migration-file");
  const outputPath = option(argv, "--output");
  if (argv.length !== 6) throw new Error("guidance migration arguments are incomplete");
  const receipt = await produceV254GuidanceMigrationReceiptV1({
    sourceRevision,
    migrationFilePath,
    outputPath,
    databaseConfig: v254GuidanceMigrationDatabaseConfig(),
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    receiptHash: receipt.receiptHash,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "v254_guidance_migration_receipt_failed_closed",
      message: "v2.5.4 guidance migration verification failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
