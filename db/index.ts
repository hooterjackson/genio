import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema.ts";

export const DATABASE_SCHEMA_VERSION = "19";
export const DATABASE_SCHEMA_20_PROOF_VERSION = "20";

export interface DatabaseSchemaSupport {
  minimum: string;
  maximum: string;
  preferred: string;
}

/**
 * The protocol-12 bridge remains schema-19-preferred while accepting the
 * additive schema-20 proof tables. Native proof authority is activated only
 * after every protocol-11 worker is fenced and the explicit index/authority
 * switch succeeds.
 */
export const DATABASE_SCHEMA_SUPPORT: DatabaseSchemaSupport = {
  minimum: "13",
  maximum: DATABASE_SCHEMA_20_PROOF_VERSION,
  preferred: DATABASE_SCHEMA_VERSION,
};

/**
 * Compatibility bridge for the schema-13 -> schema-19 expand
 * migration. Bridge binaries prefer the pre-migration schema while remaining
 * healthy after the expand migration, so API and workers can be promoted
 * independently. Schema 12 is deliberately outside this range: accepting it
 * would make current queries appear safe against a schema they cannot read.
 */
export const DATABASE_SCHEMA_V13_BRIDGE_SUPPORT: DatabaseSchemaSupport = {
  minimum: "13",
  maximum: DATABASE_SCHEMA_20_PROOF_VERSION,
  preferred: "18",
};

/**
 * @deprecated Source-compatibility alias for older rollout tooling. Despite
 * the legacy name, it now uses the fail-closed 13-16 bridge contract and
 * therefore does not accept schema 12.
 */
export const DATABASE_SCHEMA_V12_BRIDGE_SUPPORT = DATABASE_SCHEMA_V13_BRIDGE_SUPPORT;

function numericSchemaVersion(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export type DatabaseSchemaCompatibility =
  | "compatible"
  | "uninitialized"
  | "malformed"
  | "too_old"
  | "too_new";

export function databaseSchemaCompatibility(
  actual: string | null,
  support: DatabaseSchemaSupport = DATABASE_SCHEMA_SUPPORT,
): DatabaseSchemaCompatibility {
  if (actual === null) return "uninitialized";
  const observed = numericSchemaVersion(actual);
  const minimum = numericSchemaVersion(support.minimum);
  const maximum = numericSchemaVersion(support.maximum);
  const preferred = numericSchemaVersion(support.preferred);
  if (observed === null || minimum === null || maximum === null || preferred === null || minimum > preferred || preferred > maximum) {
    return "malformed";
  }
  if (observed < minimum) return "too_old";
  if (observed > maximum) return "too_new";
  return "compatible";
}

export function isDatabaseSchemaVersionCompatible(
  actual: string | null,
  support: DatabaseSchemaSupport = DATABASE_SCHEMA_SUPPORT,
): boolean {
  return databaseSchemaCompatibility(actual, support) === "compatible";
}

export interface DatabaseHandle {
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
}

export function createDatabase(config: PoolConfig = {}): DatabaseHandle {
  const connectionString = config.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: process.env.RAILWAY_SERVICE_NAME ?? "needle-api",
    ...config,
  });

  pool.on("error", (error) => {
    console.error("Unexpected Postgres pool error", { message: error.message });
  });

  return { pool, db: drizzle(pool, { schema }) };
}
