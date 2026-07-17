import { Pool } from "pg";
const connectionString = process.env.DATABASE_URL?.trim();

if (!connectionString) {
  throw new Error("DATABASE_URL is required for the database QA suite");
}

const parsed = new URL(connectionString);
const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
if (!localHosts.has(parsed.hostname) && process.env.QA_ALLOW_REMOTE_DATABASE !== "1") {
  throw new Error(
    "Database QA refuses a remote host by default. Use a disposable local Postgres 17 instance, "
      + "or set QA_ALLOW_REMOTE_DATABASE=1 only for an explicitly isolated test database.",
  );
}

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
try {
  const result = await pool.query(
    "SELECT current_database() database_name, current_user database_user, current_setting('server_version_num')::int server_version_num",
  );
  const row = result.rows[0];
  if (!row || Number(row.server_version_num) < 170_000) {
    throw new Error("Database QA requires Postgres 17 or newer");
  }
  process.stdout.write(
    `Database QA ready: ${row.database_name} as ${row.database_user} on Postgres ${Math.floor(Number(row.server_version_num) / 10_000)}\n`,
  );
} finally {
  await pool.end();
}
