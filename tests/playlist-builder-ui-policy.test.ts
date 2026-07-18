import { describe, expect, it } from "vitest";
import {
  apiErrorCode,
  evidenceCountSummary,
  publishedTrackCountSummary,
  publishedResultHeading,
  shouldQuietlyClearInitialRunRestore,
} from "../app/playlist-builder-ui-policy.ts";

describe("initial run restoration", () => {
  it("quietly clears a stale or inaccessible run only during initial run restoration", () => {
    for (const status of [400, 401, 404, 410]) {
      expect(shouldQuietlyClearInitialRunRestore({ hasRunId: true, status })).toBe(true);
    }
    expect(shouldQuietlyClearInitialRunRestore({
      hasRunId: true,
      status: 403,
      code: "capability_scope_mismatch",
    })).toBe(true);
  });

  it("preserves unrelated and explicit-operation errors", () => {
    expect(shouldQuietlyClearInitialRunRestore({
      hasRunId: false,
      status: 403,
      code: "capability_scope_mismatch",
    })).toBe(false);
    expect(shouldQuietlyClearInitialRunRestore({
      hasRunId: true,
      status: 403,
      code: "forbidden",
    })).toBe(false);
    expect(shouldQuietlyClearInitialRunRestore({ hasRunId: true, status: 500 })).toBe(false);
  });

  it("reads top-level and nested API error codes", () => {
    expect(apiErrorCode({ code: "capability_scope_mismatch" })).toBe("capability_scope_mismatch");
    expect(apiErrorCode({ error: { code: "capability_scope_mismatch" } })).toBe("capability_scope_mismatch");
    expect(apiErrorCode({ error: "not found" })).toBeNull();
  });
});

describe("published playlist result copy", () => {
  it("foregrounds the exact published track count", () => {
    expect(publishedTrackCountSummary(50, 50)).toBe("50 tracks published.");
    expect(publishedTrackCountSummary(1, 1)).toBe("1 track published.");
  });

  it("states a partial result against the requested count", () => {
    expect(publishedTrackCountSummary(23, 50)).toBe("23 of 50 requested tracks published.");
    expect(publishedTrackCountSummary(1, 50)).toBe("1 of 50 requested tracks published.");
  });

  it("keeps evidence counts separate and explicitly labeled", () => {
    expect(evidenceCountSummary(8, 0)).toBe("Evidence: 8 documented sources; 0 open gaps.");
    expect(evidenceCountSummary(1, 1)).toBe("Evidence: 1 documented source; 1 open gap.");
  });

  it("never describes an empty partial result as a published playlist", () => {
    expect(publishedResultHeading(0, true)).toBe("No compatible tracks found");
    expect(publishedResultHeading(23, true)).toBe("Playlist published with gaps");
    expect(publishedResultHeading(50, false)).toBe("Playlist published");
  });
});
