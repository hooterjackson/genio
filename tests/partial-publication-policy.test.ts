import { describe, expect, test } from "vitest";
import {
  PARTIAL_DECISION_TTL_MS,
  parsePartialReadyCheckpoint,
  partialDecisionExpiresAt,
  partialExploreEligibility,
  requireCurrentPartialOutcome,
  shortManifestRequiresDecision,
} from "../server/partial-publication-policy.ts";

const hash = "a".repeat(64);

describe("Pipeline V3 partial publication policy", () => {
  test("parses only a real shortfall and derives the authoritative count", () => {
    expect(parsePartialReadyCheckpoint({
      outcomeHash: hash,
      outcomeVersion: 4,
      targetTrackCount: 176,
      verifiedTrackCount: 142,
      shortfall: 999,
      remainingStrategyCount: 2,
      continueAvailable: true,
      preparedAt: "2026-07-20T12:00:00.000Z",
    })).toEqual({
      outcomeHash: hash,
      outcomeVersion: 4,
      targetTrackCount: 176,
      verifiedTrackCount: 142,
      shortfall: 34,
      remainingStrategyCount: 2,
      continueAvailable: true,
      preparedAt: "2026-07-20T12:00:00.000Z",
    });
    expect(parsePartialReadyCheckpoint({
      outcomeHash: hash,
      targetTrackCount: 50,
      verifiedTrackCount: 50,
      preparedAt: "2026-07-20T12:00:00.000Z",
    })).toBeNull();
  });

  test("stale outcome hashes and versions cannot authorize publication", () => {
    const checkpoint = {
      outcomeHash: hash,
      outcomeVersion: 3,
      targetTrackCount: 50,
      verifiedTrackCount: 42,
      remainingStrategyCount: 0,
      continueAvailable: false,
      preparedAt: "2026-07-20T12:00:00.000Z",
    };
    expect(() => requireCurrentPartialOutcome({ checkpoint, outcomeHash: "b".repeat(64) }))
      .toThrowError(/changed/i);
    expect(() => requireCurrentPartialOutcome({ checkpoint, outcomeVersion: 2 }))
      .toThrowError(/changed/i);
    expect(requireCurrentPartialOutcome({ checkpoint, outcomeHash: hash, outcomeVersion: 3 }))
      .toMatchObject({ targetTrackCount: 50, verifiedTrackCount: 42 });
  });

  test("short manifests require consent and decisions expire after seven days", () => {
    expect(shortManifestRequiresDecision(50, 49)).toBe(true);
    expect(shortManifestRequiresDecision(50, 50)).toBe(false);
    expect(shortManifestRequiresDecision(null, 2)).toBe(false);
    const now = new Date("2026-07-20T00:00:00.000Z");
    expect(partialDecisionExpiresAt(now).getTime() - now.getTime()).toBe(PARTIAL_DECISION_TTL_MS);
  });

  test("partials below 90 percent remain unlisted without owner approval", () => {
    expect(partialExploreEligibility({ targetTrackCount: 50, selectedTrackCount: 44 }).eligible).toBe(false);
    expect(partialExploreEligibility({ targetTrackCount: 50, selectedTrackCount: 45 }).eligible).toBe(true);
    expect(partialExploreEligibility({ targetTrackCount: 176, selectedTrackCount: 4, ownerApproved: true }).eligible).toBe(true);
  });
});
