import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  EvidenceGraphLifecycleErrorV3,
  type AppendObservationInputV3,
  type EvidenceGraphAssertionBundleV3,
  type EvidenceGraphAssertionV3,
  type EvidenceGraphCatalogIdentityV3,
  type EvidenceGraphObservationV3,
  type EvidenceGraphRepositoryV3,
  type EvidenceGraphSnapshotV3,
  type EvidenceGraphSourceDocumentV3,
  type EvidenceGraphUnitOfWorkV3,
  type InsertAssertionInputV3,
} from "./evidence-graph-service-v3.ts";

type SourceRow = QueryResultRow & {
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
  freshness_expires_at: Date | null;
  source_revision: string;
  approved_by: string | null;
  approved_at: Date | null;
  takedown_reason: string | null;
  taken_down_at: Date | null;
  status: string;
  retrieved_at: Date;
  last_verified_at: Date | null;
  metadata_json: Record<string, unknown>;
};

type ObservationRow = QueryResultRow & {
  id: string;
  observation_key: string;
  source_document_id: string;
  subject_entity_id: string | null;
  recording_id: string | null;
  release_id: string | null;
  predicate: string;
  object_json: Record<string, unknown>;
  credit_scope: string | null;
  support_excerpt: string;
  confidence: string | number;
  status: EvidenceGraphObservationV3["status"];
  pipeline_version: string;
  policy_version: string;
  observed_at: Date;
};

type AssertionRow = QueryResultRow & {
  id: string;
  assertion_key: string;
  subject_entity_id: string | null;
  recording_id: string | null;
  release_id: string | null;
  predicate: string;
  object_json: Record<string, unknown>;
  evidence_tier: string;
  status: EvidenceGraphAssertionV3["status"];
  valid_from: Date;
  valid_to: Date | null;
  promoted_at: Date;
  retracted_at: Date | null;
  promoted_by: string;
  metadata_json: Record<string, unknown>;
};

type AssertionEvidenceRow = AssertionRow & Partial<{
  observation_id: string;
  observation_key: string;
  source_document_id: string;
  observation_subject_entity_id: string | null;
  observation_recording_id: string | null;
  observation_release_id: string | null;
  observation_predicate: string;
  observation_object_json: Record<string, unknown>;
  observation_credit_scope: string | null;
  observation_support_excerpt: string;
  observation_confidence: string | number;
  observation_status: EvidenceGraphObservationV3["status"];
  observation_pipeline_version: string;
  observation_policy_version: string;
  observation_observed_at: Date;
  source_id: string;
  source_url: string;
  source_content_hash: string;
  source_title: string;
  source_class: string;
  source_provenance_root: string;
  source_access_method: EvidenceGraphSourceDocumentV3["accessMethod"];
  source_approval_state: EvidenceGraphSourceDocumentV3["approvalState"];
  source_authority: EvidenceGraphSourceDocumentV3["authority"];
  source_license_state: EvidenceGraphSourceDocumentV3["licenseState"];
  source_license_version: string | null;
  source_terms_version: string | null;
  source_attribution: string | null;
  source_cache_policy: EvidenceGraphSourceDocumentV3["cachePolicy"];
  source_retention_policy: EvidenceGraphSourceDocumentV3["retentionPolicy"];
  source_freshness_policy: EvidenceGraphSourceDocumentV3["freshnessPolicy"];
  source_freshness_expires_at: Date | null;
  source_source_revision: string;
  source_approved_by: string | null;
  source_approved_at: Date | null;
  source_takedown_reason: string | null;
  source_taken_down_at: Date | null;
  source_status: string;
  source_retrieved_at: Date;
  source_last_verified_at: Date | null;
  source_metadata_json: Record<string, unknown>;
}>;

export interface EvidenceGraphOwnerPageV3<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface EvidenceGraphObservationOwnerViewV3 {
  observation: EvidenceGraphObservationV3;
  source: Pick<EvidenceGraphSourceDocumentV3, "id" | "title" | "url" | "provenanceRoot" | "status">;
}

export interface EvidenceGraphAssertionOwnerViewV3 {
  assertion: EvidenceGraphAssertionV3;
  evidenceCount: number;
}

function sourceFromRow(row: SourceRow): EvidenceGraphSourceDocumentV3 {
  return {
    id: row.id,
    url: row.url,
    contentHash: row.content_hash,
    title: row.title,
    sourceClass: row.source_class,
    provenanceRoot: row.provenance_root,
    accessMethod: row.access_method,
    approvalState: row.approval_state,
    authority: row.authority,
    licenseState: row.license_state,
    licenseVersion: row.license_version,
    termsVersion: row.terms_version,
    attribution: row.attribution,
    cachePolicy: row.cache_policy,
    retentionPolicy: row.retention_policy,
    freshnessPolicy: row.freshness_policy,
    freshnessExpiresAt: row.freshness_expires_at,
    sourceRevision: row.source_revision,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    takedownReason: row.takedown_reason,
    takenDownAt: row.taken_down_at,
    status: row.status,
    retrievedAt: row.retrieved_at,
    lastVerifiedAt: row.last_verified_at,
    metadataJson: row.metadata_json ?? {},
  };
}

function observationFromRow(row: ObservationRow): EvidenceGraphObservationV3 {
  return {
    id: row.id,
    observationKey: row.observation_key,
    sourceDocumentId: row.source_document_id,
    subjectEntityId: row.subject_entity_id,
    recordingId: row.recording_id,
    releaseId: row.release_id,
    predicate: row.predicate,
    objectJson: row.object_json ?? {},
    creditScope: row.credit_scope,
    supportExcerpt: row.support_excerpt,
    confidence: Number(row.confidence),
    status: row.status,
    pipelineVersion: row.pipeline_version,
    policyVersion: row.policy_version,
    observedAt: row.observed_at,
  };
}

function assertionFromRow(row: AssertionRow): EvidenceGraphAssertionV3 {
  return {
    id: row.id,
    assertionKey: row.assertion_key,
    subjectEntityId: row.subject_entity_id,
    recordingId: row.recording_id,
    releaseId: row.release_id,
    predicate: row.predicate,
    objectJson: row.object_json ?? {},
    evidenceTier: row.evidence_tier,
    status: row.status,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    promotedAt: row.promoted_at,
    retractedAt: row.retracted_at,
    promotedBy: row.promoted_by,
    metadataJson: row.metadata_json ?? {},
  };
}

function observationContentMatches(
  stored: EvidenceGraphObservationV3,
  input: Parameters<EvidenceGraphUnitOfWorkV3["insertObservation"]>[0],
): boolean {
  return stored.sourceDocumentId === input.sourceDocumentId
    && stored.subjectEntityId === (input.subjectEntityId ?? null)
    && stored.recordingId === (input.recordingId ?? null)
    && stored.releaseId === (input.releaseId ?? null)
    && stored.predicate === input.predicate
    && JSON.stringify(stored.objectJson) === JSON.stringify(input.objectJson)
    && stored.creditScope === (input.creditScope ?? null)
    && stored.supportExcerpt === input.supportExcerpt
    && stored.confidence === input.confidence
    && stored.pipelineVersion === input.pipelineVersion
    && stored.policyVersion === input.policyVersion;
}

class PgEvidenceGraphUnitOfWorkV3 implements EvidenceGraphUnitOfWorkV3 {
  constructor(private readonly client: PoolClient) {}

  async getSourceDocuments(ids: readonly string[]): Promise<EvidenceGraphSourceDocumentV3[]> {
    if (ids.length === 0) return [];
    const result = await this.client.query<SourceRow>(
      `SELECT id,url,content_hash,title,source_class,provenance_root,access_method,
              approval_state,authority,license_state,license_version,terms_version,attribution,
              cache_policy,retention_policy,freshness_policy,freshness_expires_at,source_revision,
              approved_by,approved_at,takedown_reason,taken_down_at,status,retrieved_at,
              last_verified_at,metadata_json
       FROM corpus_source_documents WHERE id=ANY($1::uuid[]) FOR SHARE`,
      [[...new Set(ids)]],
    );
    return result.rows.map(sourceFromRow);
  }

  async setSourceGovernance(input: {
    sourceDocumentId: string;
    status: string;
    policy: Parameters<EvidenceGraphUnitOfWorkV3["setSourceGovernance"]>[0]["policy"];
    lastVerifiedAt: Date;
  }): Promise<EvidenceGraphSourceDocumentV3> {
    const result = await this.client.query<SourceRow>(
      `UPDATE corpus_source_documents
       SET status=$2,approval_state=$3,authority=$4,license_state=$5,license_version=$6,
           terms_version=$7,attribution=$8,cache_policy=$9,retention_policy=$10,
           freshness_policy=$11,freshness_expires_at=$12,approved_by=$13,approved_at=$14,
           takedown_reason=$15,taken_down_at=$16,last_verified_at=$17
       WHERE id=$1
       RETURNING id,url,content_hash,title,source_class,provenance_root,access_method,
                 approval_state,authority,license_state,license_version,terms_version,attribution,
                 cache_policy,retention_policy,freshness_policy,freshness_expires_at,source_revision,
                 approved_by,approved_at,takedown_reason,taken_down_at,status,retrieved_at,
                 last_verified_at,metadata_json`,
      [
        input.sourceDocumentId, input.status, input.policy.approvalState, input.policy.authority,
        input.policy.licenseState, input.policy.licenseVersion, input.policy.termsVersion,
        input.policy.attribution, input.policy.cachePolicy, input.policy.retentionPolicy,
        input.policy.freshnessPolicy, input.policy.freshnessExpiresAt, input.policy.approvedBy,
        input.policy.approvedAt, input.policy.takedownReason ?? null, input.policy.takenDownAt ?? null,
        input.lastVerifiedAt,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new EvidenceGraphLifecycleErrorV3("source_not_found", "Source document was not found");
    return sourceFromRow(row);
  }

  async insertObservation(input: Required<Pick<AppendObservationInputV3,
    "id" | "observationKey" | "sourceDocumentId" | "predicate" | "objectJson" |
    "supportExcerpt" | "confidence" | "pipelineVersion" | "policyVersion" | "observedAt"
  >> & Pick<AppendObservationInputV3, "subjectEntityId" | "recordingId" | "releaseId" | "creditScope">): Promise<EvidenceGraphObservationV3> {
    const inserted = await this.client.query<ObservationRow>(
      `INSERT INTO corpus_assertion_observations(
         id,observation_key,source_document_id,subject_entity_id,recording_id,release_id,
         predicate,object_json,credit_scope,support_excerpt,confidence,status,
         pipeline_version,policy_version,observed_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,'quarantined',$12,$13,$14)
       ON CONFLICT(observation_key) DO NOTHING
       RETURNING *`,
      [
        input.id, input.observationKey, input.sourceDocumentId, input.subjectEntityId ?? null,
        input.recordingId ?? null, input.releaseId ?? null, input.predicate,
        JSON.stringify(input.objectJson), input.creditScope ?? null, input.supportExcerpt,
        input.confidence, input.pipelineVersion, input.policyVersion, input.observedAt,
      ],
    );
    if (inserted.rows[0]) return observationFromRow(inserted.rows[0]);
    const existing = await this.client.query<ObservationRow>(
      "SELECT * FROM corpus_assertion_observations WHERE observation_key=$1",
      [input.observationKey],
    );
    const observation = existing.rows[0] && observationFromRow(existing.rows[0]);
    if (!observation || !observationContentMatches(observation, input)) {
      throw new EvidenceGraphLifecycleErrorV3(
        "observation_key_collision",
        "Observation key already belongs to different immutable content",
      );
    }
    return observation;
  }

  async getObservations(ids: readonly string[]): Promise<EvidenceGraphObservationV3[]> {
    if (ids.length === 0) return [];
    const result = await this.client.query<ObservationRow>(
      "SELECT * FROM corpus_assertion_observations WHERE id=ANY($1::uuid[]) FOR UPDATE",
      [[...new Set(ids)]],
    );
    return result.rows.map(observationFromRow);
  }

  async insertAssertion(input: InsertAssertionInputV3): Promise<EvidenceGraphAssertionV3> {
    const result = await this.client.query<AssertionRow>(
      `INSERT INTO corpus_promoted_assertions(
         id,assertion_key,subject_entity_id,recording_id,release_id,predicate,object_json,
         evidence_tier,status,valid_from,promoted_at,promoted_by,metadata_json
       ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'active',$9,$9,$10,$11::jsonb)
       ON CONFLICT(assertion_key) DO UPDATE SET assertion_key=EXCLUDED.assertion_key
       RETURNING *`,
      [
        input.id, input.assertionKey, input.subjectEntityId, input.recordingId, input.releaseId,
        input.predicate, JSON.stringify(input.objectJson), input.evidenceTier, input.validFrom,
        input.promotedBy, JSON.stringify(input.metadataJson),
      ],
    );
    return assertionFromRow(result.rows[0]!);
  }

  async linkAssertionEvidence(assertionId: string, observationIds: readonly string[]): Promise<void> {
    if (observationIds.length === 0) return;
    await this.client.query(
      `INSERT INTO corpus_assertion_evidence(promoted_assertion_id,observation_id)
       SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
      [assertionId, [...new Set(observationIds)]],
    );
  }

  async transitionObservations(
    ids: readonly string[],
    from: EvidenceGraphObservationV3["status"],
    to: EvidenceGraphObservationV3["status"],
  ): Promise<void> {
    if (ids.length === 0) return;
    const unique = [...new Set(ids)];
    const result = await this.client.query(
      "UPDATE corpus_assertion_observations SET status=$3 WHERE id=ANY($1::uuid[]) AND status=$2",
      [unique, from, to],
    );
    if (result.rowCount !== unique.length) {
      throw new EvidenceGraphLifecycleErrorV3("observation_transition_conflict", "Observation lifecycle changed concurrently");
    }
  }

  async getAssertion(id: string): Promise<EvidenceGraphAssertionV3 | null> {
    const result = await this.client.query<AssertionRow>(
      "SELECT * FROM corpus_promoted_assertions WHERE id=$1 FOR UPDATE",
      [id],
    );
    return result.rows[0] ? assertionFromRow(result.rows[0]) : null;
  }

  async transitionAssertion(input: {
    assertionId: string;
    from: readonly EvidenceGraphAssertionV3["status"][];
    to: EvidenceGraphAssertionV3["status"];
    at: Date;
  }): Promise<void> {
    const result = await this.client.query(
      `UPDATE corpus_promoted_assertions
       SET status=$3,valid_to=CASE WHEN $3='active' THEN NULL ELSE $4 END,
           retracted_at=CASE WHEN $3='retracted' THEN $4 ELSE retracted_at END
       WHERE id=$1 AND status=ANY($2::varchar[])`,
      [input.assertionId, input.from, input.to, input.at],
    );
    if (result.rowCount !== 1) {
      throw new EvidenceGraphLifecycleErrorV3("assertion_transition_conflict", "Assertion lifecycle changed concurrently");
    }
  }

  async listActiveAssertionBundles(): Promise<EvidenceGraphAssertionBundleV3[]> {
    const result = await this.client.query<AssertionEvidenceRow>(
      `SELECT a.*,
         o.id observation_id,o.observation_key,o.source_document_id,
         o.subject_entity_id observation_subject_entity_id,o.recording_id observation_recording_id,
         o.release_id observation_release_id,o.predicate observation_predicate,
         o.object_json observation_object_json,o.credit_scope observation_credit_scope,
         o.support_excerpt observation_support_excerpt,o.confidence observation_confidence,
         o.status observation_status,o.pipeline_version observation_pipeline_version,
         o.policy_version observation_policy_version,o.observed_at observation_observed_at,
         s.id source_id,s.url source_url,s.content_hash source_content_hash,s.title source_title,
         s.source_class,s.provenance_root source_provenance_root,s.access_method source_access_method,
         s.approval_state source_approval_state,s.authority source_authority,
         s.license_state source_license_state,s.license_version source_license_version,
         s.terms_version source_terms_version,s.attribution source_attribution,
         s.cache_policy source_cache_policy,s.retention_policy source_retention_policy,
         s.freshness_policy source_freshness_policy,s.freshness_expires_at source_freshness_expires_at,
         s.source_revision source_source_revision,s.approved_by source_approved_by,
         s.approved_at source_approved_at,s.takedown_reason source_takedown_reason,
         s.taken_down_at source_taken_down_at,s.status source_status,
         s.retrieved_at source_retrieved_at,s.last_verified_at source_last_verified_at,
         s.metadata_json source_metadata_json
       FROM corpus_promoted_assertions a
       LEFT JOIN corpus_assertion_evidence ae ON ae.promoted_assertion_id=a.id
       LEFT JOIN corpus_assertion_observations o ON o.id=ae.observation_id
       LEFT JOIN corpus_source_documents s ON s.id=o.source_document_id
       WHERE a.status='active'
       ORDER BY a.id,o.id`,
    );
    const byId = new Map<string, EvidenceGraphAssertionBundleV3>();
    for (const row of result.rows) {
      const bundle = byId.get(row.id) ?? { assertion: assertionFromRow(row), evidence: [] };
      if (row.observation_id && row.source_id) {
        bundle.evidence.push({
          observation: observationFromRow({
            id: row.observation_id,
            observation_key: row.observation_key!,
            source_document_id: row.source_document_id!,
            subject_entity_id: row.observation_subject_entity_id ?? null,
            recording_id: row.observation_recording_id ?? null,
            release_id: row.observation_release_id ?? null,
            predicate: row.observation_predicate!,
            object_json: row.observation_object_json ?? {},
            credit_scope: row.observation_credit_scope ?? null,
            support_excerpt: row.observation_support_excerpt!,
            confidence: row.observation_confidence!,
            status: row.observation_status!,
            pipeline_version: row.observation_pipeline_version!,
            policy_version: row.observation_policy_version!,
            observed_at: row.observation_observed_at!,
          }),
          source: sourceFromRow({
            id: row.source_id,
            url: row.source_url!,
            content_hash: row.source_content_hash!,
            title: row.source_title!,
            source_class: row.source_class!,
            provenance_root: row.source_provenance_root!,
            access_method: row.source_access_method!,
            approval_state: row.source_approval_state!,
            authority: row.source_authority!,
            license_state: row.source_license_state!,
            license_version: row.source_license_version ?? null,
            terms_version: row.source_terms_version ?? null,
            attribution: row.source_attribution ?? null,
            cache_policy: row.source_cache_policy!,
            retention_policy: row.source_retention_policy!,
            freshness_policy: row.source_freshness_policy!,
            freshness_expires_at: row.source_freshness_expires_at ?? null,
            source_revision: row.source_source_revision!,
            approved_by: row.source_approved_by ?? null,
            approved_at: row.source_approved_at ?? null,
            takedown_reason: row.source_takedown_reason ?? null,
            taken_down_at: row.source_taken_down_at ?? null,
            status: row.source_status!,
            retrieved_at: row.source_retrieved_at!,
            last_verified_at: row.source_last_verified_at ?? null,
            metadata_json: row.source_metadata_json ?? {},
          }),
        });
      }
      byId.set(row.id, bundle);
    }
    return [...byId.values()];
  }

  async listAvailableCatalogIdentities(recordingIds: readonly string[]): Promise<EvidenceGraphCatalogIdentityV3[]> {
    if (recordingIds.length === 0) return [];
    const result = await this.client.query<QueryResultRow & {
      id: string;
      recording_id: string;
      provider: string;
      storefront: string;
      catalog_id: string;
      is_preferred: boolean;
      is_available: boolean;
      identity_confidence: string | number;
    }>(
      `SELECT id,recording_id,provider,storefront,catalog_id,is_preferred,is_available,identity_confidence
       FROM corpus_catalog_identities
       WHERE recording_id=ANY($1::uuid[]) AND is_available=true`,
      [[...new Set(recordingIds)]],
    );
    return result.rows.map((row) => ({
      id: row.id,
      recordingId: row.recording_id,
      provider: row.provider,
      storefront: row.storefront,
      catalogId: row.catalog_id,
      isPreferred: row.is_preferred,
      isAvailable: row.is_available,
      identityConfidence: Number(row.identity_confidence),
    }));
  }

  async acquireSnapshotHashLock(contentHash: string): Promise<void> {
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [contentHash]);
  }

  async findLockedSnapshotByHash(contentHash: string): Promise<EvidenceGraphSnapshotV3 | null> {
    const result = await this.client.query<QueryResultRow & {
      id: string;
      parent_snapshot_id: string | null;
      status: EvidenceGraphSnapshotV3["status"];
      content_hash: string | null;
      assertion_count: number;
      catalog_identity_count: number;
      locked_at: Date | null;
    }>("SELECT * FROM graph_snapshots WHERE content_hash=$1 AND status='locked'", [contentHash]);
    const row = result.rows[0];
    return row ? {
      id: row.id,
      parentSnapshotId: row.parent_snapshot_id,
      status: row.status,
      contentHash: row.content_hash,
      assertionCount: row.assertion_count,
      catalogIdentityCount: row.catalog_identity_count,
      lockedAt: row.locked_at,
    } : null;
  }

  async insertBuildingSnapshot(input: { id: string; parentSnapshotId: string | null }): Promise<void> {
    await this.client.query(
      "INSERT INTO graph_snapshots(id,parent_snapshot_id,status) VALUES($1,$2,'building')",
      [input.id, input.parentSnapshotId],
    );
  }

  async addSnapshotAssertions(snapshotId: string, assertionIds: readonly string[]): Promise<void> {
    if (assertionIds.length === 0) return;
    await this.client.query(
      `INSERT INTO graph_snapshot_assertions(graph_snapshot_id,assertion_id)
       SELECT $1,unnest($2::uuid[])`,
      [snapshotId, [...new Set(assertionIds)]],
    );
  }

  async addSnapshotCatalogIdentities(snapshotId: string, catalogIdentityIds: readonly string[]): Promise<void> {
    if (catalogIdentityIds.length === 0) return;
    await this.client.query(
      `INSERT INTO graph_snapshot_catalog_identities(graph_snapshot_id,catalog_identity_id)
       SELECT $1,unnest($2::uuid[])`,
      [snapshotId, [...new Set(catalogIdentityIds)]],
    );
  }

  async lockSnapshot(input: {
    snapshotId: string;
    contentHash: string;
    assertionCount: number;
    catalogIdentityCount: number;
    lockedAt: Date;
  }): Promise<EvidenceGraphSnapshotV3> {
    const result = await this.client.query<QueryResultRow & {
      id: string;
      parent_snapshot_id: string | null;
      status: EvidenceGraphSnapshotV3["status"];
      content_hash: string | null;
      assertion_count: number;
      catalog_identity_count: number;
      locked_at: Date | null;
    }>(
      `UPDATE graph_snapshots
       SET status='locked',content_hash=$2,assertion_count=$3,catalog_identity_count=$4,locked_at=$5
       WHERE id=$1 AND status='building'
       RETURNING *`,
      [input.snapshotId, input.contentHash, input.assertionCount, input.catalogIdentityCount, input.lockedAt],
    );
    const row = result.rows[0];
    if (!row) throw new EvidenceGraphLifecycleErrorV3("snapshot_lock_conflict", "Snapshot is not in the building state");
    return {
      id: row.id,
      parentSnapshotId: row.parent_snapshot_id,
      status: row.status,
      contentHash: row.content_hash,
      assertionCount: row.assertion_count,
      catalogIdentityCount: row.catalog_identity_count,
      lockedAt: row.locked_at,
    };
  }
}

/**
 * Schema-14 repository. It deliberately exposes no update/delete operations
 * for observation or assertion content: only constrained lifecycle transitions
 * are mutable, and snapshot membership is writable only while building.
 */
export class PgEvidenceGraphRepositoryV3 implements EvidenceGraphRepositoryV3 {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  private async read<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await callback(client);
    } finally {
      client.release();
    }
  }

  async listSources(input: {
    limit: number;
    offset: number;
    status?: string | null;
  }): Promise<EvidenceGraphOwnerPageV3<EvidenceGraphSourceDocumentV3>> {
    return this.read(async (client) => {
      const [count, rows] = await Promise.all([
        client.query<{ count: number }>(
          "SELECT count(*)::int count FROM corpus_source_documents WHERE ($1::varchar IS NULL OR status=$1)",
          [input.status ?? null],
        ),
        client.query<SourceRow>(
          `SELECT id,url,content_hash,title,source_class,provenance_root,access_method,
                  approval_state,authority,license_state,license_version,terms_version,attribution,
                  cache_policy,retention_policy,freshness_policy,freshness_expires_at,source_revision,
                  approved_by,approved_at,takedown_reason,taken_down_at,status,retrieved_at,
                  last_verified_at,metadata_json
           FROM corpus_source_documents
           WHERE ($1::varchar IS NULL OR status=$1)
           ORDER BY retrieved_at DESC,id DESC LIMIT $2 OFFSET $3`,
          [input.status ?? null, input.limit, input.offset],
        ),
      ]);
      return {
        items: rows.rows.map(sourceFromRow),
        total: Number(count.rows[0]?.count ?? 0),
        limit: input.limit,
        offset: input.offset,
      };
    });
  }

  async listObservations(input: {
    limit: number;
    offset: number;
    status?: EvidenceGraphObservationV3["status"] | null;
  }): Promise<EvidenceGraphOwnerPageV3<EvidenceGraphObservationOwnerViewV3>> {
    return this.read(async (client) => {
      const [count, rows] = await Promise.all([
        client.query<{ count: number }>(
          "SELECT count(*)::int count FROM corpus_assertion_observations WHERE ($1::varchar IS NULL OR status=$1)",
          [input.status ?? null],
        ),
        client.query<ObservationRow & {
          source_title: string;
          source_url: string;
          source_provenance_root: string;
          source_status: string;
        }>(
          `SELECT o.*,s.title source_title,s.url source_url,
                  s.provenance_root source_provenance_root,s.status source_status
           FROM corpus_assertion_observations o
           JOIN corpus_source_documents s ON s.id=o.source_document_id
           WHERE ($1::varchar IS NULL OR o.status=$1)
           ORDER BY o.observed_at DESC,o.id DESC LIMIT $2 OFFSET $3`,
          [input.status ?? null, input.limit, input.offset],
        ),
      ]);
      return {
        items: rows.rows.map((row) => ({
          observation: observationFromRow(row),
          source: {
            id: row.source_document_id,
            title: row.source_title,
            url: row.source_url,
            provenanceRoot: row.source_provenance_root,
            status: row.source_status,
          },
        })),
        total: Number(count.rows[0]?.count ?? 0),
        limit: input.limit,
        offset: input.offset,
      };
    });
  }

  async listAssertions(input: {
    limit: number;
    offset: number;
    status?: EvidenceGraphAssertionV3["status"] | null;
  }): Promise<EvidenceGraphOwnerPageV3<EvidenceGraphAssertionOwnerViewV3>> {
    return this.read(async (client) => {
      const [count, rows] = await Promise.all([
        client.query<{ count: number }>(
          "SELECT count(*)::int count FROM corpus_promoted_assertions WHERE ($1::varchar IS NULL OR status=$1)",
          [input.status ?? null],
        ),
        client.query<AssertionRow & { evidence_count: number }>(
          `SELECT a.*,count(e.observation_id)::int evidence_count
           FROM corpus_promoted_assertions a
           LEFT JOIN corpus_assertion_evidence e ON e.promoted_assertion_id=a.id
           WHERE ($1::varchar IS NULL OR a.status=$1)
           GROUP BY a.id
           ORDER BY a.promoted_at DESC,a.id DESC LIMIT $2 OFFSET $3`,
          [input.status ?? null, input.limit, input.offset],
        ),
      ]);
      return {
        items: rows.rows.map((row) => ({
          assertion: assertionFromRow(row),
          evidenceCount: Number(row.evidence_count),
        })),
        total: Number(count.rows[0]?.count ?? 0),
        limit: input.limit,
        offset: input.offset,
      };
    });
  }

  async listSnapshots(input: {
    limit: number;
    offset: number;
    status?: EvidenceGraphSnapshotV3["status"] | null;
  }): Promise<EvidenceGraphOwnerPageV3<EvidenceGraphSnapshotV3>> {
    return this.read(async (client) => {
      type SnapshotRow = QueryResultRow & {
        id: string;
        parent_snapshot_id: string | null;
        status: EvidenceGraphSnapshotV3["status"];
        content_hash: string | null;
        assertion_count: number;
        catalog_identity_count: number;
        locked_at: Date | null;
      };
      const [count, rows] = await Promise.all([
        client.query<{ count: number }>(
          "SELECT count(*)::int count FROM graph_snapshots WHERE ($1::varchar IS NULL OR status=$1)",
          [input.status ?? null],
        ),
        client.query<SnapshotRow>(
          `SELECT id,parent_snapshot_id,status,content_hash,assertion_count,
                  catalog_identity_count,locked_at
           FROM graph_snapshots WHERE ($1::varchar IS NULL OR status=$1)
           ORDER BY sequence DESC,id DESC LIMIT $2 OFFSET $3`,
          [input.status ?? null, input.limit, input.offset],
        ),
      ]);
      return {
        items: rows.rows.map((row) => ({
          id: row.id,
          parentSnapshotId: row.parent_snapshot_id,
          status: row.status,
          contentHash: row.content_hash,
          assertionCount: Number(row.assertion_count),
          catalogIdentityCount: Number(row.catalog_identity_count),
          lockedAt: row.locked_at,
        })),
        total: Number(count.rows[0]?.count ?? 0),
        limit: input.limit,
        offset: input.offset,
      };
    });
  }

  async transaction<T>(callback: (unit: EvidenceGraphUnitOfWorkV3) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(new PgEvidenceGraphUnitOfWorkV3(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
