import { describe, expect, test } from "vitest";
import { evaluateCuratedPlaylist, evaluateHoldoutRecovery, evaluateMatchingQuality } from "../lib/benchmarks.ts";

describe("acceptance benchmark evaluator", () => {
  test("requires complete factual holdout recovery", () => {
    const expected = [{ artist: "Artist", title: "One" }, { artist: "Artist", title: "Two" }];
    expect(evaluateHoldoutRecovery(expected, expected)).toMatchObject({ recall: 1, passed: true });
    expect(evaluateHoldoutRecovery(expected, expected.slice(0, 1))).toMatchObject({ recall: 0.5, passed: false });
  });

  test("enforces 99.5% auto-match precision and 95% available-track resolvability", () => {
    const passing = Array.from({ length: 200 }, () => ({ autoAccepted: true, correct: true, storefrontAvailable: true, resolved: true }));
    expect(evaluateMatchingQuality(passing).passed).toBe(true);
    const failing = [...passing];
    failing[0] = { ...failing[0]!, correct: false };
    expect(evaluateMatchingQuality(failing)).toMatchObject({ precision: 0.995, passed: true });
    failing[1] = { ...failing[1]!, correct: false };
    expect(evaluateMatchingQuality(failing).passed).toBe(false);
    expect(evaluateMatchingQuality(passing.slice(0, 99))).toMatchObject({
      sampleSize: 99,
      minimumSampleSize: 100,
      precision: 1,
      resolvability: 1,
      passed: false,
    });
  });

  test("scores curated size, citations, uniqueness, concentration, and human rubric dimensions", () => {
    const tracks = Array.from({ length: 50 }, (_, index) => ({
      artist: `Artist ${index % 10}`,
      title: `Track ${index}`,
      citationUrls: [`https://sources.example/${index}`],
    }));
    const ratings = {
      citationQuality: 4,
      historicalRelevance: 4,
      berlinSceneFit: 4,
      eraDiversity: 4,
      artistDiversity: 4,
      duplicateAvoidance: 4,
      playlistCoherence: 4,
    };
    expect(evaluateCuratedPlaylist(tracks, ratings).passed).toBe(true);
    expect(evaluateCuratedPlaylist([...tracks, tracks[0]!], ratings).passed).toBe(false);
  });
});
