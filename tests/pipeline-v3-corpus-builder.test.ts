import { describe, expect, test } from "vitest";
import { parseColdCorpusResponseV3 } from "../server/pipeline-v3-corpus-builder.ts";

function response(rows: unknown[], extra: Record<string, unknown> = {}) {
  const payload = {
    observations: rows,
    advertisedTotal: null,
    recoveredTotal: rows.length,
    nextCursor: null,
    enumerationComplete: false,
    zeroNewEvidenceGapPasses: 0,
    gaps: [],
    ...extra,
  };
  return {
    id: "resp-corpus-1",
    output_text: JSON.stringify(payload),
    output: [{
      type: "web_search_call",
      action: {
        sources: [
          { url: "https://example.com/sessionography" },
          { url: "https://another.example.org/credits" },
        ],
      },
    }],
  };
}

const valid = {
  artist: "Michael Jackson",
  title: "Human Nature",
  album: "Thriller",
  predicate: "performed_on",
  relationship: "percussion",
  role: "percussion",
  creditScope: "exact_recording",
  sourceUrl: "https://example.com/sessionography",
  sourceTitle: "Sessionography",
  supportExcerpt: "The track-level credit lists Paulinho da Costa on percussion.",
  confidence: 0.9,
};

describe("Pipeline V3 cold corpus parser", () => {
  test("keeps valid source-bound siblings and rejects an invented URL independently", () => {
    const parsed = parseColdCorpusResponseV3(response([
      valid,
      { ...valid, title: "Bad row", sourceUrl: "https://invented.invalid/claim" },
    ]));
    expect(parsed.observations).toEqual([expect.objectContaining({ title: "Human Nature" })]);
    expect(parsed.sourceCount).toBe(1);
  });

  test("fails exhaustive completion closed when totals, cursors, or two gap passes do not reconcile", () => {
    expect(parseColdCorpusResponseV3(response([valid], {
      advertisedTotal: 10,
      recoveredTotal: 10,
      nextCursor: "page-2",
      enumerationComplete: true,
      zeroNewEvidenceGapPasses: 2,
    })).enumerationComplete).toBe(false);
    expect(parseColdCorpusResponseV3(response([valid], {
      advertisedTotal: 1,
      recoveredTotal: 1,
      nextCursor: null,
      enumerationComplete: true,
      zeroNewEvidenceGapPasses: 2,
    })).enumerationComplete).toBe(true);
  });

  test("never treats album-level observations as exact recording evidence", () => {
    const parsed = parseColdCorpusResponseV3(response([{ ...valid, creditScope: "release_unspecified_tracks" }]));
    expect(parsed.observations[0]).toMatchObject({ creditScope: "release_unspecified_tracks" });
  });
});
