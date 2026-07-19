import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluatePipelineV2ReleaseBenchmark } from "../lib/pipeline-v2-release-benchmark.ts";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const resultsPath = argument("--results") ?? process.argv[2] ?? null;
const suitePath = argument("--suite")
  ?? resolve(process.cwd(), "tests/fixtures/pipeline-v2-release-benchmark-suite.json");

if (!resultsPath) {
  process.stderr.write([
    "Usage:",
    "  pnpm benchmark:v2 -- --results <independently-reviewed-results.json>",
    "  pnpm benchmark:v2 -- --suite <frozen-suite.json> --results <independently-reviewed-results.json>",
    "",
    "The gate intentionally has no unchecked or synthetic-results mode.",
    "",
  ].join("\n"));
  process.exitCode = 2;
} else {
  try {
    const [suite, results] = await Promise.all([
      readFile(resolve(suitePath), "utf8").then(JSON.parse),
      readFile(resolve(resultsPath), "utf8").then(JSON.parse),
    ]);
    const report = evaluatePipelineV2ReleaseBenchmark(suite, results);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Pipeline V2 release benchmark failed closed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
