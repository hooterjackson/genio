import { createDatabase } from "../db/index.ts";
import {
  buildAutomaticFailureQaExport,
  type AutomaticFailureExportStatus,
} from "../server/automatic-failure-qa-export.ts";

function statusArgument(argv: readonly string[]): AutomaticFailureExportStatus | "all" {
  const index = argv.indexOf("--status");
  if (index < 0) return "quarantined";
  const value = argv[index + 1];
  if (value === "quarantined" || value === "promoted" || value === "dismissed" || value === "all") return value;
  throw new Error("--status must be quarantined, promoted, dismissed, or all");
}

const status = statusArgument(process.argv.slice(2));
const database = createDatabase({ max: 1, application_name: "genio-automatic-failure-qa-export" });

try {
  const result = await database.pool.query<{ value: string }>(
    `SELECT value FROM settings
     WHERE key LIKE 'feedback-submission:%'
       AND value::jsonb->>'origin'='automatic_failure'
     ORDER BY created_at`,
  );
  const records = result.rows.flatMap(({ value }) => {
    try {
      return [JSON.parse(value) as unknown];
    } catch {
      return [];
    }
  });
  process.stdout.write(`${JSON.stringify(buildAutomaticFailureQaExport(records, status), null, 2)}\n`);
} finally {
  await database.pool.end();
}
