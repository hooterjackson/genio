import { describe, expect, test } from "vitest";
import { buildInformation } from "../server/build-info.ts";
import packageMetadata from "../package.json";

describe("public build information", () => {
  test("combines the package version with the allowlisted Railway commit revision", () => {
    const revision = "0eff31581de337df343e06b570631f82b220b3e4";
    expect(buildInformation({
      APP_VERSION: "0.2.0",
      RAILWAY_GIT_COMMIT_SHA: revision,
      OPENAI_API_KEY: "sk-proj-must-never-appear",
    })).toEqual({
      identifier: "0.2.0+0eff31581de3",
      version: "0.2.0",
      revision,
    });
  });

  test("falls back to package metadata and rejects unsafe revision strings", () => {
    const result = buildInformation({
      RAILWAY_GIT_COMMIT_SHA: "secret=value",
      COMMIT_SHA: "not-a-commit",
    });
    expect(result).toEqual({ identifier: packageMetadata.version, version: packageMetadata.version, revision: null });
    expect(JSON.stringify(result)).not.toContain("secret=value");
  });
});
