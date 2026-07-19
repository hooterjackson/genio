import { expect, test } from "vitest";
import { partitionUniqueRecordingFamilies } from "../server/recording-family-selection.ts";

test("manifest family partition keeps one row per recording family and preserves reserve order", () => {
  const rows = [
    { candidateId: "first", familyId: "family-a" },
    { candidateId: "alternate-apple-id", familyId: "family-a" },
    { candidateId: "second", familyId: "family-b" },
  ];

  const result = partitionUniqueRecordingFamilies(rows, (row) => row.familyId);

  expect(result.unique.map((row) => row.candidateId)).toEqual(["first", "second"]);
  expect(result.duplicates.map((row) => row.candidateId)).toEqual(["alternate-apple-id"]);
});
