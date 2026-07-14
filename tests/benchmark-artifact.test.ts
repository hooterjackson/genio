import { describe, expect, test } from "vitest";
import {
  BENCHMARK_ATTESTATION_SCHEMA,
  BENCHMARK_ATTESTATION_STATEMENT,
  BENCHMARK_CURATED_ATTESTATION_STATEMENT,
  benchmarkMatchSnapshotHash,
  buildAttestedBenchmarkArtifact,
  parseBenchmarkAttestation,
  verifyBenchmarkExportArtifact,
  type BenchmarkAttestation,
  type BenchmarkName,
  type PersistedBenchmarkCandidate,
  type PersistedBenchmarkRun,
} from "../lib/benchmark-artifact.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";

function uuid(value: number): string {
  return `10000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function candidate(input: Partial<PersistedBenchmarkCandidate> & Pick<PersistedBenchmarkCandidate, "candidateId" | "artist" | "title">): PersistedBenchmarkCandidate {
  return {
    outcome: "accepted",
    matchStatus: "accepted",
    matchBasis: "Final exact compatible match",
    matchScore: 1,
    catalogId: `catalog-${input.candidateId.slice(-1)}`,
    song: { id: `catalog-${input.candidateId.slice(-1)}` },
    reviewedAt: null,
    initialMatchStatus: "accepted",
    initialBasis: "Initial exact compatible match",
    initialScore: 1,
    initialCatalogId: `catalog-${input.candidateId.slice(-1)}`,
    initialSong: { id: `catalog-${input.candidateId.slice(-1)}` },
    initialMatchedAt: "2026-07-14T12:00:00.000Z",
    manifestPosition: 0,
    factualCitationUrls: ["https://sources.example/factual"],
    curatedCitationUrls: ["https://sources.example/curated"],
    ...input,
  };
}

function run(benchmark: BenchmarkName, value: number, candidates: PersistedBenchmarkCandidate[]): PersistedBenchmarkRun {
  return {
    benchmark,
    runId: uuid(value),
    status: "complete",
    storefront: "us",
    briefHash: value.toString(16).padStart(64, "a").slice(-64),
    manifestId: uuid(value + 100),
    manifestContentHash: value.toString(16).padStart(64, "b").slice(-64),
    manifestLockedAt: "2026-07-14T13:00:00.000Z",
    candidates,
  };
}

function fixture() {
  const paulinho = run("paulinho_da_costa", 1, [candidate({
    candidateId: uuid(201),
    artist: "USA for Africa",
    title: "We Are the World",
    catalogId: "apple-paulinho",
    initialCatalogId: "apple-paulinho",
  })]);
  const michael = run("michael_jackson", 2, [candidate({
    candidateId: uuid(202),
    artist: "Michael Jackson",
    title: "Human Nature",
    initialMatchStatus: "review",
    initialCatalogId: "apple-wrong-version",
    catalogId: "apple-michael",
    reviewedAt: "2026-07-14T12:30:00.000Z",
  })]);
  const berlin = run("berlin_techno", 3, [
    candidate({ candidateId: uuid(203), artist: "Artist B", title: "Track B", manifestPosition: 1, factualCitationUrls: [] }),
    candidate({ candidateId: uuid(204), artist: "Artist A", title: "Track A", manifestPosition: 0, factualCitationUrls: [] }),
  ]);
  const runs = { paulinho_da_costa: paulinho, michael_jackson: michael, berlin_techno: berlin };
  const raw = {
    schemaVersion: BENCHMARK_ATTESTATION_SCHEMA,
    fixtureVersion: "2026-07-14",
    attestedBy: "Independent reviewer",
    attestedAt: "2026-07-14T14:00:00.000Z",
    statement: BENCHMARK_ATTESTATION_STATEMENT,
    runs: Object.fromEntries(Object.values(runs).map((item) => [item.benchmark, {
      runId: item.runId,
      manifestId: item.manifestId,
      manifestContentHash: item.manifestContentHash,
      matchSnapshotHash: benchmarkMatchSnapshotHash(item),
    }])),
    matchTruth: [
      { candidateId: uuid(201), storefrontAvailable: true, acceptableCatalogIds: ["apple-paulinho"], note: "Exact US storefront studio recording." },
      { candidateId: uuid(202), storefrontAvailable: true, acceptableCatalogIds: ["apple-michael"], note: "Reviewed against the canonical album version." },
    ],
    curatedReview: {
      statement: BENCHMARK_CURATED_ATTESTATION_STATEMENT,
      ratings: {
        citationQuality: 5,
        historicalRelevance: 5,
        berlinSceneFit: 5,
        eraDiversity: 5,
        artistDiversity: 5,
        duplicateAvoidance: 5,
        playlistCoherence: 5,
      },
      rationales: {
        citationQuality: "Each locked track has a source-backed editorial claim.",
        historicalRelevance: "The selections cover documented scene milestones.",
        berlinSceneFit: "The artists and releases have direct Berlin scene relevance.",
        eraDiversity: "The ordered set spans distinct periods in the scene.",
        artistDiversity: "No single artist dominates the locked playlist.",
        duplicateAvoidance: "Each recording appears once in its intended version.",
        playlistCoherence: "The final order forms a coherent historical progression.",
      },
    },
  };
  return { raw, runs };
}

describe("attested benchmark exports", () => {
  test("derives tracks and matching metrics from persisted snapshots plus bounded human truth", () => {
    const { raw, runs } = fixture();
    const attestation = parseBenchmarkAttestation(raw);
    const artifact = buildAttestedBenchmarkArtifact({
      generatedAt: "2026-07-14T15:00:00.000Z",
      databaseSchemaVersion: "4",
      fixtureVersion: "2026-07-14",
      attestation,
      runs,
    });

    expect(artifact.holdouts.paulinho_da_costa).toEqual([
      expect.objectContaining({ artist: "USA for Africa", title: "We Are the World" }),
    ]);
    expect(artifact.matching).toEqual([
      expect.objectContaining({ autoAccepted: true, correct: true, resolved: true }),
      expect.objectContaining({ autoAccepted: false, correct: false, resolved: true }),
    ]);
    expect(artifact.curated.tracks.map((track) => track.title)).toEqual(["Track A", "Track B"]);
    expect(() => verifyBenchmarkExportArtifact(artifact, "2026-07-14")).not.toThrow();
  });

  test("rejects arbitrary metric fields, incomplete truth, legacy decisions, and tampering", () => {
    const { raw, runs } = fixture();
    const withInventedMetric = structuredClone(raw);
    (withInventedMetric.matchTruth[0] as Record<string, unknown>).correct = true;
    expect(() => parseBenchmarkAttestation(withInventedMetric)).toThrow(/invalid keys/i);

    const attestation = parseBenchmarkAttestation(raw);
    const incomplete: BenchmarkAttestation = { ...attestation, matchTruth: attestation.matchTruth.slice(0, 1) };
    expect(() => buildAttestedBenchmarkArtifact({
      generatedAt: "2026-07-14T15:00:00.000Z",
      databaseSchemaVersion: "4",
      fixtureVersion: "2026-07-14",
      attestation: incomplete,
      runs,
    })).toThrow(/exactly cover/i);

    const legacyRuns = structuredClone(runs);
    legacyRuns.paulinho_da_costa.candidates[0]!.initialMatchStatus = null;
    legacyRuns.paulinho_da_costa.candidates[0]!.initialMatchedAt = null;
    const legacyAttestation = {
      ...attestation,
      runs: {
        ...attestation.runs,
        paulinho_da_costa: {
          ...attestation.runs.paulinho_da_costa,
          matchSnapshotHash: benchmarkMatchSnapshotHash(legacyRuns.paulinho_da_costa),
        },
      },
    };
    expect(() => buildAttestedBenchmarkArtifact({
      generatedAt: "2026-07-14T15:00:00.000Z",
      databaseSchemaVersion: "4",
      fixtureVersion: "2026-07-14",
      attestation: legacyAttestation,
      runs: legacyRuns,
    })).toThrow(/legacy matches/i);

    const artifact = buildAttestedBenchmarkArtifact({
      generatedAt: "2026-07-14T15:00:00.000Z",
      databaseSchemaVersion: "4",
      fixtureVersion: "2026-07-14",
      attestation,
      runs,
    });
    const tampered = structuredClone(artifact);
    tampered.curated.tracks[0]!.title = "Invented replacement";
    expect(() => verifyBenchmarkExportArtifact(tampered, "2026-07-14")).toThrow(/content hash/i);

    const inventedMetric = structuredClone(artifact);
    inventedMetric.matching[0]!.correct = false;
    const inventedMetricBody = { ...inventedMetric };
    delete (inventedMetricBody as Partial<typeof inventedMetric>).artifactSha256;
    inventedMetric.artifactSha256 = sha256Hex(stableStringify(inventedMetricBody));
    expect(() => verifyBenchmarkExportArtifact(inventedMetric, "2026-07-14")).toThrow(/non-derived metric/i);
    expect(() => verifyBenchmarkExportArtifact({ holdouts: {}, matching: [], curated: {} }, "2026-07-14"))
      .toThrow(/invalid keys/i);
  });
});
