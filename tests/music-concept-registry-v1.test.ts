import { describe, expect, test } from "vitest";
import {
  PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
  resolveMusicConceptV1,
} from "../server/music-concept-registry-v1.ts";

describe("playlist contract music concept resolver", () => {
  test("resolves eligibility concepts while preserving relationships and source wording", () => {
    const resolution = resolveMusicConceptV1({ text: "  Reggaetón " });
    expect(resolution).toMatchObject({
      status: "resolved",
      originalText: "Reggaetón",
      ontologyVersion: PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
      selectedConceptId: "genre:reggaeton",
    });
    expect(resolution.candidates[0]).toMatchObject({
      parentIds: ["genre:latin-urban"],
      adjacentIds: ["genre:dembow", "genre:latin-pop"],
    });
  });

  test("resolves drill as selection-grade genre while keeping adjacent scenes as discovery leads", () => {
    expect(resolveMusicConceptV1({ text: "drill", expectedKind: "genre" })).toMatchObject({
      status: "resolved",
      ontologyVersion: PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
      selectedConceptId: "genre:drill",
    });
    expect(resolveMusicConceptV1({ text: "UK drill", expectedKind: "genre" })).toMatchObject({
      status: "resolved",
      selectedConceptId: "genre:drill",
    });
  });

  test("keeps material ambiguity explicit until a candidate is selected", () => {
    const ambiguous = resolveMusicConceptV1({ text: "house" });
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.selectedConceptId).toBeNull();
    expect(ambiguous.candidates.map((candidate) => candidate.conceptId)).toEqual([
      "genre:house-music",
      "theme:houses-and-homes",
    ]);

    expect(resolveMusicConceptV1({ text: "house", expectedKind: "genre" })).toMatchObject({
      status: "resolved",
      selectedConceptId: "genre:house-music",
    });
    expect(resolveMusicConceptV1({
      text: "house",
      selectedConceptId: "theme:houses-and-homes",
    })).toMatchObject({
      status: "resolved",
      selectedConceptId: "theme:houses-and-homes",
    });
  });

  test("does not promote discovery terms or unknown text to eligibility concepts", () => {
    const discovery = resolveMusicConceptV1({ text: "perreo" });
    expect(discovery).toMatchObject({
      status: "discovery_only",
      selectedConceptId: null,
      discoveryHint: "perreo",
    });
    expect(discovery.candidates[0]?.conceptId).toBe("genre:reggaeton");

    const unresolved = resolveMusicConceptV1({ text: "Wandelweiser-adjacent fog music" });
    expect(unresolved.status).toBe("unresolved");
    expect(unresolved.selectedConceptId).toBeNull();
    expect(unresolved.unresolvedTermId).toMatch(/^unresolved:[0-9a-f]{16}$/u);
  });

  test("retains competing interpretations for overloaded scene terminology", () => {
    const result = resolveMusicConceptV1({ text: "Brazilian funk" });
    expect(result.status).toBe("ambiguous");
    expect(result.candidates.map((candidate) => candidate.conceptId)).toEqual([
      "genre:brazilian-soul-funk",
      "genre:funk-carioca",
    ]);
  });
});
