import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { CatalogSong, QueryPlanV3, QueryPlanV3Predicate } from "../shared/types.ts";
import {
  EVIDENCE_GRAPH_PIPELINE_V3,
  EVIDENCE_GRAPH_POLICY_V3,
  sourceIsApprovedForReuseV3,
  type EvidenceGraphSourceDocumentV3,
} from "./evidence-graph-service-v3.ts";
import type {
  GovernedGraphCandidateV3,
  GovernedGraphDiscoveryPageV3,
} from "./pipeline-v3-live-adapters.ts";
import type { DiscoveryRequestV3, EvidenceSourceGovernanceV3 } from "./pipeline-v3-retrieval.ts";
import { isQueryPlanV3 } from "./query-plan-v3.ts";

/**
 * Read-only, frozen-snapshot traversal for factual and exhaustive V3 work.
 *
 * This module deliberately receives only a PostgreSQL pool. It cannot reach
 * Apple user authorization, manifests, jobs, or playlist mutation functions.
 */

interface ActivePlanRow extends QueryResultRow {
  query_plan_revision_id: string;
  graph_snapshot_id: string;
  graph_snapshot_status: string;
  plan_json: unknown;
}

interface RecordingIdRow extends QueryResultRow {
  recording_id: string;
}

interface AssertionRevisionRow extends QueryResultRow {
  assertion_revision_json: unknown;
}

interface CatalogRevisionRow extends QueryResultRow {
  catalog_identity_revision_json: unknown;
}

interface RecordingRow extends QueryResultRow {
  id: string;
  title: string;
  version_class: string;
  metadata_json: Record<string, unknown>;
  primary_artist_entity_id: string | null;
  primary_artist_name: string | null;
}

interface EntityRow extends QueryResultRow {
  id: string;
  canonical_name: string;
  aliases: string[];
}

interface FrozenSourceRevision {
  id: string;
  url: string;
  content_hash: string;
  title: string;
  source_class: string;
  provenance_root: string;
  access_method: EvidenceGraphSourceDocumentV3["accessMethod"];
  approval_state: EvidenceGraphSourceDocumentV3["approvalState"];
  authority: EvidenceGraphSourceDocumentV3["authority"];
  license_state: EvidenceGraphSourceDocumentV3["licenseState"];
  license_version: string | null;
  terms_version: string | null;
  attribution: string | null;
  cache_policy: EvidenceGraphSourceDocumentV3["cachePolicy"];
  retention_policy: EvidenceGraphSourceDocumentV3["retentionPolicy"];
  freshness_policy: EvidenceGraphSourceDocumentV3["freshnessPolicy"];
  freshness_expires_at: string | null;
  source_revision: string;
  approved_by: string | null;
  approved_at: string | null;
  takedown_reason: string | null;
  taken_down_at: string | null;
  status: string;
  retrieved_at: string;
  last_verified_at: string | null;
  metadata_json: Record<string, unknown>;
}

interface FrozenObservationRevision {
  id: string;
  source_document_id: string;
  subject_entity_id: string | null;
  recording_id: string | null;
  release_id: string | null;
  predicate: string;
  object_json: Record<string, unknown>;
  credit_scope: string | null;
  confidence: number | string;
  status: string;
  pipeline_version: string;
  policy_version: string;
}

interface FrozenAssertionRevision {
  id: string;
  subject_entity_id: string | null;
  recording_id: string | null;
  release_id: string | null;
  predicate: string;
  object_json: Record<string, unknown>;
  evidence_tier: string;
  status: string;
  evidence: Array<{
    observation: FrozenObservationRevision;
    sourceDocument: FrozenSourceRevision;
  }>;
}

interface FrozenCatalogIdentityRevision {
  id: string;
  recording_id: string;
  provider: string;
  storefront: string;
  catalog_id: string;
  is_preferred: boolean;
  is_available: boolean;
  identity_confidence: number | string;
  metadata_json: Record<string, unknown>;
}

interface GraphCursorV3 {
  schema: "genio-v3-graph-cursor/v1";
  snapshotId: string;
  queryPlanRevisionId: string;
  afterRecordingId: string;
}

export interface GovernedGraphReadInputV3 {
  runId: string;
  storefront: string;
  cursor: string | null;
  limit: number;
}

export interface GovernedGraphReadPageV3 extends GovernedGraphDiscoveryPageV3 {
  graphSnapshotId: string;
  queryPlanRevisionId: string;
}

type EligibleEvidence = {
  assertionId: string;
  observationId: string;
  provenanceRoot: string;
  sourceUrl: string;
  authority: string;
  governance: EvidenceSourceGovernanceV3;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalize(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function sameTerm(left: string, right: string): boolean {
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function sameIdentity(left: string, right: string): boolean {
  const a = normalize(left).replace(/^the\s+/u, "");
  const b = normalize(right).replace(/^the\s+/u, "");
  return Boolean(a && b && a === b);
}

function parseAssertion(value: unknown): FrozenAssertionRevision | null {
  const row = object(value);
  if (!row || !text(row.id) || !text(row.recording_id) || !text(row.predicate)) return null;
  const evidence = Array.isArray(row.evidence) ? row.evidence.flatMap((item) => {
    const pair = object(item);
    const observation = object(pair?.observation);
    const source = object(pair?.sourceDocument);
    return observation && source ? [{
      observation: observation as unknown as FrozenObservationRevision,
      sourceDocument: source as unknown as FrozenSourceRevision,
    }] : [];
  }) : [];
  return {
    id: String(row.id),
    subject_entity_id: text(row.subject_entity_id),
    recording_id: text(row.recording_id),
    release_id: text(row.release_id),
    predicate: String(row.predicate),
    object_json: object(row.object_json) ?? {},
    evidence_tier: String(row.evidence_tier ?? ""),
    status: String(row.status ?? ""),
    evidence,
  };
}

function parseCatalogIdentity(value: unknown): FrozenCatalogIdentityRevision | null {
  const row = object(value);
  if (!row || !text(row.id) || !text(row.recording_id) || !text(row.catalog_id)) return null;
  return {
    id: String(row.id),
    recording_id: String(row.recording_id),
    provider: String(row.provider ?? ""),
    storefront: String(row.storefront ?? ""),
    catalog_id: String(row.catalog_id),
    is_preferred: row.is_preferred === true,
    is_available: row.is_available !== false,
    identity_confidence: Number(row.identity_confidence ?? 0),
    metadata_json: object(row.metadata_json) ?? {},
  };
}

function sourceDocument(source: FrozenSourceRevision): EvidenceGraphSourceDocumentV3 | null {
  if (!text(source.id) || !text(source.url) || !text(source.content_hash)) return null;
  const retrievedAt = new Date(source.retrieved_at);
  const lastVerifiedAt = source.last_verified_at ? new Date(source.last_verified_at) : null;
  const freshnessExpiresAt = source.freshness_expires_at ? new Date(source.freshness_expires_at) : null;
  const approvedAt = source.approved_at ? new Date(source.approved_at) : null;
  const takenDownAt = source.taken_down_at ? new Date(source.taken_down_at) : null;
  if (!Number.isFinite(retrievedAt.getTime())
    || (lastVerifiedAt && !Number.isFinite(lastVerifiedAt.getTime()))
    || (freshnessExpiresAt && !Number.isFinite(freshnessExpiresAt.getTime()))
    || (approvedAt && !Number.isFinite(approvedAt.getTime()))
    || (takenDownAt && !Number.isFinite(takenDownAt.getTime()))) return null;
  return {
    id: source.id,
    url: source.url,
    contentHash: source.content_hash,
    title: source.title ?? "Governed evidence source",
    sourceClass: source.source_class ?? "unknown",
    provenanceRoot: source.provenance_root ?? "",
    accessMethod: source.access_method,
    approvalState: source.approval_state,
    authority: source.authority,
    licenseState: source.license_state,
    licenseVersion: source.license_version,
    termsVersion: source.terms_version,
    attribution: source.attribution,
    cachePolicy: source.cache_policy,
    retentionPolicy: source.retention_policy,
    freshnessPolicy: source.freshness_policy,
    freshnessExpiresAt,
    sourceRevision: source.source_revision,
    approvedBy: source.approved_by,
    approvedAt,
    takedownReason: source.takedown_reason,
    takenDownAt,
    status: source.status ?? "",
    retrievedAt,
    lastVerifiedAt,
    metadataJson: object(source.metadata_json) ?? {},
  };
}

function graphObject(value: Record<string, unknown>): Record<string, unknown> {
  return object(value.graph) ?? {};
}

function supports(value: Record<string, unknown>): boolean {
  return graphObject(value).polarity !== "disputes";
}

function authorityOf(source: EvidenceGraphSourceDocumentV3): string {
  return source.authority;
}

function eligibleEvidence(assertion: FrozenAssertionRevision): EligibleEvidence[] {
  if (assertion.status !== "active"
    || !["verified", "corroborated"].includes(assertion.evidence_tier)
    || !supports(assertion.object_json)
    || !assertion.recording_id) return [];

  const evidence = assertion.evidence.flatMap(({ observation, sourceDocument: sourceRevision }) => {
    const source = sourceDocument(sourceRevision);
    if (!source
      || observation.status !== "promoted"
      || observation.pipeline_version !== EVIDENCE_GRAPH_PIPELINE_V3
      || observation.policy_version !== EVIDENCE_GRAPH_POLICY_V3
      || observation.credit_scope !== "exact_recording"
      || observation.recording_id !== assertion.recording_id
      || !supports(object(observation.object_json) ?? {})
      || !sourceIsApprovedForReuseV3(source)) return [];
    return [{
      assertionId: assertion.id,
      observationId: observation.id,
      provenanceRoot: source.provenanceRoot,
      sourceUrl: source.url,
      authority: authorityOf(source),
      governance: {
        policyVersion: "evidence-source-governance-v3",
        useScope: "durable_corpus",
        approvalState: "approved",
        accessMethod: source.accessMethod,
        licenseState: source.licenseState as "reusable" | "permission_recorded",
        licenseVersion: source.licenseVersion!,
        termsVersion: source.termsVersion!,
        attribution: source.attribution!,
        cachePolicy: source.cachePolicy as "excerpt_only" | "full_document_permitted",
        retentionPolicy: source.retentionPolicy as "durable_public_corpus" | "license_term",
        freshnessPolicy: source.freshnessPolicy,
        sourceHash: source.contentHash,
        sourceRevision: source.sourceRevision,
      } satisfies EvidenceSourceGovernanceV3,
    }];
  });
  if (assertion.evidence_tier === "verified") {
    return evidence.some(({ authority }) => [
      "primary_track_credit", "official_track_credit", "specialist_track_credit",
    ].includes(authority)) ? evidence : [];
  }
  const medium = evidence.filter(({ authority }) => [
    "trusted_editorial_container", "secondary_database",
  ].includes(authority));
  return new Set(medium.map(({ provenanceRoot }) => normalize(provenanceRoot)).filter(Boolean)).size >= 2
    ? medium
    : [];
}

function claimKey(assertion: FrozenAssertionRevision): string {
  const graph = graphObject(assertion.object_json);
  return [
    assertion.subject_entity_id ?? "",
    assertion.recording_id ?? "",
    normalize(assertion.predicate),
    normalize(String(graph.relationship ?? "")),
  ].join("|");
}

function sourceRank(authority: string): number {
  switch (authority) {
    case "primary_track_credit": return 0;
    case "official_track_credit": return 1;
    case "specialist_track_credit": return 2;
    case "trusted_editorial_container": return 10;
    case "secondary_database": return 20;
    default: return 50;
  }
}

function flattenedClaimTerms(assertion: FrozenAssertionRevision): string[] {
  const graph = graphObject(assertion.object_json);
  const supportedValues = Array.isArray(graph.supportedValues)
    ? graph.supportedValues.filter((value): value is string => typeof value === "string")
    : [];
  return [
    assertion.predicate,
    String(graph.relationship ?? ""),
    ...supportedValues,
    JSON.stringify(assertion.object_json),
  ].map(normalize).filter(Boolean);
}

function relationshipAliases(value: string): string[] {
  const term = normalize(value);
  if (/subject performed|perform|played|player|percussion|musician|credit/u.test(term)) {
    return ["performed", "performance", "played", "player", "percussion", "musician", "credit"];
  }
  if (/subject created|wrote|writer|compos|produc|arrang/u.test(term)) {
    return ["created", "writer", "wrote", "composer", "composed", "producer", "produced", "arranger", "arranged"];
  }
  if (/influenc/u.test(term)) return ["influence", "influenced", "influential"];
  return [term];
}

function assertionPredicateIds(input: {
  assertion: FrozenAssertionRevision;
  predicates: readonly QueryPlanV3Predicate[];
  recordingTitle: string;
  subjectNames: readonly string[];
}): string[] {
  const terms = flattenedClaimTerms(input.assertion);
  const matches = (expected: string) => terms.some((actual) => sameTerm(actual, expected));
  return input.predicates.flatMap((predicate) => {
    if (predicate.relationship === "exclude") return [];
    const values = predicate.subject.split(" | ").map((value) => value.trim()).filter(Boolean);
    if (values.length === 0) return [];
    let passed = false;
    if (predicate.kind === "artist") {
      // Entity predicates are identity constraints. Substring matching would
      // conflate distinct people (for example, "Paul" and "Paulinho") and is
      // therefore intentionally forbidden even when the relationship claim
      // text itself uses looser linguistic matching.
      passed = values.some((value) => input.subjectNames.some((name) => sameIdentity(name, value)));
    } else if (predicate.kind === "track") {
      passed = values.some((value) => sameIdentity(input.recordingTitle, value));
    } else if (predicate.kind === "factual_relationship" || predicate.kind === "relationship") {
      passed = values.some((value) => relationshipAliases(value).some(matches));
    } else if (!["recording_version", "content"].includes(predicate.kind)) {
      passed = values.some(matches);
    }
    return passed ? [predicate.id] : [];
  });
}

function encodeCursor(cursor: GraphCursorV3): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): GraphCursorV3 | null {
  if (!value) return null;
  if (value.length > 2_000) throw new Error("Governed graph cursor is invalid");
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<GraphCursorV3>;
    if (decoded.schema !== "genio-v3-graph-cursor/v1"
      || !text(decoded.snapshotId)
      || !text(decoded.queryPlanRevisionId)
      || !text(decoded.afterRecordingId)) throw new Error("invalid");
    return decoded as GraphCursorV3;
  } catch {
    throw new Error("Governed graph cursor is invalid");
  }
}

function metadataText(metadata: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = text(metadata[key]);
    if (value) return value;
  }
  return null;
}

function metadataNumber(metadata: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(metadata[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function catalogSong(input: {
  identity: FrozenCatalogIdentityRevision;
  recording: RecordingRow;
}): CatalogSong {
  const identityMetadata = input.identity.metadata_json;
  const recordingMetadata = input.recording.metadata_json ?? {};
  const contentRating = metadataText(identityMetadata, "contentRating", "content_rating");
  return {
    id: input.identity.catalog_id,
    name: metadataText(identityMetadata, "name", "title") ?? input.recording.title,
    artistName: metadataText(identityMetadata, "artistName", "artist_name")
      ?? input.recording.primary_artist_name
      ?? "Unknown artist",
    albumName: metadataText(identityMetadata, "albumName", "album_name")
      ?? metadataText(recordingMetadata, "albumName", "album_name", "album")
      ?? "",
    ...(metadataText(identityMetadata, "isrc") ? { isrc: metadataText(identityMetadata, "isrc")! } : {}),
    ...(metadataText(identityMetadata, "releaseDate", "release_date")
      ? { releaseDate: metadataText(identityMetadata, "releaseDate", "release_date")! }
      : {}),
    ...(metadataNumber(identityMetadata, "durationInMillis", "duration_in_millis", "durationMs") !== undefined
      ? { durationInMillis: metadataNumber(identityMetadata, "durationInMillis", "duration_in_millis", "durationMs") }
      : {}),
    ...(metadataText(identityMetadata, "url") ? { url: metadataText(identityMetadata, "url")! } : {}),
    ...(metadataText(identityMetadata, "versionLabel", "version_label")
      ? { versionLabel: metadataText(identityMetadata, "versionLabel", "version_label")! }
      : {}),
    ...(contentRating === "clean" || contentRating === "explicit" ? { contentRating } : {}),
  };
}

function bestIdentity(
  identities: readonly FrozenCatalogIdentityRevision[],
  storefront: string,
): FrozenCatalogIdentityRevision | null {
  return identities
    .filter((identity) => normalize(identity.provider) === "apple"
      && normalize(identity.storefront) === normalize(storefront)
      && identity.is_available
      && Number(identity.identity_confidence) >= 0.9)
    .sort((left, right) => Number(right.is_preferred) - Number(left.is_preferred)
      || Number(right.identity_confidence) - Number(left.identity_confidence)
      || left.catalog_id.localeCompare(right.catalog_id))[0] ?? null;
}

async function activePlan(client: PoolClient, runId: string): Promise<ActivePlanRow> {
  const result = await client.query<ActivePlanRow>(
    `SELECT q.id query_plan_revision_id,q.graph_snapshot_id,
            g.status graph_snapshot_status,q.plan_json
     FROM run_active_query_plans active
     JOIN query_plan_revisions q ON q.id=active.query_plan_revision_id
     JOIN graph_snapshots g ON g.id=q.graph_snapshot_id
     WHERE active.run_id=$1 AND q.run_id=$1 AND q.status='active'
       AND q.pipeline_version='corpus_first_v3'
       AND q.policy_version='corpus_first_v3_policy_v1'`,
    [runId],
  );
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) throw new Error("Active Pipeline V3 query plan was not found");
  if (row.graph_snapshot_status !== "locked") throw new Error("Pipeline V3 graph snapshot is not locked");
  if (!isQueryPlanV3(row.plan_json)) throw new Error("Active Pipeline V3 query plan is invalid");
  if (row.plan_json.graphSnapshotId !== row.graph_snapshot_id) {
    throw new Error("Pipeline V3 query plan snapshot binding is invalid");
  }
  return row;
}

function requireFactualSubject(plan: QueryPlanV3): void {
  if (!["factual_relationship", "exhaustive"].some((engine) => plan.engines.includes(engine as QueryPlanV3["engine"]))) {
    throw new Error("Governed graph traversal requires a factual or exhaustive query plan");
  }
  const hasRelationship = plan.membershipPredicates.some((predicate) => (
    ["factual_relationship", "relationship"].includes(predicate.kind)
    && predicate.relationship !== "exclude"
  ));
  const hasSubject = plan.membershipPredicates.some((predicate) => (
    predicate.kind === "artist" && predicate.relationship !== "exclude" && predicate.subject.trim()
  ));
  if (!hasRelationship || !hasSubject) {
    throw new Error("Factual graph traversal requires an explicit subject and relationship in the immutable query plan");
  }
}

function requiredArtistNames(plan: QueryPlanV3): string[] {
  return [...new Set(plan.membershipPredicates
    .filter((predicate) => predicate.kind === "artist" && predicate.relationship !== "exclude")
    .flatMap((predicate) => predicate.subject.split(" | "))
    .map((value) => value.trim())
    .filter(Boolean))];
}

async function resolveSnapshotSubjectEntityIds(
  client: PoolClient,
  snapshotId: string,
  plan: QueryPlanV3,
): Promise<string[]> {
  const requestedNames = requiredArtistNames(plan);
  if (requestedNames.length === 0) return [];
  // Resolve only entities actually referenced by the locked snapshot. This
  // keeps a factual traversal bounded even when the global corpus contains
  // millions of unrelated people and aliases.
  const result = await client.query<EntityRow>(
    `SELECT entity.id,entity.canonical_name,
            COALESCE(array_agg(DISTINCT alias.alias) FILTER (WHERE alias.alias IS NOT NULL),'{}') aliases
     FROM graph_snapshot_assertions snapshot
     JOIN corpus_entities entity
       ON entity.id::text=snapshot.assertion_revision_json->>'subject_entity_id'
     LEFT JOIN corpus_entity_aliases alias ON alias.entity_id=entity.id AND alias.confidence>=0.9
     WHERE snapshot.graph_snapshot_id=$1
     GROUP BY entity.id,entity.canonical_name`,
    [snapshotId],
  );
  return result.rows
    .filter((row) => requestedNames.some((requested) => (
      [row.canonical_name, ...row.aliases].some((candidate) => sameIdentity(candidate, requested))
    )))
    .map(({ id }) => id);
}

export class PgPipelineV3GovernedGraphReadRepository {
  constructor(private readonly pool: Pool) {}

  async readGovernedGraphCandidatesV3(input: GovernedGraphReadInputV3): Promise<GovernedGraphReadPageV3> {
    const limit = Math.max(1, Math.min(300, Math.floor(input.limit)));
    const cursor = decodeCursor(input.cursor);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const active = await activePlan(client, input.runId);
      const plan = active.plan_json as QueryPlanV3;
      requireFactualSubject(plan);
      if (normalize(plan.storefront) !== normalize(input.storefront)) {
        throw new Error("Governed graph storefront does not match the immutable query plan");
      }
      if (cursor && (cursor.snapshotId !== active.graph_snapshot_id
        || cursor.queryPlanRevisionId !== active.query_plan_revision_id)) {
        throw new Error("Governed graph cursor belongs to a different query plan snapshot");
      }

      const subjectEntityIds = await resolveSnapshotSubjectEntityIds(
        client,
        active.graph_snapshot_id,
        plan,
      );
      if (subjectEntityIds.length === 0) {
        await client.query("COMMIT");
        return {
          candidates: [], nextCursor: null, exhausted: true,
          graphSnapshotId: active.graph_snapshot_id,
          queryPlanRevisionId: active.query_plan_revision_id,
        };
      }

      const idResult = await client.query<RecordingIdRow>(
        `SELECT DISTINCT assertion_revision_json->>'recording_id' recording_id
         FROM graph_snapshot_assertions
         WHERE graph_snapshot_id=$1
           AND assertion_revision_json->>'subject_entity_id'=ANY($4::text[])
           AND assertion_revision_json->>'status'='active'
           AND assertion_revision_json->>'evidence_tier' IN ('verified','corroborated')
           AND assertion_revision_json->>'recording_id' IS NOT NULL
           AND ($2::text IS NULL OR assertion_revision_json->>'recording_id'>$2)
         ORDER BY recording_id
         LIMIT $3`,
        [active.graph_snapshot_id, cursor?.afterRecordingId ?? null, limit + 1, subjectEntityIds],
      );
      const hasMore = idResult.rows.length > limit;
      const recordingIds = idResult.rows.slice(0, limit).map(({ recording_id: id }) => id);
      if (recordingIds.length === 0) {
        await client.query("COMMIT");
        return {
          candidates: [], nextCursor: null, exhausted: true,
          graphSnapshotId: active.graph_snapshot_id,
          queryPlanRevisionId: active.query_plan_revision_id,
        };
      }

      // A pg client executes one wire query at a time. Keep the read sequence
      // explicit so this remains compatible with pg 9 rather than relying on
      // the deprecated concurrent-query queue.
      const assertionResult = await client.query<AssertionRevisionRow>(
          `SELECT assertion_revision_json
           FROM graph_snapshot_assertions
           WHERE graph_snapshot_id=$1
             AND assertion_revision_json->>'recording_id'=ANY($2::text[])
           ORDER BY assertion_revision_json->>'recording_id',assertion_id`,
          [active.graph_snapshot_id, recordingIds],
        );
      const identityResult = await client.query<CatalogRevisionRow>(
          `SELECT catalog_identity_revision_json
           FROM graph_snapshot_catalog_identities
           WHERE graph_snapshot_id=$1
             AND catalog_identity_revision_json->>'recording_id'=ANY($2::text[])
           ORDER BY catalog_identity_revision_json->>'recording_id',catalog_identity_id`,
          [active.graph_snapshot_id, recordingIds],
        );
      const recordingResult = await client.query<RecordingRow>(
          `SELECT recording.id,recording.title,recording.version_class,recording.metadata_json,
                  recording.primary_artist_entity_id,artist.canonical_name primary_artist_name
           FROM corpus_recordings recording
           LEFT JOIN corpus_entities artist ON artist.id=recording.primary_artist_entity_id
           WHERE recording.id=ANY($1::uuid[])`,
          [recordingIds],
        );

      const assertions = assertionResult.rows.map(({ assertion_revision_json }) => parseAssertion(assertion_revision_json))
        .filter((value): value is FrozenAssertionRevision => Boolean(value));
      const subjectIds = [...new Set(assertions.map(({ subject_entity_id: id }) => id).filter((id): id is string => Boolean(id)))];
      const entityResult = subjectIds.length > 0 ? await client.query<EntityRow>(
        `SELECT entity.id,entity.canonical_name,
                COALESCE(array_agg(alias.alias) FILTER (WHERE alias.alias IS NOT NULL),'{}') aliases
         FROM corpus_entities entity
         LEFT JOIN corpus_entity_aliases alias ON alias.entity_id=entity.id AND alias.confidence>=0.9
         WHERE entity.id=ANY($1::uuid[])
         GROUP BY entity.id,entity.canonical_name`,
        [subjectIds],
      ) : { rows: [] as EntityRow[] };
      const entityNames = new Map(entityResult.rows.map((row) => [row.id, [row.canonical_name, ...row.aliases]]));
      const recordingById = new Map(recordingResult.rows.map((recording) => [recording.id, recording]));
      const assertionsByRecording = new Map<string, FrozenAssertionRevision[]>();
      for (const assertion of assertions) {
        if (!assertion.recording_id) continue;
        const list = assertionsByRecording.get(assertion.recording_id) ?? [];
        list.push(assertion);
        assertionsByRecording.set(assertion.recording_id, list);
      }
      const identitiesByRecording = new Map<string, FrozenCatalogIdentityRevision[]>();
      for (const row of identityResult.rows) {
        const identity = parseCatalogIdentity(row.catalog_identity_revision_json);
        if (!identity) continue;
        const list = identitiesByRecording.get(identity.recording_id) ?? [];
        list.push(identity);
        identitiesByRecording.set(identity.recording_id, list);
      }

      const candidates: GovernedGraphCandidateV3[] = [];
      const requiredPredicateIds = plan.membershipPredicates
        .filter((predicate) => predicate.relationship !== "exclude"
          && !["recording_version", "content"].includes(predicate.kind))
        .map(({ id }) => id);
      for (const recordingId of recordingIds) {
        const recording = recordingById.get(recordingId);
        const identity = bestIdentity(identitiesByRecording.get(recordingId) ?? [], input.storefront);
        if (!recording || !identity) continue;
        const recordingAssertions = assertionsByRecording.get(recordingId) ?? [];
        const disputed = new Set(recordingAssertions
          .filter((assertion) => !supports(assertion.object_json))
          .map(claimKey));
        const evidenceBindings: NonNullable<GovernedGraphCandidateV3["evidenceBindings"]>[number][] = [];
        const acceptedAssertions: FrozenAssertionRevision[] = [];
        for (const assertion of recordingAssertions) {
          if (disputed.has(claimKey(assertion))) continue;
          const evidence = eligibleEvidence(assertion);
          if (evidence.length === 0) continue;
          const predicateIds = assertionPredicateIds({
            assertion,
            predicates: plan.membershipPredicates,
            recordingTitle: recording.title,
            subjectNames: assertion.subject_entity_id
              ? entityNames.get(assertion.subject_entity_id) ?? []
              : [],
          });
          if (predicateIds.length === 0) continue;
          acceptedAssertions.push(assertion);
          for (const item of evidence) {
            evidenceBindings.push({
              id: `graph:${item.assertionId}:${item.observationId}`,
              assertionId: item.assertionId,
              observationId: item.observationId,
              provenanceRoot: item.provenanceRoot,
              sourceUrl: item.sourceUrl,
              evidenceStrength: assertion.evidence_tier === "verified" ? 0.98 : 0.9,
              sourceRank: sourceRank(item.authority),
              predicateIds,
              governance: item.governance,
            });
          }
        }
        const satisfied = new Set(evidenceBindings.flatMap(({ predicateIds }) => predicateIds));
        if (requiredPredicateIds.some((id) => !satisfied.has(id))) continue;
        const song = catalogSong({ identity, recording });
        const roots = [...new Set(evidenceBindings.map(({ provenanceRoot }) => provenanceRoot))];
        candidates.push({
          title: song.name,
          artist: song.artistName,
          album: song.albumName || null,
          isrc: song.isrc ?? null,
          appleSong: song,
          observationIds: [...new Set(evidenceBindings.map(({ observationId }) => observationId))],
          assertionIds: [...new Set(acceptedAssertions.map(({ id }) => id))],
          graphSnapshotId: active.graph_snapshot_id,
          provenanceRoots: roots,
          sourceUrls: [...new Set(evidenceBindings.map(({ sourceUrl }) => sourceUrl))],
          evidenceBindings,
          evidenceStrength: Math.max(...evidenceBindings.map(({ evidenceStrength }) => evidenceStrength)),
          sourceRank: Math.min(...evidenceBindings.map(({ sourceRank: rank }) => rank)),
          rankingSignals: { relevance: 1, source_rank: 1 },
        });
      }
      await client.query("COMMIT");
      const lastRecordingId = recordingIds.at(-1)!;
      return {
        candidates,
        nextCursor: hasMore ? encodeCursor({
          schema: "genio-v3-graph-cursor/v1",
          snapshotId: active.graph_snapshot_id,
          queryPlanRevisionId: active.query_plan_revision_id,
          afterRecordingId: lastRecordingId,
        }) : null,
        exhausted: !hasMore,
        graphSnapshotId: active.graph_snapshot_id,
        queryPlanRevisionId: active.query_plan_revision_id,
      };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPipelineV3GovernedGraphDiscovery(
  repository: Pick<PgPipelineV3GovernedGraphReadRepository, "readGovernedGraphCandidatesV3">,
): (request: DiscoveryRequestV3) => Promise<GovernedGraphReadPageV3> {
  return async (request) => {
    if (request.appleWriteAccess !== "forbidden") {
      throw new Error("Governed graph discovery cannot receive Apple write access");
    }
    return repository.readGovernedGraphCandidatesV3({
      runId: request.runId,
      storefront: request.plan.storefront,
      cursor: request.cursor,
      limit: request.requestedRawCandidateCount,
    });
  };
}
