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
    ["accepted", false, "active"],
    ["needs_input", false, "action-required"],
    ["probing", false, "active"],
    ["executing", false, "active"],
    ["blocked_dependency", false, "paused"],
    ["needs_decision", false, "action-required"],
    ["ready", false, "active"],
    ["publishing", false, "active"],
    ["completed", true, "idle"],
    ["cancelled", true, "idle"],
    ["quarantined", false, "paused"],
  ])(
    "renders the schema-18 resolution state %s conservatively",
    (state, terminal, motion) => {
      expect(playlistWorkMotion({
        status: "researching",
        resolution: { state, terminal },
      })).toBe(motion);
    },
  );

  it("keeps an unknown future resolution active unless the server marks it terminal", () => {
    expect(playlistWorkMotion({
      status: "future_status",
      resolution: { state: "future_resolution", terminal: false },
    })).toBe("active");
    expect(playlistWorkMotion({
      status: "future_status",
      resolution: { state: "future_resolution", terminal: true },
    })).toBe("idle");
  });

  it("renders LIVE only when schema-19 reports verified running work", () => {
    expect(playlistWorkMotion({
      status: "researching",
      resolution: {
        state: "executing",
        terminal: false,
        workMotion: "running",
      },
    })).toBe("active");
    expect(playlistWorkMotion({
      status: "researching",
      resolution: {
        state: "executing",
        terminal: false,
        workMotion: "stalled",
      },
    })).toBe("paused");
    expect(playlistWorkMotion({
      status: "researching",
      resolution: {
        state: "executing",
        terminal: false,
        workMotion: "retry_scheduled",
      },
    })).toBe("paused");
  });

  it("renders evidence collapse as paused verification repair instead of active discovery", () => {
    expect(playlistWorkState({
      status: "needs_decision",
      phase: "capability_evidence_coverage_audit",
      resolution: {
        state: "quarantined",
        nextAction: "contact_support",
        terminal: false,
        workMotion: "paused",
      },
    })).toEqual({
      stage: "verify",
      motion: "paused",
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
