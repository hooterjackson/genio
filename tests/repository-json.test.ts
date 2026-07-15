import { expect, test, vi } from "vitest";
import { Repository } from "../server/repository.ts";

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
