import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { normalizeMusicText } from "../lib/matching.ts";
import { assertPublicHttpsUrl } from "../server/security.ts";

interface HoldoutRow {
  artist: string;
  title: string;
  album: string;
  source: string;
  evidenceType: string;
  evidenceNote: string;
}

interface HoldoutFixture {
  version: string;
  note: string;
  methodology: {
    frozenAt: string;
    independence: string;
    paulinho_da_costa: { classification: string; scope: string; coverageLimit: string };
    michael_jackson: { classification: string; scope: string; coverageLimit: string };
  };
  paulinho_da_costa: HoldoutRow[];
  michael_jackson: HoldoutRow[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/frozen-holdout.json", import.meta.url), "utf8"),
) as HoldoutFixture;

function recoveryKey(row: HoldoutRow): string {
  return `${normalizeMusicText(row.artist)}\u0000${normalizeMusicText(row.title)}`;
}

describe("independently frozen acceptance holdouts", () => {
  test("declares a dated, non-runtime methodology and honest coverage limits", () => {
    expect(fixture.version).toBe("2026-07-14");
    expect(fixture.methodology.frozenAt).toBe(fixture.version);
    expect(fixture.note).toMatch(/not from gênio research output/i);
    expect(fixture.methodology.independence).toMatch(/must never be used/i);
    expect(fixture.methodology.paulinho_da_costa.classification).toMatch(/not a complete career catalogue/i);
    expect(fixture.methodology.paulinho_da_costa.coverageLimit).toMatch(/do not prove recovery of all/i);
    expect(fixture.methodology.michael_jackson.classification).toMatch(/complete within/i);
    expect(fixture.methodology.michael_jackson.coverageLimit).toMatch(/not a claim/i);
  });

  test("freezes the reviewed Paulinho sample and scoped Michael Jackson catalogue", () => {
    expect(fixture.paulinho_da_costa).toHaveLength(56);
    expect(fixture.michael_jackson).toHaveLength(80);

    const michaelAlbumCounts = fixture.michael_jackson.reduce<Record<string, number>>((counts, row) => {
      counts[row.album] = (counts[row.album] ?? 0) + 1;
      return counts;
    }, {});
    expect(michaelAlbumCounts).toEqual({
      "Off the Wall": 10,
      Thriller: 9,
      Bad: 11,
      Dangerous: 14,
      "HIStory: Past, Present and Future, Book I": 15,
      "Blood on the Dance Floor: HIStory in the Mix": 5,
      Invincible: 16,
    });
  });

  test("requires unique recovery keys and documented public evidence for every row", () => {
    const collections = [fixture.paulinho_da_costa, fixture.michael_jackson];
    const allowedHosts = new Set([
      "paulinho.com",
      "discografia.discosdobrasil.com.br",
      "www.legacyrecordings.com",
      "www.michaeljackson.com",
    ]);
    const allowedEvidenceTypes = new Set([
      "official_artist",
      "track_level_credits_database",
      "official_label_discography",
      "official_artist_discography",
    ]);

    for (const rows of collections) {
      const keys = rows.map(recoveryKey);
      expect(new Set(keys).size).toBe(keys.length);
      for (const row of rows) {
        expect(row.artist.trim()).not.toBe("");
        expect(row.title.trim()).not.toBe("");
        expect(row.album.trim()).not.toBe("");
        expect(row.evidenceNote.trim().length).toBeGreaterThanOrEqual(30);
        expect(allowedEvidenceTypes.has(row.evidenceType), row.evidenceType).toBe(true);
        const url = assertPublicHttpsUrl(row.source);
        expect(allowedHosts.has(url.hostname), row.source).toBe(true);
        expect(url.hostname).not.toMatch(/discogs/i);
      }
    }
  });

  test("Paulinho database rows are track-level percussion assertions, never album expansions", () => {
    const databaseRows = fixture.paulinho_da_costa.filter(
      (row) => row.evidenceType === "track_level_credits_database",
    );
    expect(databaseRows).toHaveLength(53);
    expect(new Set(databaseRows.map((row) => row.source)).size).toBe(8);
    for (const row of databaseRows) {
      expect(new URL(row.source).hostname).toBe("discografia.discosdobrasil.com.br");
      expect(row.evidenceNote).toMatch(/exact track's Músicos section/i);
      expect(row.evidenceNote).toMatch(/Percussão/i);
    }
  });

  test("Michael Jackson rows stay inside the declared original-recording scope", () => {
    expect(new Set(fixture.michael_jackson.map((row) => row.artist))).toEqual(new Set(["Michael Jackson"]));
    expect(fixture.michael_jackson.some((row) => /\b(?:remix|demo|live)\b/i.test(row.title))).toBe(false);
    expect(fixture.methodology.michael_jackson.scope).toMatch(/80 unique original studio recordings/i);
  });
});
