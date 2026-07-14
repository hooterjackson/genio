import type { BenchmarkTrack, CuratedRatings, MatchAuditRow } from "./benchmarks.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";

export const BENCHMARK_ATTESTATION_SCHEMA = "needle-benchmark-attestation/v1";
export const BENCHMARK_EXPORT_SCHEMA = "needle-benchmark-export/v1";
export const BENCHMARK_ATTESTATION_STATEMENT = "I independently reviewed Apple Music availability and acceptable catalog IDs for every factual benchmark candidate.";
export const BENCHMARK_CURATED_ATTESTATION_STATEMENT = "I independently reviewed the locked Berlin techno playlist against every curated benchmark dimension.";

export type BenchmarkName = "paulinho_da_costa" | "michael_jackson" | "berlin_techno";
export type FactualBenchmarkName = Exclude<BenchmarkName, "berlin_techno">;

const BENCHMARK_NAMES: BenchmarkName[] = ["paulinho_da_costa", "michael_jackson", "berlin_techno"];
const FACTUAL_BENCHMARK_NAMES: FactualBenchmarkName[] = ["paulinho_da_costa", "michael_jackson"];
const RATING_KEYS: (keyof CuratedRatings)[] = [
  "citationQuality",
  "historicalRelevance",
  "berlinSceneFit",
  "eraDiversity",
  "artistDiversity",
  "duplicateAvoidance",
  "playlistCoherence",
];
type CuratedRationales = Record<keyof CuratedRatings, string>;

export interface BenchmarkRunBinding {
  runId: string;
  manifestId: string;
  manifestContentHash: string;
  matchSnapshotHash: string;
}

export interface MatchTruth {
  candidateId: string;
  storefrontAvailable: boolean;
  acceptableCatalogIds: string[];
  note: string;
}

export interface BenchmarkAttestation {
  schemaVersion: typeof BENCHMARK_ATTESTATION_SCHEMA;
  fixtureVersion: string;
  attestedBy: string;
  attestedAt: string;
  statement: typeof BENCHMARK_ATTESTATION_STATEMENT;
  runs: Record<BenchmarkName, BenchmarkRunBinding>;
  matchTruth: MatchTruth[];
  curatedReview: {
    statement: typeof BENCHMARK_CURATED_ATTESTATION_STATEMENT;
    ratings: CuratedRatings;
    rationales: CuratedRationales;
  };
}

export interface PersistedBenchmarkCandidate {
  candidateId: string;
  artist: string;
  title: string;
  outcome: string;
  matchStatus: string;
  matchBasis: string;
  matchScore: number;
  catalogId: string | null;
  song: unknown;
  reviewedAt: string | null;
  initialMatchStatus: string | null;
  initialBasis: string | null;
  initialScore: number | null;
  initialCatalogId: string | null;
  initialSong: unknown;
  initialMatchedAt: string | null;
  manifestPosition: number | null;
  factualCitationUrls: string[];
  curatedCitationUrls: string[];
}

export interface PersistedBenchmarkRun {
  benchmark: BenchmarkName;
  runId: string;
  status: string;
  storefront: string;
  briefHash: string;
  manifestId: string;
  manifestContentHash: string;
  manifestLockedAt: string;
  candidates: PersistedBenchmarkCandidate[];
}

export interface AttestedMatchAuditRow extends MatchAuditRow {
  runId: string;
  candidateId: string;
  initialStatus: string;
  initialCatalogId: string | null;
  finalStatus: string;
  finalCatalogId: string | null;
  acceptableCatalogIds: string[];
  attestationNote: string;
}

export interface BenchmarkExportArtifact {
  schemaVersion: typeof BENCHMARK_EXPORT_SCHEMA;
  generatedAt: string;
  fixtureVersion: string;
  attestation: {
    attestedBy: string;
    attestedAt: string;
    statement: typeof BENCHMARK_ATTESTATION_STATEMENT;
    curatedStatement: typeof BENCHMARK_CURATED_ATTESTATION_STATEMENT;
    curatedRationales: CuratedRationales;
    sha256: string;
  };
  provenance: {
    source: "postgres";
    databaseSchemaVersion: string;
    runs: Array<{
      benchmark: BenchmarkName;
      runId: string;
      status: string;
      storefront: string;
      briefHash: string;
      manifestId: string;
      manifestContentHash: string;
      matchSnapshotHash: string;
      manifestLockedAt: string;
      candidateCount: number;
      manifestTrackCount: number;
    }>;
  };
  holdouts: Record<FactualBenchmarkName, BenchmarkTrack[]>;
  matching: AttestedMatchAuditRow[];
  curated: { tracks: BenchmarkTrack[]; ratings: CuratedRatings };
  artifactSha256: string;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extras = Object.keys(record).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !(key in record));
  if (extras.length > 0 || missing.length > 0) {
    throw new Error(`${path} has invalid keys (missing: ${missing.join(", ") || "none"}; extra: ${extras.join(", ") || "none"})`);
  }
}

function text(value: unknown, path: string, maximum = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function uuid(value: unknown, path: string): string {
  const result = text(value, path, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result)) {
    throw new Error(`${path} must be a UUID`);
  }
  return result;
}

function sha256(value: unknown, path: string): string {
  const result = text(value, path, 64);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw new Error(`${path} must be a lowercase SHA-256 digest`);
  return result;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function isoDate(value: unknown, path: string): string {
  const result = text(value, path, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new Error(`${path} must be an ISO-8601 UTC timestamp`);
  }
  return result;
}

function catalogIds(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${path} must be an array of up to 20 catalog IDs`);
  const ids = value.map((item, index) => text(item, `${path}[${index}]`, 100));
  if (new Set(ids).size !== ids.length) throw new Error(`${path} contains duplicate catalog IDs`);
  return ids;
}

export function parseBenchmarkAttestation(value: unknown): BenchmarkAttestation {
  const root = object(value, "attestation");
  exactKeys(root, ["schemaVersion", "fixtureVersion", "attestedBy", "attestedAt", "statement", "runs", "matchTruth", "curatedReview"], "attestation");
  if (root.schemaVersion !== BENCHMARK_ATTESTATION_SCHEMA) throw new Error("Unsupported benchmark attestation schema");
  if (root.statement !== BENCHMARK_ATTESTATION_STATEMENT) throw new Error("The benchmark attestation statement must be accepted verbatim");

  const runInput = object(root.runs, "attestation.runs");
  exactKeys(runInput, BENCHMARK_NAMES, "attestation.runs");
  const runs = Object.fromEntries(BENCHMARK_NAMES.map((name) => {
    const binding = object(runInput[name], `attestation.runs.${name}`);
    exactKeys(binding, ["runId", "manifestId", "manifestContentHash", "matchSnapshotHash"], `attestation.runs.${name}`);
    return [name, {
      runId: uuid(binding.runId, `attestation.runs.${name}.runId`),
      manifestId: uuid(binding.manifestId, `attestation.runs.${name}.manifestId`),
      manifestContentHash: sha256(binding.manifestContentHash, `attestation.runs.${name}.manifestContentHash`),
      matchSnapshotHash: sha256(binding.matchSnapshotHash, `attestation.runs.${name}.matchSnapshotHash`),
    }];
  })) as Record<BenchmarkName, BenchmarkRunBinding>;

  if (!Array.isArray(root.matchTruth) || root.matchTruth.length === 0) {
    throw new Error("attestation.matchTruth must cover every factual benchmark candidate");
  }
  const matchTruth = root.matchTruth.map((value, index) => {
    const row = object(value, `attestation.matchTruth[${index}]`);
    exactKeys(row, ["candidateId", "storefrontAvailable", "acceptableCatalogIds", "note"], `attestation.matchTruth[${index}]`);
    const storefrontAvailable = boolean(row.storefrontAvailable, `attestation.matchTruth[${index}].storefrontAvailable`);
    const acceptableCatalogIds = catalogIds(row.acceptableCatalogIds, `attestation.matchTruth[${index}].acceptableCatalogIds`);
    if (storefrontAvailable !== (acceptableCatalogIds.length > 0)) {
      throw new Error(`attestation.matchTruth[${index}] must list acceptable IDs exactly when the recording is available`);
    }
    return {
      candidateId: uuid(row.candidateId, `attestation.matchTruth[${index}].candidateId`),
      storefrontAvailable,
      acceptableCatalogIds,
      note: text(row.note, `attestation.matchTruth[${index}].note`, 1_000),
    };
  });
  if (new Set(matchTruth.map((row) => row.candidateId)).size !== matchTruth.length) {
    throw new Error("attestation.matchTruth contains duplicate candidate IDs");
  }

  const curatedReview = object(root.curatedReview, "attestation.curatedReview");
  exactKeys(curatedReview, ["statement", "ratings", "rationales"], "attestation.curatedReview");
  if (curatedReview.statement !== BENCHMARK_CURATED_ATTESTATION_STATEMENT) {
    throw new Error("The curated benchmark attestation statement must be accepted verbatim");
  }
  const ratingInput = object(curatedReview.ratings, "attestation.curatedReview.ratings");
  exactKeys(ratingInput, RATING_KEYS, "attestation.curatedReview.ratings");
  const curatedRatings = Object.fromEntries(RATING_KEYS.map((key) => {
    const value = ratingInput[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 5) {
      throw new Error(`attestation.curatedReview.ratings.${key} must be between 0 and 5`);
    }
    return [key, value];
  })) as unknown as CuratedRatings;
  const rationaleInput = object(curatedReview.rationales, "attestation.curatedReview.rationales");
  exactKeys(rationaleInput, RATING_KEYS, "attestation.curatedReview.rationales");
  const curatedRationales = Object.fromEntries(RATING_KEYS.map((key) => [
    key,
    text(rationaleInput[key], `attestation.curatedReview.rationales.${key}`, 1_000),
  ])) as CuratedRationales;

  return {
    schemaVersion: BENCHMARK_ATTESTATION_SCHEMA,
    fixtureVersion: text(root.fixtureVersion, "attestation.fixtureVersion", 40),
    attestedBy: text(root.attestedBy, "attestation.attestedBy", 200),
    attestedAt: isoDate(root.attestedAt, "attestation.attestedAt"),
    statement: BENCHMARK_ATTESTATION_STATEMENT,
    runs,
    matchTruth,
    curatedReview: {
      statement: BENCHMARK_CURATED_ATTESTATION_STATEMENT,
      ratings: curatedRatings,
      rationales: curatedRationales,
    },
  };
}

export function benchmarkMatchSnapshotHash(run: PersistedBenchmarkRun): string {
  return sha256Hex(stableStringify([...run.candidates]
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    .map((candidate) => ({
      candidateId: candidate.candidateId,
      artist: candidate.artist,
      title: candidate.title,
      outcome: candidate.outcome,
      initialMatchStatus: candidate.initialMatchStatus,
      initialBasis: candidate.initialBasis,
      initialScore: candidate.initialScore,
      initialCatalogId: candidate.initialCatalogId,
      initialSong: candidate.initialSong,
      initialMatchedAt: candidate.initialMatchedAt,
      finalMatchStatus: candidate.matchStatus,
      finalBasis: candidate.matchBasis,
      finalScore: candidate.matchScore,
      finalCatalogId: candidate.catalogId,
      finalSong: candidate.song,
      reviewedAt: candidate.reviewedAt,
      manifestPosition: candidate.manifestPosition,
    }))));
}

export function benchmarkAttestationHash(attestation: BenchmarkAttestation): string {
  return sha256Hex(stableStringify({
    ...attestation,
    matchTruth: [...attestation.matchTruth].sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
  }));
}

function assertBinding(attestation: BenchmarkAttestation, run: PersistedBenchmarkRun): void {
  const expected = attestation.runs[run.benchmark];
  if (run.runId !== expected.runId
    || run.manifestId !== expected.manifestId
    || run.manifestContentHash !== expected.manifestContentHash
    || benchmarkMatchSnapshotHash(run) !== expected.matchSnapshotHash) {
    throw new Error(`${run.benchmark} persisted run or manifest does not match the attested binding`);
  }
  if (run.storefront !== "us") throw new Error(`${run.benchmark} was not matched against the required US storefront`);
  if (!run.candidates.length) throw new Error(`${run.benchmark} has no persisted candidates`);
  if (new Set(run.candidates.map((candidate) => candidate.candidateId)).size !== run.candidates.length) {
    throw new Error(`${run.benchmark} contains duplicate persisted candidate IDs`);
  }
  if (run.candidates.some((candidate) => !candidate.matchStatus)) {
    throw new Error(`${run.benchmark} has candidates without a persisted catalog outcome`);
  }
  const positions = run.candidates
    .filter((candidate) => candidate.manifestPosition !== null)
    .map((candidate) => candidate.manifestPosition!)
    .sort((left, right) => left - right);
  if (positions.some((position, index) => position !== index)) {
    throw new Error(`${run.benchmark} manifest positions are not contiguous from zero`);
  }
}

export function buildAttestedBenchmarkArtifact(input: {
  generatedAt: string;
  databaseSchemaVersion: string;
  fixtureVersion: string;
  attestation: BenchmarkAttestation;
  runs: Record<BenchmarkName, PersistedBenchmarkRun>;
}): BenchmarkExportArtifact {
  if (input.fixtureVersion !== input.attestation.fixtureVersion) throw new Error("Attestation fixture version does not match the frozen fixture");
  const orderedRuns = BENCHMARK_NAMES.map((name) => input.runs[name]);
  orderedRuns.forEach((run, index) => {
    if (!run || run.benchmark !== BENCHMARK_NAMES[index]) throw new Error(`Missing persisted ${BENCHMARK_NAMES[index]} run`);
    assertBinding(input.attestation, run);
  });

  const factualCandidates = FACTUAL_BENCHMARK_NAMES.flatMap((name) => input.runs[name].candidates.map((candidate) => ({
    runId: input.runs[name].runId,
    candidate,
  })));
  if (factualCandidates.some(({ candidate }) => (
    candidate.initialMatchStatus === null || candidate.initialMatchedAt === null
  ))) {
    throw new Error("Factual benchmark runs contain legacy matches without immutable initial decisions; rerun matching after the schema upgrade");
  }
  const truth = new Map(input.attestation.matchTruth.map((row) => [row.candidateId, row]));
  const factualIds = new Set(factualCandidates.map(({ candidate }) => candidate.candidateId));
  const missingTruth = [...factualIds].filter((candidateId) => !truth.has(candidateId));
  const extraTruth = [...truth.keys()].filter((candidateId) => !factualIds.has(candidateId));
  if (missingTruth.length > 0 || extraTruth.length > 0) {
    throw new Error(`Match truth must exactly cover persisted factual candidates (missing ${missingTruth.length}, extra ${extraTruth.length})`);
  }

  const holdouts = Object.fromEntries(FACTUAL_BENCHMARK_NAMES.map((name) => [
    name,
    input.runs[name].candidates
      .filter((candidate) => candidate.factualCitationUrls.length > 0)
      .map((candidate) => ({ artist: candidate.artist, title: candidate.title, citationUrls: candidate.factualCitationUrls })),
  ])) as Record<FactualBenchmarkName, BenchmarkTrack[]>;

  const matching: AttestedMatchAuditRow[] = factualCandidates.map(({ runId, candidate }) => {
    const expected = truth.get(candidate.candidateId)!;
    const correct = candidate.initialMatchStatus === "accepted"
      && candidate.initialCatalogId !== null
      && expected.acceptableCatalogIds.includes(candidate.initialCatalogId);
    const resolved = ["accepted", "duplicate"].includes(candidate.matchStatus)
      && candidate.catalogId !== null
      && expected.acceptableCatalogIds.includes(candidate.catalogId);
    return {
      runId,
      candidateId: candidate.candidateId,
      initialStatus: candidate.initialMatchStatus!,
      initialCatalogId: candidate.initialCatalogId,
      finalStatus: candidate.matchStatus,
      finalCatalogId: candidate.catalogId,
      acceptableCatalogIds: expected.acceptableCatalogIds,
      attestationNote: expected.note,
      autoAccepted: candidate.initialMatchStatus === "accepted",
      correct,
      storefrontAvailable: expected.storefrontAvailable,
      resolved: expected.storefrontAvailable && resolved,
    };
  });

  const curatedCandidates = input.runs.berlin_techno.candidates
    .filter((candidate) => candidate.manifestPosition !== null)
    .sort((left, right) => left.manifestPosition! - right.manifestPosition!);
  const curated = {
    tracks: curatedCandidates.map((candidate) => ({
      artist: candidate.artist,
      title: candidate.title,
      citationUrls: candidate.curatedCitationUrls,
    })),
    ratings: input.attestation.curatedReview.ratings,
  };

  const unsigned: Omit<BenchmarkExportArtifact, "artifactSha256"> = {
    schemaVersion: BENCHMARK_EXPORT_SCHEMA,
    generatedAt: isoDate(input.generatedAt, "generatedAt"),
    fixtureVersion: input.fixtureVersion,
    attestation: {
      attestedBy: input.attestation.attestedBy,
      attestedAt: input.attestation.attestedAt,
      statement: input.attestation.statement,
      curatedStatement: input.attestation.curatedReview.statement,
      curatedRationales: input.attestation.curatedReview.rationales,
      sha256: benchmarkAttestationHash(input.attestation),
    },
    provenance: {
      source: "postgres" as const,
      databaseSchemaVersion: input.databaseSchemaVersion,
      runs: orderedRuns.map((run) => ({
        benchmark: run.benchmark,
        runId: run.runId,
        status: run.status,
        storefront: run.storefront,
        briefHash: run.briefHash,
        manifestId: run.manifestId,
        manifestContentHash: run.manifestContentHash,
        matchSnapshotHash: benchmarkMatchSnapshotHash(run),
        manifestLockedAt: run.manifestLockedAt,
        candidateCount: run.candidates.length,
        manifestTrackCount: run.candidates.filter((candidate) => candidate.manifestPosition !== null).length,
      })),
    },
    holdouts,
    matching,
    curated,
  };
  return { ...unsigned, artifactSha256: sha256Hex(stableStringify(unsigned)) };
}

export function verifyBenchmarkExportArtifact(artifact: unknown, fixtureVersion: string): asserts artifact is BenchmarkExportArtifact {
  const root = object(artifact, "benchmark export");
  exactKeys(root, ["schemaVersion", "generatedAt", "fixtureVersion", "attestation", "provenance", "holdouts", "matching", "curated", "artifactSha256"], "benchmark export");
  if (root.schemaVersion !== BENCHMARK_EXPORT_SCHEMA) throw new Error("Unsupported benchmark export schema");
  if (root.fixtureVersion !== fixtureVersion) throw new Error("Benchmark export fixture version does not match the frozen fixture");
  isoDate(root.generatedAt, "benchmark export.generatedAt");
  const artifactHash = sha256(root.artifactSha256, "benchmark export.artifactSha256");
  const unsigned = { ...root };
  delete unsigned.artifactSha256;
  if (artifactHash !== sha256Hex(stableStringify(unsigned))) throw new Error("Benchmark export content hash is invalid");

  const attestation = object(root.attestation, "benchmark export.attestation");
  exactKeys(attestation, ["attestedBy", "attestedAt", "statement", "curatedStatement", "curatedRationales", "sha256"], "benchmark export.attestation");
  text(attestation.attestedBy, "benchmark export.attestation.attestedBy", 200);
  isoDate(attestation.attestedAt, "benchmark export.attestation.attestedAt");
  if (attestation.statement !== BENCHMARK_ATTESTATION_STATEMENT
    || attestation.curatedStatement !== BENCHMARK_CURATED_ATTESTATION_STATEMENT) {
    throw new Error("Benchmark export attestation statements are invalid");
  }
  sha256(attestation.sha256, "benchmark export.attestation.sha256");
  const rationales = object(attestation.curatedRationales, "benchmark export.attestation.curatedRationales");
  exactKeys(rationales, RATING_KEYS, "benchmark export.attestation.curatedRationales");
  RATING_KEYS.forEach((key) => text(rationales[key], `benchmark export.attestation.curatedRationales.${key}`, 1_000));

  const provenance = object(root.provenance, "benchmark export.provenance");
  exactKeys(provenance, ["source", "databaseSchemaVersion", "runs"], "benchmark export.provenance");
  if (provenance.source !== "postgres") throw new Error("Benchmark export lacks persisted run provenance");
  text(provenance.databaseSchemaVersion, "benchmark export.provenance.databaseSchemaVersion", 40);
  if (!Array.isArray(provenance.runs) || provenance.runs.length !== BENCHMARK_NAMES.length) {
    throw new Error("Benchmark export must contain all persisted benchmark runs");
  }
  provenance.runs.forEach((value, index) => {
    const run = object(value, `benchmark export.provenance.runs[${index}]`);
    exactKeys(run, ["benchmark", "runId", "status", "storefront", "briefHash", "manifestId", "manifestContentHash", "matchSnapshotHash", "manifestLockedAt", "candidateCount", "manifestTrackCount"], `benchmark export.provenance.runs[${index}]`);
    if (run.benchmark !== BENCHMARK_NAMES[index]) throw new Error("Benchmark export run order is invalid");
    uuid(run.runId, `benchmark export.provenance.runs[${index}].runId`);
    uuid(run.manifestId, `benchmark export.provenance.runs[${index}].manifestId`);
    sha256(run.briefHash, `benchmark export.provenance.runs[${index}].briefHash`);
    sha256(run.manifestContentHash, `benchmark export.provenance.runs[${index}].manifestContentHash`);
    sha256(run.matchSnapshotHash, `benchmark export.provenance.runs[${index}].matchSnapshotHash`);
    isoDate(run.manifestLockedAt, `benchmark export.provenance.runs[${index}].manifestLockedAt`);
    if (run.storefront !== "us") throw new Error("Benchmark export storefront must be US");
    for (const key of ["candidateCount", "manifestTrackCount"] as const) {
      if (!Number.isInteger(run[key]) || (run[key] as number) < 0) throw new Error(`benchmark export ${key} is invalid`);
    }
  });

  const holdouts = object(root.holdouts, "benchmark export.holdouts");
  exactKeys(holdouts, FACTUAL_BENCHMARK_NAMES, "benchmark export.holdouts");
  for (let index = 0; index < FACTUAL_BENCHMARK_NAMES.length; index += 1) {
    const name = FACTUAL_BENCHMARK_NAMES[index]!;
    const trackCount = validateExportTracks(holdouts[name], `benchmark export.holdouts.${name}`);
    const run = provenance.runs[index] as Record<string, unknown>;
    if (trackCount > Number(run.candidateCount)) throw new Error(`benchmark export.holdouts.${name} exceeds its persisted candidate count`);
  }

  if (!Array.isArray(root.matching)) throw new Error("benchmark export.matching must be an array");
  const factualRunCounts = new Map(provenance.runs.slice(0, 2).map((value) => {
    const run = value as Record<string, unknown>;
    return [String(run.runId), Number(run.candidateCount)];
  }));
  const exportedMatchCounts = new Map<string, number>();
  const exportedCandidateIds = new Set<string>();
  root.matching.forEach((value, index) => {
    const row = object(value, `benchmark export.matching[${index}]`);
    exactKeys(row, ["runId", "candidateId", "initialStatus", "initialCatalogId", "finalStatus", "finalCatalogId", "acceptableCatalogIds", "attestationNote", "autoAccepted", "correct", "storefrontAvailable", "resolved"], `benchmark export.matching[${index}]`);
    const runId = uuid(row.runId, `benchmark export.matching[${index}].runId`);
    const candidateId = uuid(row.candidateId, `benchmark export.matching[${index}].candidateId`);
    if (!factualRunCounts.has(runId)) throw new Error(`benchmark export.matching[${index}] references a non-factual run`);
    if (exportedCandidateIds.has(candidateId)) throw new Error("benchmark export.matching contains a duplicate candidate ID");
    exportedCandidateIds.add(candidateId);
    exportedMatchCounts.set(runId, (exportedMatchCounts.get(runId) ?? 0) + 1);
    const initialStatus = text(row.initialStatus, `benchmark export.matching[${index}].initialStatus`, 40);
    if (row.initialCatalogId !== null) text(row.initialCatalogId, `benchmark export.matching[${index}].initialCatalogId`, 100);
    const finalStatus = text(row.finalStatus, `benchmark export.matching[${index}].finalStatus`, 40);
    if (row.finalCatalogId !== null) text(row.finalCatalogId, `benchmark export.matching[${index}].finalCatalogId`, 100);
    const acceptable = catalogIds(row.acceptableCatalogIds, `benchmark export.matching[${index}].acceptableCatalogIds`);
    text(row.attestationNote, `benchmark export.matching[${index}].attestationNote`, 1_000);
    for (const key of ["autoAccepted", "correct", "storefrontAvailable", "resolved"] as const) boolean(row[key], `benchmark export.matching[${index}].${key}`);
    const derivedAutoAccepted = initialStatus === "accepted";
    const derivedCorrect = derivedAutoAccepted && typeof row.initialCatalogId === "string" && acceptable.includes(row.initialCatalogId);
    const derivedResolved = row.storefrontAvailable === true
      && ["accepted", "duplicate"].includes(finalStatus)
      && typeof row.finalCatalogId === "string"
      && acceptable.includes(row.finalCatalogId);
    if (row.autoAccepted !== derivedAutoAccepted || row.correct !== derivedCorrect || row.resolved !== derivedResolved) {
      throw new Error(`benchmark export.matching[${index}] contains non-derived metric values`);
    }
  });
  for (const [runId, candidateCount] of factualRunCounts) {
    if (exportedMatchCounts.get(runId) !== candidateCount) {
      throw new Error("benchmark export.matching does not exactly cover the persisted factual candidate counts");
    }
  }

  const curated = object(root.curated, "benchmark export.curated");
  exactKeys(curated, ["tracks", "ratings"], "benchmark export.curated");
  const curatedTrackCount = validateExportTracks(curated.tracks, "benchmark export.curated.tracks");
  const berlinRun = provenance.runs[2] as Record<string, unknown>;
  if (curatedTrackCount !== Number(berlinRun.manifestTrackCount)) {
    throw new Error("benchmark export.curated.tracks does not match the persisted Berlin manifest count");
  }
  const ratings = object(curated.ratings, "benchmark export.curated.ratings");
  exactKeys(ratings, RATING_KEYS, "benchmark export.curated.ratings");
  RATING_KEYS.forEach((key) => {
    const value = ratings[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 5) throw new Error(`benchmark export rating ${key} is invalid`);
  });

  const typed = root as unknown as BenchmarkExportArtifact;
  const reconstructedAttestation: BenchmarkAttestation = {
    schemaVersion: BENCHMARK_ATTESTATION_SCHEMA,
    fixtureVersion: typed.fixtureVersion,
    attestedBy: typed.attestation.attestedBy,
    attestedAt: typed.attestation.attestedAt,
    statement: BENCHMARK_ATTESTATION_STATEMENT,
    runs: Object.fromEntries(typed.provenance.runs.map((run) => [run.benchmark, {
      runId: run.runId,
      manifestId: run.manifestId,
      manifestContentHash: run.manifestContentHash,
      matchSnapshotHash: run.matchSnapshotHash,
    }])) as Record<BenchmarkName, BenchmarkRunBinding>,
    matchTruth: typed.matching.map((row) => ({
      candidateId: row.candidateId,
      storefrontAvailable: row.storefrontAvailable,
      acceptableCatalogIds: row.acceptableCatalogIds,
      note: row.attestationNote,
    })),
    curatedReview: {
      statement: BENCHMARK_CURATED_ATTESTATION_STATEMENT,
      ratings: typed.curated.ratings,
      rationales: typed.attestation.curatedRationales,
    },
  };
  if (typed.attestation.sha256 !== benchmarkAttestationHash(reconstructedAttestation)) {
    throw new Error("Benchmark export attestation hash is invalid");
  }
}

function validateExportTracks(value: unknown, path: string): number {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  value.forEach((item, index) => {
    const track = object(item, `${path}[${index}]`);
    exactKeys(track, ["artist", "title", "citationUrls"], `${path}[${index}]`);
    text(track.artist, `${path}[${index}].artist`, 240);
    text(track.title, `${path}[${index}].title`, 240);
    if (!Array.isArray(track.citationUrls) || track.citationUrls.some((url) => typeof url !== "string" || !url.startsWith("https://"))) {
      throw new Error(`${path}[${index}].citationUrls must contain HTTPS URLs`);
    }
  });
  return value.length;
}
