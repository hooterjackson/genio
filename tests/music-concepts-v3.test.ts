import { describe, expect, test } from "vitest";
import {
  MUSIC_CONCEPT_POLICY_VERSION,
  canonicalMusicConceptIdV3,
  discoveryMusicConceptV3,
  eligibilityAliasesForMusicConceptV3,
  musicConceptEvidenceMatchesV3,
} from "../server/music-concepts-v3.ts";

describe("server-owned music concept registry", () => {
  test("keeps exact aliases separate from broader discovery terms", () => {
    expect(MUSIC_CONCEPT_POLICY_VERSION).toBe("music_concepts_v3_3_0");
    expect(eligibilityAliasesForMusicConceptV3("baile funk")).toEqual(["funk carioca", "baile funk"]);
    expect(discoveryMusicConceptV3("Brazilian funk")?.id).toBe("genre:brazilian-funk-ambiguous");
    expect(eligibilityAliasesForMusicConceptV3("Brazilian funk")).toEqual(["Brazilian funk"]);
    expect(eligibilityAliasesForMusicConceptV3("funk")).toEqual(["funk"]);
    expect(canonicalMusicConceptIdV3("reggaeton")).toBe("genre:reggaeton");
    expect(canonicalMusicConceptIdV3("Latin urban")).toBe("genre:latin-urban");
    expect(canonicalMusicConceptIdV3("dembow")).toBe("genre:dembow");
  });

  test("supports server-owned semantic evidence patterns without model-promoted aliases", () => {
    expect(musicConceptEvidenceMatchesV3(
      "editorial:tiktok-virality",
      "The single went viral on TikTok after a dance challenge.",
    )).toBe(true);
    expect(musicConceptEvidenceMatchesV3(
      "genre:funk-carioca",
      "A foundational baile funk recording from Rio.",
    )).toBe(true);
    expect(musicConceptEvidenceMatchesV3("genre:funk-carioca", "A 1970s American funk classic.")).toBe(false);
    expect(musicConceptEvidenceMatchesV3("genre:reggaeton", "A polished reggaetón anthem.")).toBe(true);
  });

  test("uses stable ids for unknown exact concepts", () => {
    expect(canonicalMusicConceptIdV3("  Wandelweiser  ")).toBe(canonicalMusicConceptIdV3("wandelweiser"));
    expect(canonicalMusicConceptIdV3("Wandelweiser")).toMatch(/^term:wandelweiser:[a-f0-9]{12}$/u);
  });
});
