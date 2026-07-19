import { describe, expect, test } from "vitest";
import type { SelectionPlan, TrackScopeBinding } from "../shared/types.ts";
import {
  bindingGeographyRelationship,
  parseSelectionGeographyConstraints,
  proofSupportsSelectionGeography,
  provenancePathWithGeographyRelationship,
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
