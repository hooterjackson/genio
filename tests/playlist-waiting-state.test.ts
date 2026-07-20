import { describe, expect, it } from "vitest";
import {
  isAutomaticPlaylistHandoff,
  playlistWorkMotion,
  playlistWorkStage,
  playlistWorkState,
} from "../app/playlist-waiting-state";

describe("playlist waiting state", () => {
  it.each([
    ["queued", "queued", "plan"],
    ["researching", "source_discovery", "discover"],
    ["researching", "track_verification", "verify"],
    ["researching", "catalog_refill_research", "discover"],
    ["matching", "catalog_matching", "match"],
    ["visitor_review", "exception_review", "match"],
    ["manifest_ready", "manifest", "sequence"],
    ["publishing", "apple_publication", "publish"],
  ])("maps %s / %s to %s", (status, phase, expected) => {
    expect(playlistWorkStage({ status, phase })).toBe(expected);
  });

  it.each([
    "complete",
    "partial",
    "failed",
    "no_compatible_tracks",
    "cancelled",
    "failed_system",
    "failed_integrity",
    "expired",
    "deleted",
  ])("stops motion for %s", (status) => {
    expect(playlistWorkMotion({ status, phase: "gap_analysis" })).toBe("idle");
  });

  it.each([
    ["awaiting_guidance", "v3_awaiting_guidance", "plan"],
    ["partial_ready", "partial_confirmation_required", "sequence"],
  ])("marks %s as action-required without active motion", (status, phase, stage) => {
    expect(playlistWorkState({ status, phase })).toEqual({
      stage,
      motion: "action-required",
    });
  });

  it.each([
    ["resolving_catalog", "v3_resolving_catalog", "match"],
    ["continuing_research", "v3_continuing_research", "discover"],
  ])("keeps %s active in the %s stage", (status, phase, stage) => {
    expect(playlistWorkState({ status, phase })).toEqual({
      stage,
      motion: "active",
    });
  });

  it.each(["awaiting_budget", "waiting_for_apple_authorization", "waiting_for_corpus_review"])("pauses motion for %s", (status) => {
    expect(playlistWorkMotion({ status, phase: "publishing" })).toBe("paused");
  });

  it("uses a conservative active research fallback for a new phase", () => {
    expect(playlistWorkState({ status: "researching", phase: "future_music_phase" })).toEqual({
      stage: "discover",
      motion: "active",
    });
  });

  it.each([
    ["visitor_review", "exception_review"],
    ["manifest_ready", "manifest"],
  ])("keeps an automatic %s handoff active in the assembly stage", (status, phase) => {
    const run = { status, phase, autoPublish: true };
    expect(isAutomaticPlaylistHandoff(run)).toBe(true);
    expect(playlistWorkState(run)).toEqual({
      stage: "sequence",
      motion: "active",
    });
  });

  it("does not treat a manual visitor review as an automatic handoff", () => {
    const run = { status: "visitor_review", phase: "exception_review", autoPublish: false };
    expect(isAutomaticPlaylistHandoff(run)).toBe(false);
    expect(playlistWorkStage(run)).toBe("match");
  });
});
