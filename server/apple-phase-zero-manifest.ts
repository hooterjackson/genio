import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Repository } from "./repository.ts";
import { manifestContentHash, type LockedManifestTrack } from "./publisher.ts";
import { sha256Hex, stableStringify } from "./security.ts";
import {
  APPLE_PHASE_ZERO_CASES,
  type ApplePhaseZeroLockedManifest,
  type ApplePhaseZeroManifestInput,
} from "./apple-phase-zero.ts";

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function releaseYear(releaseDate: string | undefined): number | null {
  if (!releaseDate) return null;
  const match = /^(\d{4})/u.exec(releaseDate);
  const year = Number(match?.[1]);
  return Number.isInteger(year) && year >= 1800 && year <= 2200 ? year : null;
}

function validateInput(input: ApplePhaseZeroManifestInput): void {
  const testCase = APPLE_PHASE_ZERO_CASES.find((item) => item.id === input.caseId);
  if (!testCase || input.tracks.length !== testCase.trackCount) {
    throw new Error("phase-zero manifest case has an invalid exact track count");
  }
  if (!input.name.startsWith("[NEEDLE TEST] ") || input.name.length > 240) {
    throw new Error("phase-zero manifest name must use the [NEEDLE TEST] namespace");
  }
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/u.test(input.suiteId)) throw new Error("phase-zero suite ID is invalid");
  if (!/^[a-f0-9]{64}$/u.test(input.fixtureHash)) throw new Error("phase-zero fixture hash is invalid");
  if (!/^[a-z]{2}$/u.test(input.storefront)) throw new Error("phase-zero storefront is invalid");
  const ids = input.tracks.map((track) => track.id);
  if (ids.some((id) => !/^\d{1,32}$/u.test(id))) {
    throw new Error("phase-zero manifest requires numeric Apple catalog IDs");
  }
}

async function existingManifest(
  client: Pick<PoolClient, "query">,
  runId: string,
  expectedHash: string,
): Promise<ApplePhaseZeroLockedManifest | null> {
  const manifest = await client.query(
    "SELECT id,run_id,name,description,content_hash,locked_at FROM manifests WHERE run_id=$1",
    [runId],
  );
  if (!manifest.rows[0]) return null;
  if (manifest.rows[0].content_hash !== expectedHash) {
    throw new Error("an existing phase-zero suite case has different accepted catalog IDs");
  }
  const tracks = await client.query(
    "SELECT position,candidate_id,catalog_id,artist,title FROM manifest_tracks WHERE manifest_id=$1 ORDER BY position",
    [manifest.rows[0].id],
  );
  return {
    id: manifest.rows[0].id,
    runId: manifest.rows[0].run_id,
    name: manifest.rows[0].name,
    description: manifest.rows[0].description,
    contentHash: manifest.rows[0].content_hash,
    lockedAt: new Date(manifest.rows[0].locked_at).toISOString(),
    tracks: tracks.rows.map((track) => ({
      position: track.position,
      candidateId: track.candidate_id,
      catalogId: track.catalog_id,
      artist: track.artist,
      title: track.title,
    })),
  };
}

/**
 * Creates an operational test manifest with exact caller-approved Apple IDs.
 * This does not claim research evidence: the source and evidence rows are
 * explicitly marked as an inferred Apple catalog fixture. Publication still
 * runs through the normal immutable-manifest publisher and durability tables.
 */
export async function createApplePhaseZeroManifest(
  repository: Pick<Repository, "pool">,
  input: ApplePhaseZeroManifestInput,
): Promise<ApplePhaseZeroLockedManifest> {
  validateInput(input);
  const namespace = `apple-phase-zero:${input.suiteId}:${input.caseId}`;
  const runId = deterministicUuid(`${namespace}:run`);
  const manifestId = deterministicUuid(`${namespace}:manifest`);
  const sourceId = deterministicUuid(`${namespace}:source`);
  const candidateIds = input.tracks.map((track, position) => deterministicUuid(`${namespace}:candidate:${position}:${track.id}`));
  const lockedTracks: LockedManifestTrack[] = input.tracks.map((track, position) => ({
    position,
    candidateId: candidateIds[position]!,
    catalogId: track.id,
    artist: track.artistName,
    title: track.name,
  }));
  const contentHash = manifestContentHash(lockedTracks);
  const client = await repository.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [namespace]);
    const prior = await existingManifest(client, runId, contentHash);
    if (prior) {
      await client.query("COMMIT");
      return prior;
    }

    const brief = {
      title: input.name,
      description: "Operational Apple Music publication capacity fixture; not a research result.",
      mode: "hybrid",
      subjectEntities: ["Explicit owner-approved Apple catalog IDs"],
      relationship: "Operational phase-zero fixture",
      include: [`Exactly ${input.tracks.length} accepted Apple catalog IDs`],
      exclude: ["Research inference", "Unresolved catalog IDs"],
      versionPolicy: "Use the explicitly resolved Apple catalog recording IDs.",
      evidencePolicy: "Operational fixture only; no factual relationship claim.",
      orderingPolicy: "Exact owner-approved fixture order.",
      targetSize: { min: input.tracks.length, max: input.tracks.length },
      ambiguities: [],
    };
    const clientBucket = `phase-zero.${sha256Hex(input.suiteId).slice(0, 32)}`;
    await client.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,idempotency_key,
         estimated_cost_usd,approved_budget_usd,retention_expires_at)
       VALUES($1,$2,$3,$4,'manifest_ready','phase_zero_manifest',$5,$6,0,0,now()+interval '90 days')`,
      [runId, `${input.name}: exact Apple publication fixture`, brief, sha256Hex(stableStringify(brief)), clientBucket, input.caseId],
    );
    await client.query(
      `INSERT INTO source_records(id,run_id,url,title,source_class,provenance_root,note)
       VALUES($1,$2,$3,$4,'apple','music.apple.com',$5)`,
      [
        sourceId,
        runId,
        `https://music.apple.com/${input.storefront}/`,
        "Apple catalog phase-zero fixture",
        "Operational catalog resolution only; this is not evidence of an artist, credit, or influence claim.",
      ],
    );

    const rows = input.tracks.map((track, position) => ({
      candidateId: candidateIds[position]!,
      position,
      canonicalKey: `phase-zero:${input.fixtureHash}:${input.caseId}:${position}:${track.id}`,
      artist: track.artistName.slice(0, 240),
      title: track.name.slice(0, 240),
      album: track.albumName.slice(0, 240) || null,
      releaseYear: releaseYear(track.releaseDate),
      durationMs: track.durationInMillis ?? null,
      versionLabel: track.versionLabel?.slice(0, 120) ?? null,
      catalogId: track.id,
      song: track,
      evidenceId: deterministicUuid(`${namespace}:evidence:${position}:${track.id}`),
      matchId: deterministicUuid(`${namespace}:match:${position}:${track.id}`),
    }));
    const json = JSON.stringify(rows);
    await client.query(
      `INSERT INTO track_candidates(
         id,run_id,canonical_key,artist,title,album,release_year,duration_ms,version_label,outcome)
       SELECT x.candidate_id,$2,x.canonical_key,x.artist,x.title,x.album,x.release_year,x.duration_ms,x.version_label,'accepted'
       FROM jsonb_to_recordset($1::jsonb) AS x(
         candidate_id uuid,position integer,canonical_key text,artist text,title text,album text,
         release_year integer,duration_ms integer,version_label text,catalog_id text,song jsonb,evidence_id uuid,match_id uuid)`,
      [json, runId],
    );
    await client.query(
      `INSERT INTO evidence_claims(
         id,run_id,candidate_id,source_id,state,support_scope,verification_phase,
         subject_entity,subject_relationship,relationship,note)
       SELECT x.evidence_id,$2,x.candidate_id,$3,'inferred','track','catalog_enrichment',
         'Explicit owner-approved Apple catalog IDs','Operational phase-zero fixture',
         'phase-zero operational catalog fixture',
         'The owner explicitly accepted this Apple catalog ID for capacity testing; no research claim is asserted.'
       FROM jsonb_to_recordset($1::jsonb) AS x(
         candidate_id uuid,position integer,canonical_key text,artist text,title text,album text,
         release_year integer,duration_ms integer,version_label text,catalog_id text,song jsonb,evidence_id uuid,match_id uuid)`,
      [json, runId, sourceId],
    );
    await client.query(
      `INSERT INTO catalog_matches(
         id,run_id,candidate_id,status,basis,score,catalog_id,song_json,alternatives_json,reviewed_at)
       SELECT x.match_id,$2,x.candidate_id,'accepted','Owner accepted an exact storefront-resolved catalog ID',
         1,x.catalog_id,x.song,'[]'::jsonb,now()
       FROM jsonb_to_recordset($1::jsonb) AS x(
         candidate_id uuid,position integer,canonical_key text,artist text,title text,album text,
         release_year integer,duration_ms integer,version_label text,catalog_id text,song jsonb,evidence_id uuid,match_id uuid)`,
      [json, runId],
    );
    await client.query(
      "INSERT INTO manifests(id,run_id,name,description,content_hash) VALUES($1,$2,$3,$4,$5)",
      [manifestId, runId, input.name, input.description.slice(0, 1_000), contentHash],
    );
    await client.query(
      `INSERT INTO manifest_tracks(manifest_id,position,candidate_id,catalog_id,artist,title)
       SELECT $2,x.position,x.candidate_id,x.catalog_id,x.artist,x.title
       FROM jsonb_to_recordset($1::jsonb) AS x(
         candidate_id uuid,position integer,canonical_key text,artist text,title text,album text,
         release_year integer,duration_ms integer,version_label text,catalog_id text,song jsonb,evidence_id uuid,match_id uuid)
       ORDER BY x.position`,
      [json, manifestId],
    );
    await client.query(
      `INSERT INTO audit_events(run_id,actor,action,detail_json)
       VALUES($1,'phase-zero-tool','apple.phase_zero_manifest_created',$2)`,
      [runId, { suiteId: input.suiteId, caseId: input.caseId, fixtureHash: input.fixtureHash, trackCount: input.tracks.length }],
    );
    await client.query("COMMIT");
    return (await repositoryManifest(repository, manifestId))!;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function repositoryManifest(
  repository: Pick<Repository, "pool">,
  manifestId: string,
): Promise<ApplePhaseZeroLockedManifest | null> {
  const manifest = await repository.pool.query(
    "SELECT id,run_id,name,description,content_hash,locked_at FROM manifests WHERE id=$1",
    [manifestId],
  );
  if (!manifest.rows[0]) return null;
  const tracks = await repository.pool.query(
    "SELECT position,candidate_id,catalog_id,artist,title FROM manifest_tracks WHERE manifest_id=$1 ORDER BY position",
    [manifestId],
  );
  return {
    id: manifest.rows[0].id,
    runId: manifest.rows[0].run_id,
    name: manifest.rows[0].name,
    description: manifest.rows[0].description,
    contentHash: manifest.rows[0].content_hash,
    lockedAt: new Date(manifest.rows[0].locked_at).toISOString(),
    tracks: tracks.rows.map((track) => ({
      position: track.position,
      candidateId: track.candidate_id,
      catalogId: track.catalog_id,
      artist: track.artist,
      title: track.title,
    })),
  };
}
