import { describe, expect, it } from "vitest";
import { playlistWorkMotion, playlistWorkStage, playlistWorkState } from "../app/playlist-waiting-state";

describe("playlist waiting state", () => {
  it.each([
    ["queued", "queued", "queue"],
    ["researching", "source_discovery", "research"],
    ["researching", "catalog_refill_research", "match"],
    ["matching", "catalog_matching", "match"],
    ["visitor_review", "exception_review", "match"],
    ["manifest_ready", "manifest", "build"],
    ["publishing", "apple_publication", "build"],
  ])("maps %s / %s to %s", (status, phase, expected) => {
    expect(playlistWorkStage({ status, phase })).toBe(expected);
  });

  it.each(["complete", "partial", "failed", "expired", "deleted"])("stops motion for %s", (status) => {
    expect(playlistWorkMotion({ status, phase: "gap_analysis" })).toBe("idle");
  });

  it.each(["awaiting_budget", "waiting_for_apple_authorization"])("pauses motion for %s", (status) => {
    expect(playlistWorkMotion({ status, phase: "publishing" })).toBe("paused");
  });

  it("uses a conservative active research fallback for a new phase", () => {
    expect(playlistWorkState({ status: "researching", phase: "future_music_phase" })).toEqual({
      stage: "research",
      motion: "active",
    });
  });
});
