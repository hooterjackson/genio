import { describe, expect, test } from "vitest";
import type { SelectionPlan, TrackScopeBinding } from "../shared/types.ts";
import {
  bindingGeographyRelationship,
  parseSelectionGeographyConstraints,
  proofSupportsSelectionGeography,
  provenancePathWithGeographyRelationship,
  selectionGeographyIsAudienceMarketContext,
  selectionGeographyBindingsSatisfied,
} from "../server/selection-geography-policy.ts";

function binding(input: Partial<TrackScopeBinding> = {}): TrackScopeBinding {
  return {
    bindingKind: "track_specific_source",
    eligibility: "qualifying",
    scopeAxis: "geography",
    scopeValue: "French",
    geographyRelationship: null,
    relationship: "The artist resides in France.",
    confidence: 0.95,
    sourceUrl: "https://example.org/exact-track-proof",
    sourceRecordId: "source-1",
    researchContainerId: null,
    citationAttestationId: "citation-1",
    provenancePath: [
      { kind: "provenance_root", id: "example" },
      { kind: "source_record", id: "source-1" },
    ],
    note: "The cited biography documents the artist as residing in France.",
    ...input,
  };
}

function plan(
  value: string,
  relationship: NonNullable<TrackScopeBinding["geographyRelationship"]>,
): Pick<SelectionPlan, "geographyConstraints"> {
  return { geographyConstraints: [{ value, relationship }] };
}

describe("typed selection geography", () => {
  test("keeps language separate while preserving an unresolved national adjective", () => {
    expect(parseSelectionGeographyConstraints("French-language American house music")).toEqual([
      { value: "French", relationship: "language" },
      { value: "American", relationship: "unspecified" },
    ]);
  });

  test("treats coordinated languages as an allowed set instead of requiring bilingual tracks", () => {
    expect(parseSelectionGeographyConstraints("tracks in Arabic and French")).toEqual(expect.arrayContaining([
      { value: "Arabic", relationship: "language" },
      { value: "French", relationship: "language" },
    ]));
    const multilingualPlan: Pick<SelectionPlan, "geographyConstraints"> = {
      geographyConstraints: [
        { value: "Arabic", relationship: "language" },
        { value: "French", relationship: "language" },
      ],
    };
    const french = binding({
      scopeAxis: "language",
      scopeValue: "French",
      geographyRelationship: "language",
      relationship: "The track is sung in French.",
      note: "The cited track annotation identifies French-language vocals.",
    });
    const german = binding({
      scopeAxis: "language",
      scopeValue: "German",
      geographyRelationship: "language",
      relationship: "The track is sung in German.",
      note: "The cited track annotation identifies German-language vocals.",
    });
    expect(selectionGeographyBindingsSatisfied(multilingualPlan, [french])).toBe(true);
    expect(selectionGeographyBindingsSatisfied(multilingualPlan, [german])).toBe(false);
  });

  test("treats places within one geography relationship as alternatives", () => {
    const eitherScene: Pick<SelectionPlan, "geographyConstraints"> = {
      geographyConstraints: [
        { value: "Brazilian", relationship: "unspecified" },
        { value: "French", relationship: "unspecified" },
      ],
    };
    const brazilian = binding({
      scopeValue: "Brazilian",
      relationship: "The recording belongs to the Brazilian scene.",
      note: "The track-specific source places it in Brazil.",
    });
    expect(selectionGeographyBindingsSatisfied({
      ...eitherScene,
      policyVersion: "relevance_first_2026_07_r2",
    }, [brazilian])).toBe(true);
    expect(selectionGeographyBindingsSatisfied({
      ...eitherScene,
      policyVersion: "relevance_first_2026_07",
    }, [brazilian])).toBe(false);
  });

  test("keeps distinct geography relationships conjunctive", () => {
    const originAndLocation: Pick<SelectionPlan, "geographyConstraints"> = {
      geographyConstraints: [
        { value: "Brazilian", relationship: "artist_origin" },
        { value: "French", relationship: "recording_location" },
      ],
    };
    const brazilianOrigin = binding({
      scopeValue: "Brazilian",
      geographyRelationship: "artist_origin",
      relationship: "The artist is from Brazil.",
      note: "The cited biography documents Brazilian origin.",
    });
    const frenchSession = binding({
      scopeValue: "French",
      geographyRelationship: "recording_location",
      relationship: "The recording was made in France.",
      note: "The cited liner notes document a French recording session.",
    });
    expect(selectionGeographyBindingsSatisfied(originAndLocation, [brazilianOrigin])).toBe(false);
    expect(selectionGeographyBindingsSatisfied(originAndLocation, [brazilianOrigin, frenchSession])).toBe(true);
  });

  test.each([
    ["jazz from the French scene", "label_or_venue_scene"],
    ["jazz recorded in France", "recording_location"],
    ["jazz by artists residing in France", "artist_residence"],
    ["jazz by artists from France", "artist_origin"],
    ["jazz associated with the French sound", "sound_association"],
  ] as const)("parses %s as %s", (prompt, relationship) => {
    expect(parseSelectionGeographyConstraints(prompt)).toContainEqual({ value: "French", relationship });
  });

  test("preserves bare French jazz as typed ambiguity", () => {
    expect(parseSelectionGeographyConstraints("French jazz")).toEqual([
      { value: "French", relationship: "unspecified" },
    ]);
  });

  test("preserves Irish and Ireland as one governed geographic family", () => {
    expect(parseSelectionGeographyConstraints("Irish music")).toEqual([
      { value: "Irish", relationship: "unspecified" },
    ]);
    expect(parseSelectionGeographyConstraints("music by artists from Ireland"))
      .toContainEqual({
        value: "Irish",
        relationship: "artist_origin",
      });
  });

  test.each([
    ["disco a 65-year-old listener in Brazil may plausibly have heard", "Brazilian"],
    ["iconic disco songs my father might have listened to growing up in Brazil", "Brazilian"],
    ["international disco staples that were popular in Brazil", "Brazilian"],
    ["global jazz familiar to listeners in France", "French"],
    ["club hits that charted in the American market", "American"],
  ])("recognizes listener and popularity geography as market context: %s", (prompt, value) => {
    expect(selectionGeographyIsAudienceMarketContext(prompt, value)).toBe(true);
  });

  test.each([
    ["Brazilian disco songs", "Brazilian"],
    ["French jazz recordings", "French"],
    ["American drill tracks", "American"],
    ["disco recordings from Brazil", "Brazilian"],
  ])("keeps intrinsic recording geography out of market context: %s", (prompt, value) => {
    expect(selectionGeographyIsAudienceMarketContext(prompt, value)).toBe(false);
  });

  test("requires exact relationship proof rather than a shared place word", () => {
    expect(proofSupportsSelectionGeography(
      "A French artist recorded the album in London.",
      { value: "French", relationship: "recording_location" },
    )).toBe(false);
    expect(proofSupportsSelectionGeography(
      "The album was recorded in France at Studio Davout.",
      { value: "French", relationship: "recording_location" },
    )).toBe(true);
  });

  test("treats a country noun and demonym as equivalent without weakening relationship proof", () => {
    expect(proofSupportsSelectionGeography(
      "A foundational disco recording by Brazilian artists.",
      { value: "Brazil", relationship: "artist_origin" },
    )).toBe(true);
    expect(proofSupportsSelectionGeography(
      "A foundational Brazilian disco recording.",
      { value: "Brazil", relationship: "artist_origin" },
    )).toBe(false);
    expect(proofSupportsSelectionGeography(
      "The record was made by Brazilian artists in Paris.",
      { value: "Brazil", relationship: "recording_location" },
    )).toBe(false);
  });

  test("round-trips the relationship through the persisted provenance path", () => {
    const stored = binding({
      geographyRelationship: null,
      provenancePath: provenancePathWithGeographyRelationship([], "artist_residence"),
    });
    expect(bindingGeographyRelationship(stored)).toBe("artist_residence");
    expect(selectionGeographyBindingsSatisfied(plan("French", "artist_residence"), [stored])).toBe(true);
    expect(selectionGeographyBindingsSatisfied(plan("French", "artist_origin"), [stored])).toBe(false);
  });

  test("does not let a scene binding satisfy recording-location or residence constraints", () => {
    const scene = binding({
      scopeAxis: "scene",
      geographyRelationship: "label_or_venue_scene",
      relationship: "Exact member of a documented French jazz scene container.",
      provenancePath: provenancePathWithGeographyRelationship([], "label_or_venue_scene"),
    });
    expect(selectionGeographyBindingsSatisfied(plan("French", "label_or_venue_scene"), [scene])).toBe(true);
    expect(selectionGeographyBindingsSatisfied(plan("French", "recording_location"), [scene])).toBe(false);
    expect(selectionGeographyBindingsSatisfied(plan("French", "artist_residence"), [scene])).toBe(false);
  });
});
