import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BENCHMARK_ATTESTATION_SCHEMA,
  BENCHMARK_ATTESTATION_STATEMENT,
  BENCHMARK_CURATED_ATTESTATION_STATEMENT,
  benchmarkMatchSnapshotHash,
  buildAttestedBenchmarkArtifact,
  parseBenchmarkAttestation,
  type BenchmarkName,
  type PersistedBenchmarkRun,
} from "../lib/benchmark-artifact.ts";
import { createDatabase, DATABASE_SCHEMA_VERSION } from "../db/index.ts";
import type { Pool } from "pg";
import {
  loadPersistedBenchmarkRuns,
  loadPersistedBenchmarkRunsById,
  type BenchmarkRunIds,
} from "../server/benchmark-export.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";

const BENCHMARK_NAMES: BenchmarkName[] = ["paulinho_da_costa", "michael_jackson", "berlin_techno"];
const FACTUAL_BENCHMARK_NAMES = ["paulinho_da_costa", "michael_jackson"] as const;
const RATING_KEYS = [
  "citationQuality",
  "historicalRelevance",
  "berlinSceneFit",
  "eraDiversity",
  "artistDiversity",
  "duplicateAvoidance",
  "playlistCoherence",
] as const;

async function currentDatabaseSchemaVersion(pool: Pool): Promise<string> {
  const result = await pool.query<{ value: string }>(
    "SELECT value FROM settings WHERE key='schema_version'",
  );
  const actual = result.rows[0]?.value ?? "uninitialized";
  if (actual !== DATABASE_SCHEMA_VERSION) {
    throw new Error(`Benchmark database schema mismatch: expected ${DATABASE_SCHEMA_VERSION}, found ${actual}`);
  }
  return actual;
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : null;
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function writeNewJson(path: string, value: unknown): Promise<void> {
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function reviewSnapshot(run: PersistedBenchmarkRun) {
  return {
    benchmark: run.benchmark,
    runId: run.runId,
    status: run.status,
    storefront: run.storefront,
    manifestId: run.manifestId,
    manifestContentHash: run.manifestContentHash,
    matchSnapshotHash: benchmarkMatchSnapshotHash(run),
    candidates: run.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      artist: candidate.artist,
      title: candidate.title,
      initialStatus: candidate.initialMatchStatus,
      initialBasis: candidate.initialBasis,
      initialScore: candidate.initialScore,
      initialCatalogId: candidate.initialCatalogId,
      initialSong: candidate.initialSong,
      finalStatus: candidate.matchStatus,
      finalBasis: candidate.matchBasis,
      finalScore: candidate.matchScore,
      finalCatalogId: candidate.catalogId,
      finalSong: candidate.song,
      outcome: candidate.outcome,
      manifestPosition: candidate.manifestPosition,
      factualCitationUrls: candidate.factualCitationUrls,
      curatedCitationUrls: candidate.curatedCitationUrls,
    })),
  };
}

async function fixtureVersion(): Promise<string> {
  const fixture = JSON.parse(await readFile(new URL("../tests/fixtures/frozen-holdout.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof fixture.version !== "string") throw new Error("Frozen benchmark fixture has no version");
  return fixture.version;
}

async function prepare(): Promise<void> {
  const output = requiredArgument("--output");
  const runIds: BenchmarkRunIds = {
    paulinho_da_costa: requiredArgument("--paulinho-run"),
    michael_jackson: requiredArgument("--michael-run"),
    berlin_techno: requiredArgument("--berlin-run"),
  };
  const database = createDatabase({ application_name: "needle-benchmark-prepare" });
  try {
    await currentDatabaseSchemaVersion(database.pool);
    const runs = await loadPersistedBenchmarkRunsById(database.pool, runIds);
    const version = await fixtureVersion();
    const snapshots = BENCHMARK_NAMES.map((name) => reviewSnapshot(runs[name]));
    const packet = {
      schemaVersion: "needle-benchmark-review/v1",
      preparedAt: new Date().toISOString(),
      fixtureVersion: version,
      instructions: "Review the immutable snapshot. Fill only the blank attestation values; do not edit IDs or hashes.",
      snapshots,
      snapshotSha256: sha256Hex(stableStringify(snapshots)),
      attestation: {
        schemaVersion: BENCHMARK_ATTESTATION_SCHEMA,
        fixtureVersion: version,
        attestedBy: "",
        attestedAt: "",
        statement: BENCHMARK_ATTESTATION_STATEMENT,
        runs: Object.fromEntries(BENCHMARK_NAMES.map((name) => [name, {
          runId: runs[name].runId,
          manifestId: runs[name].manifestId,
          manifestContentHash: runs[name].manifestContentHash,
          matchSnapshotHash: benchmarkMatchSnapshotHash(runs[name]),
        }])),
        matchTruth: FACTUAL_BENCHMARK_NAMES.flatMap((name) => runs[name].candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          storefrontAvailable: null,
          acceptableCatalogIds: [],
          note: "",
        }))),
        curatedReview: {
          statement: BENCHMARK_CURATED_ATTESTATION_STATEMENT,
          ratings: Object.fromEntries(RATING_KEYS.map((key) => [key, null])),
          rationales: Object.fromEntries(RATING_KEYS.map((key) => [key, ""])),
        },
      },
    };
    await writeNewJson(output, packet);
    process.stdout.write(`${JSON.stringify({ output: resolve(output), reviewCandidates: packet.attestation.matchTruth.length }, null, 2)}\n`);
  } finally {
    await database.pool.end();
  }
}

async function finalize(): Promise<void> {
  const reviewPath = requiredArgument("--review");
  const output = requiredArgument("--output");
  const raw = JSON.parse(await readFile(resolve(reviewPath), "utf8")) as unknown;
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const reviewKeys = ["schemaVersion", "preparedAt", "fixtureVersion", "instructions", "snapshots", "snapshotSha256", "attestation"];
  const missing = reviewKeys.filter((key) => !(key in record));
  const extras = Object.keys(record).filter((key) => !reviewKeys.includes(key));
  if (record.schemaVersion !== "needle-benchmark-review/v1" || missing.length > 0 || extras.length > 0) {
    throw new Error(`The review packet is invalid (missing: ${missing.join(", ") || "none"}; extra: ${extras.join(", ") || "none"})`);
  }
  if (!Array.isArray(record.snapshots)
    || typeof record.snapshotSha256 !== "string"
    || record.snapshotSha256 !== sha256Hex(stableStringify(record.snapshots))) {
    throw new Error("The prepared review snapshot was edited or is invalid");
  }
  const version = await fixtureVersion();
  if (record.fixtureVersion !== version) throw new Error("The prepared review packet uses a different frozen fixture version");
  const attestation = parseBenchmarkAttestation(record.attestation);
  const database = createDatabase({ application_name: "needle-benchmark-export" });
  try {
    const databaseSchemaVersion = await currentDatabaseSchemaVersion(database.pool);
    const runs = await loadPersistedBenchmarkRuns(database.pool, attestation);
    const artifact = buildAttestedBenchmarkArtifact({
      generatedAt: new Date().toISOString(),
      databaseSchemaVersion,
      fixtureVersion: version,
      attestation,
      runs,
    });
    await writeNewJson(output, artifact);
    process.stdout.write(`${JSON.stringify({
      output: resolve(output),
      artifactSha256: artifact.artifactSha256,
      runs: artifact.provenance.runs.map((run) => ({
        benchmark: run.benchmark,
        runId: run.runId,
        manifestContentHash: run.manifestContentHash,
        matchSnapshotHash: run.matchSnapshotHash,
        candidateCount: run.candidateCount,
        manifestTrackCount: run.manifestTrackCount,
      })),
    }, null, 2)}\n`);
  } finally {
    await database.pool.end();
  }
}

const command = process.argv[2];
if (command === "prepare") await prepare();
else if (command === "finalize") await finalize();
else {
  process.stderr.write([
    "Usage:",
    "  pnpm benchmark:export -- prepare --paulinho-run <uuid> --michael-run <uuid> --berlin-run <uuid> --output <review.json>",
    "  pnpm benchmark:export -- finalize --review <review.json> --output <artifact.json>",
    "",
  ].join("\n"));
  process.exitCode = 2;
}
