import { expect, test, vi } from "vitest";
import { createApplePhaseZeroManifest } from "../server/apple-phase-zero-manifest.ts";
import type { ApplePhaseZeroManifestInput } from "../server/apple-phase-zero.ts";

test("phase-zero JSON recordset payload uses the exact PostgreSQL column keys", async () => {
  let manifestInsert: unknown[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT id,run_id,name,description,content_hash,locked_at FROM manifests WHERE run_id")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO manifests")) manifestInsert = params;
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM manifests WHERE id")) {
        return {
          rows: [{
            id: manifestInsert[0],
            run_id: manifestInsert[1],
            name: manifestInsert[2],
            description: manifestInsert[3],
            content_hash: manifestInsert[4],
            locked_at: new Date("2026-07-14T12:00:00.000Z"),
          }],
        };
      }
      return { rows: [] };
    }),
  };
  const input: ApplePhaseZeroManifestInput = {
    suiteId: "recordset-fixture",
    fixtureHash: "a".repeat(64),
    caseId: "three",
    storefront: "us",
    name: "[NEEDLE TEST] recordset fixture",
    description: "Recordset regression fixture.",
    tracks: ["101", "202", "101"].map((id, index) => ({
      id,
      name: `Track ${index}`,
      artistName: "Artist",
      albumName: "Album",
      releaseDate: "2020-01-01",
      durationInMillis: 180_000,
      versionLabel: "original",
    })),
  };

  await createApplePhaseZeroManifest({ pool } as any, input);

  const candidateInsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO track_candidates"));
  const rows = JSON.parse(String(candidateInsert?.[1]?.[0])) as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({
    candidate_id: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    canonical_key: expect.any(String),
    release_year: 2020,
    duration_ms: 180_000,
    version_label: "original",
    catalog_id: "101",
    evidence_id: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    match_id: expect.stringMatching(/^[a-f0-9-]{36}$/u),
  });
  expect(rows[0]).not.toHaveProperty("candidateId");
  expect(rows[0]).not.toHaveProperty("canonicalKey");

  const evidenceInsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO evidence_claims"));
  expect(String(evidenceInsert?.[0])).toContain("x.artist || ' — ' || x.title");
  expect(String(evidenceInsert?.[0])).toContain("'operational Apple catalog fixture'");
});
