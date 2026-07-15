import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";
import { createDatabase, DATABASE_SCHEMA_VERSION, type DatabaseHandle } from "../db/index.ts";
import { settings } from "../db/schema.ts";
import type {
  CatalogMatchResult,
  CatalogSong,
  EvidenceClaimInput,
  PlaylistBrief,
  PlaylistManifest,
  ResearchRunView,
  SourceFrontierItem,
  SourceRecordInput,
  TrackCandidateInput,
} from "../shared/types.ts";
import {
  candidateIdentityKey,
  compactEvidenceNote,
  duplicateClusterKey,
  HttpError,
  assertPublicHttpsUrl,
  sha256Hex,
  stableStringify,
} from "./security.ts";
import { normalizeMusicText } from "../lib/matching.ts";
import { manifestDescriptionForBrief } from "./brief-policy.ts";
import {
  failureContextForJob,
  failureContextForRun,
  sanitizeFailure,
  sanitizeOptionalFailure,
} from "./error-sanitizer.ts";
import { readCostConfiguration } from "./cost-config.ts";
import { resolveEvidenceIntegrity } from "./evidence-integrity.ts";
import {
  createFastRouteCheckpoint,
  researchExecutionPolicy,
  researchPolicyFingerprint,
} from "./research-policy.ts";
import { resolveEvidenceSubjectBinding } from "./evidence-binding.ts";
import {
  CATALOG_RECOVERY_UNRESOLVED_BASIS,
  RETRYABLE_CATALOG_MATCH_BASES,
} from "./catalog-match-recovery.ts";
import {
  citationAttestationKey,
  citationTextIsLocalToClaim,
  MAX_CITATION_EXCERPT_CHARS,
  type HostedCitationAttestation,
} from "./citation-attestation.ts";
import { appleAuthorizationGeneration } from "./apple.ts";

const ACTIVE_RUN_STATUSES = [
  "queued",
  "awaiting_budget",
  "researching",
  "ready_for_matching",
  "matching",
  "review",
  "visitor_review",
  "manifest_ready",
  "publishing",
  "waiting_for_apple_authorization",
];
const TERMINAL_RUN_STATUSES = ["complete", "partial", "failed", "expired", "deleted"];
const JOB_ADVISORY_LOCK = 694_207_551;
const BUDGET_ADVISORY_LOCK = 694_207_552;
const RUN_CAPACITY_ADVISORY_LOCK = 694_207_553;

type CandidateRow = TrackCandidateInput & {
  id: string;
  runId: string;
  outcome: string;
  duplicateClusterKey: string | null;
};

export interface JobView {
  id: string;
  runId: string | null;
  briefRequestId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
}

export interface ResearchRunHistoryItem {
  id: string;
  prompt: string;
  brief: PlaylistBrief;
  status: string;
  phase: string;
  candidateCount: number;
  sourceCount: number;
  unresolvedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogTrackRow {
  position: number;
  candidateId: string;
  selectionRank: number | null;
  artist: string;
  title: string;
  album: string | null;
  releaseYear: number | null;
  durationMs: number | null;
  isrc: string | null;
  versionLabel: string | null;
  duplicateClusterKey: string | null;
  status: CatalogMatchResult["status"] | "pending";
  basis: string | null;
  score: number;
  catalogId: string | null;
  song: CatalogSong | null;
  alternatives: CatalogSong[];
  evidenceEligible: boolean;
  selected: boolean;
  selectable: boolean;
  retryable: boolean;
}

export interface CatalogTrackPage {
  items: CatalogTrackRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  selectableCount: number;
  unmatchedCount: number;
  retryableCount: number;
  matchingComplete: boolean;
}

export interface CatalogSelectionInput {
  selected?: Array<{ candidateId: string; catalogId: string }>;
  useRecommended?: boolean;
  excludedCandidateIds?: string[];
  overrides?: Array<{ candidateId: string; catalogId: string }>;
}

export interface PublicationVolumeInput {
  manifestId: string;
  volumeNumber: number;
  volumeCount: number;
  startPosition: number;
  endPosition: number;
  status?: string;
}

export interface PublicationQueueResult {
  queued: boolean;
  state: "queued" | "in_flight" | "waiting_for_apple_authorization" | "terminal";
  runStatus: string;
  jobId: string | null;
}

export interface EncryptedAppleAuthorizationInput {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
  storefront: string;
  status?: string;
  lastValidatedAt?: Date | null;
  lastError?: string | null;
}

export interface ResearchContainerInput {
  id?: string;
  sourceRecordId?: string | null;
  parentContainerId?: string | null;
  containerType: "artist" | "release" | "session" | "collection" | string;
  providerId: string;
  title: string;
  status: "discovered" | "enumerating" | "complete" | "inaccessible" | "unresolved" | string;
  cursor?: string | null;
  advertisedTotal?: number | null;
  recoveredTotal?: number;
  metadata?: Record<string, unknown>;
}

export interface CostSubject {
  runId?: string | null;
  briefRequestId?: string | null;
}

function finiteMoney(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 10_000) throw new HttpError(400, `${field} is invalid`, "invalid_cost");
  return Math.round(value * 1_000_000) / 1_000_000;
}

function date(value: unknown): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(String(value));
}

async function markTerminalPublicationVolumes(
  client: Pick<PoolClient, "query">,
  payload: Record<string, unknown> | null,
  error: string,
): Promise<void> {
  const manifestId = typeof payload?.manifestId === "string" ? payload.manifestId : "";
  if (!manifestId) return;
  const publicError = sanitizeFailure(error, "publication");
  // A terminal worker failure does not prove that Apple's playlist contents
  // diverged from the manifest. Preserve the resource ID so an explicit retry
  // can reconcile it. Confirmed divergence and persistent 404s are orphaned by
  // the deterministic publisher before they cross this generic failure path.
  await client.query(
    `UPDATE publication_volumes pv SET status='failed',last_error=$2,updated_at=now()
     WHERE pv.manifest_id=$1 AND pv.status NOT IN ('complete','waiting_for_owner')
       AND EXISTS (
         SELECT 1 FROM manifests m JOIN research_runs r ON r.id=m.run_id
         WHERE m.id=pv.manifest_id AND r.status<>'waiting_for_apple_authorization'
       )`,
    [manifestId, publicError],
  );
}

function isCatalogRecoveryJob(payload: Record<string, unknown> | null): boolean {
  return payload?.retryIncomplete === true;
}

function catalogRecoveryGeneration(payload: Record<string, unknown> | null): number {
  const value = Number(payload?.recoveryGeneration);
  return Number.isInteger(value) && value >= 1 && value <= 3 ? value : 3;
}

async function settleCatalogRecoveryFailure(
  client: Pick<PoolClient, "query">,
  runId: string,
  generation: number,
): Promise<void> {
  if (generation >= 3) {
    await client.query(
      `UPDATE catalog_matches SET basis=$3
       WHERE run_id=$1 AND status='review' AND song_json IS NULL AND basis=ANY($2::text[])
         AND EXISTS (
           SELECT 1 FROM research_runs r WHERE r.id=$1
             AND r.status IN ('matching','review','visitor_review')
         )`,
      [runId, [...RETRYABLE_CATALOG_MATCH_BASES], CATALOG_RECOVERY_UNRESOLVED_BASIS],
    );
  }
  await client.query(
    `UPDATE research_runs SET status='visitor_review',phase='exception_review',error=NULL,
       completed_at=NULL,updated_at=now()
     WHERE id=$1 AND status IN ('matching','review','visitor_review')`,
    [runId],
  );
}

export function manifestOrderSql(brief: Pick<PlaylistBrief, "mode" | "orderingPolicy">): string {
  // Curated extraction persists the model's reviewed editorial sequence as a
  // one-based rank. Use the strict brief mode—not free-form model wording—to
  // decide whether that rank governs truncation and the immutable manifest.
  if (brief.mode === "curated") {
    return "c.selection_rank NULLS LAST,c.artist,c.title,c.id";
  }
  const normalized = brief.orderingPolicy.toLowerCase();
  if (normalized.includes("evidence") || normalized.includes("confidence")) {
    return `(SELECT COALESCE(max(CASE
        WHEN e.state='verified' AND e.support_scope='track' AND e.verification_phase='track_verification' THEN 4
        WHEN e.state='corroborated' AND e.support_scope='track' AND e.verification_phase='track_verification' THEN 3
        WHEN e.state='editorial' THEN 2 ELSE 1 END),0)
      FROM evidence_claims e
      JOIN source_records es ON es.id=e.source_id AND es.source_class='web'
      JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
        AND ca.run_id=e.run_id AND ca.source_url=es.url
      WHERE e.candidate_id=c.id) DESC,c.artist,c.title,c.id`;
  }
  if (normalized.includes("discover")) return "c.created_at,c.id";
  if (normalized.includes("chronolog") || normalized.includes("release") || normalized.includes("year")) {
    return "c.release_year NULLS LAST,c.artist,c.album NULLS LAST,c.title,c.id";
  }
  if (normalized.startsWith("title") || normalized.includes("title first")) return "c.title,c.artist,c.id";
  return "c.artist,c.title,c.release_year NULLS LAST,c.album NULLS LAST,c.id";
}

export class Repository {
  readonly pool: Pool;
  readonly db: DatabaseHandle["db"];

  constructor(handle: DatabaseHandle = createDatabase()) {
    this.pool = handle.pool;
    this.db = handle.db;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async getSchemaVersion(): Promise<string | null> {
    try {
      const result = await this.pool.query<{ value: string }>("SELECT value FROM settings WHERE key = 'schema_version'");
      return result.rows[0]?.value ?? null;
    } catch {
      return null;
    }
  }

  async ensureSchemaVersion(): Promise<void> {
    const actual = await this.getSchemaVersion();
    if (actual !== DATABASE_SCHEMA_VERSION) {
      throw new Error(`Database schema mismatch: expected ${DATABASE_SCHEMA_VERSION}, found ${actual ?? "uninitialized"}`);
    }
  }

  async getSetting(key: string): Promise<string | null> {
    const rows = await this.db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
    return rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.insert(settings).values({ key, value }).onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    });
  }

  async deleteSetting(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }

  async createBriefRequest(input: {
    prompt: string;
    model: string;
    clientBucket: string;
    clientBucketAliases: string[];
    idempotencyKey?: string | null;
    rateLimit?: number;
    bypassVisitorRateLimit?: boolean;
  }): Promise<{ id: string; status: string; created: boolean }> {
    const prompt = input.prompt.trim();
    if (prompt.length < 4 || prompt.length > 2_000) throw new HttpError(400, "Describe the playlist in 4–2,000 characters", "invalid_prompt");
    return this.transaction(async (client) => {
      if (input.idempotencyKey) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `brief:${[...new Set(input.clientBucketAliases)].sort().join(":")}:${input.idempotencyKey}`,
        ]);
        const existing = await client.query<{ id: string; status: string }>(
          "SELECT id, status FROM brief_requests WHERE client_bucket = ANY($1::text[]) AND idempotency_key = $2 AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
          [input.clientBucketAliases, input.idempotencyKey],
        );
        if (existing.rows[0]) return { ...existing.rows[0], created: false };
      }
      if (!input.bypassVisitorRateLimit) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`rate:brief:${input.clientBucketAliases.join(":")}`]);
        const rate = await client.query<{ count: number }>(
          "SELECT count(*)::int count FROM rate_limit_events WHERE client_bucket=ANY($1::text[]) AND action='brief' AND occurred_at>now()-interval '24 hours'",
          [input.clientBucketAliases],
        );
        if (rate.rows[0]!.count >= (input.rateLimit ?? 10)) throw new HttpError(429, "Brief limit reached; try again later", "rate_limited");
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO brief_requests(id,prompt,model,status,client_bucket,idempotency_key,expires_at)
         VALUES($1,$2,$3,'queued',$4,$5,now()+interval '24 hours')`,
        [id, prompt, input.model, input.clientBucket, input.idempotencyKey ?? null],
      );
      if (!input.bypassVisitorRateLimit) {
        await client.query("INSERT INTO rate_limit_events(client_bucket,action) VALUES($1,'brief')", [input.clientBucket]);
      }
      return { id, status: "queued", created: true };
    });
  }

  async getBriefRequest(id: string): Promise<any | null> {
    const result = await this.pool.query(
      `SELECT id,prompt,model,status,brief_json,estimate_usd,error,client_bucket,expires_at,created_at,updated_at
       FROM brief_requests WHERE id=$1 AND expires_at>now()`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      prompt: row.prompt,
      model: row.model,
      status: row.status,
      brief: row.brief_json,
      estimateUsd: row.estimate_usd == null ? null : Number(row.estimate_usd),
      error: sanitizeOptionalFailure(row.error, "brief"),
      clientBucket: row.client_bucket,
      expiresAt: date(row.expires_at),
      createdAt: date(row.created_at),
      updatedAt: date(row.updated_at),
    };
  }

  async saveBriefResult(id: string, result: {
    status: "complete" | "failed";
    brief?: PlaylistBrief;
    estimateUsd?: number;
    error?: string | null;
  }): Promise<void> {
    const persistedError = result.status === "failed"
      ? sanitizeFailure(result.error, "brief")
      : null;
    await this.pool.query(
      `UPDATE brief_requests SET status=$2,brief_json=$3,estimate_usd=$4,error=$5,updated_at=now()
       WHERE id=$1`,
      [id, result.status, result.brief ?? null, result.estimateUsd == null ? null : finiteMoney(result.estimateUsd, "Estimate"), persistedError],
    );
  }

  private async attachCapabilitySessionAccess(
    client: PoolClient,
    sessionId: string,
    runId: string,
    accessId: string,
  ): Promise<void> {
    const attached = await client.query(
      `INSERT INTO capability_session_accesses(session_id,run_id,access_id)
       SELECT s.id,a.run_id,a.id
       FROM capability_sessions s
       JOIN run_accesses a ON a.id=$3 AND a.run_id=$2
       JOIN research_runs r ON r.id=a.run_id AND r.deleted_at IS NULL
       WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
         AND a.deleted_at IS NULL AND a.expires_at>now()
       ON CONFLICT(session_id,access_id) DO UPDATE SET run_id=EXCLUDED.run_id
       RETURNING access_id`,
      [sessionId, runId, accessId],
    );
    if (!attached.rows[0]) {
      throw new HttpError(401, "Session has expired", "capability_required");
    }
  }

  async createRunIdempotent(input: {
    prompt: string;
    brief: PlaylistBrief;
    estimateUsd: number;
    approvedBudgetUsd: number;
    clientBucket: string;
    clientBucketAliases: string[];
    idempotencyKey: string;
    reuseDays?: number;
    rateLimit?: number;
    globalLimit?: number;
    capabilitySessionId?: string;
    bypassVisitorRateLimit?: boolean;
  }): Promise<{ runId: string; accessId: string; created: boolean; reused: boolean; status: string }> {
    const estimate = finiteMoney(input.estimateUsd, "Estimate");
    const approved = finiteMoney(input.approvedBudgetUsd, "Approved budget");
    const briefHash = sha256Hex(stableStringify({
      brief: input.brief,
      researchPolicy: researchPolicyFingerprint(input.brief),
    }));
    const executionPolicy = researchExecutionPolicy(input.brief);
    // Owner requests are deliberate test/refresh runs. Never attach them to a
    // prior visitor result, even when the confirmed brief hashes identically.
    const reuseDays = input.bypassVisitorRateLimit
      ? 0
      : Math.max(0, Math.min(input.reuseDays ?? 30, 30));
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`run:${input.clientBucket}:${input.idempotencyKey}`]);
      const existing = await client.query(
        `SELECT a.id AS access_id,a.run_id,r.status FROM run_accesses a JOIN research_runs r ON r.id=a.run_id
         WHERE a.client_bucket=ANY($1::text[]) AND a.idempotency_key=$2 AND a.deleted_at IS NULL ORDER BY a.created_at DESC LIMIT 1`,
        [input.clientBucketAliases, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (input.capabilitySessionId) {
          await this.attachCapabilitySessionAccess(
            client,
            input.capabilitySessionId,
            existing.rows[0].run_id,
            existing.rows[0].access_id,
          );
        }
        return {
          runId: existing.rows[0].run_id,
          accessId: existing.rows[0].access_id,
          status: existing.rows[0].status,
          created: false,
          reused: false,
        };
      }

      if (!input.bypassVisitorRateLimit) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`rate:run:${input.clientBucketAliases.join(":")}`]);
        const rate = await client.query<{ count: number }>(
          "SELECT count(*)::int count FROM rate_limit_events WHERE client_bucket=ANY($1::text[]) AND action='run' AND occurred_at>now()-interval '24 hours'",
          [input.clientBucketAliases],
        );
        if (rate.rows[0]!.count >= (input.rateLimit ?? 3)) throw new HttpError(429, "Research-run limit reached; try again later", "rate_limited");
      }
      let runId: string | null = null;
      if (reuseDays > 0) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`brief:${briefHash}`]);
        const cached = await client.query<{ id: string; status: string }>(
          `SELECT id,status FROM research_runs
           WHERE brief_hash=$1 AND status='complete' AND completed_at >= now()-($2::text || ' days')::interval
             AND completed_at >= COALESCE(
               (SELECT value::timestamptz FROM settings WHERE key='reuse_not_before:' || $1),
               '-infinity'::timestamptz
             )
             AND (
               COALESCE((brief_json #>> '{targetSize,min}')::int,0)=0
               OR (SELECT count(*)::int
                   FROM manifests m
                   JOIN manifest_tracks mt ON mt.manifest_id=m.id
                   WHERE m.run_id=research_runs.id) >= (brief_json #>> '{targetSize,min}')::int
             )
             AND deleted_at IS NULL ORDER BY completed_at DESC LIMIT 1`,
          [briefHash, String(reuseDays)],
        );
        runId = cached.rows[0]?.id ?? null;
      }

      const reused = Boolean(runId);
      let status = "complete";
      if (!runId) {
        // Capacity is a system-wide invariant. A plain count followed by an
        // insert lets requests from different client buckets race past the
        // limit, so serialize only this short count-and-create section.
        await client.query("SELECT pg_advisory_xact_lock($1)", [RUN_CAPACITY_ADVISORY_LOCK]);
        const active = await client.query<{ count: number }>(
          "SELECT count(*)::int count FROM research_runs WHERE status=ANY($1::text[]) AND deleted_at IS NULL",
          [ACTIVE_RUN_STATUSES],
        );
        if (active.rows[0]!.count >= (input.globalLimit ?? 10)) throw new HttpError(503, "gênio is at capacity; try again soon", "global_capacity_reached");
        runId = randomUUID();
        const gate = readCostConfiguration().autoRunCostLimitUsd;
        status = estimate > gate && approved < estimate ? "awaiting_budget" : "queued";
        const phase = status === "awaiting_budget" ? "budget_gate" : "queued";
        const canonicalPrompt = `${input.brief.title}: ${input.brief.description}`.slice(0, 2_000);
        const insertedRun = await client.query<{ created_at: Date }>(
          `INSERT INTO research_runs(
             id,prompt,brief_json,brief_hash,status,phase,client_bucket,idempotency_key,
             estimated_cost_usd,approved_budget_usd,budget_approval_expires_at,retention_expires_at)
           VALUES($1,$2,$3,$4,$5::varchar,$6,$7,$8,$9,$10,CASE WHEN $5::varchar='awaiting_budget' THEN now()+interval '7 days' ELSE NULL END,now()+interval '90 days')
           RETURNING created_at`,
          [runId, canonicalPrompt, input.brief, briefHash, status, phase, input.clientBucket, input.idempotencyKey, estimate, Math.max(approved, status === "queued" ? estimate : 0)],
        );
        if (executionPolicy.kind === "fast_curated") {
          const route = createFastRouteCheckpoint(executionPolicy, insertedRun.rows[0]!.created_at);
          await client.query(
            `INSERT INTO research_checkpoints(run_id,phase,state_json)
             VALUES($1,$2,$3)`,
            [runId, `fast:route:${executionPolicy.version}`, route],
          );
        }
      } else {
        const reusedRun = await client.query<{ status: string }>("SELECT status FROM research_runs WHERE id=$1", [runId]);
        status = reusedRun.rows[0]!.status;
      }

      const accessId = randomUUID();
      await client.query(
        `INSERT INTO run_accesses(id,run_id,prompt,client_bucket,idempotency_key,expires_at)
         VALUES($1,$2,$3,$4,$5,now()+interval '90 days')`,
        [accessId, runId, input.prompt.slice(0, 2_000), input.clientBucket, input.idempotencyKey],
      );
      if (input.capabilitySessionId) {
        await this.attachCapabilitySessionAccess(client, input.capabilitySessionId, runId, accessId);
      }
      if (!input.bypassVisitorRateLimit) {
        await client.query("INSERT INTO rate_limit_events(client_bucket,action) VALUES($1,'run')", [input.clientBucket]);
      }
      return { runId, accessId, status, created: !reused, reused };
    });
  }

  async createRun(prompt: string, brief: PlaylistBrief, estimate: number, approvedBudget: number): Promise<string> {
    const clientBucket = `legacy.${sha256Hex(randomUUID()).slice(0, 32)}`;
    const result = await this.createRunIdempotent({
      prompt,
      brief,
      estimateUsd: estimate,
      approvedBudgetUsd: approvedBudget,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
    });
    return result.runId;
  }

  async updateRun(id: string, values: {
    status?: string;
    phase?: string;
    costDelta?: number;
    approvedBudget?: number;
    noNewGapPasses?: number;
    error?: string | null;
  }): Promise<void> {
    const costDelta = values.costDelta == null ? 0 : finiteMoney(values.costDelta, "Cost delta");
    const persistedError = values.error === undefined
      ? undefined
      : sanitizeOptionalFailure(values.error, failureContextForRun(values.phase));
    const result = await this.pool.query(
      `UPDATE research_runs SET
         status=COALESCE($2,status), phase=COALESCE($3,phase), actual_cost_usd=actual_cost_usd+$4,
         approved_budget_usd=COALESCE($5,approved_budget_usd), no_new_gap_passes=COALESCE($6,no_new_gap_passes),
         error=CASE WHEN $7::boolean THEN $8 ELSE error END,
         budget_approval_expires_at=CASE
           WHEN $2::varchar='awaiting_budget' THEN now()+interval '7 days'
           WHEN $2::varchar='queued' THEN NULL
           ELSE budget_approval_expires_at
         END,
         completed_at=CASE WHEN COALESCE($2,status) IN ('complete','partial','failed','expired','deleted') THEN COALESCE(completed_at,now()) ELSE completed_at END,
         updated_at=now()
       WHERE id=$1
         AND NOT (status='failed' AND phase='owner_cancelled')
         AND NOT (status='deleted' OR phase='visitor_deleted')`,
      [id, values.status ?? null, values.phase ?? null, costDelta, values.approvedBudget ?? null, values.noNewGapPasses ?? null, values.error !== undefined, persistedError ?? null],
    );
    if (result.rowCount === 0) throw new HttpError(404, "Research run not found", "run_not_found");
  }

  private async getRunRow(id: string): Promise<any | null> {
    const result = await this.pool.query("SELECT * FROM research_runs WHERE id=$1 AND deleted_at IS NULL", [id]);
    return result.rows[0] ?? null;
  }

  async getRunControlState(id: string): Promise<{ status: string; phase: string } | null> {
    const result = await this.pool.query<{ status: string; phase: string }>(
      "SELECT status,phase FROM research_runs WHERE id=$1 AND deleted_at IS NULL",
      [id],
    );
    return result.rows[0] ?? null;
  }

  async getPublicationCompleteness(runId: string, manifestId: string): Promise<{
    omittedCandidateCount: number;
    unresolvedCoverageCount: number;
  }> {
    const result = await this.pool.query<{
      omitted_candidate_count: number;
      unresolved_coverage_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM track_candidates c
          WHERE c.run_id=$1 AND c.outcome<>'duplicate'
            AND NOT EXISTS (
              SELECT 1 FROM manifest_tracks mt WHERE mt.manifest_id=$2 AND mt.candidate_id=c.id
            )) AS omitted_candidate_count,
         ((SELECT count(*)::int FROM source_frontier f
           WHERE f.run_id=$1 AND (
             f.status IN ('pending','unresolved','inaccessible') OR f.discovered_count>f.recovered_count
           ))
          +
          (SELECT count(*)::int FROM research_containers c
           WHERE c.run_id=$1 AND (
             c.status IN ('discovered','enumerating','inaccessible','unresolved')
             OR (c.advertised_total IS NOT NULL AND c.advertised_total>c.recovered_total)
           ))) AS unresolved_coverage_count`,
      [runId, manifestId],
    );
    return {
      omittedCandidateCount: Number(result.rows[0]?.omitted_candidate_count ?? 0),
      unresolvedCoverageCount: Number(result.rows[0]?.unresolved_coverage_count ?? 0),
    };
  }

  async getRun(id: string): Promise<ResearchRunView & Record<string, unknown>> {
    const row = await this.getRunRow(id);
    if (!row) throw new HttpError(404, "Research run not found", "run_not_found");
    const [counts, frontier] = await Promise.all([
      this.pool.query(
        `SELECT
          (SELECT count(*)::int FROM track_candidates WHERE run_id=$1) candidate_count,
          (SELECT count(*)::int FROM source_records WHERE run_id=$1) source_count,
          ((SELECT count(*)::int FROM source_frontier
             WHERE run_id=$1 AND status IN ('pending','unresolved','inaccessible')) +
           (SELECT count(*)::int FROM research_containers
             WHERE run_id=$1 AND status IN ('discovered','enumerating','inaccessible','unresolved'))) unresolved_count`,
        [id],
      ),
      this.getFrontier(id),
    ]);
    const count = counts.rows[0];
    return {
      id: row.id,
      prompt: row.prompt,
      brief: row.brief_json,
      status: row.status,
      phase: row.phase,
      estimatedCostUsd: Number(row.estimated_cost_usd),
      actualCostUsd: Number(row.actual_cost_usd),
      approvedBudgetUsd: Number(row.approved_budget_usd),
      reservedCostUsd: Number(row.reserved_cost_usd),
      noNewGapPasses: Number(row.no_new_gap_passes),
      error: sanitizeOptionalFailure(row.error, failureContextForRun(row.phase)),
      candidateCount: count.candidate_count,
      sourceCount: count.source_count,
      unresolvedCount: count.unresolved_count,
      frontier,
      createdAt: date(row.created_at)?.toISOString(),
      updatedAt: date(row.updated_at)?.toISOString(),
      completedAt: date(row.completed_at)?.toISOString() ?? null,
      budgetApprovalExpiresAt: date(row.budget_approval_expires_at)?.toISOString() ?? null,
    } as ResearchRunView & Record<string, unknown>;
  }

  async getRunByAccess(accessId: string): Promise<(ResearchRunView & Record<string, unknown>) | null> {
    const result = await this.pool.query<{ run_id: string; prompt: string | null }>(
      "SELECT run_id,prompt FROM run_accesses WHERE id=$1 AND deleted_at IS NULL AND expires_at>now()",
      [accessId],
    );
    if (!result.rows[0]) return null;
    const run = await this.getRun(result.rows[0].run_id);
    return { ...run, id: accessId, canonicalRunId: result.rows[0].run_id, prompt: result.rows[0].prompt ?? run.prompt };
  }

  async listRunsForCapabilitySession(sessionId: string, limit = 50): Promise<ResearchRunHistoryItem[]> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 50));
    const result = await this.pool.query(
      `SELECT
         a.id AS access_id,
         COALESCE(a.prompt,r.prompt) AS prompt,
         r.brief_json,
         r.status,
         r.phase,
         a.created_at,
         r.updated_at,
         (SELECT count(*)::int FROM track_candidates tc WHERE tc.run_id=r.id) AS candidate_count,
         (SELECT count(*)::int FROM source_records sr WHERE sr.run_id=r.id) AS source_count,
         ((SELECT count(*)::int FROM source_frontier sf
            WHERE sf.run_id=r.id AND sf.status IN ('pending','unresolved','inaccessible'))
          +
          (SELECT count(*)::int FROM research_containers rc
            WHERE rc.run_id=r.id AND rc.status IN ('discovered','enumerating','inaccessible','unresolved'))) AS unresolved_count
       FROM capability_session_accesses csa
       JOIN capability_sessions s ON s.id=csa.session_id
       JOIN run_accesses a ON a.id=csa.access_id AND a.run_id=csa.run_id
       JOIN research_runs r ON r.id=csa.run_id
       WHERE csa.session_id=$1
         AND s.revoked_at IS NULL AND s.expires_at>now()
         AND a.deleted_at IS NULL AND a.expires_at>now()
         AND r.deleted_at IS NULL
       ORDER BY a.created_at DESC,a.id DESC
       LIMIT $2`,
      [sessionId, boundedLimit],
    );
    return result.rows.map((row) => ({
      id: row.access_id,
      prompt: row.prompt,
      brief: row.brief_json,
      status: row.status,
      phase: row.phase,
      candidateCount: Number(row.candidate_count),
      sourceCount: Number(row.source_count),
      unresolvedCount: Number(row.unresolved_count),
      createdAt: date(row.created_at)!.toISOString(),
      updatedAt: date(row.updated_at)!.toISOString(),
    }));
  }

  async getCanonicalRunId(accessId: string): Promise<string | null> {
    const result = await this.pool.query<{ run_id: string }>(
      "SELECT run_id FROM run_accesses WHERE id=$1 AND deleted_at IS NULL AND expires_at>now()",
      [accessId],
    );
    return result.rows[0]?.run_id ?? null;
  }

  async deleteRunAccess(accessId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const access = await client.query<{ run_id: string }>("SELECT run_id FROM run_accesses WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [accessId]);
      if (!access.rows[0]) return false;
      const runId = access.rows[0].run_id;
      await client.query("UPDATE run_accesses SET prompt=NULL,deleted_at=now(),updated_at=now() WHERE id=$1", [accessId]);
      const affectedSessions = await client.query<{ session_id: string }>(
        "DELETE FROM capability_session_accesses WHERE access_id=$1 RETURNING session_id",
        [accessId],
      );
      if (affectedSessions.rows.length > 0) await client.query(
        `UPDATE capability_sessions s SET revoked_at=now(),updated_at=now()
         WHERE s.id=ANY($1::uuid[])
           AND NOT EXISTS (
             SELECT 1 FROM capability_session_accesses csa
             JOIN run_accesses a ON a.id=csa.access_id AND a.run_id=csa.run_id
             WHERE csa.session_id=s.id AND a.deleted_at IS NULL AND a.expires_at>now()
           )`,
        [affectedSessions.rows.map((row) => row.session_id)],
      );
      await client.query("DELETE FROM capability_tokens WHERE access_id=$1", [accessId]);
      const remaining = await client.query<{ count: number }>("SELECT count(*)::int count FROM run_accesses WHERE run_id=$1 AND deleted_at IS NULL", [runId]);
      if (remaining.rows[0]!.count === 0) {
        const run = await client.query<{ status: string; actual_cost_usd: string }>("SELECT status,actual_cost_usd FROM research_runs WHERE id=$1 FOR UPDATE", [runId]);
        if (run.rows[0] && !TERMINAL_RUN_STATUSES.includes(run.rows[0].status)) {
          await client.query("UPDATE research_runs SET status='deleted',phase='visitor_deleted',completed_at=now(),updated_at=now() WHERE id=$1", [runId]);
          await client.query("UPDATE job_queue SET status='cancelled',completed_at=now(),updated_at=now() WHERE run_id=$1 AND status IN ('queued','leased')", [runId]);
        }
        if (run.rows[0]) {
          const manifest = await client.query("SELECT id,content_hash,name FROM manifests WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1", [runId]);
          const volumes = manifest.rows[0]
            ? await client.query("SELECT apple_share_url FROM publication_volumes WHERE manifest_id=$1 AND apple_share_url IS NOT NULL ORDER BY volume_number", [manifest.rows[0].id])
            : { rows: [] };
          const counts = await client.query("SELECT outcome,count(*)::int count FROM track_candidates WHERE run_id=$1 GROUP BY outcome", [runId]);
          const appleLinks = volumes.rows.map((volume) => volume.apple_share_url);
          const outcomeCounts = Object.fromEntries(counts.rows.map((entry) => [entry.outcome, entry.count]));
          await client.query(
            `INSERT INTO retention_tombstones(run_id,manifest_hash,playlist_title,apple_links_json,outcome_counts_json,aggregate_cost_usd)
             VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6) ON CONFLICT(run_id) DO NOTHING`,
            [runId, manifest.rows[0]?.content_hash ?? null, manifest.rows[0]?.name ?? null, JSON.stringify(appleLinks), JSON.stringify(outcomeCounts), Number(run.rows[0].actual_cost_usd)],
          );
          const notificationIds = await client.query<{ id: string }>(
            `SELECT id FROM notification_outbox
             WHERE payload_json->>'runId'=$1
                OR ($2::text IS NOT NULL AND payload_json->>'manifestId'=$2::text)`,
            [runId, manifest.rows[0]?.id ?? null],
          );
          if (notificationIds.rows.length > 0) {
            const ids = notificationIds.rows.map((item) => item.id);
            await client.query(
              "DELETE FROM job_queue WHERE kind='notification' AND payload_json->>'notificationId'=ANY($1::text[])",
              [ids],
            );
            await client.query("DELETE FROM notification_outbox WHERE id=ANY($1::uuid[])", [ids]);
          }
          await client.query("DELETE FROM cost_ledger WHERE run_id=$1", [runId]);
          await client.query("DELETE FROM audit_events WHERE run_id=$1", [runId]);
          await client.query("DELETE FROM research_runs WHERE id=$1", [runId]);
        }
      }
      return true;
    });
  }

  private async addSourcesInTransaction(client: PoolClient, runId: string, sources: SourceRecordInput[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const source of sources) {
      const id = randomUUID();
      const result = await client.query<{ id: string }>(
        `INSERT INTO source_records(id,run_id,url,title,source_class,provenance_root,note)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(run_id,url) DO UPDATE SET
           title=CASE WHEN source_records.source_class<>'import' AND EXCLUDED.source_class='import'
             THEN source_records.title ELSE EXCLUDED.title END,
           note=CASE WHEN source_records.source_class<>'import' AND EXCLUDED.source_class='import'
             THEN source_records.note ELSE EXCLUDED.note END,
           source_class=CASE WHEN source_records.source_class='import' AND EXCLUDED.source_class<>'import'
             THEN EXCLUDED.source_class ELSE source_records.source_class END,
           provenance_root=CASE WHEN source_records.source_class='import' AND EXCLUDED.source_class<>'import'
             THEN EXCLUDED.provenance_root ELSE source_records.provenance_root END
         WHERE (source_records.source_class=EXCLUDED.source_class
             AND source_records.provenance_root=EXCLUDED.provenance_root)
           OR (source_records.source_class='import' AND EXCLUDED.source_class<>'import')
           OR (source_records.source_class<>'import' AND EXCLUDED.source_class='import')
         RETURNING id`,
        [id, runId, source.url, source.title.slice(0, 240), source.sourceClass, source.provenanceRoot.slice(0, 240), compactEvidenceNote(source.note)],
      );
      if (!result.rows[0]) {
        throw new HttpError(409, "A stored source URL has conflicting class or provenance", "source_provenance_conflict");
      }
      ids.set(source.url, result.rows[0].id);
    }
    return ids;
  }

  async addSources(runId: string, sources: SourceRecordInput[]): Promise<Map<string, string>> {
    return this.transaction((client) => this.addSourcesInTransaction(client, runId, sources));
  }

  async addCitationAttestations(runId: string, attestations: readonly HostedCitationAttestation[]): Promise<void> {
    if (attestations.length === 0) return;
    await this.transaction(async (client) => {
      for (const raw of attestations.slice(0, 1_000)) {
        const sourceUrl = assertPublicHttpsUrl(raw.sourceUrl).toString();
        if (!raw.responseId || raw.responseId.length > 240 || !raw.outputItemId || raw.outputItemId.length > 240
          || !Number.isInteger(raw.contentIndex) || raw.contentIndex < 0
          || !Number.isInteger(raw.startIndex) || raw.startIndex < 0
          || !Number.isInteger(raw.endIndex) || raw.endIndex <= raw.startIndex
          || typeof raw.excerpt !== "string" || raw.excerpt.trim().length < 8
          || raw.excerpt.length > MAX_CITATION_EXCERPT_CHARS
          || raw.endIndex - raw.startIndex !== raw.excerpt.length
          || /[\uD800-\uDFFF]/.test(raw.excerpt)) {
          throw new HttpError(400, "Citation attestation is invalid", "invalid_citation_attestation");
        }
        const attestation: HostedCitationAttestation = { ...raw, sourceUrl };
        await client.query(
          `INSERT INTO citation_attestations(
             id,run_id,attestation_key,source_url,response_id,output_item_id,
             content_index,start_index,end_index,excerpt)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT(run_id,attestation_key) DO NOTHING`,
          [
            randomUUID(), runId, citationAttestationKey(attestation), sourceUrl,
            attestation.responseId, attestation.outputItemId, attestation.contentIndex,
            attestation.startIndex, attestation.endIndex, attestation.excerpt,
          ],
        );
      }
    });
  }

  private async addCandidatesInTransaction(client: PoolClient, runId: string, candidates: TrackCandidateInput[], sourceIds: Map<string, string>, verificationPhase = "unverified"): Promise<number> {
    const allowedPhases = new Set([
      "scope_resolution", "source_discovery", "container_discovery", "container_enumeration",
      "track_verification", "catalog_enrichment", "gap_analysis",
    ]);
    const storedPhase = allowedPhases.has(verificationPhase) ? verificationPhase : "unverified";
    const briefResult = await client.query<{ brief_json: PlaylistBrief }>(
      "SELECT brief_json FROM research_runs WHERE id=$1 AND deleted_at IS NULL",
      [runId],
    );
    const brief = briefResult.rows[0]?.brief_json;
    if (!brief) throw new HttpError(404, "Research run not found", "run_not_found");
    let added = 0;
    for (const candidate of candidates) {
        const boundEvidence = candidate.evidence.map((evidence) => {
          const binding = resolveEvidenceSubjectBinding(
            brief,
            evidence.subjectEntity,
            evidence.subjectRelationship,
          );
          if (!binding) {
            throw new HttpError(
              400,
              "Evidence claim subject does not match the confirmed playlist scope",
              "evidence_subject_mismatch",
            );
          }
          return { ...evidence, ...binding };
        });
        const identityKey = candidateIdentityKey(candidate);
        const candidateId = randomUUID();
        const selectionRank = Number.isInteger(candidate.selectionRank)
          && Number(candidate.selectionRank) > 0
          && Number(candidate.selectionRank) <= 10_000
          ? Number(candidate.selectionRank)
          : null;
        const inserted = await client.query<{ id: string; inserted: boolean }>(
          `INSERT INTO track_candidates(
             id,run_id,canonical_key,duplicate_cluster_key,selection_rank,artist,title,album,release_year,duration_ms,isrc,musicbrainz_id,version_label)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT(run_id,canonical_key) DO UPDATE SET
             selection_rank=CASE
               WHEN EXCLUDED.selection_rank IS NULL THEN track_candidates.selection_rank
               WHEN track_candidates.selection_rank IS NULL THEN EXCLUDED.selection_rank
               ELSE LEAST(track_candidates.selection_rank,EXCLUDED.selection_rank)
             END
           RETURNING id,(xmax=0) inserted`,
          [candidateId, runId, identityKey, duplicateClusterKey(candidate), selectionRank,
            candidate.artist.slice(0, 240), candidate.title.slice(0, 240), candidate.album?.slice(0, 240) ?? null,
            candidate.releaseYear, candidate.durationMs, candidate.isrc, candidate.musicbrainzId,
            candidate.versionLabel?.slice(0, 120) ?? null],
        );
        const storedId = inserted.rows[0]?.id;
        if (!storedId) throw new Error("Candidate upsert did not return an identifier");
        if (inserted.rows[0]!.inserted) added += 1;
        if (!inserted.rows[0]!.inserted) {
          const existing = await client.query<{ id: string; artist: string; title: string; version_label: string | null }>(
            "SELECT id,artist,title,version_label FROM track_candidates WHERE run_id=$1 AND canonical_key=$2",
            [runId, identityKey],
          );
          const prior = existing.rows[0]!;
          const versionConflict = Boolean(prior.version_label && candidate.versionLabel
            && normalizeMusicText(prior.version_label) !== normalizeMusicText(candidate.versionLabel));
          if (normalizeMusicText(prior.artist) !== normalizeMusicText(candidate.artist)
            || normalizeMusicText(prior.title) !== normalizeMusicText(candidate.title)
            || versionConflict) {
            throw new HttpError(409, "A stable recording identifier has conflicting artist, title, or version metadata", "recording_identifier_conflict");
          }
        }
        if (storedPhase === "track_verification") {
          const verifiedSourceIds = [...new Set(boundEvidence
            .map((evidence) => sourceIds.get(evidence.sourceUrl))
            .filter((sourceId): sourceId is string => Boolean(sourceId)))];
          if (verifiedSourceIds.length > 0) {
            // A dedicated verification batch replaces prior conclusions from
            // the same sources, even if the model phrases the relationship
            // differently on the later pass.
            await client.query(
              "UPDATE evidence_claims SET state='inferred' WHERE candidate_id=$1 AND source_id=ANY($2::uuid[]) AND state IN ('verified','corroborated')",
              [storedId, verifiedSourceIds],
            );
          }
        }
        for (const evidence of boundEvidence) {
          const sourceId = sourceIds.get(evidence.sourceUrl);
          if (!sourceId) continue;
          const sourceResult = await client.query<{ source_class: SourceRecordInput["sourceClass"]; url: string }>(
            "SELECT source_class,url FROM source_records WHERE id=$1 AND run_id=$2",
            [sourceId, runId],
          );
          const storedSource = sourceResult.rows[0];
          if (!storedSource || storedSource.url !== evidence.sourceUrl) continue;
          const supportScope = ["track", "album", "session", "collection", "editorial"].includes(evidence.supportScope ?? "")
            ? evidence.supportScope
            : "collection";
          let citationAttestationId: string | null = null;
          if (storedSource.source_class === "web" && evidence.citationSupport
            && citationTextIsLocalToClaim(
              evidence.citationSupport.excerpt,
              candidate.title,
              evidence.subjectEntity,
              evidence.relationship,
            )) {
            const attestation: HostedCitationAttestation = {
              sourceUrl: storedSource.url,
              ...evidence.citationSupport,
            };
            const citation = await client.query<{ id: string }>(
              `SELECT id FROM citation_attestations
               WHERE run_id=$1 AND attestation_key=$2 AND source_url=$3
                 AND response_id=$4 AND output_item_id=$5 AND content_index=$6
                 AND start_index=$7 AND end_index=$8 AND excerpt=$9`,
              [
                runId, citationAttestationKey(attestation), storedSource.url,
                attestation.responseId, attestation.outputItemId, attestation.contentIndex,
                attestation.startIndex, attestation.endIndex, attestation.excerpt,
              ],
            );
            citationAttestationId = citation.rows[0]?.id ?? null;
          }
          const needsStrongSupport = evidence.state === "verified" || evidence.state === "corroborated"
            || evidence.state === "editorial" || evidence.state === "disputed";
          const sourceCannotAttestRelationship = storedSource.source_class !== "web";
          const missingWebAttestation = storedSource.source_class === "web" && !citationAttestationId;
          const storedState = ((evidence.state === "verified" || evidence.state === "corroborated" || evidence.state === "disputed")
            && (storedPhase !== "track_verification" || supportScope !== "track")
            || (needsStrongSupport && (sourceCannotAttestRelationship || missingWebAttestation)))
            ? "inferred"
            : evidence.state;
          await client.query(
            `INSERT INTO evidence_claims(
               id,run_id,candidate_id,source_id,citation_attestation_id,state,support_scope,verification_phase,
               subject_entity,subject_relationship,relationship,note)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT(candidate_id,source_id,subject_entity,subject_relationship,relationship) DO UPDATE SET
               state=CASE WHEN EXCLUDED.verification_phase='track_verification' THEN EXCLUDED.state ELSE evidence_claims.state END,
               support_scope=CASE WHEN EXCLUDED.verification_phase='track_verification' THEN EXCLUDED.support_scope ELSE evidence_claims.support_scope END,
               verification_phase=CASE WHEN EXCLUDED.verification_phase='track_verification' THEN EXCLUDED.verification_phase ELSE evidence_claims.verification_phase END,
               citation_attestation_id=CASE WHEN EXCLUDED.verification_phase='track_verification' THEN EXCLUDED.citation_attestation_id ELSE evidence_claims.citation_attestation_id END,
               note=CASE WHEN EXCLUDED.verification_phase='track_verification' THEN EXCLUDED.note ELSE evidence_claims.note END`,
            [randomUUID(), runId, storedId, sourceId, citationAttestationId, storedState, supportScope, storedPhase,
              evidence.subjectEntity, evidence.subjectRelationship,
              evidence.relationship.slice(0, 240), compactEvidenceNote(evidence.note)],
          );
        }
        const storedEvidence = await client.query<{
          id: string;
          source_url: string;
          source_class: SourceRecordInput["sourceClass"];
          provenance_root: string;
          state: EvidenceClaimInput["state"];
          support_scope: EvidenceClaimInput["supportScope"];
          subject_entity: string;
          subject_relationship: string;
          relationship: string;
          note: string;
        }>(
          `SELECT e.id,s.url source_url,s.source_class,s.provenance_root,e.state,e.support_scope,
             e.subject_entity,e.subject_relationship,e.relationship,e.note
           FROM evidence_claims e JOIN source_records s ON s.id=e.source_id
           WHERE e.candidate_id=$1 ORDER BY e.id`,
          [storedId],
        );
        const integrity = resolveEvidenceIntegrity(
          storedEvidence.rows.map((row) => ({
            sourceUrl: row.source_url,
            state: row.state,
            supportScope: row.support_scope,
            subjectEntity: row.subject_entity,
            subjectRelationship: row.subject_relationship,
            relationship: row.relationship,
            note: row.note,
          })),
          storedEvidence.rows.map((row) => ({
            url: row.source_url,
            sourceClass: row.source_class,
            provenanceRoot: row.provenance_root,
          })),
        );
        for (let index = 0; index < storedEvidence.rows.length; index += 1) {
          const row = storedEvidence.rows[index]!;
          const effective = integrity.evidence[index]!;
          if (row.state !== effective.state) {
            await client.query("UPDATE evidence_claims SET state=$2 WHERE id=$1", [row.id, effective.state]);
          }
        }
        if (integrity.hasDisagreement) {
          await client.query(
            `INSERT INTO source_frontier(id,run_id,source_class,strategy,cursor,status,discovered_count,recovered_count,note)
             VALUES($1,$2,'evidence',$3,NULL,'unresolved',1,0,$4)
             ON CONFLICT(run_id,source_class,strategy) DO UPDATE SET
               status='unresolved',discovered_count=1,recovered_count=0,note=EXCLUDED.note`,
            [
              randomUUID(),
              runId,
              `source disagreement:${storedId}`,
              compactEvidenceNote(`Sources disagree about the track-level relationship for ${candidate.artist} — ${candidate.title}; automatic inclusion is blocked pending visitor review.`),
            ],
          );
        }
    }
    return added;
  }

  async addCandidates(runId: string, candidates: TrackCandidateInput[], sourceIds: Map<string, string>, verificationPhase = "unverified"): Promise<number> {
    return this.transaction((client) => this.addCandidatesInTransaction(client, runId, candidates, sourceIds, verificationPhase));
  }

  private async upsertFrontierInTransaction(client: PoolClient, runId: string, items: SourceFrontierItem[]): Promise<void> {
    for (const item of items) {
      await client.query(
        `INSERT INTO source_frontier(id,run_id,source_class,strategy,cursor,status,discovered_count,recovered_count,note)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(run_id,source_class,strategy) DO UPDATE SET cursor=EXCLUDED.cursor,status=EXCLUDED.status,
           discovered_count=EXCLUDED.discovered_count,recovered_count=EXCLUDED.recovered_count,note=EXCLUDED.note`,
        [randomUUID(), runId, item.sourceClass.slice(0, 80), item.strategy.slice(0, 240), item.cursor, item.status, item.discoveredCount, item.recoveredCount, compactEvidenceNote(item.note)],
      );
    }
  }

  async upsertFrontier(runId: string, items: SourceFrontierItem[]): Promise<void> {
    await this.transaction((client) => this.upsertFrontierInTransaction(client, runId, items));
  }

  async getFrontier(runId: string): Promise<SourceFrontierItem[]> {
    const result = await this.pool.query("SELECT * FROM source_frontier WHERE run_id=$1 ORDER BY source_class,strategy", [runId]);
    return result.rows.map((row) => ({
      sourceClass: row.source_class,
      strategy: row.strategy,
      cursor: row.cursor,
      status: row.status,
      discoveredCount: row.discovered_count,
      recoveredCount: row.recovered_count,
      note: row.note,
    }));
  }

  async getCoverage(runId: string): Promise<Record<string, unknown>> {
    const run = await this.getRun(runId);
    const [keys, containers, eligibility] = await Promise.all([
      this.pool.query<{ canonical_key: string }>("SELECT canonical_key FROM track_candidates WHERE run_id=$1 ORDER BY created_at LIMIT 250", [runId]),
      this.listResearchContainers(runId),
      this.pool.query<{ verified_count: number; editorial_count: number }>(
        `SELECT
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM evidence_claims e
             JOIN source_records es ON es.id=e.source_id AND es.source_class='web'
             JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
               AND ca.run_id=e.run_id AND ca.source_url=es.url
             WHERE e.candidate_id=c.id
             AND e.state IN ('verified','corroborated')
             AND e.support_scope='track' AND e.verification_phase='track_verification'
             AND e.subject_entity=ANY($2::text[]) AND e.subject_relationship=$3
           ))::int verified_count,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM evidence_claims e
             JOIN source_records es ON es.id=e.source_id AND es.source_class='web'
             JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
               AND ca.run_id=e.run_id AND ca.source_url=es.url
             WHERE e.candidate_id=c.id
             AND ((e.state IN ('verified','corroborated') AND e.support_scope='track' AND e.verification_phase='track_verification')
               OR e.state='editorial')
             AND e.subject_entity=ANY($2::text[]) AND e.subject_relationship=$3
           ))::int editorial_count
         FROM track_candidates c WHERE c.run_id=$1`,
        [runId, run.brief.subjectEntities, run.brief.relationship],
      ),
    ]);
    const eligibleCandidateCount = run.brief.mode === "curated"
      ? Number(eligibility.rows[0]?.editorial_count ?? 0)
      : Number(eligibility.rows[0]?.verified_count ?? 0);
    return { candidateCount: run.candidateCount, eligibleCandidateCount, sourceCount: run.sourceCount, unresolvedCount: run.unresolvedCount, frontier: run.frontier, containers, existingKeys: keys.rows.map((row) => row.canonical_key) };
  }

  async upsertResearchContainers(runId: string, items: ResearchContainerInput[]): Promise<void> {
    await this.transaction(async (client) => {
      for (const item of items) {
        await client.query(
          `INSERT INTO research_containers(
             id,run_id,source_record_id,parent_container_id,container_type,provider_id,title,status,cursor,
             advertised_total,recovered_total,metadata_json,completed_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::varchar,$9,$10,$11,$12,CASE WHEN $8::varchar='complete' THEN now() ELSE NULL END)
           ON CONFLICT(run_id,container_type,provider_id) DO UPDATE SET source_record_id=COALESCE(EXCLUDED.source_record_id,research_containers.source_record_id),
             parent_container_id=COALESCE(EXCLUDED.parent_container_id,research_containers.parent_container_id),title=EXCLUDED.title,
             status=CASE WHEN EXCLUDED.status='discovered' THEN research_containers.status ELSE EXCLUDED.status END,
             cursor=CASE
               WHEN EXCLUDED.status='discovered' AND research_containers.status<>'discovered' THEN research_containers.cursor
               WHEN EXCLUDED.status='discovered' THEN COALESCE(research_containers.cursor,EXCLUDED.cursor)
               ELSE EXCLUDED.cursor END,
             advertised_total=CASE
               WHEN EXCLUDED.status='discovered' AND research_containers.status<>'discovered' THEN research_containers.advertised_total
               WHEN EXCLUDED.status='discovered' THEN COALESCE(research_containers.advertised_total,EXCLUDED.advertised_total)
               ELSE EXCLUDED.advertised_total END,
             recovered_total=CASE
               WHEN EXCLUDED.status='discovered' AND research_containers.status<>'discovered' THEN research_containers.recovered_total
               WHEN EXCLUDED.status='discovered' THEN GREATEST(research_containers.recovered_total,EXCLUDED.recovered_total)
               ELSE EXCLUDED.recovered_total END,
             metadata_json=CASE WHEN EXCLUDED.status='discovered'
               THEN COALESCE(EXCLUDED.metadata_json,'{}'::jsonb)||COALESCE(research_containers.metadata_json,'{}'::jsonb)
               ELSE EXCLUDED.metadata_json END,
             completed_at=CASE
               WHEN EXCLUDED.status='discovered' THEN research_containers.completed_at
               WHEN EXCLUDED.status='complete' THEN COALESCE(research_containers.completed_at,now())
               ELSE NULL END,updated_at=now()`,
          [item.id ?? randomUUID(), runId, item.sourceRecordId ?? null, item.parentContainerId ?? null, item.containerType.slice(0, 48), item.providerId.slice(0, 240), item.title.slice(0, 240), item.status.slice(0, 32), item.cursor ?? null, item.advertisedTotal ?? null, item.recoveredTotal ?? 0, item.metadata ?? {}],
        );
      }
    });
  }

  async listResearchContainers(runId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT id,source_record_id,parent_container_id,container_type,provider_id,title,status,cursor,
       advertised_total,recovered_total,metadata_json,completed_at FROM research_containers
       WHERE run_id=$1 ORDER BY container_type,title,provider_id`,
      [runId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sourceRecordId: row.source_record_id,
      parentContainerId: row.parent_container_id,
      containerType: row.container_type,
      providerId: row.provider_id,
      title: row.title,
      status: row.status,
      cursor: row.cursor,
      advertisedTotal: row.advertised_total,
      recoveredTotal: row.recovered_total,
      metadata: row.metadata_json,
      completedAt: date(row.completed_at)?.toISOString() ?? null,
    }));
  }

  async listCandidates(runId: string): Promise<CandidateRow[]> {
    const [result, evidenceResult] = await Promise.all([
      this.pool.query(
        "SELECT * FROM track_candidates WHERE run_id=$1 ORDER BY selection_rank NULLS LAST,artist,release_year NULLS LAST,album NULLS LAST,title,id",
        [runId],
      ),
      this.pool.query(
        `SELECT e.candidate_id,s.url source_url,s.source_class,e.state,e.support_scope,e.verification_phase,
           e.subject_entity,e.subject_relationship,e.relationship,e.note,
           ca.response_id,ca.output_item_id,ca.content_index,ca.start_index,ca.end_index,ca.excerpt
         FROM evidence_claims e
         JOIN source_records s ON s.id=e.source_id
         LEFT JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
           AND ca.run_id=e.run_id AND ca.source_url=s.url
         WHERE e.run_id=$1 ORDER BY e.candidate_id,e.state,s.url`,
        [runId],
      ),
    ]);
    const evidenceByCandidate = new Map<string, any[]>();
    for (const row of evidenceResult.rows) {
      const evidence = evidenceByCandidate.get(row.candidate_id) ?? [];
      evidence.push({
        sourceUrl: row.source_url,
        sourceClass: row.source_class,
        state: ((row.state === "verified" || row.state === "corroborated" || row.state === "disputed")
            && (row.support_scope !== "track" || row.verification_phase !== "track_verification"
              || row.source_class !== "web" || !row.response_id))
          || (row.state === "editorial" && (row.source_class !== "web" || !row.response_id))
          ? "inferred"
          : row.state,
        supportScope: row.support_scope,
        verificationPhase: row.verification_phase,
        subjectEntity: row.subject_entity,
        subjectRelationship: row.subject_relationship,
        relationship: row.relationship,
        note: row.note,
        citationSupport: row.response_id ? {
          responseId: row.response_id,
          outputItemId: row.output_item_id,
          contentIndex: row.content_index,
          startIndex: row.start_index,
          endIndex: row.end_index,
          excerpt: row.excerpt,
        } : null,
      });
      evidenceByCandidate.set(row.candidate_id, evidence);
    }
    return result.rows.map((row): CandidateRow => ({
        id: row.id,
        runId: row.run_id,
        selectionRank: row.selection_rank,
        artist: row.artist,
        title: row.title,
        album: row.album,
        releaseYear: row.release_year,
        durationMs: row.duration_ms,
        isrc: row.isrc,
        musicbrainzId: row.musicbrainz_id,
        versionLabel: row.version_label,
        outcome: row.outcome,
        duplicateClusterKey: row.duplicate_cluster_key,
        evidence: evidenceByCandidate.get(row.id) ?? [],
      }));
  }

  async saveMatch(runId: string, match: CatalogMatchResult): Promise<void> {
    await this.transaction(async (client) => {
      const run = await client.query("SELECT id FROM research_runs WHERE id=$1 FOR UPDATE", [runId]);
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      const candidate = await client.query(
        "SELECT id FROM track_candidates WHERE id=$1 AND run_id=$2 FOR UPDATE",
        [match.candidateId, runId],
      );
      if (!candidate.rows[0]) {
        throw new HttpError(409, "Catalog match candidate does not belong to this run", "catalog_candidate_scope_mismatch");
      }
      let resultingStatus = match.status;
      if (match.status === "accepted" && match.song?.id) {
        const duplicate = await client.query(
          "SELECT 1 FROM catalog_matches WHERE run_id=$1 AND catalog_id=$2 AND status='accepted' AND candidate_id<>$3 LIMIT 1",
          [runId, match.song.id, match.candidateId],
        );
        if (duplicate.rows[0]) resultingStatus = "duplicate";
      }
      await client.query(
        `INSERT INTO catalog_matches(
           id,run_id,candidate_id,status,basis,score,catalog_id,song_json,alternatives_json,
           initial_status,initial_basis,initial_score,initial_catalog_id,initial_song_json,initial_matched_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$4,$5,$6,$7,$8,now())
         ON CONFLICT(candidate_id) DO UPDATE SET status=EXCLUDED.status,basis=EXCLUDED.basis,score=EXCLUDED.score,
           catalog_id=EXCLUDED.catalog_id,song_json=EXCLUDED.song_json,alternatives_json=EXCLUDED.alternatives_json`,
        [
          randomUUID(),
          runId,
          match.candidateId,
          resultingStatus,
          match.basis,
          match.score,
          match.song?.id ?? null,
          match.song ? JSON.stringify(match.song) : null,
          JSON.stringify(match.alternatives ?? []),
        ],
      );
      await client.query("UPDATE track_candidates SET outcome=$1 WHERE id=$2 AND run_id=$3", [resultingStatus, match.candidateId, runId]);
    });
  }

  async saveTimeoutMatches(runId: string, candidateIds: string[], basis: string): Promise<void> {
    if (candidateIds.length === 0) return;
    const uniqueCandidateIds = [...new Set(candidateIds)];
    if (uniqueCandidateIds.length !== candidateIds.length) {
      throw new HttpError(409, "Timed-out catalog candidates must be unique", "catalog_candidate_duplicate");
    }
    await this.transaction(async (client) => {
      const run = await client.query("SELECT id FROM research_runs WHERE id=$1 FOR UPDATE", [runId]);
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      const scoped = await client.query<{ id: string }>(
        "SELECT id FROM track_candidates WHERE run_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE",
        [runId, uniqueCandidateIds],
      );
      if (scoped.rows.length !== uniqueCandidateIds.length) {
        throw new HttpError(409, "Catalog match candidate does not belong to this run", "catalog_candidate_scope_mismatch");
      }
      const existing = await client.query(
        "SELECT candidate_id FROM catalog_matches WHERE run_id=$1 AND candidate_id=ANY($2::uuid[]) LIMIT 1",
        [runId, uniqueCandidateIds],
      );
      if (existing.rows[0]) {
        throw new HttpError(409, "A timed-out catalog candidate already has an outcome", "catalog_candidate_already_matched");
      }
      const matchIds = uniqueCandidateIds.map(() => randomUUID());
      await client.query(
        `INSERT INTO catalog_matches(
           id,run_id,candidate_id,status,basis,score,catalog_id,song_json,alternatives_json,
           initial_status,initial_basis,initial_score,initial_catalog_id,initial_song_json,initial_matched_at)
         SELECT batch.match_id,$1,batch.candidate_id,'review',$4,0,NULL,NULL,'[]'::jsonb,
                'review',$4,0,NULL,NULL,now()
         FROM unnest($2::uuid[],$3::uuid[]) AS batch(match_id,candidate_id)`,
        [runId, matchIds, uniqueCandidateIds, basis],
      );
      await client.query(
        "UPDATE track_candidates SET outcome='review' WHERE run_id=$1 AND id=ANY($2::uuid[])",
        [runId, uniqueCandidateIds],
      );
    });
  }

  async listMatches(runId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT m.*,c.artist,c.title,c.album,c.duplicate_cluster_key FROM catalog_matches m
       JOIN track_candidates c ON c.id=m.candidate_id WHERE m.run_id=$1 ORDER BY c.artist,c.title,c.id`,
      [runId],
    );
    return result.rows.map((row) => ({
      candidateId: row.candidate_id,
      artist: row.artist,
      title: row.title,
      album: row.album,
      duplicateClusterKey: row.duplicate_cluster_key,
      status: row.status,
      basis: row.basis,
      score: Number(row.score),
      song: row.song_json,
      alternatives: row.alternatives_json ?? [],
      reviewedAt: date(row.reviewed_at)?.toISOString() ?? null,
    }));
  }

  async listExceptions(runId: string, page: number, pageSize = 20): Promise<{ items: any[]; page: number; pageSize: number; total: number; totalPages: number; unresolvedCount: number }> {
    const safePage = Math.max(1, Math.floor(page));
    const size = Math.max(1, Math.min(Math.floor(pageSize), 20));
    const offset = (safePage - 1) * size;
    const count = await this.pool.query<{ total: number }>(
      "SELECT count(*)::int total FROM catalog_matches WHERE run_id=$1 AND status IN ('review','unavailable')",
      [runId],
    );
    const rows = await this.pool.query(
      `SELECT m.*,c.artist,c.title,c.album,c.version_label,c.duplicate_cluster_key
       FROM catalog_matches m JOIN track_candidates c ON c.id=m.candidate_id
       WHERE m.run_id=$1 AND m.status IN ('review','unavailable') ORDER BY c.artist,c.title,c.id LIMIT $2 OFFSET $3`,
      [runId, size, offset],
    );
    const total = count.rows[0]!.total;
    return { items: rows.rows.map((row) => ({
      candidateId: row.candidate_id,
      artist: row.artist,
      title: row.title,
      album: row.album,
      versionLabel: row.version_label,
      duplicateClusterKey: row.duplicate_cluster_key,
      status: row.status,
      basis: row.basis,
      score: Number(row.score),
      song: row.song_json,
      alternatives: row.alternatives_json ?? [],
    })), page: safePage, pageSize: size, total, totalPages: Math.ceil(total / size), unresolvedCount: total };
  }

  async listCatalogTracks(runId: string, page = 1, pageSize = 200): Promise<CatalogTrackPage> {
    const run = await this.getRunRow(runId);
    if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
    const brief = run.brief_json as PlaylistBrief;
    const safePage = Math.max(1, Math.floor(page));
    const size = Math.max(1, Math.min(Math.floor(pageSize), 500));
    const offset = (safePage - 1) * size;
    const orderSql = manifestOrderSql(brief);
    const evidenceStates = brief.mode === "curated"
      ? ["verified", "corroborated", "editorial"]
      : ["verified", "corroborated"];
    // Alternatives are evidence for an ambiguity screen, not proof that a
    // catalog recording is safe to include. A row is selectable by default
    // only when matching produced a plausible primary song.
    const choiceSql = `m.song_json IS NOT NULL AND NULLIF(m.song_json->>'id','') IS NOT NULL`;
    const recoverySlotsSql = `(SELECT count(*) FROM job_queue recovery_jobs
      WHERE recovery_jobs.run_id=c.run_id AND recovery_jobs.kind='matching'
        AND recovery_jobs.payload_json->>'retryIncomplete'='true') < 3`;
    const retryableSql = `m.status='review' AND m.song_json IS NULL
      AND (m.basis=ANY($2::text[]) OR m.basis=$3)
      AND ${recoverySlotsSql}`;
    const summary = await this.pool.query<{
      total: number;
      selectable_count: number;
      unmatched_count: number;
      retryable_count: number;
      matching_complete: boolean;
    }>(
      `SELECT count(*)::int total,
         count(*) FILTER (WHERE ${choiceSql})::int selectable_count,
         count(*) FILTER (WHERE NOT (${choiceSql}))::int unmatched_count,
         count(*) FILTER (WHERE ${retryableSql})::int retryable_count,
         COALESCE(bool_and(m.status IS NOT NULL AND NOT (${retryableSql})),true) matching_complete
       FROM track_candidates c
       LEFT JOIN catalog_matches m ON m.candidate_id=c.id AND m.run_id=c.run_id
       WHERE c.run_id=$1`,
      [runId, [...RETRYABLE_CATALOG_MATCH_BASES], CATALOG_RECOVERY_UNRESOLVED_BASIS],
    );
    const rows = await this.pool.query(
      `SELECT
         row_number() OVER (ORDER BY ${orderSql})-1 AS position,
         c.id AS candidate_id,c.selection_rank,c.artist,c.title,c.album,c.release_year,c.duration_ms,
         c.isrc,c.version_label,c.duplicate_cluster_key,
         COALESCE(m.status,'pending') AS status,m.basis,m.score,m.catalog_id,m.song_json,m.alternatives_json,
         (${choiceSql}) AS selectable,
         (m.status='review' AND m.song_json IS NULL
           AND (m.basis=ANY($5::text[]) OR m.basis=$6)
           AND ${recoverySlotsSql}) AS retryable,
         EXISTS (
           SELECT 1 FROM evidence_claims e
           JOIN source_records es ON es.id=e.source_id AND es.source_class='web'
           JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
             AND ca.run_id=e.run_id AND ca.source_url=es.url
           WHERE e.candidate_id=c.id AND e.state=ANY($2::text[])
             AND e.support_scope='track' AND e.verification_phase='track_verification'
             AND e.subject_entity=ANY($3::text[]) AND e.subject_relationship=$4
         ) AS evidence_eligible
       FROM track_candidates c
       LEFT JOIN catalog_matches m ON m.candidate_id=c.id AND m.run_id=c.run_id
       WHERE c.run_id=$1
       ORDER BY ${orderSql}
       LIMIT $7 OFFSET $8`,
      [
        runId,
        evidenceStates,
        brief.subjectEntities,
        brief.relationship,
        [...RETRYABLE_CATALOG_MATCH_BASES],
        CATALOG_RECOVERY_UNRESOLVED_BASIS,
        size,
        offset,
      ],
    );
    const totals = summary.rows[0] ?? {
      total: 0,
      selectable_count: 0,
      unmatched_count: 0,
      retryable_count: 0,
      matching_complete: true,
    };
    return {
      items: rows.rows.map((row): CatalogTrackRow => ({
        position: Number(row.position),
        candidateId: row.candidate_id,
        selectionRank: row.selection_rank == null ? null : Number(row.selection_rank),
        artist: row.artist,
        title: row.title,
        album: row.album,
        releaseYear: row.release_year == null ? null : Number(row.release_year),
        durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
        isrc: row.isrc,
        versionLabel: row.version_label,
        duplicateClusterKey: row.duplicate_cluster_key,
        status: row.status,
        basis: row.basis,
        score: Number(row.score ?? 0),
        catalogId: row.catalog_id,
        song: row.song_json,
        alternatives: Array.isArray(row.alternatives_json) ? row.alternatives_json : [],
        evidenceEligible: Boolean(row.evidence_eligible),
        selected: row.status === "accepted",
        selectable: Boolean(row.selectable),
        retryable: Boolean(row.retryable),
      })),
      page: safePage,
      pageSize: size,
      total: Number(totals.total),
      totalPages: Math.ceil(Number(totals.total) / size),
      selectableCount: Number(totals.selectable_count),
      unmatchedCount: Number(totals.unmatched_count),
      retryableCount: Number(totals.retryable_count),
      matchingComplete: Boolean(totals.matching_complete),
    };
  }

  async queueCatalogRecovery(runId: string, storefront: string): Promise<{
    queued: boolean;
    state: "queued" | "in_flight" | "ready";
    retryableCount: number;
  }> {
    if (!/^[a-z]{2}$/iu.test(storefront)) throw new HttpError(400, "Apple storefront is invalid", "invalid_storefront");
    return this.transaction(async (client) => {
      const run = await client.query<{ status: string }>(
        "SELECT status FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [runId],
      );
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      const prior = await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM job_queue WHERE run_id=$1 AND kind='matching'
           AND payload_json->>'retryIncomplete'='true'`,
        [runId],
      );
      const priorGenerationCount = Number(prior.rows[0]?.count ?? 0);
      const retryable = await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM catalog_matches
         WHERE run_id=$1 AND status='review' AND song_json IS NULL
           AND (basis=ANY($2::text[]) OR basis=$3) AND $4::int<3`,
        [
          runId,
          [...RETRYABLE_CATALOG_MATCH_BASES],
          CATALOG_RECOVERY_UNRESOLVED_BASIS,
          priorGenerationCount,
        ],
      );
      const retryableCount = Number(retryable.rows[0]?.count ?? 0);
      const active = await client.query<{ id: string; recovery: boolean }>(
        `SELECT id,(payload_json->>'retryIncomplete'='true') AS recovery
         FROM job_queue WHERE run_id=$1 AND kind='matching' AND status IN ('queued','leased')
         ORDER BY created_at DESC LIMIT 1`,
        [runId],
      );
      if (active.rows[0]?.recovery) return { queued: false, state: "in_flight", retryableCount };
      if (active.rows[0] || !["review", "visitor_review"].includes(run.rows[0].status)) {
        throw new HttpError(409, "Run is not ready for catalog recovery", "catalog_recovery_not_ready");
      }
      if (priorGenerationCount >= 3) {
        await settleCatalogRecoveryFailure(client, runId, 3);
        return { queued: false, state: "ready", retryableCount: 0 };
      }
      if (retryableCount === 0) return { queued: false, state: "ready", retryableCount };
      const generation = priorGenerationCount + 1;
      // Builds before bounded generations terminalized every failed recovery.
      // Reopen those rows only while the run still has a recovery generation
      // available. Normalize legacy malformed JSON at the same atomic boundary
      // so the new job can never observe node-postgres' old `{}` encoding.
      await client.query(
        `UPDATE catalog_matches SET
           alternatives_json=CASE WHEN jsonb_typeof(alternatives_json)='array'
             THEN alternatives_json ELSE '[]'::jsonb END,
           basis=$3
         WHERE run_id=$1 AND status='review' AND song_json IS NULL AND basis=$2
        `,
        [runId, CATALOG_RECOVERY_UNRESOLVED_BASIS, RETRYABLE_CATALOG_MATCH_BASES[0]],
      );
      await client.query(
        `INSERT INTO job_queue(id,run_id,kind,dedupe_key,payload_json,max_attempts)
         VALUES($1,$2,'matching',$3,$4,1)`,
        [
          randomUUID(),
          runId,
          `matching-recovery:${runId}:${generation}`,
          { runId, storefront: storefront.toLowerCase(), retryIncomplete: true, recoveryGeneration: generation },
        ],
      );
      await client.query(
        "UPDATE research_runs SET status='matching',phase='catalog_matching_recovery',error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1",
        [runId],
      );
      return { queued: true, state: "queued", retryableCount };
    });
  }

  async reviewMatch(runId: string, candidateId: string, status: "accepted" | "rejected", catalogSong?: unknown): Promise<"accepted" | "rejected" | "duplicate"> {
    const requestedCatalogId = (catalogSong as { id?: string } | undefined)?.id ?? null;
    const result = await this.transaction(async (client) => {
      const run = await client.query<{ status: string }>("SELECT status FROM research_runs WHERE id=$1 FOR UPDATE", [runId]);
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      if (!["review", "visitor_review"].includes(run.rows[0].status)) {
        throw new HttpError(409, "The immutable manifest is already locked", "manifest_already_locked");
      }
      const current = await client.query(
        "SELECT song_json,alternatives_json FROM catalog_matches WHERE candidate_id=$1 AND run_id=$2 FOR UPDATE",
        [candidateId, runId],
      );
      if (!current.rows[0]) return 0;
      let selectedSong: unknown = null;
      let selectedCatalogId: string | null = null;
      let resultingStatus: "accepted" | "rejected" | "duplicate" = status;
      if (status === "accepted") {
        if (!requestedCatalogId) throw new HttpError(400, "Choose one of the Apple Music matches", "catalog_match_required");
        const options = [current.rows[0].song_json, ...(Array.isArray(current.rows[0].alternatives_json) ? current.rows[0].alternatives_json : [])]
          .filter((song) => song && typeof song === "object" && typeof song.id === "string");
        selectedSong = options.find((song) => song.id === requestedCatalogId) ?? null;
        if (!selectedSong) throw new HttpError(400, "That Apple Music recording was not among the verified match options", "catalog_match_not_permitted");
        selectedCatalogId = requestedCatalogId;
        const duplicate = await client.query(
          "SELECT 1 FROM catalog_matches WHERE run_id=$1 AND catalog_id=$2 AND status='accepted' AND candidate_id<>$3 LIMIT 1",
          [runId, selectedCatalogId, candidateId],
        );
        if (duplicate.rows[0]) resultingStatus = "duplicate";
      }
      const updated = await client.query(
        `UPDATE catalog_matches SET status=$1::varchar,catalog_id=CASE WHEN $1::varchar IN ('accepted','duplicate') THEN $2 ELSE catalog_id END,
         song_json=CASE WHEN $1::varchar IN ('accepted','duplicate') THEN $3 ELSE song_json END,reviewed_at=now()
         WHERE candidate_id=$4 AND run_id=$5`,
        [resultingStatus, selectedCatalogId, selectedSong, candidateId, runId],
      );
      if (updated.rowCount) await client.query("UPDATE track_candidates SET outcome=$1 WHERE id=$2 AND run_id=$3", [resultingStatus, candidateId, runId]);
      return updated.rowCount ? resultingStatus : null;
    });
    if (!result) throw new HttpError(404, "Candidate match not found", "candidate_not_found");
    return result;
  }

  async finalizeCatalogSelection(
    runId: string,
    input: CatalogSelectionInput,
  ): Promise<PlaylistManifest & { contentHash: string; lockedAt: string }> {
    return this.transaction(async (client) => {
      const runResult = await client.query<{ status: string; brief_json: PlaylistBrief }>(
        "SELECT status,brief_json FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [runId],
      );
      const run = runResult.rows[0];
      if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
      const existingManifest = await client.query("SELECT id FROM manifests WHERE run_id=$1 LIMIT 1", [runId]);
      if (existingManifest.rows[0]) return this.createManifestInTransaction(client, runId);
      if (!["review", "visitor_review"].includes(run.status)) {
        throw new HttpError(409, "Run is not ready for playlist selection", "selection_not_ready");
      }
      const explicitMode = Array.isArray(input.selected);
      const recommendedMode = input.useRecommended === true;
      if (explicitMode === recommendedMode) {
        throw new HttpError(400, "Choose either explicit tracks or recommended tracks", "invalid_selection");
      }
      const selected = explicitMode ? input.selected! : [];
      const excluded = recommendedMode ? (input.excludedCandidateIds ?? []) : [];
      const overrides = recommendedMode ? (input.overrides ?? []) : [];
      if (selected.length > 10_000 || excluded.length > 10_000 || overrides.length > 10_000) {
        throw new HttpError(413, "Playlist selection is too large", "selection_too_large");
      }
      const uniqueValues = (values: string[]) => new Set(values).size === values.length;
      if (!uniqueValues(selected.map((item) => item.candidateId))
        || !uniqueValues(excluded)
        || !uniqueValues(overrides.map((item) => item.candidateId))) {
        throw new HttpError(400, "Playlist selection contains duplicate candidates", "invalid_selection");
      }
      const excludedSet = new Set(excluded);
      if (overrides.some((item) => excludedSet.has(item.candidateId))) {
        throw new HttpError(400, "An excluded track cannot also override its Apple match", "invalid_selection");
      }
      const orderSql = manifestOrderSql(run.brief_json);
      const candidates = await client.query(
        `SELECT c.id,c.artist,c.title,m.status,m.basis,m.song_json,m.alternatives_json
         FROM track_candidates c
         JOIN catalog_matches m ON m.candidate_id=c.id AND m.run_id=c.run_id
         WHERE c.run_id=$1 ORDER BY ${orderSql} FOR UPDATE OF c,m`,
        [runId],
      );
      const candidateCount = await client.query<{ count: number }>(
        "SELECT count(*)::int count FROM track_candidates WHERE run_id=$1",
        [runId],
      );
      if (candidates.rows.length !== Number(candidateCount.rows[0]?.count ?? 0)) {
        throw new HttpError(409, "Apple catalog matching is still in progress", "matching_incomplete");
      }
      const accountedStatuses = new Set(["accepted", "review", "unavailable", "rejected", "duplicate", "unsupported", "overflow"]);
      if (candidates.rows.some((row) => !accountedStatuses.has(row.status))) {
        throw new HttpError(409, "Apple catalog matching is still in progress", "matching_incomplete");
      }
      const rowsByCandidate = new Map<string, (typeof candidates.rows)[number]>(
        candidates.rows.map((row) => [row.id, row]),
      );
      for (const candidateId of excluded) {
        if (!rowsByCandidate.has(candidateId)) throw new HttpError(400, "An excluded track is not part of this run", "invalid_selection");
      }
      const choicesByCandidate = new Map<string, Map<string, CatalogSong>>();
      for (const row of candidates.rows) {
        const hasPrimary = Boolean(row.song_json && typeof row.song_json === "object" && typeof row.song_json.id === "string");
        const choices = [
          row.song_json,
          ...(hasPrimary && Array.isArray(row.alternatives_json) ? row.alternatives_json : []),
        ]
          .filter((song): song is CatalogSong => Boolean(song && typeof song === "object" && typeof song.id === "string"));
        choicesByCandidate.set(row.id, new Map(choices.map((song) => [song.id, song])));
      }
      const requested = new Map<string, string>();
      if (explicitMode) {
        for (const item of selected) requested.set(item.candidateId, item.catalogId);
      } else {
        for (const row of candidates.rows) {
          if (!excludedSet.has(row.id)
            && ["accepted", "review"].includes(row.status)
            && row.song_json
            && typeof row.song_json.id === "string") {
            requested.set(row.id, row.song_json.id);
          }
        }
        for (const item of overrides) requested.set(item.candidateId, item.catalogId);
      }
      const selectedSongs = new Map<string, CatalogSong>();
      for (const [candidateId, catalogId] of requested) {
        const choice = choicesByCandidate.get(candidateId)?.get(catalogId);
        if (!choice) {
          throw new HttpError(400, "A selected Apple recording was not one of the server-provided choices", "catalog_match_not_permitted");
        }
        selectedSongs.set(candidateId, choice);
      }
      if (selectedSongs.size === 0) throw new HttpError(409, "Select at least one Apple Music track", "empty_selection");
      const acceptedCatalogIds = new Set<string>();
      const updates = candidates.rows.map((row) => {
        const song = selectedSongs.get(row.id) ?? null;
        if (song) {
          const status = acceptedCatalogIds.has(song.id) ? "duplicate" : "accepted";
          acceptedCatalogIds.add(song.id);
          return {
            candidate_id: row.id,
            status,
            catalog_id: song.id,
            song_json: song,
            basis: status === "duplicate"
              ? `Visitor selection duplicated Apple catalog ID ${song.id}`
              : `Visitor selected Apple catalog ID ${song.id} in bulk review`,
          };
        }
        const noChoices = (choicesByCandidate.get(row.id)?.size ?? 0) === 0;
        const status = noChoices && ["unavailable", "unsupported"].includes(row.status)
          ? row.status
          : "rejected";
        return {
          candidate_id: row.id,
          status,
          catalog_id: null,
          song_json: null,
          basis: status === row.status ? row.basis : "Visitor excluded this track in bulk review",
        };
      });
      const updated = await client.query(
        `UPDATE catalog_matches m SET
           status=u.status,
           basis=u.basis,
           catalog_id=CASE WHEN u.status IN ('accepted','duplicate') THEN u.catalog_id ELSE NULL END,
           song_json=CASE WHEN u.status IN ('accepted','duplicate') THEN u.song_json ELSE m.song_json END,
           reviewed_at=now()
         FROM jsonb_to_recordset($2::jsonb) AS u(
           candidate_id uuid,status varchar,basis text,catalog_id text,song_json jsonb
         )
         WHERE m.run_id=$1 AND m.candidate_id=u.candidate_id`,
        [runId, JSON.stringify(updates)],
      );
      if (updated.rowCount !== updates.length) {
        throw new HttpError(409, "Playlist selection changed while it was being saved", "selection_conflict");
      }
      await client.query(
        `UPDATE track_candidates c SET outcome=m.status FROM catalog_matches m
         WHERE c.run_id=$1 AND m.run_id=$1 AND m.candidate_id=c.id`,
        [runId],
      );
      return this.createManifestInTransaction(client, runId, { allowUnavailable: true });
    });
  }

  private async createManifestInTransaction(
    client: PoolClient,
    runId: string,
    options: { verifiedOnly?: boolean; allowUnavailable?: boolean } = {},
  ): Promise<PlaylistManifest & { contentHash: string; lockedAt: string }> {
      const runResult = await client.query("SELECT * FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [runId]);
      const run = runResult.rows[0];
      if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
      const alreadyLocked = await client.query("SELECT * FROM manifests WHERE run_id=$1 LIMIT 1", [runId]);
      if (alreadyLocked.rows[0]) {
        const stored = alreadyLocked.rows[0];
        const storedTracks = await client.query(
          "SELECT position,candidate_id,catalog_id,artist,title FROM manifest_tracks WHERE manifest_id=$1 ORDER BY position",
          [stored.id],
        );
        return {
          id: stored.id,
          runId,
          name: stored.name,
          description: stored.description,
          contentHash: stored.content_hash,
          lockedAt: date(stored.locked_at)!.toISOString(),
          createdAt: date(stored.created_at)!.toISOString(),
          tracks: storedTracks.rows.map((track) => ({ position: track.position, candidateId: track.candidate_id, catalogId: track.catalog_id, artist: track.artist, title: track.title })),
        };
      }
      if (!["review", "visitor_review"].includes(run.status)) throw new HttpError(409, "Run is not ready for a manifest", "manifest_not_ready");
      const brief = run.brief_json as PlaylistBrief;
      const accounting = await client.query<{
        id: string;
        outcome: string;
        match_status: string | null;
        catalog_id: string | null;
        evidence_eligible: boolean;
      }>(
        `SELECT c.id,c.outcome,m.status match_status,m.catalog_id,
           EXISTS (
             SELECT 1 FROM evidence_claims e
             JOIN source_records es ON es.id=e.source_id AND es.source_class='web'
             JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
               AND ca.run_id=e.run_id AND ca.source_url=es.url
             WHERE e.candidate_id=c.id
               AND e.state IN ('verified','corroborated') AND e.support_scope='track'
               AND e.verification_phase='track_verification'
               AND e.subject_entity=ANY($2::text[]) AND e.subject_relationship=$3
           ) evidence_eligible
         FROM track_candidates c
         LEFT JOIN catalog_matches m ON m.candidate_id=c.id AND m.run_id=c.run_id
         WHERE c.run_id=$1 ORDER BY c.id`,
        [runId, brief.subjectEntities, brief.relationship],
      );
      const matchStatuses = new Set(["accepted", "review", "unavailable", "rejected", "duplicate", "unsupported", "overflow"]);
      const incomplete = accounting.rows.some((candidate) => (
        !candidate.match_status
        || !matchStatuses.has(candidate.match_status)
        || candidate.outcome === "pending"
        || candidate.outcome !== candidate.match_status
        || (candidate.match_status === "accepted" && !candidate.catalog_id)
      ));
      if (incomplete) {
        throw new HttpError(409, "Catalog matching has not accounted for every candidate", "matching_incomplete");
      }
      if (!options.verifiedOnly && accounting.rows.some((candidate) => candidate.match_status === "review"
        || (!options.allowUnavailable && candidate.match_status === "unavailable"))) {
        throw new HttpError(409, "Resolve every exception or choose Publish verified tracks", "unresolved_exceptions");
      }
      if (options.verifiedOnly) {
        // Choosing "Publish verified tracks" is itself the visitor's explicit
        // disposition for unresolved or evidence-ineligible candidates. Keep
        // every candidate accounted for before the immutable manifest locks.
        const rejected = accounting.rows.filter((candidate) => candidate.match_status === "review").map((candidate) => candidate.id);
        const unsupported = accounting.rows
          .filter((candidate) => candidate.match_status === "accepted" && !candidate.evidence_eligible)
          .map((candidate) => candidate.id);
        if (rejected.length > 0) {
          await client.query(
            "UPDATE catalog_matches SET status='rejected',reviewed_at=now() WHERE run_id=$1 AND candidate_id=ANY($2::uuid[])",
            [runId, rejected],
          );
        }
        if (unsupported.length > 0) {
          await client.query(
            "UPDATE catalog_matches SET status='unsupported',reviewed_at=now() WHERE run_id=$1 AND candidate_id=ANY($2::uuid[])",
            [runId, unsupported],
          );
        }
        if (rejected.length > 0 || unsupported.length > 0) {
          await client.query(
            `UPDATE track_candidates c SET outcome=m.status FROM catalog_matches m
             WHERE c.run_id=$1 AND m.run_id=$1 AND m.candidate_id=c.id`,
            [runId],
          );
        }
      }
      const verifiedClause = options.verifiedOnly
        ? `AND EXISTS (
             SELECT 1 FROM evidence_claims e
             JOIN source_records es ON es.id=e.source_id AND es.source_class='web'
             JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
               AND ca.run_id=e.run_id AND ca.source_url=es.url
             WHERE e.candidate_id=c.id AND e.state IN ('verified','corroborated')
               AND e.support_scope='track' AND e.verification_phase='track_verification'
               AND e.subject_entity=ANY($2::text[]) AND e.subject_relationship=$3
           )`
        : "";
      const orderSql = manifestOrderSql(brief);
      const matches = await client.query(
        `SELECT m.candidate_id,m.catalog_id,m.song_json,c.artist,c.title FROM catalog_matches m
         JOIN track_candidates c ON c.id=m.candidate_id
         WHERE m.run_id=$1 AND m.status='accepted' AND m.catalog_id IS NOT NULL ${verifiedClause}
         ORDER BY ${orderSql}`,
        options.verifiedOnly ? [runId, brief.subjectEntities, brief.relationship] : [runId],
      );
      const maximumTracks = brief.mode === "curated"
        ? Math.max(1, Math.floor(brief.targetSize?.max ?? 100))
        : Number.POSITIVE_INFINITY;
      const selectedMatches = matches.rows.slice(0, maximumTracks);
      const overflowMatches = matches.rows.slice(maximumTracks);
      if (overflowMatches.length > 0) {
        const overflowIds = overflowMatches.map((match) => match.candidate_id);
        await client.query(
          `UPDATE catalog_matches SET status='overflow',
             basis=$3,reviewed_at=now()
           WHERE run_id=$1 AND candidate_id=ANY($2::uuid[]) AND status='accepted'`,
          [
            runId,
            overflowIds,
            `Excluded by the confirmed curated target maximum of ${maximumTracks} tracks after deterministic ${brief.orderingPolicy || "artist/title"} ordering`,
          ],
        );
        await client.query(
          "UPDATE track_candidates SET outcome='overflow' WHERE run_id=$1 AND id=ANY($2::uuid[])",
          [runId, overflowIds],
        );
      }
      const tracks = selectedMatches.map((match, index) => ({
        position: index,
        candidateId: match.candidate_id,
        catalogId: match.catalog_id,
        artist: match.artist,
        title: match.title,
      }));
      if (tracks.length === 0) throw new HttpError(409, "No accepted Apple Music matches are ready", "empty_manifest");
      const contentHash = sha256Hex(JSON.stringify(tracks.map((track) => [track.position, track.candidateId, track.catalogId])));
      const id = randomUUID();
      const now = new Date();
      const name = `${brief.title} · ${now.toISOString().slice(0, 10)}`.slice(0, 240);
      const description = manifestDescriptionForBrief(brief);
      await client.query("INSERT INTO manifests(id,run_id,name,description,content_hash) VALUES($1,$2,$3,$4,$5)", [id, runId, name, description, contentHash]);
      for (const track of tracks) {
        await client.query(
          "INSERT INTO manifest_tracks(manifest_id,position,candidate_id,catalog_id,artist,title) VALUES($1,$2,$3,$4,$5,$6)",
          [id, track.position, track.candidateId, track.catalogId, track.artist, track.title],
        );
      }
      await client.query("UPDATE research_runs SET status='manifest_ready',phase='manifest',updated_at=now() WHERE id=$1", [runId]);
      return { id, runId, name, description, createdAt: now.toISOString(), tracks, contentHash, lockedAt: now.toISOString() };
  }

  async createManifest(runId: string, options: { verifiedOnly?: boolean } = {}): Promise<PlaylistManifest & { contentHash: string; lockedAt: string }> {
    return this.transaction((client) => this.createManifestInTransaction(client, runId, options));
  }

  async getManifestById(id: string): Promise<any | null> {
    const manifest = await this.pool.query("SELECT * FROM manifests WHERE id=$1", [id]);
    if (!manifest.rows[0]) return null;
    const tracks = await this.pool.query(
      "SELECT position,candidate_id,catalog_id,artist,title FROM manifest_tracks WHERE manifest_id=$1 ORDER BY position",
      [id],
    );
    const row = manifest.rows[0];
    return {
      id: row.id,
      runId: row.run_id,
      name: row.name,
      description: row.description,
      contentHash: row.content_hash,
      lockedAt: date(row.locked_at)?.toISOString(),
      createdAt: date(row.created_at)?.toISOString(),
      tracks: tracks.rows.map((track) => ({ position: track.position, candidateId: track.candidate_id, catalogId: track.catalog_id, artist: track.artist, title: track.title })),
    };
  }

  async getLatestManifestForRun(runId: string): Promise<any | null> {
    const result = await this.pool.query<{ id: string }>("SELECT id FROM manifests WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1", [runId]);
    return result.rows[0] ? this.getManifestById(result.rows[0].id) : null;
  }

  async createPublicationVolume(input: PublicationVolumeInput): Promise<any> {
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO publication_volumes(id,manifest_id,volume_number,volume_count,start_position,end_position,status)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(manifest_id,volume_number) DO UPDATE SET volume_count=EXCLUDED.volume_count RETURNING *`,
      [id, input.manifestId, input.volumeNumber, input.volumeCount, input.startPosition, input.endPosition, input.status ?? "queued"],
    );
    return result.rows[0];
  }

  async updatePublicationVolume(id: string, patch: {
    status?: string;
    applePlaylistId?: string | null;
    appleShareUrl?: string | null;
    appendedCount?: number;
    attemptDelta?: number;
    lastError?: string | null;
    publishedAt?: Date | null;
  }): Promise<void> {
    const persistedLastError = sanitizeOptionalFailure(patch.lastError, "publication");
    const result = await this.pool.query(
      `UPDATE publication_volumes SET status=COALESCE($2,status),apple_playlist_id=CASE WHEN $3::boolean THEN $4 ELSE apple_playlist_id END,
       apple_share_url=CASE WHEN $5::boolean THEN $6 ELSE apple_share_url END,appended_count=COALESCE($7,appended_count),
       attempt=attempt+$8,last_error=CASE WHEN $9::boolean THEN $10 ELSE last_error END,
       published_at=CASE WHEN $11::boolean THEN $12 ELSE published_at END,updated_at=now() WHERE id=$1`,
      [id, patch.status ?? null, patch.applePlaylistId !== undefined, patch.applePlaylistId ?? null, patch.appleShareUrl !== undefined, patch.appleShareUrl ?? null, patch.appendedCount ?? null, patch.attemptDelta ?? 0, patch.lastError !== undefined, persistedLastError ?? null, patch.publishedAt !== undefined, patch.publishedAt ?? null],
    );
    if (!result.rowCount) throw new HttpError(404, "Publication volume not found", "publication_not_found");
  }

  async listPublicationVolumes(manifestId: string): Promise<any[]> {
    const result = await this.pool.query("SELECT * FROM publication_volumes WHERE manifest_id=$1 ORDER BY volume_number", [manifestId]);
    return result.rows.map((row) => ({
      id: row.id,
      manifestId: row.manifest_id,
      volumeNumber: row.volume_number,
      volumeCount: row.volume_count,
      startPosition: row.start_position,
      endPosition: row.end_position,
      status: row.status,
      applePlaylistId: row.apple_playlist_id,
      appleShareUrl: row.apple_share_url,
      appendedCount: row.appended_count,
      attempt: row.attempt,
      lastError: sanitizeOptionalFailure(row.last_error, "publication"),
    }));
  }

  async markPlaylistOrphan(input: { manifestId?: string | null; publicationVolumeId?: string | null; applePlaylistId: string; reason: string }): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      "INSERT INTO orphan_playlists(id,manifest_id,publication_volume_id,apple_playlist_id,reason) VALUES($1,$2,$3,$4,$5)",
      [id, input.manifestId ?? null, input.publicationVolumeId ?? null, input.applePlaylistId, sanitizeFailure(input.reason, "publication")],
    );
    return id;
  }

  async listOrphanPlaylists(): Promise<any[]> {
    const result = await this.pool.query("SELECT * FROM orphan_playlists WHERE cleaned_at IS NULL ORDER BY created_at DESC");
    return result.rows.map((row) => ({
      ...row,
      reason: sanitizeFailure(row.reason, "publication"),
    }));
  }

  async listWaitingPublicationManifests(): Promise<Array<{ manifestId: string; runId: string }>> {
    const result = await this.pool.query<{ id: string; run_id: string }>(
      `SELECT DISTINCT ON (m.run_id) m.id,m.run_id FROM manifests m
       JOIN research_runs r ON r.id=m.run_id
       WHERE r.status='waiting_for_apple_authorization' AND r.deleted_at IS NULL
       ORDER BY m.run_id,m.created_at DESC`,
    );
    return result.rows.map((row) => ({ manifestId: row.id, runId: row.run_id }));
  }

  /**
   * Queue one publication recovery for this exact authorization-validation
   * epoch. Completed, cancelled, and terminally failed recoveries are never
   * revived by a heartbeat; a later successful reauthorization uses a new
   * epoch and therefore a new durable job.
   */
  async enqueueWaitingPublicationRecovery(input: {
    manifestId: string;
    runId: string;
    dedupeKey: string;
  }): Promise<boolean> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO job_queue(id,run_id,kind,dedupe_key,payload_json,max_attempts)
       SELECT $1,m.run_id,'publication',$4,$5,3
       FROM manifests m JOIN research_runs r ON r.id=m.run_id
       WHERE m.id=$2 AND m.run_id=$3 AND r.status='waiting_for_apple_authorization' AND r.deleted_at IS NULL
       ON CONFLICT(kind,dedupe_key) DO NOTHING RETURNING id`,
      [randomUUID(), input.manifestId, input.runId, input.dedupeKey.slice(0, 160), { manifestId: input.manifestId }],
    );
    return Boolean(result.rowCount);
  }

  /**
   * Atomically transitions a locked manifest into publication and creates its
   * durable job. The run row is the serialization boundary, so a retry that
   * races with the worker can never move a terminal run back to `publishing`.
   */
  async queueManifestPublication(input: {
    runId: string;
    manifestId: string;
    appleAuthorized: boolean;
    clientBucket: string;
    clientBucketAliases: string[];
    rateLimit?: number;
  }): Promise<PublicationQueueResult> {
    return this.transaction(async (client) => {
      const runResult = await client.query<{ status: string; phase: string }>(
        "SELECT status,phase FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [input.runId],
      );
      const run = runResult.rows[0];
      if (!run) throw new HttpError(404, "Research run not found", "run_not_found");

      const manifest = await client.query<{ id: string }>(
        "SELECT id FROM manifests WHERE id=$1 AND run_id=$2",
        [input.manifestId, input.runId],
      );
      if (!manifest.rows[0]) throw new HttpError(409, "Lock a manifest before publishing", "manifest_not_ready");

      const dedupeKey = `publication:${input.manifestId}`;
      const existingJob = await client.query<{ id: string; status: string }>(
        `SELECT id,status FROM job_queue
         WHERE kind='publication' AND run_id=$1 AND payload_json->>'manifestId'=$2
         ORDER BY CASE
           WHEN status IN ('queued','retry','leased') THEN 0
           WHEN status IN ('failed','cancelled') THEN 1
           ELSE 2 END,created_at DESC
         LIMIT 1 FOR UPDATE`,
        [input.runId, input.manifestId],
      );
      const job = existingJob.rows[0] ?? null;

      if (["complete", "partial"].includes(run.status)) {
        return { queued: false, state: "terminal", runStatus: run.status, jobId: job?.id ?? null };
      }
      if (run.status === "waiting_for_apple_authorization") {
        return {
          queued: false,
          state: "waiting_for_apple_authorization",
          runStatus: run.status,
          jobId: job?.id ?? null,
        };
      }
      if (job && ["queued", "retry", "leased"].includes(job.status)) {
        if (run.status !== "publishing") {
          await client.query(
            "UPDATE research_runs SET status='publishing',phase='publication_queued',error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1",
            [input.runId],
          );
        }
        return { queued: false, state: "in_flight", runStatus: "publishing", jobId: job.id };
      }
      if (job?.status === "complete") {
        // A completed worker job must have committed the terminal run state
        // first. Refuse to regress an inconsistent legacy row; the health and
        // owner surfaces can expose it for repair without creating duplicates.
        throw new HttpError(409, "Publication already completed; refresh the run result", "publication_already_complete");
      }

      if (!input.appleAuthorized) {
        await client.query(
          "UPDATE research_runs SET status='waiting_for_apple_authorization',phase='apple_authorization',error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1",
          [input.runId],
        );
        return {
          queued: false,
          state: "waiting_for_apple_authorization",
          runStatus: "waiting_for_apple_authorization",
          jobId: job?.id ?? null,
        };
      }

      const retryableFailure = run.status === "failed" && run.phase === "publication_failed";
      if (run.status !== "manifest_ready" && run.status !== "publishing" && !retryableFailure) {
        throw new HttpError(409, "Run is not ready for publication", "publication_not_ready");
      }

      const aliases = [...new Set(input.clientBucketAliases)].sort();
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`rate:publish:${aliases.join(":")}`]);
      const rate = await client.query<{ count: number }>(
        "SELECT count(*)::int count FROM rate_limit_events WHERE client_bucket=ANY($1::text[]) AND action='publish' AND occurred_at>now()-interval '24 hours'",
        [aliases],
      );
      if (rate.rows[0]!.count >= (input.rateLimit ?? 10)) {
        throw new HttpError(429, "Publication limit reached; try again later", "rate_limited");
      }

      const jobId = job?.id ?? randomUUID();
      if (job) {
        await client.query(
          `UPDATE job_queue SET run_id=$2,payload_json=$3,status='queued',attempts=0,max_attempts=3,
             available_at=now(),lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,completed_at=NULL,updated_at=now()
           WHERE id=$1 AND status IN ('failed','cancelled')`,
          [jobId, input.runId, { runId: input.runId, manifestId: input.manifestId }],
        );
      } else {
        await client.query(
          `INSERT INTO job_queue(id,run_id,kind,dedupe_key,payload_json,max_attempts)
           VALUES($1,$2,'publication',$3,$4,3)`,
          [jobId, input.runId, dedupeKey, { runId: input.runId, manifestId: input.manifestId }],
        );
      }
      await client.query("INSERT INTO rate_limit_events(client_bucket,action) VALUES($1,'publish')", [input.clientBucket]);
      await client.query(
        "UPDATE research_runs SET status='publishing',phase='publication_queued',error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1",
        [input.runId],
      );
      return { queued: true, state: "queued", runStatus: "publishing", jobId };
    });
  }

  async enqueueJob(input: {
    kind: string;
    runId?: string | null;
    briefRequestId?: string | null;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
    availableAt?: Date;
    maxAttempts?: number;
  }): Promise<{ id: string; created: boolean }> {
    const id = randomUUID();
    const dedupeKey = input.dedupeKey ?? input.runId ?? input.briefRequestId ?? randomUUID();
    const result = await this.pool.query<{ id: string; inserted: boolean }>(
      `INSERT INTO job_queue(id,run_id,brief_request_id,kind,dedupe_key,payload_json,available_at,max_attempts)
       VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now()),$8)
       ON CONFLICT(kind,dedupe_key) DO UPDATE SET
         run_id=EXCLUDED.run_id,
         brief_request_id=EXCLUDED.brief_request_id,
         payload_json=EXCLUDED.payload_json,
         status='queued',
         attempts=0,
         max_attempts=EXCLUDED.max_attempts,
         available_at=EXCLUDED.available_at,
         lease_owner=NULL,
         lease_expires_at=NULL,
         last_error=NULL,
         completed_at=NULL,
         updated_at=now()
       WHERE job_queue.status IN ('failed','cancelled')
          OR (job_queue.status='complete' AND EXCLUDED.kind='apple_authorization')
       RETURNING id,(xmax=0) AS inserted`,
      [id, input.runId ?? null, input.briefRequestId ?? null, input.kind, dedupeKey.slice(0, 160), input.payload ?? {}, input.availableAt ?? null, input.maxAttempts ?? 3],
    );
    if (result.rows[0]) return { id: result.rows[0].id, created: result.rows[0].inserted };
    const existing = await this.pool.query<{ id: string }>("SELECT id FROM job_queue WHERE kind=$1 AND dedupe_key=$2", [input.kind, dedupeKey.slice(0, 160)]);
    return { id: existing.rows[0]!.id, created: false };
  }

  async leaseNextJob(workerId: string, leaseMs: number): Promise<JobView | null> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [JOB_ADVISORY_LOCK]);
      const exhausted = await client.query<{ run_id: string | null; brief_request_id: string | null; kind: string; payload_json: Record<string, unknown> | null }>(
        `UPDATE job_queue SET status='failed',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,
         last_error=CASE kind
           WHEN 'brief' THEN $1
           WHEN 'research' THEN $2
           WHEN 'matching' THEN $3
           WHEN 'publication' THEN $4
           WHEN 'notification' THEN $5
           WHEN 'apple_authorization' THEN $6
           ELSE $7 END,
         updated_at=now()
         WHERE status='leased' AND lease_expires_at<=now() AND attempts>=max_attempts
         RETURNING run_id,brief_request_id,kind,payload_json`,
        [
          sanitizeFailure(null, "brief"),
          sanitizeFailure(null, "research"),
          sanitizeFailure(null, "matching"),
          sanitizeFailure("Worker lease expired after the final attempt", "publication"),
          sanitizeFailure(null, "notification"),
          sanitizeFailure(null, "apple_authorization"),
          sanitizeFailure(null, "background"),
        ],
      );
      for (const job of exhausted.rows) {
        if (job.kind === "apple_authorization") {
          const authorization = await client.query<{ ciphertext: string; key_version: string }>(
            "SELECT ciphertext,key_version FROM apple_authorizations WHERE id='owner' FOR UPDATE",
          );
          const row = authorization.rows[0];
          const expectedGeneration = typeof job.payload_json?.authorizationGeneration === "string"
            ? job.payload_json.authorizationGeneration
            : null;
          if (row && expectedGeneration === appleAuthorizationGeneration({
            ciphertext: row.ciphertext,
            keyVersion: row.key_version,
          })) {
            await client.query(
              `UPDATE apple_authorizations SET status='validation_failed',last_error=$1,updated_at=now()
               WHERE id='owner' AND status<>'valid'`,
              [sanitizeFailure(null, "apple_authorization")],
            );
          }
        }
        const recoveryFailure = Boolean(job.run_id && job.kind === "matching" && isCatalogRecoveryJob(job.payload_json));
        if (recoveryFailure) {
          await settleCatalogRecoveryFailure(
            client,
            job.run_id!,
            catalogRecoveryGeneration(job.payload_json),
          );
        } else if (job.run_id && ["research", "matching", "publication"].includes(job.kind)) {
          await client.query(
            `UPDATE research_runs SET status='failed',phase=$2,error=$3,
             completed_at=COALESCE(completed_at,now()),updated_at=now()
             WHERE id=$1 AND status NOT IN ('complete','partial','failed','expired','deleted','waiting_for_apple_authorization')`,
            [job.run_id, `${job.kind}_failed`, sanitizeFailure(
              job.kind === "publication" ? "Worker lease expired after the final attempt" : null,
              failureContextForJob(job.kind),
            )],
          );
        }
        if (job.brief_request_id && job.kind === "brief") {
          await client.query(
            "UPDATE brief_requests SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status<>'complete'",
            [job.brief_request_id, sanitizeFailure(null, "brief")],
          );
        }
        if (job.kind === "publication") {
          await markTerminalPublicationVolumes(client, job.payload_json, "Worker lease expired after the final attempt");
        }
        const notificationId = job.kind === "notification" && typeof job.payload_json?.notificationId === "string"
          ? job.payload_json.notificationId
          : null;
        if (notificationId) {
          await client.query(
            `UPDATE notification_outbox SET status='failed',last_error=$2,updated_at=now()
             WHERE id=$1 AND status<>'sent'`,
            [notificationId, sanitizeFailure(null, "notification")],
          );
        }
      }
      const capacity = Math.max(1, Math.min(Number(process.env.WORKER_CONCURRENCY ?? process.env.MAX_WORKER_JOBS ?? 2), 10));
      const active = await client.query<{ count: number }>("SELECT count(*)::int count FROM job_queue WHERE status='leased' AND lease_expires_at>now()");
      if (active.rows[0]!.count >= capacity) return null;
      // Brief and explicitly marked fast jobs normally lead the queue. Once an
      // operational job has been runnable for 30 seconds it is promoted above
      // that lane, preventing an endless stream of fast jobs from starving it.
      const selected = await client.query(
        `SELECT candidate.* FROM job_queue candidate WHERE
           ((candidate.status='queued' AND candidate.available_at<=now()) OR (candidate.status='leased' AND candidate.lease_expires_at<=now()))
           AND NOT (candidate.kind IN ('brief','research','matching') AND COALESCE((SELECT value='true' FROM settings WHERE key='research_paused'),false))
           AND NOT (candidate.kind='publication' AND COALESCE((SELECT value='true' FROM settings WHERE key='publishing_paused'),false))
           AND NOT (
             candidate.kind='publication'
             AND candidate.payload_json->>'manifestId' IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM job_queue active_publication
               WHERE active_publication.id<>candidate.id
                 AND active_publication.kind='publication'
                 AND active_publication.status='leased'
                 AND active_publication.lease_expires_at>now()
               AND active_publication.payload_json->>'manifestId'=candidate.payload_json->>'manifestId'
             )
           )
           AND NOT (
             candidate.kind IN ('research','matching')
             AND NOT (candidate.payload_json @> '{"fast":true}'::jsonb)
             AND EXISTS (
               SELECT 1 FROM job_queue active_deep
               WHERE active_deep.status='leased'
                 AND active_deep.lease_expires_at>now()
                 AND active_deep.kind IN ('research','matching')
                 AND NOT (active_deep.payload_json @> '{"fast":true}'::jsonb)
             )
           )
           AND candidate.attempts<candidate.max_attempts
           ORDER BY CASE
             WHEN candidate.kind NOT IN ('brief','research','matching')
               AND candidate.available_at<=now()-interval '30 seconds' THEN 0
             WHEN candidate.kind='matching'
               AND candidate.payload_json @> '{"fast":true}'::jsonb THEN 0
             WHEN candidate.kind='brief' THEN 1
             WHEN candidate.kind IN ('research','matching')
               AND candidate.payload_json @> '{"fast":true}'::jsonb THEN 1
             ELSE 2
           END,
           candidate.available_at,candidate.created_at FOR UPDATE OF candidate SKIP LOCKED LIMIT 1`,
      );
      const job = selected.rows[0];
      if (!job) return null;
      const expiresAt = new Date(Date.now() + Math.max(30_000, leaseMs));
      const updated = await client.query(
        `UPDATE job_queue SET status='leased',lease_owner=$2,lease_expires_at=$3,attempts=attempts+1,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [job.id, workerId, expiresAt],
      );
      const row = updated.rows[0];
      return { id: row.id, runId: row.run_id, briefRequestId: row.brief_request_id, kind: row.kind, payload: row.payload_json ?? {}, attempts: row.attempts, maxAttempts: row.max_attempts, leaseOwner: row.lease_owner, leaseExpiresAt: date(row.lease_expires_at) };
    });
  }

  async renewJobLease(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE job_queue SET lease_expires_at=$3,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status='leased' AND lease_expires_at>now()",
      [jobId, workerId, new Date(Date.now() + Math.max(30_000, leaseMs))],
    );
    return Boolean(result.rowCount);
  }

  async deferJob(jobId: string, workerId: string, availableAt: Date, reason: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE job_queue SET status='queued',attempts=GREATEST(0,attempts-1),available_at=$3,
       lease_owner=NULL,lease_expires_at=NULL,last_error=$4,completed_at=NULL,updated_at=now()
       WHERE id=$1 AND lease_owner=$2 AND status='leased'`,
      [jobId, workerId, availableAt, sanitizeFailure(reason, "background")],
    );
    if (!result.rowCount) throw new HttpError(409, "Job lease was lost", "job_lease_lost");
  }

  async cancelLeasedJob(jobId: string, workerId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE job_queue SET status='cancelled',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,
       last_error=$3,updated_at=now()
       WHERE id=$1 AND lease_owner=$2 AND status='leased'`,
      [jobId, workerId, sanitizeFailure(reason, "background")],
    );
  }

  async completeJob(jobId: string, workerId: string): Promise<void> {
    await this.transaction(async (client) => {
      const current = await client.query<{
        run_id: string | null;
        kind: string;
        payload_json: Record<string, unknown> | null;
      }>(
        "SELECT run_id,kind,payload_json FROM job_queue WHERE id=$1 AND lease_owner=$2 AND status='leased' FOR UPDATE",
        [jobId, workerId],
      );
      if (!current.rows[0]) throw new HttpError(409, "Job lease was lost", "job_lease_lost");
      const job = current.rows[0];
      if (job.run_id && job.kind === "matching" && isCatalogRecoveryJob(job.payload_json)
        && catalogRecoveryGeneration(job.payload_json) >= 3) {
        await settleCatalogRecoveryFailure(client, job.run_id, 3);
      }
      await client.query(
        `UPDATE job_queue SET status='complete',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
         WHERE id=$1 AND lease_owner=$2 AND status='leased'`,
        [jobId, workerId],
      );
    });
  }

  async failJob(jobId: string, workerId: string, error: string, retryAt: Date | null = null): Promise<void> {
    await this.transaction(async (client) => {
      const current = await client.query<{ attempts: number; max_attempts: number; run_id: string | null; brief_request_id: string | null; kind: string; payload_json: Record<string, unknown> | null }>(
        "SELECT attempts,max_attempts,run_id,brief_request_id,kind,payload_json FROM job_queue WHERE id=$1 AND lease_owner=$2 AND status='leased' FOR UPDATE",
        [jobId, workerId],
      );
      if (!current.rows[0]) throw new HttpError(409, "Job lease was lost", "job_lease_lost");
      const retry = retryAt && current.rows[0].attempts < current.rows[0].max_attempts;
      const context = failureContextForJob(current.rows[0].kind);
      const persistedError = sanitizeFailure(error, context);
      await client.query(
        `UPDATE job_queue SET status=$3::varchar,available_at=COALESCE($4::timestamptz,available_at),last_error=$5,
         completed_at=CASE WHEN $3::varchar='failed' THEN now() ELSE NULL END,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
         WHERE id=$1 AND lease_owner=$2`,
        [jobId, workerId, retry ? "queued" : "failed", retry ? retryAt : null, persistedError],
      );
      if (!retry && current.rows[0].kind === "apple_authorization") {
        const authorization = await client.query<{ ciphertext: string; key_version: string }>(
          "SELECT ciphertext,key_version FROM apple_authorizations WHERE id='owner' FOR UPDATE",
        );
        const row = authorization.rows[0];
        const expectedGeneration = typeof current.rows[0].payload_json?.authorizationGeneration === "string"
          ? current.rows[0].payload_json.authorizationGeneration
          : null;
        if (row && expectedGeneration === appleAuthorizationGeneration({
          ciphertext: row.ciphertext,
          keyVersion: row.key_version,
        })) {
          await client.query(
            `UPDATE apple_authorizations SET status='validation_failed',last_error=$1,updated_at=now()
             WHERE id='owner' AND status<>'valid'`,
            [persistedError],
          );
        }
      }
      const recoveryFailure = !retry
        && Boolean(current.rows[0].run_id)
        && current.rows[0].kind === "matching"
        && isCatalogRecoveryJob(current.rows[0].payload_json);
      if (recoveryFailure) {
        await settleCatalogRecoveryFailure(
          client,
          current.rows[0].run_id!,
          catalogRecoveryGeneration(current.rows[0].payload_json),
        );
      } else if (!retry && current.rows[0].run_id && ["research", "matching", "publication"].includes(current.rows[0].kind)) {
        await client.query(
          `UPDATE research_runs SET status='failed',phase=$2,error=$3,completed_at=COALESCE(completed_at,now()),updated_at=now()
           WHERE id=$1 AND status NOT IN ('complete','partial','failed','expired','deleted','waiting_for_apple_authorization')`,
          [current.rows[0].run_id, `${current.rows[0].kind}_failed`, persistedError.slice(0, 2_000)],
        );
      }
      if (!retry && current.rows[0].kind === "publication") {
        await markTerminalPublicationVolumes(client, current.rows[0].payload_json, error);
      }
      if (!retry && current.rows[0].brief_request_id && current.rows[0].kind === "brief") {
        await client.query(
          "UPDATE brief_requests SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status<>'complete'",
          [current.rows[0].brief_request_id, sanitizeFailure(error, "brief")],
        );
      }
      const notificationId = !retry && current.rows[0].kind === "notification" && typeof current.rows[0].payload_json?.notificationId === "string"
        ? current.rows[0].payload_json.notificationId
        : null;
      if (notificationId) {
        await client.query(
          "UPDATE notification_outbox SET status='failed',last_error=$2,updated_at=now() WHERE id=$1 AND status<>'sent'",
          [notificationId, sanitizeFailure(error, "notification")],
        );
      }
    });
  }

  async updateWorkerHeartbeat(workerId: string, metadata: { schemaVersion?: string; capacity?: number; activeJobs?: number; [key: string]: unknown }): Promise<void> {
    const { schemaVersion = DATABASE_SCHEMA_VERSION, capacity = 1, activeJobs = 0, ...rest } = metadata;
    await this.pool.query(
      `INSERT INTO worker_heartbeats(worker_id,schema_version,capacity,active_jobs,metadata_json)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(worker_id) DO UPDATE SET schema_version=EXCLUDED.schema_version,
       capacity=EXCLUDED.capacity,active_jobs=EXCLUDED.active_jobs,metadata_json=EXCLUDED.metadata_json,last_seen_at=now()`,
      [workerId, schemaVersion, capacity, activeJobs, rest],
    );
  }

  async getResearchCheckpoint(runId: string, phase: string): Promise<unknown | null> {
    const result = await this.pool.query<{ state_json: unknown }>("SELECT state_json FROM research_checkpoints WHERE run_id=$1 AND phase=$2", [runId, phase]);
    return result.rows[0]?.state_json ?? null;
  }

  async saveResearchCheckpoint(runId: string, phase: string, state: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO research_checkpoints(run_id,phase,state_json) VALUES($1,$2,$3)
       ON CONFLICT(run_id,phase) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=now()`,
      [runId, phase, state],
    );
  }

  async consumeRateLimit(clientBucketAliases: string[], action: string, limit: number, windowHours = 24): Promise<{ remaining: number }> {
    const primary = clientBucketAliases[0];
    if (!primary) throw new HttpError(401, "Client bucket is required", "invalid_gateway_identity");
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`rate:${action}:${clientBucketAliases.join(":")}`]);
      const count = await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM rate_limit_events
         WHERE client_bucket=ANY($1::text[]) AND action=$2 AND occurred_at>now()-($3::text || ' hours')::interval`,
        [clientBucketAliases, action, String(windowHours)],
      );
      if (count.rows[0]!.count >= limit) throw new HttpError(429, "Rate limit reached; try again later", "rate_limited");
      await client.query("INSERT INTO rate_limit_events(client_bucket,action) VALUES($1,$2)", [primary, action]);
      return { remaining: Math.max(0, limit - count.rows[0]!.count - 1) };
    });
  }

  async assertGlobalRunCapacity(limit = 10): Promise<void> {
    const result = await this.pool.query<{ count: number }>("SELECT count(*)::int count FROM research_runs WHERE status=ANY($1::text[]) AND deleted_at IS NULL", [ACTIVE_RUN_STATUSES]);
    if (result.rows[0]!.count >= limit) throw new HttpError(503, "gênio is at capacity; try again soon", "global_capacity_reached");
  }

  async claimGatewayNonce(keyId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const result = await this.transaction(async (client) => {
      await client.query("DELETE FROM gateway_nonces WHERE expires_at<now()");
      return client.query(
        "INSERT INTO gateway_nonces(key_id,nonce,expires_at) VALUES($1,$2,$3) ON CONFLICT(key_id,nonce) DO NOTHING RETURNING nonce",
        [keyId, nonce, expiresAt],
      );
    });
    return Boolean(result.rows[0]);
  }

  async createCapabilityToken(runId: string, accessId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      "INSERT INTO capability_tokens(id,run_id,access_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), runId, accessId, tokenHash, expiresAt],
    );
  }

  async exchangeCapabilityToken(tokenHash: string, session: {
    id: string;
    tokenHash?: string;
    expiresAt?: Date;
    reuseExisting?: boolean;
  }): Promise<any | null> {
    return this.transaction(async (client) => {
      const token = await client.query<{ id: string; run_id: string; access_id: string }>(
        `SELECT id,run_id,access_id FROM capability_tokens WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
        [tokenHash],
      );
      if (!token.rows[0]) return null;
      const access = await client.query(
        "SELECT 1 FROM run_accesses WHERE id=$1 AND deleted_at IS NULL AND expires_at>now() FOR KEY SHARE",
        [token.rows[0].access_id],
      );
      if (!access.rows[0]) return null;
      let expiresAt: Date;
      if (session.reuseExisting) {
        const existing = await client.query<{ expires_at: Date }>(
          `SELECT s.expires_at FROM capability_sessions s
           WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
             AND EXISTS (
               SELECT 1 FROM capability_session_accesses csa
               JOIN run_accesses a ON a.id=csa.access_id AND a.run_id=csa.run_id
               WHERE csa.session_id=s.id AND a.deleted_at IS NULL AND a.expires_at>now()
             )
           FOR UPDATE`,
          [session.id],
        );
        if (!existing.rows[0]) return null;
        expiresAt = date(existing.rows[0].expires_at)!;
      } else {
        if (!session.tokenHash || !session.expiresAt) throw new Error("New capability sessions require a token and expiry");
        expiresAt = session.expiresAt;
        await client.query(
          "INSERT INTO capability_sessions(id,run_id,access_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)",
          [session.id, token.rows[0].run_id, token.rows[0].access_id, session.tokenHash, expiresAt],
        );
      }
      await client.query("UPDATE capability_tokens SET consumed_at=now() WHERE id=$1", [token.rows[0].id]);
      await this.attachCapabilitySessionAccess(client, session.id, token.rows[0].run_id, token.rows[0].access_id);
      return { id: session.id, runId: token.rows[0].run_id, accessId: token.rows[0].access_id, expiresAt };
    });
  }

  async getCapabilitySession(tokenHash: string): Promise<any | null> {
    const result = await this.pool.query(
      `WITH live_session AS (
         UPDATE capability_sessions s SET last_seen_at=now(),updated_at=now()
         WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
           AND EXISTS (
             SELECT 1 FROM capability_session_accesses csa
             JOIN run_accesses a ON a.id=csa.access_id AND a.run_id=csa.run_id
             JOIN research_runs r ON r.id=csa.run_id
             WHERE csa.session_id=s.id
               AND a.deleted_at IS NULL AND a.expires_at>now() AND r.deleted_at IS NULL
           )
         RETURNING s.id,s.expires_at
       )
       SELECT ls.id,aa.run_id,aa.access_id,ls.expires_at
       FROM live_session ls
       JOIN LATERAL (
         SELECT csa.run_id,csa.access_id
         FROM capability_session_accesses csa
         JOIN run_accesses a ON a.id=csa.access_id AND a.run_id=csa.run_id
         JOIN research_runs r ON r.id=csa.run_id
         WHERE csa.session_id=ls.id
           AND a.deleted_at IS NULL AND a.expires_at>now() AND r.deleted_at IS NULL
         ORDER BY csa.created_at DESC,csa.access_id DESC LIMIT 1
       ) aa ON true`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? { id: row.id, runId: row.run_id, accessId: row.access_id, expiresAt: date(row.expires_at)! } : null;
  }

  async getCapabilitySessionAccess(sessionId: string, accessId: string): Promise<{ runId: string; accessId: string } | null> {
    const result = await this.pool.query<{ run_id: string; access_id: string }>(
      `SELECT csa.run_id,csa.access_id
       FROM capability_session_accesses csa
       JOIN capability_sessions s ON s.id=csa.session_id
       JOIN run_accesses a ON a.id=csa.access_id AND a.run_id=csa.run_id
       JOIN research_runs r ON r.id=csa.run_id
       WHERE csa.session_id=$1 AND csa.access_id=$2
         AND s.revoked_at IS NULL AND s.expires_at>now()
         AND a.deleted_at IS NULL AND a.expires_at>now()
         AND r.deleted_at IS NULL`,
      [sessionId, accessId],
    );
    return result.rows[0]
      ? { runId: result.rows[0].run_id, accessId: result.rows[0].access_id }
      : null;
  }

  async revokeCapabilitySession(sessionId: string): Promise<void> {
    await this.pool.query("UPDATE capability_sessions SET revoked_at=now(),updated_at=now() WHERE id=$1", [sessionId]);
  }

  async reserveProviderCost(subjectOrRunId: CostSubject | string | null, operation: string, maxUsd: number): Promise<{ reservationId: string }> {
    const subject: CostSubject = typeof subjectOrRunId === "string" ? { runId: subjectOrRunId } : subjectOrRunId ?? {};
    const amount = finiteMoney(maxUsd, "Reserved cost");
    if (!subject.runId && !subject.briefRequestId) throw new HttpError(400, "Cost reservation requires a run or brief", "invalid_cost_subject");
    const idempotencyKey = sha256Hex(`${subject.runId ?? ""}\n${subject.briefRequestId ?? ""}\n${operation}`);
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [BUDGET_ADVISORY_LOCK]);
      const expired = await client.query<{ run_id: string | null; reserved_usd: string }>(
        "UPDATE cost_reservations SET status='released',reconciled_at=now() WHERE status='reserved' AND expires_at<=now() RETURNING run_id,reserved_usd",
      );
      for (const item of expired.rows) {
        if (item.run_id) await client.query("UPDATE research_runs SET reserved_cost_usd=GREATEST(0,reserved_cost_usd-$2),updated_at=now() WHERE id=$1", [item.run_id, Number(item.reserved_usd)]);
      }
      const existing = await client.query<{ id: string; status: string }>("SELECT id,status FROM cost_reservations WHERE idempotency_key=$1 FOR UPDATE", [idempotencyKey]);
      if (existing.rows[0] && existing.rows[0].status !== "released") return { reservationId: existing.rows[0].id };
      const monthly = await client.query<{ spent: number; reserved: number }>(
        `SELECT
          COALESCE((SELECT sum(amount_usd) FROM cost_ledger WHERE occurred_at >= date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'),0)::float8 spent,
          COALESCE((SELECT sum(reserved_usd) FROM cost_reservations WHERE status='reserved' AND expires_at>now()),0)::float8 reserved`,
      );
      const ceiling = readCostConfiguration().monthlyCostLimitUsd;
      if (monthly.rows[0]!.spent + monthly.rows[0]!.reserved + amount > ceiling) {
        throw new HttpError(402, "Monthly research budget has been reached", "monthly_budget_reached");
      }
      if (subject.runId) {
        const run = await client.query("SELECT actual_cost_usd,reserved_cost_usd,approved_budget_usd FROM research_runs WHERE id=$1 FOR UPDATE", [subject.runId]);
        if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
        const projected = Number(run.rows[0].actual_cost_usd) + Number(run.rows[0].reserved_cost_usd) + amount;
        if (projected > Number(run.rows[0].approved_budget_usd)) throw new HttpError(402, "Run needs additional budget approval", "run_budget_reached");
      }
      const id = existing.rows[0]?.id ?? randomUUID();
      if (existing.rows[0]) {
        await client.query(
          `UPDATE cost_reservations SET status='reserved',reserved_usd=$2,actual_usd=NULL,usage_json=NULL,expires_at=now()+interval '30 minutes',reconciled_at=NULL WHERE id=$1`,
          [id, amount],
        );
      } else {
        await client.query(
          `INSERT INTO cost_reservations(id,run_id,brief_request_id,operation,idempotency_key,reserved_usd,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 minutes')`,
          [id, subject.runId ?? null, subject.briefRequestId ?? null, operation.slice(0, 120), idempotencyKey, amount],
        );
      }
      if (subject.runId) await client.query("UPDATE research_runs SET reserved_cost_usd=reserved_cost_usd+$2,updated_at=now() WHERE id=$1", [subject.runId, amount]);
      return { reservationId: id };
    });
  }

  async reconcileProviderCost(reservationId: string, actualUsd: number, usage: unknown = null): Promise<void> {
    const actual = finiteMoney(actualUsd, "Actual cost");
    const overrun = await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [BUDGET_ADVISORY_LOCK]);
      const reservation = await client.query("SELECT * FROM cost_reservations WHERE id=$1 FOR UPDATE", [reservationId]);
      const row = reservation.rows[0];
      if (!row) throw new HttpError(404, "Cost reservation not found", "reservation_not_found");
      if (row.status === "reconciled" || row.status === "reconciled_overrun") return false;
      if (row.status !== "reserved") throw new HttpError(409, "Cost reservation is no longer active", "reservation_inactive");
      const reserved = Number(row.reserved_usd);
      const monthly = await client.query<{ spent: number; reserved: number }>(
        `SELECT
          COALESCE((SELECT sum(amount_usd) FROM cost_ledger WHERE occurred_at >= date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'),0)::float8 spent,
          COALESCE((SELECT sum(reserved_usd) FROM cost_reservations WHERE status='reserved'),0)::float8 reserved`,
      );
      const monthlyCeiling = readCostConfiguration().monthlyCostLimitUsd;
      const monthlyProjected = monthly.rows[0]!.spent + Math.max(0, monthly.rows[0]!.reserved - reserved) + actual;
      let runCeilingExceeded = false;
      if (row.run_id) {
        const run = await client.query(
          "SELECT actual_cost_usd,reserved_cost_usd,approved_budget_usd FROM research_runs WHERE id=$1 FOR UPDATE",
          [row.run_id],
        );
        if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
        const projected = Number(run.rows[0].actual_cost_usd)
          + Math.max(0, Number(run.rows[0].reserved_cost_usd) - reserved)
          + actual;
        runCeilingExceeded = projected > Number(run.rows[0].approved_budget_usd) + 0.000001;
      }
      const exceededCeiling = monthlyProjected > monthlyCeiling + 0.000001 || runCeilingExceeded;
      await client.query(
        "UPDATE cost_reservations SET status=$2,actual_usd=$3,usage_json=$4,reconciled_at=now() WHERE id=$1",
        [reservationId, exceededCeiling ? "reconciled_overrun" : "reconciled", actual, usage],
      );
      await client.query(
        `INSERT INTO cost_ledger(id,run_id,brief_request_id,reservation_id,operation,amount_usd,usage_json)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), row.run_id, row.brief_request_id, reservationId, row.operation, actual, usage],
      );
      if (row.run_id) {
        await client.query(
          `UPDATE research_runs SET
             reserved_cost_usd=GREATEST(0,reserved_cost_usd-$2),
             actual_cost_usd=actual_cost_usd+$3,
             status=CASE WHEN $4 THEN 'awaiting_budget' ELSE status END,
             error=CASE WHEN $4 THEN 'Actual provider usage crossed an approved cost ceiling; owner budget review is required before resuming.' ELSE error END,
             budget_approval_expires_at=CASE WHEN $4 THEN now()+interval '7 days' ELSE budget_approval_expires_at END,
             updated_at=now()
           WHERE id=$1`,
          [row.run_id, reserved, actual, exceededCeiling],
        );
      }
      return exceededCeiling;
    });
    if (overrun) {
      throw new HttpError(
        402,
        "Actual provider usage crossed an approved cost ceiling; further paid work is paused",
        "provider_cost_overrun",
      );
    }
  }

  async releaseProviderCost(reservationId: string): Promise<void> {
    await this.transaction(async (client) => {
      const reservation = await client.query("SELECT * FROM cost_reservations WHERE id=$1 FOR UPDATE", [reservationId]);
      const row = reservation.rows[0];
      if (!row || row.status !== "reserved") return;
      await client.query("UPDATE cost_reservations SET status='released',reconciled_at=now() WHERE id=$1", [reservationId]);
      if (row.run_id) await client.query("UPDATE research_runs SET reserved_cost_usd=GREATEST(0,reserved_cost_usd-$2),updated_at=now() WHERE id=$1", [row.run_id, Number(row.reserved_usd)]);
    });
  }

  async appendCostLedger(subject: CostSubject, operation: string, amountUsd: number, usage: unknown = null): Promise<void> {
    const amount = finiteMoney(amountUsd, "Cost");
    await this.transaction(async (client) => {
      await client.query(
        "INSERT INTO cost_ledger(id,run_id,brief_request_id,operation,amount_usd,usage_json) VALUES($1,$2,$3,$4,$5,$6)",
        [randomUUID(), subject.runId ?? null, subject.briefRequestId ?? null, operation.slice(0, 120), amount, usage],
      );
      if (subject.runId) await client.query("UPDATE research_runs SET actual_cost_usd=actual_cost_usd+$2,updated_at=now() WHERE id=$1", [subject.runId, amount]);
    });
  }

  async getAppleAuthorization(): Promise<any | null> {
    const result = await this.pool.query("SELECT * FROM apple_authorizations WHERE id='owner'");
    const row = result.rows[0];
    if (!row) return null;
    return {
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
      keyVersion: row.key_version,
      storefront: row.storefront,
      status: row.status,
      lastValidatedAt: date(row.last_validated_at),
      lastError: sanitizeOptionalFailure(row.last_error, "apple_authorization"),
      updatedAt: date(row.updated_at),
    };
  }

  async saveAppleAuthorization(input: EncryptedAppleAuthorizationInput): Promise<void> {
    const persistedLastError = sanitizeOptionalFailure(input.lastError, "apple_authorization");
    await this.pool.query(
      `INSERT INTO apple_authorizations(id,ciphertext,iv,auth_tag,key_version,storefront,status,last_validated_at,last_error)
       VALUES('owner',$1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,
       iv=EXCLUDED.iv,auth_tag=EXCLUDED.auth_tag,key_version=EXCLUDED.key_version,storefront=EXCLUDED.storefront,
       status=EXCLUDED.status,last_validated_at=EXCLUDED.last_validated_at,last_error=EXCLUDED.last_error,updated_at=now()`,
      [input.ciphertext, input.iv, input.authTag, input.keyVersion, input.storefront, input.status ?? "unverified", input.lastValidatedAt ?? null, persistedLastError],
    );
  }

  async setEncryptedAppleAuthorization(input: EncryptedAppleAuthorizationInput): Promise<void> {
    await this.saveAppleAuthorization(input);
  }

  async updateAppleAuthorizationStatus(status: string, lastError: string | null = null): Promise<void> {
    await this.pool.query(
      "UPDATE apple_authorizations SET status=$1::varchar,last_error=$2,last_validated_at=CASE WHEN $1::varchar='valid' THEN now() ELSE last_validated_at END,updated_at=now() WHERE id='owner'",
      [status, sanitizeOptionalFailure(lastError, "apple_authorization")],
    );
  }

  async updateAppleAuthorizationValidation(input: {
    expectedCiphertext: string;
    expectedKeyVersion: string;
    storefront?: string;
    status: "valid" | "reauthorization_required";
    lastError?: string | null;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE apple_authorizations SET storefront=COALESCE($3,storefront),status=$4::varchar,last_error=$5,
       last_validated_at=CASE WHEN $4::varchar='valid' THEN now() ELSE last_validated_at END,updated_at=now()
       WHERE id='owner' AND ciphertext=$1 AND key_version=$2`,
      [
        input.expectedCiphertext,
        input.expectedKeyVersion,
        input.storefront ?? null,
        input.status,
        sanitizeOptionalFailure(input.lastError, "apple_authorization"),
      ],
    );
    return Boolean(result.rowCount);
  }

  async revokeAppleAuthorization(): Promise<void> {
    await this.pool.query("DELETE FROM apple_authorizations WHERE id='owner'");
  }

  async enqueueNotification(kind: string, payload: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    const supplied = typeof payload.deduplicationKey === "string" ? payload.deduplicationKey : null;
    const dedupeKey = (supplied ?? `${kind}:${sha256Hex(stableStringify(payload))}`).slice(0, 200);
    return this.transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO notification_outbox(id,kind,dedupe_key,payload_json) VALUES($1,$2,$3,$4)
         ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
        [id, kind.slice(0, 80), dedupeKey, payload],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query<{ id: string }>("SELECT id FROM notification_outbox WHERE dedupe_key=$1", [dedupeKey]);
        return existing.rows[0]!.id;
      }
      await client.query(
        `INSERT INTO job_queue(id,kind,dedupe_key,payload_json) VALUES($1,'notification',$2,$3)
         ON CONFLICT(kind,dedupe_key) DO NOTHING`,
        [randomUUID(), `notification:${id}`, { notificationId: id }],
      );
      return id;
    });
  }

  async getNotification(id: string): Promise<any | null> {
    const result = await this.pool.query("SELECT * FROM notification_outbox WHERE id=$1", [id]);
    const row = result.rows[0];
    return row ? { id: row.id, kind: row.kind, payload: row.payload_json, status: row.status, attempts: row.attempts, availableAt: date(row.available_at), sentAt: date(row.sent_at)?.toISOString() ?? null, lastError: sanitizeOptionalFailure(row.last_error, "notification") } : null;
  }

  async markNotificationSent(id: string, providerId: string | null = null): Promise<void> {
    await this.pool.query(
      "UPDATE notification_outbox SET status='sent',sent_at=now(),provider_id=$2,last_error=NULL,updated_at=now() WHERE id=$1",
      [id, providerId?.slice(0, 200) ?? null],
    );
  }

  async markNotificationFailed(id: string, error: string, retryAt: Date | null): Promise<void> {
    await this.pool.query(
      `UPDATE notification_outbox SET status=$2,attempts=attempts+1,available_at=COALESCE($3,available_at),last_error=$4,updated_at=now() WHERE id=$1`,
      [id, retryAt ? "pending" : "failed", retryAt, sanitizeFailure(error, "notification")],
    );
  }

  async recordAudit(actor: string, action: string, detail: Record<string, unknown> = {}, runId: string | null = null): Promise<void> {
    await this.pool.query("INSERT INTO audit_events(run_id,actor,action,detail_json) VALUES($1,$2,$3,$4)", [runId, actor.slice(0, 80), action.slice(0, 120), detail]);
  }

  async listAwaitingBudgets(): Promise<any[]> {
    await this.pool.query(
      `UPDATE research_runs SET status='expired',phase='budget_approval_expired',error='Budget approval expired after seven days',completed_at=now(),updated_at=now()
       WHERE status='awaiting_budget' AND budget_approval_expires_at<=now()`,
    );
    const result = await this.pool.query(
      `SELECT id,brief_json,estimated_cost_usd,actual_cost_usd,reserved_cost_usd,approved_budget_usd,
              budget_approval_expires_at,created_at
       FROM research_runs WHERE status='awaiting_budget' AND budget_approval_expires_at>now() AND deleted_at IS NULL ORDER BY created_at`,
    );
    const monthlyCeiling = readCostConfiguration().monthlyCostLimitUsd;
    return result.rows.map((row) => ({
      id: row.id,
      brief: row.brief_json,
      estimatedCostUsd: Number(row.estimated_cost_usd),
      actualCostUsd: Number(row.actual_cost_usd),
      approvedBudgetUsd: Number(row.approved_budget_usd),
      requestedBudgetUsd: Math.min(
        monthlyCeiling,
        Math.max(
          Number(row.estimated_cost_usd),
          Number(row.approved_budget_usd) * 2,
          Number(row.actual_cost_usd) + Number(row.reserved_cost_usd) + 5,
        ),
      ),
      expiresAt: date(row.budget_approval_expires_at)?.toISOString(),
      createdAt: date(row.created_at)?.toISOString(),
    }));
  }

  async listRecentRuns(limit = 50): Promise<Array<{
    id: string;
    title: string;
    status: string;
    phase: string;
    completedAt: string | null;
    createdAt: string;
  }>> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 100)) : 50;
    const result = await this.pool.query(
      `SELECT id,brief_json->>'title' title,status,phase,completed_at,created_at
       FROM research_runs WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1`,
      [safeLimit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title || "Untitled run",
      status: row.status,
      phase: row.phase,
      completedAt: date(row.completed_at)?.toISOString() ?? null,
      createdAt: date(row.created_at)!.toISOString(),
    }));
  }

  async invalidateRunReuse(runId: string, actor: string): Promise<{ briefHash: string; invalidatedAt: string }> {
    return this.transaction(async (client) => {
      const initial = await client.query<{ brief_hash: string }>(
        "SELECT brief_hash FROM research_runs WHERE id=$1 AND deleted_at IS NULL",
        [runId],
      );
      if (!initial.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`brief:${initial.rows[0].brief_hash}`]);
      const run = await client.query<{ brief_hash: string }>(
        "SELECT brief_hash FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [runId],
      );
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      const timestamp = await client.query<{ invalidated_at: Date }>("SELECT clock_timestamp() invalidated_at");
      const invalidatedAt = timestamp.rows[0]!.invalidated_at.toISOString();
      await client.query(
        `INSERT INTO settings(key,value) VALUES($1,$2)
         ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
        [`reuse_not_before:${run.rows[0].brief_hash}`, invalidatedAt],
      );
      await client.query(
        "INSERT INTO audit_events(run_id,actor,action,detail_json) VALUES($1,$2,$3,$4)",
        [runId, actor.slice(0, 80), "run.cache_invalidated", { invalidatedAt }],
      );
      return { briefHash: run.rows[0].brief_hash, invalidatedAt };
    });
  }

  async importOwnerCatalog(input: {
    runId: string;
    actor: string;
    importHash: string;
    sources: SourceRecordInput[];
    candidates: TrackCandidateInput[];
  }): Promise<{ newlyAdded: number }> {
    return this.transaction(async (client) => {
      const pause = await client.query<{ value: string }>(
        "SELECT value FROM settings WHERE key='research_paused' FOR UPDATE",
      );
      if (pause.rows[0]?.value !== "true") {
        throw new HttpError(409, "Pause research before importing a specialist catalogue", "catalog_import_requires_pause");
      }
      const result = await client.query<{ status: string; phase: string; brief_json: PlaylistBrief; leased: boolean; locked: boolean }>(
        `SELECT r.status,r.phase,r.brief_json,
          EXISTS(SELECT 1 FROM job_queue j WHERE j.run_id=r.id AND j.status='leased') leased,
          EXISTS(SELECT 1 FROM manifests m WHERE m.run_id=r.id) locked
         FROM research_runs r WHERE r.id=$1 AND r.deleted_at IS NULL FOR UPDATE OF r`,
        [input.runId],
      );
      const run = result.rows[0];
      if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
      if (run.locked) throw new HttpError(409, "The immutable manifest is already locked", "manifest_already_locked");
      if (run.leased) throw new HttpError(409, "Wait for the active worker lease to stop before importing", "run_not_quiescent");
      if (!["queued", "awaiting_budget", "researching", "ready_for_matching"].includes(run.status)) {
        throw new HttpError(409, "Catalogue imports are allowed only before matching begins", "catalog_import_too_late");
      }

      const candidates = input.candidates.map((candidate) => ({
        ...candidate,
        evidence: candidate.evidence.map((claim) => {
          if (claim.subjectEntity.trim() || claim.subjectRelationship.trim()) return claim;
          if (run.brief_json.subjectEntities.length !== 1) {
            throw new HttpError(
              400,
              "Multi-subject catalogue imports must name the confirmed subject and relationship",
              "evidence_subject_mismatch",
            );
          }
          return {
            ...claim,
            subjectEntity: run.brief_json.subjectEntities[0]!,
            subjectRelationship: run.brief_json.relationship,
          };
        }),
      }));

      const sourceIds = await this.addSourcesInTransaction(client, input.runId, input.sources);
      const newlyAdded = await this.addCandidatesInTransaction(client, input.runId, candidates, sourceIds, "unverified");
      await this.upsertFrontierInTransaction(client, input.runId, [{
        sourceClass: "import",
        strategy: `owner catalogue ${input.importHash.slice(0, 16)}`,
        cursor: null,
        status: "complete",
        discoveredCount: input.candidates.length,
        recoveredCount: input.candidates.length,
        note: `Owner-imported specialist catalogue (${input.sources.length} sources); claims remain inferred.`,
      }]);
      await client.query(
        "INSERT INTO audit_events(run_id,actor,action,detail_json) VALUES($1,$2,$3,$4)",
        [input.runId, input.actor.slice(0, 80), "run.catalog_imported", {
          importHash: input.importHash,
          sourceCount: input.sources.length,
          candidateCount: input.candidates.length,
          newlyAdded,
          evidenceState: "inferred",
        }],
      );
      return { newlyAdded };
    });
  }

  async approveRunBudget(runId: string, approvedBudgetUsd: number): Promise<void> {
    const amount = finiteMoney(approvedBudgetUsd, "Approved budget");
    const result = await this.pool.query(
      `UPDATE research_runs SET approved_budget_usd=$2,status='queued',phase='queued',error=NULL,budget_approval_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND status='awaiting_budget' AND budget_approval_expires_at>now() AND $2>actual_cost_usd+reserved_cost_usd`,
      [runId, amount],
    );
    if (!result.rowCount) throw new HttpError(409, "Run cannot be approved at that budget", "budget_approval_invalid");
  }

  async cancelRun(runId: string): Promise<void> {
    await this.transaction(async (client) => {
      const updated = await client.query(
        "UPDATE research_runs SET status='failed',phase='owner_cancelled',error='Cancelled by owner',completed_at=now(),updated_at=now() WHERE id=$1 AND status NOT IN ('complete','partial','deleted')",
        [runId],
      );
      if (!updated.rowCount) throw new HttpError(409, "Run cannot be cancelled", "run_not_cancellable");
      await client.query("UPDATE job_queue SET status='cancelled',completed_at=now(),updated_at=now() WHERE run_id=$1 AND status='queued'", [runId]);
    });
  }

  async getSystemHealth(): Promise<any> {
    const [worker, queue, costs, apple, notifications, publications, orphans, retention, researchPaused, publishingPaused] = await Promise.all([
      this.pool.query("SELECT worker_id,schema_version,capacity,active_jobs,last_seen_at FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 1"),
      this.pool.query(
        `SELECT
          count(*) FILTER (WHERE status='queued')::int queued,
          count(*) FILTER (WHERE status='leased' AND lease_expires_at>now())::int leased,
          count(*) FILTER (WHERE status='leased' AND lease_expires_at<=now())::int expired_leases,
          count(*) FILTER (WHERE status='failed')::int failed,
          COALESCE(EXTRACT(EPOCH FROM (now()-min(created_at) FILTER (WHERE status='queued'))),0)::float8 oldest_queued_seconds
         FROM job_queue`,
      ),
      this.pool.query(
        `SELECT
          COALESCE((SELECT sum(amount_usd) FROM cost_ledger WHERE occurred_at >= date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'),0)::float8 month_spend,
          COALESCE((SELECT sum(reserved_usd) FROM cost_reservations WHERE status='reserved' AND expires_at>now()),0)::float8 month_reserved`,
      ),
      this.pool.query("SELECT status,storefront,last_validated_at,last_error,updated_at FROM apple_authorizations WHERE id='owner'"),
      this.pool.query(
        `SELECT
          count(*) FILTER (WHERE status='pending')::int pending,
          count(*) FILTER (WHERE status='failed')::int failed,
          COALESCE(EXTRACT(EPOCH FROM (now()-min(created_at) FILTER (WHERE status='pending'))),0)::float8 oldest_pending_seconds
         FROM notification_outbox`,
      ),
      this.pool.query(
        `SELECT
          (SELECT count(*)::int FROM research_runs WHERE status='failed' AND phase LIKE 'publication%') failed_runs,
          (SELECT count(*)::int FROM publication_volumes WHERE status='failed') failed_volumes`,
      ),
      this.pool.query<{ count: number }>("SELECT count(*)::int count FROM orphan_playlists WHERE cleaned_at IS NULL"),
      this.pool.query(
        `SELECT
          (SELECT count(*)::int FROM research_runs WHERE retention_expires_at<=now()) due_runs,
          (SELECT value FROM settings WHERE key='retention_last_run_at') last_run_at,
          (SELECT value FROM settings WHERE key='retention_last_purged') last_purged`,
      ),
      this.getSetting("research_paused"),
      this.getSetting("publishing_paused"),
    ]);
    const heartbeat = worker.rows[0];
    const queueRow = queue.rows[0] ?? {};
    const notificationRow = notifications.rows[0] ?? {};
    const publicationRow = publications.rows[0] ?? {};
    const retentionRow = retention.rows[0] ?? {};
    const lastSeenAt = date(heartbeat?.last_seen_at);
    const configuredStaleSeconds = Number(process.env.WORKER_STALE_SECONDS ?? 90);
    const staleAfterMs = (Number.isFinite(configuredStaleSeconds) ? Math.max(30, configuredStaleSeconds) : 90) * 1_000;
    return {
      database: { ok: true, schemaVersion: await this.getSchemaVersion() },
      worker: heartbeat ? {
        ...heartbeat,
        lastSeenAt: lastSeenAt?.toISOString(),
        stale: !lastSeenAt || Date.now() - lastSeenAt.getTime() > staleAfterMs,
        schemaCompatible: heartbeat.schema_version === DATABASE_SCHEMA_VERSION,
      } : { stale: true, schemaCompatible: false },
      queue: {
        queued: Number(queueRow.queued ?? 0),
        leased: Number(queueRow.leased ?? 0),
        expiredLeases: Number(queueRow.expired_leases ?? 0),
        failed: Number(queueRow.failed ?? 0),
        oldestQueuedSeconds: Number(queueRow.oldest_queued_seconds ?? 0),
      },
      monthSpendUsd: Number(costs.rows[0]?.month_spend ?? 0),
      monthReservedUsd: Number(costs.rows[0]?.month_reserved ?? 0),
      monthCeilingUsd: readCostConfiguration().monthlyCostLimitUsd,
      apple: apple.rows[0] ? { status: apple.rows[0].status, storefront: apple.rows[0].storefront, lastValidatedAt: date(apple.rows[0].last_validated_at)?.toISOString() ?? null, lastError: sanitizeOptionalFailure(apple.rows[0].last_error, "apple_authorization") } : { status: "missing" },
      notificationBacklog: Number(notificationRow.pending ?? 0),
      notificationFailures: Number(notificationRow.failed ?? 0),
      oldestNotificationSeconds: Number(notificationRow.oldest_pending_seconds ?? 0),
      publicationFailures: {
        runs: Number(publicationRow.failed_runs ?? 0),
        volumes: Number(publicationRow.failed_volumes ?? 0),
      },
      orphanedPlaylists: orphans.rows[0]?.count ?? 0,
      retention: {
        dueRuns: Number(retentionRow.due_runs ?? 0),
        lastRunAt: typeof retentionRow.last_run_at === "string" ? retentionRow.last_run_at : null,
        lastPurged: Number(retentionRow.last_purged ?? 0),
      },
      paused: { research: researchPaused === "true", publishing: publishingPaused === "true" },
    };
  }

  async getPublicResult(runId: string): Promise<any> {
    const [manifest, run, outcomeCounts] = await Promise.all([
      this.getLatestManifestForRun(runId),
      this.getRun(runId),
      this.getOutcomeCounts(runId),
    ]);
    if (!manifest) return { status: run.status, manifest: null, volumes: [], outcomeCounts, completedTracks: 0, totalTracks: 0 };
    const rawVolumes = await this.listPublicationVolumes(manifest.id);
    const volumes = rawVolumes.map((volume) => ({
      ...volume,
      index: volume.volumeNumber,
      total: volume.volumeCount,
      playlistId: volume.applePlaylistId,
      shareUrl: volume.appleShareUrl,
      trackCount: Math.max(0, volume.endPosition - volume.startPosition + 1),
    }));
    return {
      status: run.status,
      manifest: { id: manifest.id, name: manifest.name, contentHash: manifest.contentHash, trackCount: manifest.tracks.length },
      volumes,
      outcomeCounts,
      completedTracks: volumes.reduce((sum, volume) => sum + volume.appendedCount, 0),
      totalTracks: manifest.tracks.length,
      error: run.error,
    };
  }

  async getOutcomeCounts(runId: string): Promise<Record<string, number>> {
    const result = await this.pool.query<{ outcome: string; count: number }>("SELECT outcome,count(*)::int count FROM track_candidates WHERE run_id=$1 GROUP BY outcome", [runId]);
    return Object.fromEntries(result.rows.map((row) => [row.outcome, row.count]));
  }

  async getEvidenceReport(runId: string, page = 1, pageSize = 50): Promise<any> {
    const safePage = Math.max(1, Math.floor(page));
    const size = Math.max(1, Math.min(Math.floor(pageSize), 100));
    const totalResult = await this.pool.query<{ count: number }>("SELECT count(*)::int count FROM track_candidates WHERE run_id=$1", [runId]);
    const candidates = await this.pool.query(
      `SELECT c.id,c.artist,c.title,c.album,c.outcome,
       COALESCE(json_agg(json_build_object('state',CASE
           WHEN e.state IN ('verified','corroborated','disputed') AND (
             e.support_scope<>'track' OR e.verification_phase<>'track_verification'
             OR s.source_class<>'web' OR ca.id IS NULL
           ) THEN 'inferred'
           WHEN e.state='editorial' AND (s.source_class<>'web' OR ca.id IS NULL) THEN 'inferred'
           ELSE e.state END,'supportScope',e.support_scope,
         'verificationPhase',e.verification_phase,'relationship',e.relationship,'note',e.note,
         'subjectEntity',e.subject_entity,'subjectRelationship',e.subject_relationship,
         'citationSupport',CASE WHEN ca.id IS NULL THEN NULL ELSE json_build_object(
           'responseId',ca.response_id,'outputItemId',ca.output_item_id,'contentIndex',ca.content_index,
           'startIndex',ca.start_index,'endIndex',ca.end_index,'excerpt',ca.excerpt) END,
         'source',json_build_object('url',s.url,'title',s.title,'class',s.source_class,'provenanceRoot',s.provenance_root))
         ORDER BY e.state,s.url) FILTER (WHERE e.id IS NOT NULL),'[]'::json) evidence
       FROM track_candidates c LEFT JOIN evidence_claims e ON e.candidate_id=c.id
       LEFT JOIN source_records s ON s.id=e.source_id
       LEFT JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
         AND ca.run_id=e.run_id AND ca.source_url=s.url
       WHERE c.run_id=$1
       GROUP BY c.id ORDER BY c.artist,c.title,c.id LIMIT $2 OFFSET $3`,
      [runId, size, (safePage - 1) * size],
    );
    const total = totalResult.rows[0]!.count;
    return {
      coverage: await this.getCoverage(runId),
      outcomes: await this.getOutcomeCounts(runId),
      page: safePage,
      pageSize: size,
      total,
      totalPages: Math.ceil(total / size),
      candidates: candidates.rows,
    };
  }

  async runRetentionSweep(limit = 50): Promise<number> {
    const detailCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000);
    await this.pool.query(
      `UPDATE research_runs SET status='expired',phase='budget_approval_expired',error='Budget approval expired after seven days',completed_at=now(),updated_at=now()
       WHERE status='awaiting_budget' AND budget_approval_expires_at<=now()`,
    );
    const expired = await this.pool.query<{ id: string }>(
      "SELECT id FROM research_runs WHERE retention_expires_at<=now() ORDER BY retention_expires_at FOR UPDATE SKIP LOCKED LIMIT $1",
      [Math.max(1, Math.min(limit, 500))],
    );
    for (const row of expired.rows) await this.purgeRunToTombstone(row.id);
    await this.pool.query(
      "DELETE FROM cost_ledger WHERE brief_request_id IN (SELECT id FROM brief_requests WHERE expires_at<=now())",
    );
    await this.pool.query("DELETE FROM brief_requests WHERE expires_at<=now()");
    await this.pool.query(
      `DELETE FROM job_queue j USING notification_outbox n
       WHERE j.kind='notification' AND j.payload_json->>'notificationId'=n.id::text AND n.created_at<=$1`,
      [detailCutoff],
    );
    await this.pool.query("DELETE FROM notification_outbox WHERE created_at<=$1", [detailCutoff]);
    await this.pool.query("DELETE FROM cost_ledger WHERE occurred_at<=$1", [detailCutoff]);
    await this.pool.query("DELETE FROM audit_events WHERE occurred_at<=$1", [detailCutoff]);
    await this.pool.query("DELETE FROM rate_limit_events WHERE occurred_at<now()-interval '48 hours'");
    await this.pool.query("DELETE FROM gateway_nonces WHERE expires_at<=now()");
    await this.pool.query(
      `INSERT INTO settings(key,value) VALUES
         ('retention_last_run_at',$1),('retention_last_purged',$2)
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
      [new Date().toISOString(), String(expired.rows.length)],
    );
    return expired.rows.length;
  }

  private async purgeRunToTombstone(runId: string): Promise<void> {
    await this.transaction(async (client) => {
      const run = await client.query("SELECT actual_cost_usd FROM research_runs WHERE id=$1 FOR UPDATE", [runId]);
      if (!run.rows[0]) return;
      const manifest = await client.query("SELECT id,content_hash,name FROM manifests WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1", [runId]);
      const volumes = manifest.rows[0]
        ? await client.query("SELECT apple_share_url FROM publication_volumes WHERE manifest_id=$1 AND apple_share_url IS NOT NULL ORDER BY volume_number", [manifest.rows[0].id])
        : { rows: [] };
      const counts = await client.query("SELECT outcome,count(*)::int count FROM track_candidates WHERE run_id=$1 GROUP BY outcome", [runId]);
      const appleLinks = volumes.rows.map((volume) => volume.apple_share_url);
      const outcomeCounts = Object.fromEntries(counts.rows.map((entry) => [entry.outcome, entry.count]));
      await client.query(
        `INSERT INTO retention_tombstones(run_id,manifest_hash,playlist_title,apple_links_json,outcome_counts_json,aggregate_cost_usd)
         VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6) ON CONFLICT(run_id) DO NOTHING`,
        [runId, manifest.rows[0]?.content_hash ?? null, manifest.rows[0]?.name ?? null, JSON.stringify(appleLinks), JSON.stringify(outcomeCounts), Number(run.rows[0].actual_cost_usd)],
      );
      const notificationIds = await client.query<{ id: string }>(
        `SELECT id FROM notification_outbox
         WHERE payload_json->>'runId'=$1
            OR ($2::text IS NOT NULL AND payload_json->>'manifestId'=$2::text)`,
        [runId, manifest.rows[0]?.id ?? null],
      );
      if (notificationIds.rows.length > 0) {
        const ids = notificationIds.rows.map((item) => item.id);
        await client.query(
          "DELETE FROM job_queue WHERE kind='notification' AND payload_json->>'notificationId'=ANY($1::text[])",
          [ids],
        );
        await client.query("DELETE FROM notification_outbox WHERE id=ANY($1::uuid[])", [ids]);
      }
      await client.query("DELETE FROM cost_ledger WHERE run_id=$1", [runId]);
      await client.query("DELETE FROM audit_events WHERE run_id=$1", [runId]);
      await client.query("DELETE FROM research_runs WHERE id=$1", [runId]);
    });
  }
}
