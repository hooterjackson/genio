import { readFile } from "node:fs/promises";
import {
  evaluateCuratedPlaylist,
  evaluateHoldoutRecovery,
  evaluateMatchingQuality,
  type BenchmarkTrack,
  type CuratedRatings,
  type MatchAuditRow,
} from "../lib/benchmarks.ts";

interface BenchmarkArtifact {
  holdouts: Record<string, BenchmarkTrack[]>;
  matching: MatchAuditRow[];
  curated: { tracks: BenchmarkTrack[]; ratings: CuratedRatings };
}

const artifactPath = process.argv[2];
if (!artifactPath) {
  process.stderr.write("Usage: pnpm benchmark -- <staging-benchmark-results.json>\n");
  process.exitCode = 2;
} else {
  const fixture = JSON.parse(await readFile(new URL("../tests/fixtures/frozen-holdout.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as BenchmarkArtifact;
  const holdouts = Object.fromEntries(["paulinho_da_costa", "michael_jackson"].map((name) => [
    name,
    evaluateHoldoutRecovery(fixture[name] as BenchmarkTrack[], artifact.holdouts?.[name] ?? []),
  ]));
  const matching = evaluateMatchingQuality(artifact.matching ?? []);
  const curated = evaluateCuratedPlaylist(artifact.curated?.tracks ?? [], artifact.curated?.ratings ?? {} as CuratedRatings);
  const report = { fixtureVersion: fixture.version, holdouts, matching, curated };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!Object.values(holdouts).every((result) => result.passed) || !matching.passed || !curated.passed) {
    process.exitCode = 1;
  }
}
