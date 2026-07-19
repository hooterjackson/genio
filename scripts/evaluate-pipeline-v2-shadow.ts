import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluatePipelineV2ManifestShadow } from "../server/pipeline-v2-shadow.ts";
import {
  PIPELINE_V2_SHADOW_ORCHESTRATION_SCHEMA,
  orchestratePipelineV2ManifestShadow,
} from "../server/pipeline-v2-shadow-orchestrator.ts";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const inputPath = argument("--input") ?? process.argv[2] ?? null;
const primaryArtifactPath = argument("--primary-artifact");
const shadowArtifactPath = argument("--shadow-artifact");
const artifactMode = Boolean(primaryArtifactPath || shadowArtifactPath);

if ((!inputPath && !artifactMode) || (artifactMode && (!primaryArtifactPath || !shadowArtifactPath))) {
  process.stderr.write([
    "Usage:",
    "  pnpm qa:shadow:v2 -- --input <manifest-candidate-pools.json>",
    "  pnpm qa:shadow:v2 -- --primary-artifact <v1.json> --shadow-artifact <v2.json> [--comparison-id <id>]",
    "",
    "The command is manifest-only: it cannot authorize Apple Music or publish a playlist.",
    "",
  ].join("\n"));
  process.exitCode = 2;
} else {
  try {
    const report = artifactMode
      ? orchestratePipelineV2ManifestShadow({
          schemaVersion: PIPELINE_V2_SHADOW_ORCHESTRATION_SCHEMA,
          comparisonId: argument("--comparison-id") ?? "persisted-artifact-shadow",
          primaryArtifact: await readFile(resolve(primaryArtifactPath!), "utf8").then(JSON.parse),
          shadowArtifact: await readFile(resolve(shadowArtifactPath!), "utf8").then(JSON.parse),
        })
      : evaluatePipelineV2ManifestShadow(
          await readFile(resolve(inputPath!), "utf8").then(JSON.parse),
        );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `Pipeline V2 manifest-only shadow comparison failed closed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
