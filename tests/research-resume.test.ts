import { expect, test } from "vitest";
import { researchResumeJob } from "../server/research-resume.ts";

test("budget and crash resumes preserve the durable generation and segment", () => {
  expect(researchResumeJob("run-1", {
    phase: "gap_analysis",
    gapAttempt: 3,
    generation: 7,
    segment: 4,
  })).toEqual({
    kind: "research",
    runId: "run-1",
    payload: {
      runId: "run-1",
      phase: "gap_analysis",
      gapAttempt: 3,
      generation: 7,
      segment: 4,
    },
    dedupeKey: "research:run-1:gap_analysis:3:g7",
  });
});

test("new research runs start at the first durable segment", () => {
  expect(researchResumeJob("run-2", null)).toMatchObject({
    payload: {
      runId: "run-2",
      phase: "scope_resolution",
      gapAttempt: 0,
      generation: 0,
      segment: 0,
    },
    dedupeKey: "research:run-2:scope_resolution:g0",
  });
});
