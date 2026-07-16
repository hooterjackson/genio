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

  test("rejects an under-limit request restatement that starts with the requested count", () => {
    const brief = context({
      subjectEntities: ["Paulinho da Costa"],
      targetSize: { min: 200, max: 200 },
      relationship: "recordings on which Paulinho da Costa performed",
    });

    expect(normalizePlaylistTitle(
      "200 Songs Paulinho da Costa Performed On Across Six Decades",
      brief,
    )).toBe("Paulinho da Costa: 200 Performance Credits");
  });

  test("replaces a conflicting model count with the server-selected count", () => {
    expect(normalizePlaylistTitle(
      "300 Influential Techno Tracks",
      context({ targetSize: { min: 50, max: 50 } }),
    )).toBe("Berlin techno: 50 Influential Tracks");
  });

  test("rejects generic model titles while preserving specific editorial titles", () => {
    expect(normalizePlaylistTitle("The Essentials", context()))
      .toBe("Berlin techno: 50 Influential Tracks");
    expect(normalizePlaylistTitle("Machine City After Dark", context()))
      .toBe("Machine City After Dark");
  });

  test("uses both subjects for a concise collaboration fallback", () => {
    const brief = context({
      subjectEntities: ["Beyoncé", "JAY-Z"],
      relationship: "collaborations recorded together",
      targetSize: { min: 25, max: 25 },
    });

    expect(normalizePlaylistTitle(
      "Please compile all 25 songs where Beyoncé and JAY-Z recorded together",
      brief,
    )).toBe("Beyoncé + JAY-Z: 25 Collaborations");
  });

  test("preserves Unicode, diacritics, and joined emoji without splitting graphemes", () => {
    const brief = context({
      subjectEntities: ["Gênio brasileiro 🎧‍🔥"],
      relationship: "historically influential recordings",
      targetSize: { min: 50, max: 50 },
    });
    const title = normalizePlaylistTitle(
      "Give me the 50 most influential canções connected to this very detailed Brazilian music history request",
      brief,
    );

    expect(title).toBe("Gênio brasileiro 🎧‍🔥: 50 Influential Tracks");
    expect(title).toContain("ê");
    expect(title).toContain("🎧‍🔥");

    const suffixedEmojiTitle = appendPlaylistTitleSuffix("🎧‍🔥".repeat(30), "[1/2]");
    expect(Array.from(suffixedEmojiTitle).length).toBeLessThanOrEqual(PLAYLIST_TITLE_MAX_LENGTH);
    expect(suffixedEmojiTitle).not.toMatch(/‍…/u);
    expect(suffixedEmojiTitle.endsWith("[1/2]")).toBe(true);
  });

  test("normalization is deterministic and never mutates the detailed brief", () => {
    const brief = context({
      description: "Keep this complete, detailed scope for the research report and Apple description.",
      subjectEntities: ["Late-night dream pop"],
      relationship: "fits the requested mood and listening arc",
      targetSize: { min: 75, max: 75 },
    });
    const before = structuredClone(brief);
    const proposed = "Create a playlist of dream pop that gradually becomes stranger and quieter toward dawn";

    expect(normalizePlaylistTitle(proposed, brief))
      .toBe(normalizePlaylistTitle(proposed, brief));
    expect(brief).toEqual(before);
    expect(brief.description).toBe(before.description);
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
