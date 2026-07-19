import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema.ts";

export const DATABASE_SCHEMA_VERSION = "13";

export interface DatabaseSchemaSupport {
  minimum: string;
  maximum: string;
  preferred: string;
}

/** Current V13 code reads V13 columns and therefore supports schema 13 only. */
export const DATABASE_SCHEMA_SUPPORT: DatabaseSchemaSupport = {
  minimum: "13",
  maximum: "13",
  preferred: DATABASE_SCHEMA_VERSION,
};

/**
 * Compatibility contract for the Release-A V12 bridge deployed before the
 * expand migration. Keeping this explicit makes the 12 -> 13 migration and a
 * rollback to that bridge testable without pretending V13 queries run on V12.
 */
export const DATABASE_SCHEMA_V12_BRIDGE_SUPPORT: DatabaseSchemaSupport = {
  minimum: "12",
  maximum: "13",
  preferred: "12",
};

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
