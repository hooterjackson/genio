import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import { deriveEvidenceScopeDescriptors } from "../server/repository.ts";
import { createSelectionPlanV2 } from "../server/selection-plan-v2.ts";

function brazilianDiscoBrief(): PlaylistBrief {
  return {
    title: "Brazilian Disco Classics",
    description: "A broad, source-backed survey of Brazilian disco.",
    mode: "curated",
    subjectEntities: ["Brazilian disco"],
    relationship: "is a recording in the Brazilian disco genre",
    include: ["Brazilian disco recordings."],
    exclude: [],
    versionPolicy: "Prefer one canonical studio recording per song.",
    evidencePolicy: "Require track-scope editorial or historical evidence.",
    orderingPolicy: "Intermix artists and albums.",
    targetSize: { min: 50, max: 50 },
    ambiguities: [],
  };
}

function descriptorsFor(relationship: string) {
  const brief = brazilianDiscoBrief();
  const plan = createSelectionPlanV2({
    prompt: "Brazilian disco songs",
    brief,
    storefront: "us",
  });
  return deriveEvidenceScopeDescriptors(plan, brief, relationship);
}

describe("repository evidence scope-binding derivation", () => {
  test("turns affirmative source-specific container wording into a typed scope binding", () => {
    const descriptors = descriptorsFor("Brazilian Disco Boogie Sounds: 1978-1982");

    expect(descriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeAxis: "genre" }),
    ]));
  });

  test("does not let repeated positive subject metadata override a negated relationship", () => {
    const descriptors = descriptorsFor(
      "this recording does not belong to Brazilian disco",
    );

    expect(descriptors).toEqual([]);
  });

  test("keeps the affirmative not-only construction eligible", () => {
    const descriptors = descriptorsFor(
      "not only a Brazilian disco classic but also a boogie landmark",
    );

    expect(descriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeAxis: "genre" }),
    ]));
  });

  test.each([
    "unrelated to Brazilian disco",
    "outside the Brazilian disco genre",
    "incorrectly classified as Brazilian disco",
    "keyword match only",
  ])("rejects non-supporting source relationships before binding generation: %s", (relationship) => {
    expect(descriptorsFor(relationship)).toEqual([]);
  });
});
