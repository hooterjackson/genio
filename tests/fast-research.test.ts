import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  fastExtractionSchema,
  fastSynthesisCheckpoint,
  parseFastExtraction,
  validateFastCandidates,
} from "../server/fast-research.ts";
import { collectHostedCitationAttestations } from "../server/research.ts";

const brief: PlaylistBrief = {
  title: "Influential fixture",
  description: "A cited editorial fixture.",
  mode: "curated",
  subjectEntities: ["Berlin techno"],
  relationship: "historically influential in the scene",
  include: [],
  exclude: [],
  versionPolicy: "one canonical recording",
  evidencePolicy: "cited editorial sources",
  orderingPolicy: "influence rank",
  targetSize: { min: 50, max: 100 },
  ambiguities: [],
};

function synthesisResponse(support = "Berlin techno histories identify Fixture Artist — Signal One (1992) and Second Artist — Signal Two as historically influential scene recordings.") {
  const marker = "[source]";
  const text = `${support} ${marker}`;
  return {
    id: "resp-fast-synthesis",
    model: "gpt-5.6-luna",
    output: [
      { type: "web_search_call", action: { type: "search", query: "Berlin techno history" } },
      { id: "msg-fast", type: "message", content: [{
        type: "output_text",
        text,
        annotations: [{
          type: "url_citation",
          url: "https://history.example/berlin-techno",
          title: "Berlin techno history",
          start_index: support.length + 1,
          end_index: text.length,
        }],
      }] },
    ],
  };
}

describe("fast curated research", () => {
  test("persists only provider-attested synthesis sources", () => {
    const response = synthesisResponse();
    const checkpoint = fastSynthesisCheckpoint(response, collectHostedCitationAttestations(response));
    expect(checkpoint).toMatchObject({
      status: "complete",
      responseId: "resp-fast-synthesis",
      webSearchCalls: 1,
      sourceTitles: { "https://history.example/berlin-techno": "Berlin techno history" },
    });
    expect(checkpoint.citationAttestations[0]!.excerpt).toContain("Signal One");
  });

  test("accepts only extracted tracks that bind to a cited local evidence group", () => {
    const source = synthesisResponse();
    const synthesis = fastSynthesisCheckpoint(source, collectHostedCitationAttestations(source));
    const extraction = {
      output_text: JSON.stringify({
        candidates: [
          { artist: "Fixture Artist", title: "Signal One", album: null, releaseYear: 1992, versionLabel: null, relationship: "historically influential scene", citationIndexes: [0] },
          { artist: "Impostor Artist", title: "Signal One", album: null, releaseYear: null, versionLabel: null, relationship: "historically influential scene", citationIndexes: [0] },
          { artist: "Invented Artist", title: "Not In Source", album: null, releaseYear: null, versionLabel: null, relationship: "historically influential scene", citationIndexes: [0] },
          { artist: "Bad URL Artist", title: "Signal Two", album: null, releaseYear: null, versionLabel: null, relationship: "historically influential scene", citationIndexes: [999] },
        ],
      }),
    };
    const rows = parseFastExtraction(extraction, 120);
    const result = validateFastCandidates(rows, brief, synthesis);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      selectionRank: 1,
      artist: "Fixture Artist",
      title: "Signal One",
      evidence: [expect.objectContaining({ state: "editorial", citationSupport: expect.any(Object) })],
    });
    expect(result.sources.map((sourceRecord) => sourceRecord.url)).toEqual(["https://history.example/berlin-techno"]);
    expect(result.rejectedCandidateCount).toBe(3);
  });

  test("rejects model-supplied matching metadata that is absent from the citation", () => {
    const source = synthesisResponse(
      "Berlin techno histories call Fixture Artist — Signal One from Album Alpha (1992, original mix) historically influential in the scene.",
    );
    const synthesis = fastSynthesisCheckpoint(source, collectHostedCitationAttestations(source));
    const rows = parseFastExtraction({
      output_text: JSON.stringify({
        candidates: [
          { artist: "Fixture Artist", title: "Signal One", album: "Album Alpha", releaseYear: 1992, versionLabel: "original mix", relationship: "historically influential in the scene", citationIndexes: [0] },
          { artist: "Impostor Artist", title: "Signal One", album: "Album Alpha", releaseYear: 1992, versionLabel: "original mix", relationship: "historically influential in the scene", citationIndexes: [0] },
          { artist: "Fixture Artist", title: "Signal One", album: "Invented Album", releaseYear: 1992, versionLabel: "original mix", relationship: "historically influential in the scene", citationIndexes: [0] },
          { artist: "Fixture Artist", title: "Signal One", album: "Album Alpha", releaseYear: 1993, versionLabel: "original mix", relationship: "historically influential in the scene", citationIndexes: [0] },
          { artist: "Fixture Artist", title: "Signal One", album: "Album Alpha", releaseYear: 1992, versionLabel: "2012 remaster", relationship: "historically influential in the scene", citationIndexes: [0] },
        ],
      }),
    }, 120);

    const result = validateFastCandidates(rows, brief, synthesis);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      artist: "Fixture Artist",
      title: "Signal One",
      album: "Album Alpha",
      releaseYear: 1992,
      versionLabel: "original mix",
    });
    expect(result.rejectedCandidateCount).toBe(4);
  });

  test("one cited subject mention also binds the artist when the subject is the artist", () => {
    const artistBrief: PlaylistBrief = {
      ...brief,
      subjectEntities: ["Michael Jackson"],
      relationship: "released",
    };
    const support = "Michael Jackson released Billie Jean in 1982 on the album Thriller as the original studio version.";
    expect(support.match(/Michael Jackson/gu)).toHaveLength(1);
    const source = synthesisResponse(support);
    const synthesis = fastSynthesisCheckpoint(source, collectHostedCitationAttestations(source));
    const rows = parseFastExtraction({
      output_text: JSON.stringify({
        candidates: [{
          artist: "Michael Jackson",
          title: "Billie Jean",
          album: "Thriller",
          releaseYear: 1982,
          versionLabel: "original studio version",
          relationship: "released",
          citationIndexes: [0],
        }],
      }),
    }, 120);

    const result = validateFastCandidates(rows, artistBrief, synthesis);

    expect(result.rejectedCandidateCount).toBe(0);
    expect(result.candidates).toHaveLength(1);
  });

  test("bounds the extraction schema to the server candidate ceiling", () => {
    const schema = fastExtractionSchema(999) as any;
    expect(schema.properties.candidates.maxItems).toBe(120);
  });
});
