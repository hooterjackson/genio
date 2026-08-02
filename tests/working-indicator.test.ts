import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { cumulativeCandidateCount, WorkingIndicator } from "../app/working-indicator";

describe("working indicator candidate funnel", () => {
  it("keeps unknown stage telemetry distinct from a known zero", () => {
    expect(cumulativeCandidateCount(undefined, "scope_qualified")).toBeNull();
    expect(cumulativeCandidateCount({}, "scope_qualified")).toBeNull();
    expect(cumulativeCandidateCount({ discovered: 12 }, "scope_qualified")).toBe(0);
  });

  it("turns current-stage buckets into a cumulative qualified snapshot", () => {
    expect(cumulativeCandidateCount({
      discovered: 7,
      identity_resolved: 2,
      scope_qualified: 4,
      claim_verified: 3,
      playable: 9,
      catalog_resolved: 5,
      rejected: 6,
    }, "scope_qualified")).toBe(21);
  });

  it("does not count rejected or exhausted candidates as Apple-ready", () => {
    expect(cumulativeCandidateCount({
      playable: 8,
      selected: 4,
      published: 3,
      rejected: 17,
      exhausted: 11,
    }, "playable")).toBe(15);
  });

  it("renders known zeroes, recent sources, and durable operational detail", () => {
    const markup = renderToStaticMarkup(createElement(WorkingIndicator, {
      stage: "discover",
      motion: "paused",
      phaseLabel: "Waiting for the next discovery pass.",
      candidateCount: 0,
      sourceCount: 0,
      unresolvedCount: 0,
      targetCount: 25,
      candidateStageCounts: { discovered: 0 },
      details: { relationship: "belongs to the documented scene" },
      progress: {
        targetTrackCount: 25,
        latestActivityAt: "2026-07-19T10:00:00.000Z",
        sourceSummary: {
          total: 1,
          recentSources: [{ title: "Scene archive", domain: "archive.example", sourceClass: "web" }],
        },
        frontierSummary: {
          total: 2,
          complete: 0,
          active: 2,
          unresolved: 0,
          inaccessible: 0,
          discoveredCount: 0,
          recoveredCount: 0,
        },
        containerSummary: {
          total: 0,
          complete: 0,
          active: 0,
          unresolved: 0,
          inaccessible: 0,
          advertisedCount: 0,
          recoveredCount: 0,
        },
        matchSummary: {
          attempted: 0,
          accepted: 0,
          review: 0,
          unavailable: 0,
          duplicate: 0,
          rejected: 0,
          unsupported: 0,
          overflow: 0,
          shortfall: 25,
        },
        publicationSummary: {
          volumeCount: 0,
          completedVolumes: 0,
          totalTracks: 0,
          appendedTracks: 0,
          currentVolume: null,
          status: null,
        },
      },
    }));

    expect(markup).toContain("DISCOVERED</small><strong>0</strong>");
    expect(markup).toContain("Scene archive");
    expect(markup).toContain("archive.example");
    expect(markup).toContain("0 of 2 strategies complete");
    expect(markup).toContain('data-stage="discover"');
    expect(markup).toContain('data-motion="paused"');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain("CATALOG-READY YIELD");
    expect(markup).toContain("0 / 25");
    expect(markup).toContain("25 still needed");
    expect(markup.match(/role="status"/gu)).toHaveLength(1);
  });

  it("renders action-required work without a live animation state", () => {
    const markup = renderToStaticMarkup(createElement(WorkingIndicator, {
      stage: "sequence",
      motion: "action-required",
      phaseLabel: "Choose whether to continue researching or publish the verified tracks.",
      targetCount: 50,
    }));

    expect(markup).toContain('data-motion="action-required"');
    expect(markup).toContain("ACTION REQUIRED");
    expect(markup).not.toContain("LIVE");
  });

  it("keeps provider observations separate from unique leads and candidates", () => {
    const markup = renderToStaticMarkup(createElement(WorkingIndicator, {
      stage: "verify",
      motion: "action-required",
      phaseLabel: "Evidence coverage needs technical attention.",
      sourceCount: 1_005,
      sourceCountOverride: 189,
      observationCount: 1_005,
      candidateCount: 77,
      unresolvedCount: 77,
      targetCount: 25,
      progress: {
        targetTrackCount: 25,
        latestActivityAt: "2026-08-02T10:00:00.000Z",
        sourceSummary: {
          total: 1_005,
          recentSources: [],
        },
        frontierSummary: {
          total: 2,
          complete: 2,
          active: 0,
          unresolved: 0,
          inaccessible: 0,
          discoveredCount: 1_005,
          recoveredCount: 1_005,
        },
        containerSummary: {
          total: 0,
          complete: 0,
          active: 0,
          unresolved: 0,
          inaccessible: 0,
          advertisedCount: 0,
          recoveredCount: 0,
        },
        matchSummary: {
          attempted: 77,
          accepted: 73,
          review: 0,
          unavailable: 4,
          duplicate: 0,
          rejected: 0,
          unsupported: 0,
          overflow: 0,
          shortfall: 0,
        },
        publicationSummary: {
          volumeCount: 0,
          completedVolumes: 0,
          totalTracks: 0,
          appendedTracks: 0,
          currentVolume: null,
          status: null,
        },
      },
    }));

    expect(markup).toContain("SOURCES</small><strong>189</strong>");
    expect(markup).toContain("DISCOVERED</small><strong>77</strong>");
    expect(markup).toContain(
      "OBSERVATIONS</small><strong>1,005</strong>",
    );
    expect(markup).not.toContain(
      "DISCOVERED</small><strong>1,005</strong>",
    );
  });

  it("renders a durable stalled label without claiming the run is live", () => {
    const markup = renderToStaticMarkup(createElement(WorkingIndicator, {
      stage: "discover",
      motion: "paused",
      stateLabelOverride: "STALLED",
      phaseLabel: "No eligible worker has made progress recently.",
      targetCount: 50,
    }));

    expect(markup).toContain("RESEARCH CONSOLE");
    expect(markup).toContain("STALLED");
    expect(markup).not.toContain("LIVE");
  });
});
