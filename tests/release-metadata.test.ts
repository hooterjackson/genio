import { describe, expect, test } from "vitest";
import packageMetadata from "../package.json";
import releaseManifest from "../shared/releases.json";
import { currentRelease, formatReleaseDate, releaseHistory } from "../shared/release-metadata.ts";

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

describe("application release metadata", () => {
  test("uses one current semantic version throughout the application", () => {
    expect(releaseManifest.schemaVersion).toBe(1);
    expect(currentRelease).toBe(releaseHistory[0]);
    expect(currentRelease.version).toBe(packageMetadata.version);
    expect(currentRelease.version).toMatch(semver);
  });

  test("keeps release history newest-first with usable patch notes", () => {
    const versions = new Set<string>();
    const dates = new Set<string>();
    for (const [index, release] of releaseHistory.entries()) {
      expect(release.version).toMatch(semver);
      expect(versions.has(release.version)).toBe(false);
      versions.add(release.version);
      expect(release.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(Number.isNaN(Date.parse(`${release.releasedAt}T00:00:00.000Z`))).toBe(false);
      expect(dates.has(`${release.version}:${release.releasedAt}`)).toBe(false);
      dates.add(`${release.version}:${release.releasedAt}`);
      expect(release.title.trim().length).toBeGreaterThanOrEqual(3);
      expect(release.notes.length).toBeGreaterThan(0);
      for (const note of release.notes) expect(note.trim().length).toBeGreaterThanOrEqual(8);
      if (index > 0) expect(release.releasedAt <= releaseHistory[index - 1]!.releasedAt).toBe(true);
    }
  });

  test("formats date-only release dates without shifting time zones", () => {
    expect(formatReleaseDate("2026-07-18")).toBe("July 18, 2026");
  });
});
