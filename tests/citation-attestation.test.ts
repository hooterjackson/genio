import { describe, expect, test } from "vitest";
import {
  citationSupportWindow,
  MAX_CITATION_EXCERPT_CHARS,
} from "../server/citation-attestation.ts";

describe("citation support-window bounds", () => {
  test("accepts a provider-attested line above 1,000 characters but below the strict cap", () => {
    const claim = "A".repeat(1_100);
    const marker = "[source]";
    const text = `${claim} ${marker}`;

    const support = citationSupportWindow(text, claim.length + 1, text.length);

    expect(MAX_CITATION_EXCERPT_CHARS).toBe(1_500);
    expect(support).toEqual({
      startIndex: 0,
      endIndex: text.length,
      excerpt: text,
    });
    expect(support!.excerpt.length).toBeGreaterThan(1_000);
    expect(support!.excerpt.length).toBeLessThan(MAX_CITATION_EXCERPT_CHARS);
  });

  test("rejects a provider-attested line above the finite 1,500-character cap", () => {
    const claim = "A".repeat(MAX_CITATION_EXCERPT_CHARS);
    const marker = "[source]";
    const text = `${claim} ${marker}`;

    expect(citationSupportWindow(text, claim.length + 1, text.length)).toBeNull();
  });
});
