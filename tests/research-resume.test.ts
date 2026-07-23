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
    maxAttempts: 6,
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

test("fast resumes carry an exact server-owned queue marker", () => {
  expect(researchResumeJob("run-fast", null, { fast: true })).toMatchObject({
    payload: {
      runId: "run-fast",
      phase: "scope_resolution",
      fast: true,
    },
  });
  expect(researchResumeJob("run-deep", null, { fast: false }).payload).not.toHaveProperty("fast");
});

test("fast resume reconstruction preserves the original absolute timing", () => {
  const fastRoute = {
    confirmedAt: "2026-07-14T12:00:00.000Z",
    researchDeadlineAt: "2026-07-14T12:01:35.000Z",
    deadlineAt: "2026-07-14T12:02:00.000Z",
  };
  expect(researchResumeJob("run-fast-timed", null, { fast: true, fastRoute }).payload).toMatchObject({
    fast: true,
    fastConfirmedAt: fastRoute.confirmedAt,
    fastResearchDeadlineAt: fastRoute.researchDeadlineAt,
    fastDeadlineAt: fastRoute.deadlineAt,
  });
});
