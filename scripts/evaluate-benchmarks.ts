import { readFile } from "node:fs/promises";
import {
  evaluateCuratedPlaylist,
  evaluateHoldoutRecovery,
  evaluateMatchingQuality,
  type BenchmarkTrack,
  type CuratedRatings,
} from "../lib/benchmarks.ts";
import {
  verifyBenchmarkExportArtifact,
} from "../lib/benchmark-artifact.ts";

const artifactPath = process.argv[2];
if (!artifactPath) {
  process.stderr.write("Usage: pnpm benchmark -- <staging-benchmark-results.json>\n");
  process.exitCode = 2;
} else {
  const fixture = JSON.parse(await readFile(new URL("../tests/fixtures/frozen-holdout.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const artifact: unknown = JSON.parse(await readFile(artifactPath, "utf8"));
  verifyBenchmarkExportArtifact(artifact, String(fixture.version));
  const factualBenchmarks = ["paulinho_da_costa", "michael_jackson"] as const;
  const holdouts = Object.fromEntries(factualBenchmarks.map((name) => [
    name,
    evaluateHoldoutRecovery(fixture[name] as BenchmarkTrack[], artifact.holdouts?.[name] ?? []),
  ]));
  const matching = evaluateMatchingQuality(artifact.matching ?? []);
  const curated = evaluateCuratedPlaylist(artifact.curated?.tracks ?? [], artifact.curated?.ratings ?? {} as CuratedRatings);
  const report = {
    fixtureVersion: fixture.version,
    artifactSha256: artifact.artifactSha256,
    attestation: artifact.attestation,
    persistedRuns: artifact.provenance.runs,
    holdouts,
    matching,
    curated,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!Object.values(holdouts).every((result) => result.passed) || !matching.passed || !curated.passed) {
    process.exitCode = 1;
  }
}
