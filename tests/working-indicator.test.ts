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
    expect(markup.match(/role="status"/gu)).toHaveLength(1);
  });
});
