import { describe, expect, test } from "vitest";
import {
  assertHostedPublication,
  parseHostedSmokeArgs,
  recommendedGuidanceAnswers,
} from "../scripts/hosted-publication-smoke.ts";

function completedResult(trackCount = 3) {
  return {
    status: "complete",
    error: null,
    manifest: { id: "manifest-1", name: "Hosted smoke", trackCount },
    totalTracks: trackCount,
    completedTracks: trackCount,
    volumes: [{
      index: 1,
      status: "complete",
      trackCount,
      appendedCount: trackCount,
      shareUrl: "https://music.apple.com/us/playlist/hosted-smoke/pl.test",
    }],
  };
}

describe("hosted publication smoke harness", () => {
  test("parses a bounded exact public request and normalizes its origin", () => {
    expect(parseHostedSmokeArgs([
      "--confirm-live-write",
      "--origin", "https://9enio.com:443",
      "--prompt", "Rio de Janeiro songs",
      "--count", "50",
    ])).toMatchObject({
      confirmLiveWrite: true,
      origin: "https://9enio.com",
      prompt: "Rio de Janeiro songs",
      targetTrackCount: 50,
    });
  });

  test("refuses an unconfirmed write, an unsafe origin, and counts the public API rejects", () => {
    expect(() => parseHostedSmokeArgs([])).toThrow(/confirm-live-write/u);
    expect(() => parseHostedSmokeArgs([
      "--confirm-live-write", "--origin", "http://9enio.com",
    ])).toThrow(/HTTPS origin/u);
    expect(() => parseHostedSmokeArgs([
      "--confirm-live-write", "--count", "301",
    ])).toThrow(/1 to 300/u);
  });

  test("selects exactly one server-recommended option per grounded question", () => {
    expect(recommendedGuidanceAnswers({
      questions: [{
        id: "period",
        options: [
          { id: "classic", recommended: false },
          { id: "modern", recommended: true },
          { id: "survey", recommended: false },
        ],
      }],
    })).toEqual([{ questionId: "period", optionId: "modern" }]);
  });

  test("rejects malformed hosted guidance instead of silently choosing the first option", () => {
    expect(() => recommendedGuidanceAnswers({ questions: [] })).toThrow(/1–3 valid questions/u);
    expect(() => recommendedGuidanceAnswers({
      questions: [{
        id: "period",
        options: [
          { id: "classic", recommended: false },
          { id: "modern", recommended: false },
          { id: "survey", recommended: false },
        ],
      }],
    })).toThrow(/exactly one recommendation/u);
  });

  test("accepts only a complete exact publication with valid Apple volume links", () => {
    expect(() => assertHostedPublication({ status: "complete", error: null }, completedResult(), 3)).not.toThrow();
    expect(() => assertHostedPublication({ status: "failed" }, completedResult(), 3)).toThrow(/status failed/u);
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      { ...completedResult(), completedTracks: 2 },
      3,
    )).toThrow(/completed 2 tracks instead of 3/u);
    expect(() => assertHostedPublication(
      { status: "complete", error: null },
      {
        ...completedResult(),
        volumes: [{ ...completedResult().volumes[0], shareUrl: "https://example.com/not-apple" }],
      },
      3,
    )).toThrow(/valid public Apple Music link/u);
  });
});
