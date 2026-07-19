import { describe, expect, test } from "vitest";
import {
  scoreBroadCuratedCandidate,
  selectBroadCuratedCandidates,
  shouldScoreBroadCuratedSelection,
  type BroadCuratedCandidate,
} from "../shared/selection-score-v2.ts";
import { selectWithConstraintLadder } from "../server/pipeline-v2-policy.ts";

function candidate(
  id: string,
  overrides: Partial<BroadCuratedCandidate<string>> = {},
): BroadCuratedCandidate<string> {
  return {
    id,
    artist: `Artist ${id}`,
    title: `Track ${id}`,
    album: `Album ${id}`,
    releaseYear: 2000,
    scenes: ["scene-a"],
    geographies: ["place-a"],
    sourceRank: 1,
    evidenceConfidence: 0.95,
    independentProvenanceRoots: [`source-${id}`],
    value: id,
    ...overrides,
  };
}

describe("Pipeline V2 SelectionScore", () => {
  test("enables scoring only for broad curated work and preserves direct or factual ordering", () => {
    expect(shouldScoreBroadCuratedSelection("curated", ["genre_scene"])).toBe(true);
    expect(shouldScoreBroadCuratedSelection("curated", ["similarity", "theme"])).toBe(true);
    expect(shouldScoreBroadCuratedSelection("curated", ["artist_catalogue"])).toBe(false);
    expect(shouldScoreBroadCuratedSelection("curated", ["genre_scene", "factual_relationship"])).toBe(false);
    expect(shouldScoreBroadCuratedSelection("exhaustive", ["genre_scene"])).toBe(false);
  });

  test("is bounded, auditable, and neutral when optional metadata is absent", () => {
    const score = scoreBroadCuratedCandidate(candidate("a", {
      album: null,
      releaseYear: null,
      scenes: [],
      geographies: [],
      sourceRank: null,
    }), { selected: [] });

    expect(score.version).toBe("selection_score_v2_2026_07");
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(100);
    expect(score.components).toHaveLength(7);
    expect(score.components.filter((component) => component.available).map((component) => component.dimension))
      .toEqual(["source_evidence", "artist_diversity"]);
    expect(score.components.reduce((sum, component) => sum + component.contribution, 0))
      .toBeCloseTo(score.total, 5);
    expect(score.tieBreakKey).toContain("artist a|track a|a");
  });

  test("records independent corroboration without letting copied roots multiply support", () => {
    const oneRoot = scoreBroadCuratedCandidate(candidate("a", {
      independentProvenanceRoots: ["Discography A", "discography a"],
    }), { selected: [] });
    const twoRoots = scoreBroadCuratedCandidate(candidate("a", {
      independentProvenanceRoots: ["Discography A", "Liner Notes B"],
    }), { selected: [] });

    const oneEvidence = oneRoot.components.find((component) => component.dimension === "source_evidence")!;
    const twoEvidence = twoRoots.components.find((component) => component.dimension === "source_evidence")!;
    expect(oneEvidence.reasonCode).toBe("source_evidence_supported");
    expect(twoEvidence.reasonCode).toBe("independent_evidence_corroborated");
    expect(twoEvidence.rawValue).toBeGreaterThan(oneEvidence.rawValue!);
  });

  test("greedily broadens artists, albums, eras, scenes, and geographies when qualified evidence exists", () => {
    const selection = selectBroadCuratedCandidates([
      candidate("a1", { artist: "Artist A", album: "Album A", releaseYear: 2001, scenes: ["north"], geographies: ["france"], sourceRank: 1 }),
      candidate("a2", { artist: "Artist A", album: "Album A", releaseYear: 2002, scenes: ["north"], geographies: ["france"], sourceRank: 2 }),
      candidate("b", { artist: "Artist B", album: "Album B", releaseYear: 1991, scenes: ["south"], geographies: ["brazil"], sourceRank: 3 }),
    ], 2);

    expect(selection.selected.map((item) => item.candidate.id)).toEqual(["a1", "b"]);
    expect(selection.selected[1]!.score.components.filter((component) => (
      ["artist_diversity", "album_diversity", "era_diversity", "scene_diversity", "geography_diversity"]
        .includes(component.dimension)
    )).every((component) => component.normalizedValue === 1)).toBe(true);
    expect(selection.overflow.map((item) => item.id)).toEqual(["a2"]);
  });

  test("replays deterministically and uses the stable key only after equal totals", () => {
    const candidates = [candidate("z"), candidate("a")];
    const first = selectBroadCuratedCandidates(candidates, 2);
    const second = selectBroadCuratedCandidates([...candidates].reverse(), 2);
    expect(first.selected.map((item) => item.candidate.id)).toEqual(["a", "z"]);
    expect(second.selected.map((item) => item.candidate.id)).toEqual(["a", "z"]);
    expect(second).toEqual(first);
  });

  test("integrates after the V2 hard-constraint gate and before final slicing", () => {
    const low = scoreBroadCuratedCandidate(candidate("low", { evidenceConfidence: 0.7 }), { selected: [] });
    const high = scoreBroadCuratedCandidate(candidate("high", { evidenceConfidence: 1 }), { selected: [] });
    const result = selectWithConstraintLadder({
      target: 1,
      constraints: [{ id: "required_scope", kind: "hard", relaxationRank: null }],
      candidates: [
        { value: "low", violations: [], selectionScore: low },
        { value: "high", violations: [], selectionScore: high },
        { value: "ineligible", violations: ["required_scope"], selectionScore: high },
      ],
    });

    expect(result.selected).toEqual(["high"]);
    expect(result.outcome).toBe("complete");
  });

  test("supports dynamic greedy ranking only across candidates that cleared the ladder", () => {
    const wrappers = [
      { value: candidate("a1", { artist: "Artist A", album: "Album A", sourceRank: 1 }), violations: [] },
      { value: candidate("a2", { artist: "Artist A", album: "Album A", sourceRank: 2 }), violations: [] },
      { value: candidate("b", { artist: "Artist B", album: "Album B", sourceRank: 3 }), violations: [] },
      { value: candidate("blocked", { evidenceConfidence: 1, sourceRank: 1 }), violations: ["required_scope"] },
    ];
    const result = selectWithConstraintLadder({
      target: 2,
      constraints: [{ id: "required_scope", kind: "hard", relaxationRank: null }],
      candidates: wrappers,
      rankQualifiedCandidates: (qualified, target) => selectBroadCuratedCandidates(
        qualified.map((wrapper) => ({ ...wrapper.value, value: wrapper })),
        target,
      ).selected.map((item) => item.candidate.value),
    });

    expect(result.selected.map((item) => item.id)).toEqual(["a1", "b"]);
  });

  test("rejects a ranker that attempts to reintroduce an ineligible candidate", () => {
    const blocked = { value: "blocked", violations: ["required_scope"] };
    expect(() => selectWithConstraintLadder({
      target: 1,
      constraints: [{ id: "required_scope", kind: "hard", relaxationRank: null }],
      candidates: [{ value: "eligible", violations: [] }, blocked],
      rankQualifiedCandidates: () => [blocked],
    })).toThrow("Qualified-candidate ranker returned an ineligible candidate");
  });
});
