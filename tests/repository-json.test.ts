import { expect, test, vi } from "vitest";
import { Repository } from "../server/repository.ts";
import type { PipelineOutcome, PlaylistBrief, SelectionPlan } from "../shared/types.ts";

const brief: PlaylistBrief = {
  title: "House foundations",
  description: "A scoped house-music playlist.",
  mode: "curated",
  subjectEntities: ["house music"],
  relationship: "genre/scene",
  include: ["house recordings"],
  exclude: [],
  versionPolicy: "canonical studio recordings",
  evidencePolicy: "track scope binding required",
  orderingPolicy: "editorial",
  targetSize: { min: 25, max: 25 },
  ambiguities: [],
};

const selectionPlan: SelectionPlan = {
  schemaVersion: 1,
  pipelineVersion: "catalog_first_v2",
  policyVersion: "catalog_first_v2_policy_v1",
  intents: ["genre_scene"],
  archetypes: ["genre_scene"],
  storefront: "us",
  requestedTrackCount: 25,
  minimumQualifiedTrackCount: 25,
  reserveTrackCount: 5,
  constraints: [{
    id: "requested-genre",
    axis: "genre",
    operator: "include",
    values: ["house"],
    kind: "hard",
    relaxationRank: null,
  }],
  geographyConstraints: [],
  similarityDimensions: [],
  labels: [],
  venues: [],
  referenceRecordings: [],
  softGoalRelaxationOrder: ["artist-concentration", "album-concentration"],
  diversityGoals: {
    minimumDistinctArtists: 10,
    minimumDistinctAlbums: null,
    minimumDistinctEras: null,
    minimumDistinctScenes: null,
    minimumDistinctGeographies: null,
    maximumTracksPerArtist: 3,
    maximumTracksPerAlbum: 2,
  },
  evidencePolicy: "track scope binding required",
  versionPolicy: {
    preferred: ["canonical"],
    allowed: ["canonical", "unknown"],
    excludeCompilations: false,
    excludeKaraokeAndTributes: true,
  },
  orderingPolicy: {
    mode: "editorial",
    goals: ["coherent arc"],
    avoidAdjacentSameArtist: true,
    avoidAdjacentSameAlbum: true,
  },
  contentPolicy: {
    explicitContent: "allow",
    instrumental: "allow",
    languages: [],
  },
};

const pipelineOutcome: PipelineOutcome = {
  schemaVersion: 1,
  pipelineVersion: "catalog_first_v2",
  policyVersion: "catalog_first_v2_policy_v1",
  status: "partial_frontier_exhausted",
  targetTrackCount: 25,
  discoveredTrackCount: 40,
  qualifiedTrackCount: 24,
  selectedTrackCount: 24,
  publishedTrackCount: 24,
  exactCountSatisfied: false,
  frontierExhausted: true,
  providerUnavailable: false,
  reasonCodes: ["scope_frontier_exhausted"],
  deficits: [{
    stage: "scope_qualified",
    kind: "scope_relevance",
    status: "exhausted",
    requiredCount: 25,
    actualCount: 24,
    deficitCount: 1,
    reasonCode: "scope_frontier_exhausted",
    detail: { sourceFamilies: 3 },
    observedAt: "2026-07-19T00:00:00.000Z",
  }],
  completedAt: "2026-07-19T00:00:00.000Z",
};

test("builds a bounded public-safe live progress summary from durable run state", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("SELECT * FROM research_runs")) {
        return { rows: [{
          id: "run-id",
          prompt: "House foundations",
          brief_json: brief,
          status: "matching",
          phase: "catalog_matching",
          auto_publish: true,
          estimated_cost_usd: 1,
          actual_cost_usd: 0.1,
          approved_budget_usd: 1,
          reserved_cost_usd: 0,
          no_new_gap_passes: 0,
          error: null,
          pipeline_version: "catalog_first_v2",
          policy_version: "catalog_first_v2_policy_v1",
          selection_plan_json: selectionPlan,
          pipeline_policy_snapshot_json: null,
          pipeline_outcome_json: null,
          guidance_source_hints_json: [],
          guidance_telemetry_json: null,
          guidance_preferences_json: [],
          created_at: new Date("2026-07-19T00:00:00.000Z"),
          updated_at: new Date("2026-07-19T00:01:00.000Z"),
          completed_at: null,
          budget_approval_expires_at: null,
        }], rowCount: 1 };
      }
      if (text.includes("candidate_stage_counts")) {
        return { rows: [{
          candidate_count: 32,
          source_count: 7,
          recent_sources: [
            { title: "House music history", url: "https://history.example/article?private=1", source_class: "web" },
            { title: "Imported fixture", url: "import://fixture/private", source_class: "import" },
            { title: "Apple editorial", url: "https://music.apple.com/us/playlist/example", source_class: "apple" },
          ],
          candidate_stage_counts: { discovered: 10, catalog_resolved: 22 },
          frontier_total: 4,
          frontier_complete: 2,
          frontier_active: 1,
          frontier_unresolved: 1,
          frontier_inaccessible: 0,
          frontier_discovered_count: 60,
          frontier_recovered_count: 44,
          container_total: 6,
          container_complete: 4,
          container_active: 1,
          container_unresolved: 0,
          container_inaccessible: 1,
          container_advertised_count: 80,
          container_recovered_count: 63,
          match_attempted: 30,
          match_accepted: 21,
          match_review: 2,
          match_unavailable: 1,
          match_duplicate: 2,
          match_rejected: 1,
          match_unsupported: 2,
          match_overflow: 1,
          publication_volume_count: 1,
          publication_completed_volumes: 0,
          publication_total_tracks: 25,
          publication_appended_tracks: 10,
          publication_current_volume: 1,
          publication_status: "appending",
          latest_activity_at: new Date("2026-07-19T00:01:15.000Z"),
          unresolved_count: 3,
        }], rowCount: 1 };
      }
      if (text.includes("SELECT * FROM source_frontier")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected repository query: ${text}`);
    }),
    end: vi.fn(),
  };
  const repository = new Repository({ pool, db: {} } as never);

  const run = await repository.getRun("run-id");

  expect(run.progress).toEqual({
    targetTrackCount: 25,
    latestActivityAt: "2026-07-19T00:01:15.000Z",
    sourceSummary: {
      total: 7,
      recentSources: [
        { title: "House music history", domain: "history.example", sourceClass: "web" },
        { title: "Apple editorial", domain: "music.apple.com", sourceClass: "apple" },
      ],
    },
    frontierSummary: {
      total: 4, complete: 2, active: 1, unresolved: 1, inaccessible: 0,
      discoveredCount: 60, recoveredCount: 44,
    },
    containerSummary: {
      total: 6, complete: 4, active: 1, unresolved: 0, inaccessible: 1,
      advertisedCount: 80, recoveredCount: 63,
    },
    matchSummary: {
      attempted: 30, accepted: 21, review: 2, unavailable: 1, duplicate: 2,
      rejected: 1, unsupported: 2, overflow: 1, shortfall: 4,
    },
    publicationSummary: {
      volumeCount: 1, completedVolumes: 0, totalTracks: 25, appendedTracks: 10,
      currentVolume: 1, status: "appending",
    },
  });
  const aggregate = calls.find((call) => call.text.includes("candidate_stage_counts"));
  expect(aggregate?.text).toContain("LIMIT 8");
  expect(aggregate?.text).not.toContain("source_records.note");
  expect(JSON.stringify(run.progress)).not.toContain("private=1");
  expect(JSON.stringify(run.progress)).not.toContain("import://");
});

test("serializes catalog songs and alternatives as JSONB parameters", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("SELECT id FROM research_runs")) return { rows: [{ id: "run-id" }] };
      if (text.includes("SELECT id FROM track_candidates")) return { rows: [{ id: "candidate-id" }] };
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(),
  };
  const repository = new Repository({ pool, db: {} } as never);
  const song = {
    id: "catalog-primary",
    name: "Track",
    artistName: "Artist",
    albumName: "Album",
  };
  const alternatives = [{
    id: "catalog-alternative",
    name: "Track (Alternate)",
    artistName: "Artist",
    albumName: "Album",
  }];

  await repository.saveMatch("run-id", {
    candidateId: "candidate-id",
    status: "review",
    basis: "ambiguous catalog results",
    score: 0.8,
    song,
    alternatives,
  });

  const insert = calls.find((call) => call.text.includes("INSERT INTO catalog_matches"));
  expect(insert?.values[7]).toBe(JSON.stringify(song));
  expect(insert?.values[8]).toBe(JSON.stringify(alternatives));
});

test("serializes a versioned selection plan into the durable run boundary", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("FROM research_runs WHERE id=$1")) {
        return { rows: [{
          brief_json: brief,
          guidance_telemetry_json: null,
          pipeline_version: "legacy_v1",
          policy_version: "legacy_v1",
          selection_plan_json: null,
          pipeline_policy_snapshot_json: null,
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(),
  };
  const repository = new Repository({ pool, db: {} } as never);

  await repository.savePipelineSelectionPlan("run-id", selectionPlan);

  const update = calls.find((call) => call.text.includes("UPDATE research_runs SET pipeline_version"));
  expect(update?.values?.slice(0, 4)).toEqual([
    "run-id",
    "catalog_first_v2",
    "catalog_first_v2_policy_v1",
    JSON.stringify(selectionPlan),
  ]);
  expect(JSON.parse(String(update?.values?.[4]))).toMatchObject({
    pipelineVersion: "catalog_first_v2",
    policyVersion: "catalog_first_v2_policy_v1",
    storefront: "us",
  });
});

test("serializes a pipeline outcome and its deficit snapshot transactionally", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("SELECT pipeline_version,policy_version FROM research_runs")) {
        return { rows: [{
          pipeline_version: pipelineOutcome.pipelineVersion,
          policy_version: pipelineOutcome.policyVersion,
        }] };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(),
  };
  const repository = new Repository({ pool, db: {} } as never);

  await repository.savePipelineOutcome("run-id", pipelineOutcome);

  const insert = calls.find((call) => call.text.includes("INSERT INTO pipeline_outcomes"));
  expect(insert?.values[11]).toBe(JSON.stringify(pipelineOutcome.reasonCodes));
  expect(insert?.values[12]).toBe(JSON.stringify(pipelineOutcome.deficits));
  expect(insert?.values[13]).toBe(JSON.stringify(pipelineOutcome));
  const runUpdate = calls.find((call) => call.text.includes("pipeline_outcome_json=$2"));
  expect(runUpdate?.values).toEqual([
    "run-id",
    JSON.stringify(pipelineOutcome),
  ]);
  expect(calls.at(0)?.text).toBe("BEGIN");
  expect(calls.at(-1)?.text).toBe("COMMIT");
  expect(client.release).toHaveBeenCalledOnce();
});

test("serializes recording-family metadata and returns the idempotent family id", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: [{ id: "family-id" }], rowCount: 1 };
    }),
    end: vi.fn(),
  };
  const repository = new Repository({ pool, db: {} } as never);

  const id = await repository.upsertRecordingFamily("run-id", {
    familyKey: "isrc:USABC1234567",
    canonicalArtist: "Artist",
    canonicalTitle: "Track",
    versionClass: "canonical",
    metadata: { source: "apple" },
    pipelineVersion: "catalog_first_v2",
    policyVersion: "catalog_first_v2_policy_v1",
  });

  expect(id).toBe("family-id");
  expect(calls[0]?.values[6]).toBe(JSON.stringify({ source: "apple" }));
  expect(calls[0]?.text).toContain("ON CONFLICT(run_id,family_key)");
});

test("durably caps MusicBrainz enrichment requests at five with a locked checkpoint", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let checkpoint: Record<string, unknown> | null = null;
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("SELECT id FROM research_runs")) return { rows: [{ id: "run-id" }], rowCount: 1 };
      if (text.includes("SELECT state_json FROM research_checkpoints")) {
        return { rows: checkpoint ? [{ state_json: checkpoint }] : [], rowCount: checkpoint ? 1 : 0 };
      }
      if (text.includes("INSERT INTO research_checkpoints") || text.includes("UPDATE research_checkpoints")) {
        checkpoint = JSON.parse(String(values[2])) as Record<string, unknown>;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), end: vi.fn() };
  const repository = new Repository({ pool, db: {} } as never);

  const reservations = [];
  for (let index = 0; index < 6; index += 1) {
    reservations.push(await repository.reserveMusicBrainzEnrichmentRequest("run-id", 5));
  }

  expect(reservations).toEqual([1, 2, 3, 4, 5, null]);
  expect(checkpoint).toMatchObject({
    version: "musicbrainz_identity_budget_v1",
    uncachedRequests: 5,
    maximum: 5,
  });
  expect(calls.filter((call) => call.text.includes("SELECT state_json FROM research_checkpoints")))
    .toHaveLength(6);
  expect(calls.find((call) => call.text.includes("SELECT state_json FROM research_checkpoints"))?.text)
    .toContain("FOR UPDATE");
});

test("serializes run-scoped scope binding provenance through an idempotent upsert", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("INSERT INTO track_scope_bindings")) return { rows: [{ id: "binding-id" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), end: vi.fn() };
  const repository = new Repository({ pool, db: {} } as never);
  const provenancePath = [{ kind: "source", id: "source-id", label: "Discography" }];

  await repository.saveTrackScopeBindings("run-id", "candidate-id", [{
    bindingKind: "track_specific_source",
    eligibility: "qualifying",
    scopeAxis: "factual_relationship",
    scopeValue: "performed on",
    relationship: "has a track-level percussion credit",
    confidence: 0.99,
    sourceUrl: "https://example.com/credits",
    sourceRecordId: "00000000-0000-4000-a000-000000000001",
    researchContainerId: null,
    citationAttestationId: null,
    provenancePath,
    note: "Explicit track credit",
  }], {
    pipelineVersion: "catalog_first_v2",
    policyVersion: "catalog_first_v2_policy_v1",
  });

  const insert = calls.find((call) => call.text.includes("INSERT INTO track_scope_bindings"));
  expect(insert?.values[13]).toBe(JSON.stringify(provenancePath));
  expect(insert?.text).toContain("ON CONFLICT ON CONSTRAINT scope_binding_unique_key");
  expect(calls.at(0)?.text).toBe("BEGIN");
  expect(calls.at(-1)?.text).toBe("COMMIT");
});
