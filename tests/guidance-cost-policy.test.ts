import { describe, expect, test, vi } from "vitest";
import { isGuidanceScoutOperation, Repository } from "../server/repository.ts";

describe("guided research cost partition", () => {
  test("classifies the canonical question-scout operation and rollout-compatible suffixes", () => {
    expect(isGuidanceScoutOperation("brief.question_scout")).toBe(true);
    expect(isGuidanceScoutOperation("brief.question_scout:primary")).toBe(true);
    expect(isGuidanceScoutOperation("brief.scout:legacy")).toBe(true);
    expect(isGuidanceScoutOperation("brief.interpret:primary")).toBe(false);
    expect(isGuidanceScoutOperation("research.fast.web")).toBe(false);
  });

  test("excludes scout spend from the allowance reported to track research", async () => {
    const query = vi.fn(async (text: string) => {
      expect(text).toContain("operation NOT LIKE 'brief.question_scout%'");
      expect(text).toContain("operation NOT LIKE 'brief.scout%'");
      return { rows: [{ actual: 0.17 }] };
    });
    const repository = new Repository({ pool: { query }, db: {} } as never);

    await expect(repository.getBriefActualCostUsd("brief-id")).resolves.toBeCloseTo(0.17, 6);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
