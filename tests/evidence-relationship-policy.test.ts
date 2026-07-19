import { describe, expect, test } from "vitest";
import { evidenceRelationshipIsMaterial } from "../server/evidence-relationship-policy.ts";

describe("evidence relationship policy", () => {
  test.each([
    "Brazilian Disco Boogie Sounds: 1978-1982",
    "a Brazilian disco classic and boogie landmark",
    "not only a Brazilian disco classic but also a boogie landmark",
    "featured in an authoritative history of the Brazilian disco scene",
  ])("accepts affirmative source-specific wording: %s", (relationship) => {
    expect(evidenceRelationshipIsMaterial(relationship)).toBe(true);
  });

  test.each([
    "is merely mentioned by the source",
    "not part of Brazilian disco",
    "this recording does not belong to Brazilian disco",
    "unrelated to Brazilian disco",
    "outside the Brazilian disco genre",
    "incorrectly classified as Brazilian disco",
    "contains only the phrase Brazilian disco",
    "keyword match only",
    "",
  ])("rejects non-supporting evidence: %s", (relationship) => {
    expect(evidenceRelationshipIsMaterial(relationship)).toBe(false);
  });
});
