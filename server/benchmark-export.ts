import type { Pool, PoolClient } from "pg";
import type {
  BenchmarkAttestation,
  BenchmarkName,
  PersistedBenchmarkCandidate,
  PersistedBenchmarkRun,
} from "../lib/benchmark-artifact.ts";
import { isPlaylistBrief } from "./brief-policy.ts";
import { sha256Hex } from "./security.ts";

const BENCHMARK_NAMES: BenchmarkName[] = ["paulinho_da_costa", "michael_jackson", "berlin_techno"];
export type BenchmarkRunIds = Record<BenchmarkName, string>;

interface RunRow {
  id: string;
  status: string;
  brief_json: unknown;
  brief_hash: string;
  manifest_id: string;
  manifest_content_hash: string;
  manifest_locked_at: Date;
}

interface CandidateRow {
  candidate_id: string;
  artist: string;
  title: string;
  outcome: string;
  match_status: string | null;
  basis: string | null;
  score: string | number | null;
  catalog_id: string | null;
  song_json: unknown;
  reviewed_at: Date | null;
  initial_status: string | null;
  initial_basis: string | null;
  initial_score: string | number | null;
  initial_catalog_id: string | null;
  initial_song_json: unknown;
  initial_matched_at: Date | null;
  manifest_position: number | null;
  manifest_catalog_id: string | null;
  factual_citation_urls: string[] | null;
  curated_citation_urls: string[] | null;
}

function timestamp(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is not a valid timestamp`);
  return date.toISOString();
}

async function loadRun(
  client: PoolClient,
  benchmark: BenchmarkName,
  runId: string,
): Promise<PersistedBenchmarkRun> {
  const runResult = await client.query<RunRow>(
    `SELECT r.id,r.status,r.brief_json,r.brief_hash,
       m.id manifest_id,m.content_hash manifest_content_hash,m.locked_at manifest_locked_at
     FROM research_runs r
     JOIN manifests m ON m.run_id=r.id
     WHERE r.id=$1 AND r.deleted_at IS NULL`,
    [runId],
  );
  const run = runResult.rows[0];
  if (!run) throw new Error(`${benchmark} run or locked manifest was not found`);
  if (!isPlaylistBrief(run.brief_json)) throw new Error(`${benchmark} persisted brief is invalid`);
  const checkpointResult = await client.query<{ state_json: unknown }>(
    "SELECT state_json FROM research_checkpoints WHERE run_id=$1 AND phase='catalog_matching'",
    [run.id],
  );
  const checkpoint = checkpointResult.rows[0]?.state_json;
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new Error(`${benchmark} has no persisted catalog-matching checkpoint`);
  }
  const checkpointState = checkpoint as Record<string, unknown>;
  if (checkpointState.complete !== true || typeof checkpointState.storefront !== "string") {
    throw new Error(`${benchmark} catalog matching is not complete`);
  }
  const storefront = checkpointState.storefront.toLowerCase();

  const candidateResult = await client.query<CandidateRow>(
    `SELECT c.id candidate_id,c.artist,c.title,c.outcome,
       cm.status match_status,cm.basis,cm.score,cm.catalog_id,cm.song_json,cm.reviewed_at,
       cm.initial_status,cm.initial_basis,cm.initial_score,cm.initial_catalog_id,cm.initial_song_json,cm.initial_matched_at,
       mt.position manifest_position,mt.catalog_id manifest_catalog_id,
       COALESCE(evidence.factual_urls,ARRAY[]::text[]) factual_citation_urls,
       COALESCE(evidence.curated_urls,ARRAY[]::text[]) curated_citation_urls
     FROM track_candidates c
     LEFT JOIN catalog_matches cm ON cm.run_id=c.run_id AND cm.candidate_id=c.id
     LEFT JOIN manifest_tracks mt ON mt.manifest_id=$2 AND mt.candidate_id=c.id
     LEFT JOIN LATERAL (
       SELECT
         array_agg(DISTINCT s.url ORDER BY s.url) FILTER (
           WHERE e.state IN ('verified','corroborated')
             AND e.support_scope='track'
             AND e.verification_phase='track_verification'
             AND s.source_class='web'
             AND EXISTS (SELECT 1 FROM citation_attestations ca
               WHERE ca.id=e.citation_attestation_id AND ca.run_id=e.run_id AND ca.source_url=s.url)
             AND e.subject_entity=ANY($3::text[])
             AND e.subject_relationship=$4
             AND (s.source_class<>'web' OR e.citation_attestation_id IS NOT NULL)
         ) factual_urls,
         array_agg(DISTINCT s.url ORDER BY s.url) FILTER (
           WHERE (
             (e.state IN ('verified','corroborated') AND e.support_scope='track' AND e.verification_phase='track_verification')
             OR e.state='editorial'
           )
             AND s.source_class='web'
             AND EXISTS (SELECT 1 FROM citation_attestations ca
               WHERE ca.id=e.citation_attestation_id AND ca.run_id=e.run_id AND ca.source_url=s.url)
             AND e.subject_entity=ANY($3::text[])
             AND e.subject_relationship=$4
             AND (s.source_class<>'web' OR e.citation_attestation_id IS NOT NULL)
         ) curated_urls
       FROM evidence_claims e
       JOIN source_records s ON s.id=e.source_id
       WHERE e.candidate_id=c.id
     ) evidence ON true
     WHERE c.run_id=$1
     ORDER BY c.id`,
    [run.id, run.manifest_id, run.brief_json.subjectEntities, run.brief_json.relationship],
  );

  const candidates: PersistedBenchmarkCandidate[] = candidateResult.rows.map((candidate) => ({
    candidateId: candidate.candidate_id,
    artist: candidate.artist,
    title: candidate.title,
    outcome: candidate.outcome,
    matchStatus: candidate.match_status ?? "",
    matchBasis: candidate.basis ?? "",
    matchScore: Number(candidate.score ?? 0),
    catalogId: candidate.catalog_id,
    song: candidate.song_json,
    reviewedAt: candidate.reviewed_at ? timestamp(candidate.reviewed_at, `${benchmark} reviewed_at`) : null,
    initialMatchStatus: candidate.initial_status,
    initialBasis: candidate.initial_basis,
    initialScore: candidate.initial_score === null ? null : Number(candidate.initial_score),
    initialCatalogId: candidate.initial_catalog_id,
    initialSong: candidate.initial_song_json,
    initialMatchedAt: candidate.initial_matched_at ? timestamp(candidate.initial_matched_at, `${benchmark} initial_matched_at`) : null,
    manifestPosition: candidate.manifest_position === null ? null : Number(candidate.manifest_position),
    factualCitationUrls: candidate.factual_citation_urls ?? [],
    curatedCitationUrls: candidate.curated_citation_urls ?? [],
  }));
  const lockedTracks = candidateResult.rows
    .filter((candidate) => candidate.manifest_position !== null)
    .sort((left, right) => Number(left.manifest_position) - Number(right.manifest_position));
  if (lockedTracks.length === 0 || lockedTracks.some((candidate, index) => (
    Number(candidate.manifest_position) !== index || !candidate.manifest_catalog_id
  ))) {
    throw new Error(`${benchmark} locked manifest has invalid positions or catalog IDs`);
  }
  const recomputedManifestHash = sha256Hex(JSON.stringify(lockedTracks.map((candidate) => [
    Number(candidate.manifest_position),
    candidate.candidate_id,
    candidate.manifest_catalog_id,
  ])));
  if (recomputedManifestHash !== run.manifest_content_hash) {
    throw new Error(`${benchmark} stored manifest content hash does not match its ordered tracks`);
  }

  return {
    benchmark,
    runId: run.id,
    status: run.status,
    storefront,
    briefHash: run.brief_hash,
    manifestId: run.manifest_id,
    manifestContentHash: run.manifest_content_hash,
    manifestLockedAt: timestamp(run.manifest_locked_at, `${benchmark} manifest locked_at`),
    candidates,
  };
}

async function loadRunsByIds(
  pool: Pool,
  runIds: BenchmarkRunIds,
): Promise<Record<BenchmarkName, PersistedBenchmarkRun>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const pairs: Array<[BenchmarkName, PersistedBenchmarkRun]> = [];
    for (const benchmark of BENCHMARK_NAMES) {
      pairs.push([benchmark, await loadRun(client, benchmark, runIds[benchmark])]);
    }
    await client.query("COMMIT");
    return Object.fromEntries(pairs) as Record<BenchmarkName, PersistedBenchmarkRun>;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function loadPersistedBenchmarkRuns(
  pool: Pool,
  attestation: BenchmarkAttestation,
): Promise<Record<BenchmarkName, PersistedBenchmarkRun>> {
  return loadRunsByIds(pool, Object.fromEntries(BENCHMARK_NAMES.map((benchmark) => [
    benchmark,
    attestation.runs[benchmark].runId,
  ])) as BenchmarkRunIds);
}

export async function loadPersistedBenchmarkRunsById(
  pool: Pool,
  runIds: BenchmarkRunIds,
): Promise<Record<BenchmarkName, PersistedBenchmarkRun>> {
  return loadRunsByIds(pool, runIds);
}
