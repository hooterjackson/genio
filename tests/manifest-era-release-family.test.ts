import { describe, expect, test } from "vitest";
import {
  canonicalRecordingFamilyReleaseYear,
  recordingFamilySatisfiesEraConstraint,
} from "../server/selection-era-policy.ts";

describe("manifest hard-era evidence", () => {
  const seventiesAndEighties = {
    operator: "within" as const,
    values: ["1970s", "1980s"],
  };

  test("accepts a period recording when the preferred Apple result is a modern reissue", () => {
    expect(recordingFamilySatisfiesEraConstraint({
      candidateReleaseYear: null,
      appleReleaseDate: "2001-05-07",
      compatibleReleaseYears: [1978, 2001],
    }, seventiesAndEighties)).toBe(true);
  });

  test("rejects a genuinely out-of-era recording with only modern compatible issues", () => {
    expect(recordingFamilySatisfiesEraConstraint({
      candidateReleaseYear: null,
      appleReleaseDate: "2015-02-10",
      compatibleReleaseYears: [1995, 2015, 2024],
    }, seventiesAndEighties)).toBe(false);
  });

  test("retains an evidence-backed candidate year when Apple exposes no useful issue history", () => {
    expect(recordingFamilySatisfiesEraConstraint({
      candidateReleaseYear: 1982,
      appleReleaseDate: "2020-01-01",
      compatibleReleaseYears: [],
    }, seventiesAndEighties)).toBe(true);
  });

  test("does not infer an era when every date is absent or malformed", () => {
    expect(recordingFamilySatisfiesEraConstraint({
      candidateReleaseYear: null,
      appleReleaseDate: "unknown",
      compatibleReleaseYears: [],
    }, seventiesAndEighties)).toBe(false);
  });

  test("preserves disjoint requested decades instead of admitting the decade between them", () => {
    const seventiesAndNineties = {
      operator: "within" as const,
      values: ["1970s", "1990s"],
    };
    expect(recordingFamilySatisfiesEraConstraint({
      candidateReleaseYear: 1985,
      compatibleReleaseYears: [],
    }, seventiesAndNineties)).toBe(false);
    expect(recordingFamilySatisfiesEraConstraint({
      candidateReleaseYear: 1978,
      compatibleReleaseYears: [],
    }, seventiesAndNineties)).toBe(true);
    expect(recordingFamilySatisfiesEraConstraint({
      candidateReleaseYear: 1994,
      compatibleReleaseYears: [],
    }, seventiesAndNineties)).toBe(true);
  });

  test("keeps an explicit between constraint continuous", () => {
    expect(recordingFamilySatisfiesEraConstraint({
      candidateReleaseYear: 1985,
      compatibleReleaseYears: [],
    }, {
      operator: "between",
      values: ["1979", "1991"],
    })).toBe(true);
  });

  test("uses the oldest compatible recording-family issue for scoring and ordering", () => {
    expect(canonicalRecordingFamilyReleaseYear({
      candidateReleaseYear: 1984,
      appleReleaseDate: "2024-07-01",
      compatibleReleaseYears: [2001, 1978, 2024],
    })).toBe(1978);
    expect(canonicalRecordingFamilyReleaseYear({
      candidateReleaseYear: null,
      appleReleaseDate: "unknown",
      compatibleReleaseYears: [],
    })).toBeNull();
  });
});
