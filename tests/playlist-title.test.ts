import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  appendPlaylistTitleSuffix,
  normalizePlaylistTitle,
  PLAYLIST_TITLE_MAX_LENGTH,
} from "../server/playlist-title.ts";

function context(overrides: Partial<PlaylistBrief> = {}): PlaylistBrief {
  return {
    title: "Fixture",
    description: "Full scope remains here.",
    mode: "curated",
    subjectEntities: ["Berlin techno"],
    relationship: "historically influential within",
    include: [],
    exclude: [],
    versionPolicy: "one canonical recording",
    evidencePolicy: "cited editorial evidence",
    orderingPolicy: "influence rank",
    targetSize: { min: 50, max: 50 },
    ambiguities: [],
    ...overrides,
  };
}

describe("playlist title normalization", () => {
  test("turns a prompt-shaped Paulinho title into a concise Apple Music name", () => {
    const brief = context({
      subjectEntities: ["Paulinho da Costa"],
      targetSize: { min: 200, max: 200 },
      relationship: "influential recording featuring",
    });

    expect(normalizePlaylistTitle(
      "The 200 most influential songs associated with Paulinho da Costa",
      brief,
    )).toBe("Paulinho da Costa: 200 Influential Tracks");
  });

  test("removes request language and names a Berlin techno playlist directly", () => {
    const brief = context();

    expect(normalizePlaylistTitle(
      "Please create a playlist of the 50 most influential Berlin techno tracks",
      brief,
    )).toBe("Berlin techno: 50 Influential Tracks");
  });

  test("preserves a good concise model-generated name", () => {
    expect(normalizePlaylistTitle("Berlin Techno Foundations", context()))
      .toBe("Berlin Techno Foundations");
  });

  test("falls back from a long natural-language request without losing the subject or count", () => {
    const brief = context({
      subjectEntities: ["Late-night dream pop"],
      relationship: "fits the requested mood and listening arc",
      targetSize: { min: 75, max: 75 },
    });
    const title = normalizePlaylistTitle(
      "Create a playlist of 75 dream pop songs for a very long late-night drive that gradually becomes stranger, quieter, and more atmospheric toward dawn",
      brief,
    );

    expect(title).toBe("Late-night dream pop: 75 Selected Tracks");
    expect(Array.from(title).length).toBeLessThanOrEqual(PLAYLIST_TITLE_MAX_LENGTH);
  });

  test("sanitizes control characters and caps names while retaining publication suffixes", () => {
    const normalized = normalizePlaylistTitle(
      "A very concise\u0000 title with invisible\u200b control characters",
      context({ relationship: "selected for" }),
    );
    const dated = appendPlaylistTitleSuffix(
      `${normalized} plus enough additional words to exceed the publication limit`,
      "· 2026-07-15",
    );
    const volume = appendPlaylistTitleSuffix(dated, "[1/6]");

    expect(normalized).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(Array.from(dated).length).toBeLessThanOrEqual(PLAYLIST_TITLE_MAX_LENGTH);
    expect(Array.from(volume).length).toBeLessThanOrEqual(PLAYLIST_TITLE_MAX_LENGTH);
    expect(dated.endsWith("· 2026-07-15")).toBe(true);
    expect(volume.endsWith("[1/6]")).toBe(true);
  });
});
