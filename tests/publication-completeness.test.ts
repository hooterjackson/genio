import { describe, expect, test } from "vitest";
import {
  resolvePublicationCompleteness,
  type PublicationCompletenessInput,
} from "../server/publication-completeness.ts";
import { publicationTerminalStatus } from "../server/publisher.ts";

function resolve(
  overrides: Partial<PublicationCompletenessInput> = {},
): ReturnType<typeof resolvePublicationCompleteness> {
  return resolvePublicationCompleteness({
    mode: "curated",
    targetMinimum: 50,
    manifestTrackCount: 50,
    omittedCandidateCount: 30,
    unresolvedCoverageCount: 4,
    ...overrides,
  });
}

describe("publication completeness policy", () => {
  test("an exact curated manifest is complete despite reserves and an unresolved frontier", () => {
    const completeness = resolve();

    expect(completeness).toEqual({
      omittedCandidateCount: 0,
      unresolvedCoverageCount: 0,
    });
    expect(publicationTerminalStatus(completeness)).toBe("complete");
  });

  test("a curated manifest below its confirmed minimum reports only the track shortfall", () => {
    const completeness = resolve({ manifestTrackCount: 47 });

    expect(completeness).toEqual({
      omittedCandidateCount: 3,
      unresolvedCoverageCount: 0,
    });
    expect(publicationTerminalStatus(completeness)).toBe("partial");
  });

  test.each(["exhaustive", "hybrid"] as const)(
    "%s publication retains strict candidate and source-frontier accounting",
    (mode) => {
      const completeness = resolve({
        mode,
        targetMinimum: mode === "exhaustive" ? null : 50,
      });

      expect(completeness).toEqual({
        omittedCandidateCount: 30,
        unresolvedCoverageCount: 4,
      });
      expect(publicationTerminalStatus(completeness)).toBe("partial");
    },
  );

  test("a malformed legacy curated row fails closed to strict accounting", () => {
    expect(resolve({ targetMinimum: null })).toEqual({
      omittedCandidateCount: 30,
      unresolvedCoverageCount: 4,
    });
  });
});
