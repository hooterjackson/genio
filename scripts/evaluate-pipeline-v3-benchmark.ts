import { readFile } from "node:fs/promises";
import { evaluatePipelineV3ModelBenchmark } from "./pipeline-v3-benchmark-lib.ts";

const artifactPath = process.argv[2];
const scenariosPath = process.argv[3]
  ?? new URL("../tests/fixtures/pipeline-v3-regression-scenarios.json", import.meta.url).pathname;

if (!artifactPath) {
  process.stderr.write("Usage: node --experimental-transform-types scripts/evaluate-pipeline-v3-benchmark.ts <artifact.json> [scenarios.json]\n");
  process.exitCode = 2;
} else {
  const [artifact, scenarios] = await Promise.all([
    readFile(artifactPath, "utf8").then(JSON.parse) as Promise<unknown>,
    readFile(scenariosPath, "utf8").then(JSON.parse) as Promise<{ scenarios?: Array<{ id?: string }> }>,
  ]);
  const scenarioIds = (scenarios.scenarios ?? []).map(({ id }) => id).filter((id): id is string => Boolean(id));
  const report = evaluatePipelineV3ModelBenchmark(artifact, scenarioIds);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
