import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema.ts";

export const DATABASE_SCHEMA_VERSION = "10";

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
