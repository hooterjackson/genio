import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  PgPipelineV3GovernedGraphReadRepository,
} from "../server/pipeline-v3-governed-graph-adapter.ts";
import { createQueryPlanV3, queryPlanV3Hash } from "../server/query-plan-v3.ts";
import { selectionPlanV3Hash, type SelectionPlanV3 } from "../server/selection-plan-v3.ts";
import { MUSIC_CONCEPT_POLICY_VERSION } from "../server/music-concepts-v3.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationSql = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort()
  .map((file) => readFileSync(new URL(`../postgres-migrations/${file}`, import.meta.url), "utf8"))
  .join("\n-- statement-breakpoint\n");

async function applySql(pool: Pool, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of sql
      .split(/\s*-- statement-breakpoint\s*/u)
      .map((value) => value.trim())
      .filter(Boolean)) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function factualPlan(count: number): SelectionPlanV3 {
  const membershipPredicates: SelectionPlanV3["membershipPredicates"] = [
    {
      id: "subject-paulinho",
      axis: "artist",
      operator: "require",
      values: ["Paulinho da Costa"],
      source: "user",
      reason: "The exact credited performer is required.",
    },
    {
      id: "relationship-performed",
      axis: "factual_relationship",
      operator: "require",
      values: ["subject_performed"],
      source: "user",
      reason: "The exact recording must carry a performance credit.",
    },
  ];
  const semanticClauses: SelectionPlanV3["semanticClauses"] = membershipPredicates.map((predicate) => ({
    id: predicate.id,
    role: "membership",
    axis: predicate.axis,
    operator: predicate.operator,
    values: [...predicate.values],
    source: "raw_prompt",
    explicitUserAuthored: true,
    geographyRelationship: null,
    reason: predicate.reason,
  }));
  return {
    schemaVersion: 1,
    pipelineVersion: "corpus_first_v3",
    selectionPlanVersion: "selection_plan_v3",
    prompt: `${count} Paulinho da Costa performance credits`,
    requestedTrackCount: count,
    storefront: "us",
    intents: ["factual_relationship"],
    engines: ["factual_relationship"],
    membershipPredicates,
    rankingObjectives: [{
      id: "ranking-influence",
      dimension: "influence",
      direction: "maximize",
      weight: 1,
      relaxationRank: null,
      values: [],
      reason: "Rank evidence-qualified credits by documented influence.",
    }],
    scopeKind: "factual_frontier",
    hardConstraints: [],
    softPreferences: [],
    sourceDiscoveryHints: [],
    diversityGoals: {
      minimumDistinctArtists: null,
      minimumDistinctAlbums: null,
      minimumDistinctEras: null,
      minimumDistinctScenes: null,
      minimumDistinctGeographies: null,
      maximumTracksPerArtist: null,
      maximumTracksPerAlbum: null,
    },
    orderingPolicy: {
      mode: "editorial",
      goals: [],
      avoidAdjacentSameArtist: false,
      avoidAdjacentSameAlbum: false,
    },
    softGoalRelaxationOrder: [],
    criticalAmbiguities: [],
    recordingPolicy: {
      allowedVersions: ["canonical", "clean", "explicit"],
      preferCanonicalStudio: true,
      excludeKaraokeTributeAndCovers: true,
    },
    semanticPolicyVersion: "scope_gate_v2_1_2",
    musicConceptPolicyVersion: MUSIC_CONCEPT_POLICY_VERSION,
    semanticClauses,
    contextSignals: [],
    catalogPolicies: [],
    explicitUserConstraintHash: sha(`${count}:Paulinho da Costa performance credits`),
    confirmed: true,
    resolvedAmbiguityKeys: [],
  };
}

databaseDescribe("Pipeline V3 governed graph runtime adapter", () => {
  const schemaName = `genio_graph_runtime_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl, max: 2, application_name: "graph-runtime-admin" });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 4,
      application_name: "graph-runtime-integration",
    });
    await applySql(pool, migrationSql);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  test("reads only the active frozen snapshot, rejects album-only and uncorroborated claims, and paginates past 100", async () => {
    const runId = randomUUID();
    const selectionPlanId = randomUUID();
    const queryPlanId = randomUUID();
    const activeSnapshotId = randomUUID();
    const otherSnapshotId = randomUUID();
    const subjectId = randomUUID();
    const unrelatedSubjectId = randomUUID();
    const primaryArtistId = randomUUID();
    const primarySourceId = randomUUID();
    const mediumSourceId = randomUUID();
    const plan = factualPlan(125);

    await pool.query(
      `INSERT INTO corpus_entities(id,entity_type,canonical_key,canonical_name)
       VALUES($1,'person','person:paulinho-da-costa','Paulinho da Costa'),
             ($2,'artist','artist:runtime','Runtime Ensemble'),
             ($3,'person','person:unrelated-performer','Unrelated Performer')`,
      [subjectId, primaryArtistId, unrelatedSubjectId],
    );
    await pool.query(
      `INSERT INTO corpus_source_documents(
         id,url,content_hash,title,source_class,provenance_root,access_method,approval_state,
         authority,license_state,license_version,terms_version,attribution,cache_policy,
         retention_policy,freshness_policy,source_revision,approved_by,approved_at,
         status,retrieved_at,last_verified_at,metadata_json
       ) VALUES
         ($1,'https://credits.example/paulinho',$2,'Exact track credits','liner_notes','credits.example',
          'manual_entry','approved','primary_track_credit','permission_recorded','test-permission-v1',
          'test-terms-v1','Exact track credits','excerpt_only','durable_public_corpus',
          'immutable_revision',$2,'integration-owner','2026-07-20T12:00:00.000Z','active',now(),now(),'{}'::jsonb),
         ($3,'https://database.example/paulinho',$4,'Secondary credits','database','database.example',
          'manual_entry','approved','secondary_database','permission_recorded','test-permission-v1',
          'test-terms-v1','Secondary credits','excerpt_only','durable_public_corpus',
          'immutable_revision',$4,'integration-owner','2026-07-20T12:00:00.000Z','active',now(),now(),'{}'::jsonb)`,
      [
        primarySourceId, sha("primary-source"), mediumSourceId, sha("medium-source"),
      ],
    );

    const valid = Array.from({ length: 125 }, (_, index) => ({
      recordingId: randomUUID(),
      observationId: randomUUID(),
      assertionId: randomUUID(),
      identityId: randomUUID(),
      title: `Exact Credit ${String(index + 1).padStart(3, "0")}`,
      appleId: `apple-exact-${index + 1}`,
      key: sha(`valid-${index}`),
      subjectId,
    }));
    const invalid = [
      {
        recordingId: randomUUID(), observationId: randomUUID(), assertionId: randomUUID(),
        identityId: randomUUID(), title: "Album-only Credit", appleId: "apple-album-only",
        key: sha("album-only"), scope: "album", tier: "verified", sourceId: primarySourceId, subjectId,
      },
      {
        recordingId: randomUUID(), observationId: randomUUID(), assertionId: randomUUID(),
        identityId: randomUUID(), title: "Single-root Corroboration", appleId: "apple-single-root",
        key: sha("single-root"), scope: "exact_recording", tier: "corroborated", sourceId: mediumSourceId, subjectId,
      },
    ];
    const other = {
      recordingId: randomUUID(), observationId: randomUUID(), assertionId: randomUUID(),
      identityId: randomUUID(), title: "Other Snapshot Credit", appleId: "apple-other-snapshot",
      key: sha("other-snapshot"), subjectId,
    };
    // More unrelated frozen assertions than one full traversal page prove
    // pagination is subject-scoped before limits are applied.
    const unrelated = Array.from({ length: 80 }, (_, index) => ({
      recordingId: randomUUID(), observationId: randomUUID(), assertionId: randomUUID(),
      identityId: randomUUID(), title: `Unrelated Credit ${String(index + 1).padStart(3, "0")}`,
      appleId: `apple-unrelated-${index + 1}`, key: sha(`unrelated-${index}`), subjectId: unrelatedSubjectId,
      scope: "exact_recording", tier: "verified", sourceId: primarySourceId,
    }));
    const all = [
      ...valid.map((row) => ({ ...row, scope: "exact_recording", tier: "verified", sourceId: primarySourceId })),
      ...invalid,
      { ...other, scope: "exact_recording", tier: "verified", sourceId: primarySourceId },
      ...unrelated,
    ];

    await pool.query(
      `INSERT INTO corpus_recordings(id,canonical_key,primary_artist_entity_id,title,version_class,metadata_json)
       SELECT x.id,x.canonical_key,$2,x.title,'studio','{}'::jsonb
       FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,canonical_key text,title text)`,
      [JSON.stringify(all.map((row) => ({ id: row.recordingId, canonical_key: `recording:${row.key}`, title: row.title }))), primaryArtistId],
    );
    await pool.query(
      `INSERT INTO corpus_assertion_observations(
         id,observation_key,source_document_id,subject_entity_id,recording_id,predicate,object_json,
         credit_scope,support_excerpt,confidence,status,pipeline_version,policy_version
       )
       SELECT x.observation_id,x.observation_key,x.source_id,x.subject_id,x.recording_id,'performance_credit',
              jsonb_build_object('graph',jsonb_build_object(
                'relationship','performed_on','supportedValues',jsonb_build_array('performed'),
                'polarity','supports','scope',x.scope)),
              x.scope,'The governed source credits the performer on this recording.',0.99,'promoted',
              'corpus_first_v3','corpus_first_v3_policy_v1'
       FROM jsonb_to_recordset($1::jsonb) AS x(
         observation_id uuid,observation_key text,source_id uuid,subject_id uuid,recording_id uuid,scope text
       )`,
      [JSON.stringify(all.map((row) => ({
        observation_id: row.observationId, observation_key: sha(`observation:${row.key}`),
        source_id: row.sourceId, subject_id: row.subjectId, recording_id: row.recordingId, scope: row.scope,
      })))],
    );
    await pool.query(
      `INSERT INTO corpus_promoted_assertions(
         id,assertion_key,subject_entity_id,recording_id,predicate,object_json,evidence_tier,status,promoted_by
       )
       SELECT x.assertion_id,x.assertion_key,x.subject_id,x.recording_id,'performance_credit',
              jsonb_build_object('graph',jsonb_build_object(
                'relationship','performed_on','supportedValues',jsonb_build_array('performed'),
                'polarity','supports','scope',x.scope)),
              x.tier,'active','integration-owner'
       FROM jsonb_to_recordset($1::jsonb) AS x(
         assertion_id uuid,assertion_key text,subject_id uuid,recording_id uuid,scope text,tier text
       )`,
      [JSON.stringify(all.map((row) => ({
        assertion_id: row.assertionId, assertion_key: sha(`assertion:${row.key}`),
        subject_id: row.subjectId, recording_id: row.recordingId, scope: row.scope, tier: row.tier,
      })))],
    );
    await pool.query(
      `INSERT INTO corpus_assertion_evidence(promoted_assertion_id,observation_id)
       SELECT x.assertion_id,x.observation_id
       FROM jsonb_to_recordset($1::jsonb) AS x(assertion_id uuid,observation_id uuid)`,
      [JSON.stringify(all.map((row) => ({ assertion_id: row.assertionId, observation_id: row.observationId })))],
    );
    await pool.query(
      `INSERT INTO corpus_catalog_identities(
         id,recording_id,provider,storefront,catalog_id,is_preferred,is_available,identity_confidence,metadata_json
       )
       SELECT x.identity_id,x.recording_id,'apple','us',x.apple_id,true,true,0.99,
              jsonb_build_object('name',x.title,'artistName','Runtime Ensemble','albumName','Runtime Sessions')
       FROM jsonb_to_recordset($1::jsonb) AS x(
         identity_id uuid,recording_id uuid,apple_id text,title text
       )`,
      [JSON.stringify(all.map((row) => ({
        identity_id: row.identityId, recording_id: row.recordingId, apple_id: row.appleId, title: row.title,
      })))],
    );

    await pool.query("INSERT INTO graph_snapshots(id,status) VALUES($1,'building'),($2,'building')", [activeSnapshotId, otherSnapshotId]);
    const activeRows = all.filter((row) => row.recordingId !== other.recordingId);
    await pool.query(
      `INSERT INTO graph_snapshot_assertions(graph_snapshot_id,assertion_id)
       SELECT $1,x.assertion_id FROM jsonb_to_recordset($2::jsonb) AS x(assertion_id uuid)`,
      [activeSnapshotId, JSON.stringify(activeRows.map((row) => ({ assertion_id: row.assertionId })))],
    );
    await pool.query(
      `INSERT INTO graph_snapshot_catalog_identities(graph_snapshot_id,catalog_identity_id)
       SELECT $1,x.identity_id FROM jsonb_to_recordset($2::jsonb) AS x(identity_id uuid)`,
      [activeSnapshotId, JSON.stringify(activeRows.map((row) => ({ identity_id: row.identityId })))],
    );
    await pool.query(
      "INSERT INTO graph_snapshot_assertions(graph_snapshot_id,assertion_id) VALUES($1,$2)",
      [otherSnapshotId, other.assertionId],
    );
    await pool.query(
      "INSERT INTO graph_snapshot_catalog_identities(graph_snapshot_id,catalog_identity_id) VALUES($1,$2)",
      [otherSnapshotId, other.identityId],
    );
    await pool.query(
      `UPDATE graph_snapshots SET status='locked',content_hash=$2,assertion_count=$3,
         catalog_identity_count=$3,locked_at=now() WHERE id=$1`,
      [activeSnapshotId, sha("active-snapshot"), activeRows.length],
    );
    await pool.query(
      `UPDATE graph_snapshots SET status='locked',content_hash=$2,assertion_count=1,
         catalog_identity_count=1,locked_at=now() WHERE id=$1`,
      [otherSnapshotId, sha("other-snapshot")],
    );

    await pool.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,idempotency_key,
         retention_expires_at,pipeline_version,policy_version
       ) VALUES($1,$2,'{}'::jsonb,$3,'researching','research','graph-runtime',$4,
         now()+interval '1 day','corpus_first_v3','corpus_first_v3_policy_v1')`,
      [runId, plan.prompt, sha("brief"), randomUUID()],
    );
    await pool.query(
      `INSERT INTO run_specs(
         run_id,raw_prompt,requested_track_count,storefront,guidance_answers_json,spec_hash,pipeline_version,policy_version
       ) VALUES($1,$2,125,'us','[]'::jsonb,$3,'corpus_first_v3','corpus_first_v3_policy_v1')`,
      [runId, plan.prompt, sha("spec")],
    );
    const planHash = selectionPlanV3Hash(plan);
    await pool.query(
      `INSERT INTO selection_plans(
         id,run_id,revision,status,plan_hash,plan_json,pipeline_version,policy_version,confirmed_at
       ) VALUES($1,$2,1,'active',$3,$4::jsonb,'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
      [selectionPlanId, runId, planHash, JSON.stringify(plan)],
    );
    const queryPlan = createQueryPlanV3(plan, activeSnapshotId);
    await pool.query(
      `INSERT INTO query_plan_revisions(
         id,run_id,selection_plan_id,revision,graph_snapshot_id,engine,status,plan_hash,plan_json,
         pipeline_version,policy_version,activated_at
       ) VALUES($1,$2,$3,1,$4,'factual_relationship','active',$5,$6::jsonb,
         'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
      [queryPlanId, runId, selectionPlanId, activeSnapshotId, queryPlanV3Hash(queryPlan), JSON.stringify(queryPlan)],
    );
    await pool.query(
      "INSERT INTO run_active_query_plans(run_id,query_plan_revision_id) VALUES($1,$2)",
      [runId, queryPlanId],
    );

    const repository = new PgPipelineV3GovernedGraphReadRepository(pool);
    const found = [];
    let cursor: string | null = null;
    let pageCount = 0;
    do {
      const page = await repository.readGovernedGraphCandidatesV3({
        runId, storefront: "us", cursor, limit: 40,
      });
      pageCount += 1;
      found.push(...page.candidates);
      cursor = page.nextCursor;
    } while (cursor);

    expect(pageCount).toBeGreaterThanOrEqual(4);
    expect(found).toHaveLength(125);
    expect(new Set(found.map(({ appleSong }) => appleSong?.id)).size).toBe(125);
    expect(found.map(({ title }) => title)).not.toContain("Album-only Credit");
    expect(found.map(({ title }) => title)).not.toContain("Single-root Corroboration");
    expect(found.map(({ title }) => title)).not.toContain("Other Snapshot Credit");
    expect(found.every(({ assertionIds, evidenceBindings }) => (
      assertionIds.length === 1
      && evidenceBindings?.length === 1
      && evidenceBindings[0]?.predicateIds.includes("subject-paulinho")
      && evidenceBindings[0]?.predicateIds.includes("relationship-performed")
    ))).toBe(true);
  }, 45_000);
});
