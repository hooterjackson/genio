import { describe, expect, test } from "vitest";
import {
  hasExplicitPlaywrightProject,
  normalizePlaywrightArguments,
  playwrightProjectRuns,
  RESPONSIVE_QA_PROJECTS,
} from "../scripts/qa-playwright-args.mjs";

describe("browser QA argument routing", () => {
  test("strips pnpm's delimiter so Playwright still parses filters", () => {
    expect(normalizePlaywrightArguments([
      "--",
      "tests/e2e/privacy.spec.ts",
      "--project=mobile-320",
    ])).toEqual([
      "tests/e2e/privacy.spec.ts",
      "--project=mobile-320",
    ]);
  });

  test.each([
    [["--project=desktop"]],
    [["--project", "desktop"]],
  ])("recognizes an explicit project without splitting the run", (arguments_) => {
    expect(hasExplicitPlaywrightProject(arguments_)).toBe(true);
    expect(playwrightProjectRuns(arguments_)).toEqual([{
      arguments_,
      projectName: undefined,
    }]);
  });

  test("runs every responsive project in a fresh Playwright process by default", () => {
    const runs = playwrightProjectRuns(["--", "tests/e2e/mobile.spec.ts", "-g", "composer"]);
    expect(runs.map(({ projectName }) => projectName)).toEqual(RESPONSIVE_QA_PROJECTS);
    expect(runs).toHaveLength(4);
    for (const run of runs) {
      expect(run.arguments_).toEqual(expect.arrayContaining([
        "tests/e2e/mobile.spec.ts",
        `--project=${run.projectName}`,
        `--output=test-results/${run.projectName}`,
      ]));
      expect(run.arguments_[0]).not.toBe("--");
    }
  });
});
