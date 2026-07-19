import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  canonicalFastResearchSubject,
  extractFastCandidatesFromSynthesis,
  fastExtractionSchema,
  fastSynthesisCheckpoint,
  parseFastExtraction,
  validateFastCandidates,
} from "../server/fast-research.ts";
import { collectHostedCitationAttestations } from "../server/research.ts";
import { resolveEvidenceSubjectBinding } from "../server/evidence-binding.ts";

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

function evidenceGroup(input: {
  subject?: string;
  relationship?: string;
  tracks: string[];
  containers?: string[];
}): string {
  return `EVIDENCE GROUP | SUBJECT: ${input.subject ?? "Berlin techno"} | RELATIONSHIP: ${input.relationship ?? "historically influential in the scene"} | TRACKS: ${input.tracks.join("; ")} | CONTAINERS: ${input.containers?.join("; ") ?? "NONE"}`;
}

function synthesisResponse(support = evidenceGroup({
  tracks: ["Fixture Artist — Signal One", "Second Artist — Signal Two"],
  containers: ["Fixture Artist — Album Alpha", "YEAR 1992 — VERSION original mix"],
})) {
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

  test("counts hosted searches without treating page inspection as another search", () => {
    const response: any = synthesisResponse();
    response.output.splice(1, 0,
      { type: "web_search_call", action: { type: "search", query: "Berlin techno discography" } },
      { type: "web_search_call", action: { type: "open_page", url: "https://history.example/berlin-techno" } },
      { type: "web_search_call", action: { type: "find_in_page", pattern: "track" } },
    );

    const checkpoint = fastSynthesisCheckpoint(response, collectHostedCitationAttestations(response));

    expect(checkpoint.webSearchCalls).toBe(2);
    expect(extractFastCandidatesFromSynthesis(checkpoint, 120)).toHaveLength(2);
  });

  test("counts unknown hosted-search actions conservatively", () => {
    const response: any = synthesisResponse();
    response.output.splice(1, 0, {
      type: "web_search_call",
      action: { type: "future_search_action" },
    });

    const checkpoint = fastSynthesisCheckpoint(response, collectHostedCitationAttestations(response));

    expect(checkpoint.webSearchCalls).toBe(2);
  });

  test("deterministically extracts cited Artist — Track pairs without a second model call", () => {
    const source = synthesisResponse(evidenceGroup({
      tracks: ["Fixture Artist — Signal One", "Second Artist — Signal Two"],
      containers: ["Fixture Artist — Album Alpha"],
    }));
    const synthesis = fastSynthesisCheckpoint(source, collectHostedCitationAttestations(source));

    expect(extractFastCandidatesFromSynthesis(synthesis, 120)).toEqual([
      {
        artist: "Fixture Artist",
        title: "Signal One",
        album: "Album Alpha",
        releaseYear: null,
        versionLabel: null,
        relationship: "historically influential in the scene",
        citationIndexes: [0],
      },
      {
        artist: "Second Artist",
        title: "Signal Two",
        album: null,
        releaseYear: null,
        versionLabel: null,
        relationship: "historically influential in the scene",
        citationIndexes: [0],
      },
    ]);
  });

  test("does not persist a trailing hosted Markdown citation as part of a release title", () => {
    const evidence = `${evidenceGroup({
      tracks: ["Fixture Artist — Signal One"],
      containers: ["Fixture Artist — Album Alpha"],
    })} ([history.example](https://history.example/berlin-techno))`;
    const source = synthesisResponse(evidence);
    const synthesis = fastSynthesisCheckpoint(source, collectHostedCitationAttestations(source));

    expect(extractFastCandidatesFromSynthesis(synthesis, 120)).toEqual([
      expect.objectContaining({
        artist: "Fixture Artist",
        title: "Signal One",
        album: "Album Alpha",
      }),
    ]);
  });

  test("does not guess a container when one artist has multiple tracks or releases", () => {
    const source = synthesisResponse(evidenceGroup({
      tracks: ["Fixture Artist — Signal One", "Fixture Artist — Signal Two"],
      containers: ["Fixture Artist — Album Alpha", "Fixture Artist — Album Beta"],
    }));
    const synthesis = fastSynthesisCheckpoint(source, collectHostedCitationAttestations(source));

    expect(extractFastCandidatesFromSynthesis(synthesis, 120).map((row) => row.album))
      .toEqual([null, null]);
  });

  test("recovers a descriptive evidence-group prefix without weakening tagged subject binding", () => {
    const acceptedSupport = evidenceGroup({
      tracks: ["Fixture Artist — Signal One", "Second Artist — Signal Two"],
    }).replace(/^EVIDENCE GROUP/u, "FOUNDATIONAL BERLIN TECHNO RECORDINGS");
    const accepted = fastSynthesisCheckpoint(
      synthesisResponse(acceptedSupport),
      collectHostedCitationAttestations(synthesisResponse(acceptedSupport)),
    );
    expect(extractFastCandidatesFromSynthesis(accepted, 120).map((row) => row.title))
      .toEqual(["Signal One", "Signal Two"]);

    const mismatchedSupport = acceptedSupport.replace(
      /SUBJECT: Berlin techno/u,
      "SUBJECT: Detroit techno",
    );
    const rejected = fastSynthesisCheckpoint(
      synthesisResponse(mismatchedSupport),
      collectHostedCitationAttestations(synthesisResponse(mismatchedSupport)),
    );
    expect(validateFastCandidates(
      extractFastCandidatesFromSynthesis(rejected, 120),
      brief,
      rejected,
    ).candidates).toEqual([]);
  });

  test("recovers and validates the exact provider formatting drift from the production house run", () => {
    const houseBrief: PlaylistBrief = {
      ...brief,
      title: "Foundations of House",
      subjectEntities: ["House music", "Chicago", "New York", "Detroit", "UK"],
      relationship: "is a recording in the house music genre that satisfies the requested stylistic, geographic, historical, and editorial criteria",
      targetSize: { min: 25, max: 25 },
    };
    const subject = canonicalFastResearchSubject(houseBrief.subjectEntities);
    const variants = [
      `FOUNDATIONAL HOUSE RECORDINGS | SUBJECT: ${subject} | RELATIONSHIP: ${houseBrief.relationship} | TRACKS: Jesse Saunders — On and On; Marshall Jefferson — Move Your Body <inline citations>`,
      `Curated house-history evidence | SUBJECT: ${subject} | RELATIONSHIP: ${houseBrief.relationship} | TRACKS: Frankie Knuckles — Your Love; Adonis — No Way Back | CONTAINERS: NONE <inline citations>`,
      `Historical/scene relevance | SUBJECT: ${subject} | RELATIONSHIP: ${houseBrief.relationship} | TRACKS: Lil Louis — French Kiss; Inner City — Good Life | CONTAINERS: NONE <inline citation>`,
    ];

    for (const support of variants) {
      const response = synthesisResponse(support);
      const synthesis = fastSynthesisCheckpoint(response, collectHostedCitationAttestations(response));
      const extracted = extractFastCandidatesFromSynthesis(synthesis, 120);
      const validated = validateFastCandidates(extracted, houseBrief, synthesis);

      expect(extracted, support).toHaveLength(2);
      expect(validated.rejectedCandidateCount, support).toBe(0);
      expect(validated.sources, support).toHaveLength(1);
      expect(validated.candidates, support).toHaveLength(2);
      expect(validated.candidates[0]!.evidence[0]).toMatchObject({
        subjectEntity: "House music",
        subjectRelationship: houseBrief.relationship,
      });
    }
  });

  test("preserves bracketed track-version labels while removing citation markers", () => {
    const support = `Production replay | SUBJECT: Berlin techno | RELATIONSHIP: ${brief.relationship} | TRACKS: Fixture Artist — Signal [Live]; Second Artist — Pulse [Radio Edit] <inline citations>`;
    const response = synthesisResponse(support);
    const synthesis = fastSynthesisCheckpoint(response, collectHostedCitationAttestations(response));

    expect(extractFastCandidatesFromSynthesis(synthesis, 120).map((row) => row.title))
      .toEqual(["Signal [Live]", "Pulse [Radio Edit]"]);
  });

  test("never upgrades a weaker tagged relationship to the confirmed brief relationship", () => {
    const support = evidenceGroup({
      relationship: "is merely mentioned by the source",
      tracks: ["Fixture Artist — Signal One"],
    });
    const response = synthesisResponse(support);
    const synthesis = fastSynthesisCheckpoint(response, collectHostedCitationAttestations(response));
    const extracted = extractFastCandidatesFromSynthesis(synthesis, 120);

    expect(extracted).toHaveLength(1);
    expect(validateFastCandidates(extracted, brief, synthesis)).toMatchObject({
      candidates: [],
      rejectedCandidateCount: 1,
    });
  });

  test("recovers a production-shaped dense repeated-subject evidence group", () => {
    const tracks = Array.from({ length: 10 }, (_, index) => (
      `Fixture Artist ${index + 1} — Signal ${index + 1}`
    ));
    const support = evidenceGroup({ tracks }).replace(/^EVIDENCE GROUP/u, "Berlin techno");
    const response = synthesisResponse(support);
    const synthesis = fastSynthesisCheckpoint(response, collectHostedCitationAttestations(response));

    expect(extractFastCandidatesFromSynthesis(synthesis, 120)).toHaveLength(10);
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
      evidence: [expect.objectContaining({
        state: "editorial",
        relationship: "historically influential in the scene",
        citationSupport: expect.any(Object),
      })],
    });
    expect(result.sources.map((sourceRecord) => sourceRecord.url)).toEqual(["https://history.example/berlin-techno"]);
    expect(result.rejectedCandidateCount).toBe(3);
  });

  test("rejects model-supplied matching metadata that is absent from the citation", () => {
    const source = synthesisResponse(
      evidenceGroup({
        tracks: ["Fixture Artist — Signal One"],
        containers: ["Fixture Artist — Album Alpha", "YEAR 1992 — VERSION original mix"],
      }),
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

  test("the strict subject field binds the artist when the subject is the recording artist", () => {
    const artistBrief: PlaylistBrief = {
      ...brief,
      subjectEntities: ["Michael Jackson"],
      relationship: "released",
    };
    const support = evidenceGroup({
      subject: "Michael Jackson",
      relationship: "released",
      tracks: ["Michael Jackson — Billie Jean"],
      containers: ["Michael Jackson — Thriller", "YEAR 1982 — VERSION original studio version"],
    });
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

  test("accepts only the exact ordered aggregate for a multi-entity brief and stores a canonical individual subject", () => {
    const movieBrief: PlaylistBrief = {
      ...brief,
      subjectEntities: ["films", "soundtracks", "popular music"],
      relationship: "songs strongly associated with movies",
    };
    expect(canonicalFastResearchSubject(movieBrief.subjectEntities))
      .toBe("films, soundtracks, popular music");

    const validateSubject = (subject: string) => {
      const source = synthesisResponse(evidenceGroup({
        subject,
        relationship: movieBrief.relationship,
        tracks: ["Judy Garland — Over the Rainbow"],
      }));
      const synthesis = fastSynthesisCheckpoint(source, collectHostedCitationAttestations(source));
      return validateFastCandidates(
        extractFastCandidatesFromSynthesis(synthesis, 120),
        movieBrief,
        synthesis,
      );
    };

    const accepted = validateSubject("films, soundtracks, popular music");
    expect(accepted.rejectedCandidateCount).toBe(0);
    expect(accepted.candidates).toHaveLength(1);
    expect(accepted.candidates[0]!.evidence[0]).toMatchObject({
      subjectEntity: "films",
      subjectRelationship: "songs strongly associated with movies",
    });
    expect(resolveEvidenceSubjectBinding(
      movieBrief,
      accepted.candidates[0]!.evidence[0]!.subjectEntity,
      accepted.candidates[0]!.evidence[0]!.subjectRelationship,
    )).toEqual({
      subjectEntity: "films",
      subjectRelationship: "songs strongly associated with movies",
    });

    expect(validateSubject("films, soundtracks").candidates).toHaveLength(0);
    expect(validateSubject("popular music, soundtracks, films").candidates).toHaveLength(0);
    expect(validateSubject("films / soundtracks / popular music").candidates).toHaveLength(0);
    expect(validateSubject("films, soundtracks, popular music, movie culture").candidates).toHaveLength(0);
  });

  test("rejects release and album titles tagged as containers instead of tracks", () => {
    const source = synthesisResponse(evidenceGroup({
      tracks: ["Underground Resistance — Final Frontier"],
      containers: ["X-101 — X-101", "Surgeon — Basictonalvocabulary"],
    }));
    const synthesis = fastSynthesisCheckpoint(source, collectHostedCitationAttestations(source));
    const rows = parseFastExtraction({
      output_text: JSON.stringify({
        candidates: [
          { artist: "Underground Resistance", title: "Final Frontier", album: null, releaseYear: null, versionLabel: null, relationship: "influential techno recording", citationIndexes: [0] },
          { artist: "X-101", title: "X-101", album: null, releaseYear: null, versionLabel: null, relationship: "influential techno recording", citationIndexes: [0] },
          { artist: "Surgeon", title: "Basictonalvocabulary", album: null, releaseYear: null, versionLabel: null, relationship: "influential techno recording", citationIndexes: [0] },
        ],
      }),
    }, 120);

    const result = validateFastCandidates(rows, brief, synthesis);

    expect(result.candidates.map((candidate) => `${candidate.artist} — ${candidate.title}`))
      .toEqual(["Underground Resistance — Final Frontier"]);
    expect(result.rejectedCandidateCount).toBe(2);
  });

  test("deterministically rejects tracks by an excluded reference artist", () => {
    const similarityBrief: PlaylistBrief = {
      ...brief,
      subjectEntities: ["Radiohead"],
      relationship: "stylistically similar to the reference artist",
      exclude: ["Reference artist is a style seed; exclude recordings by: Radiohead"],
    };
    const source = synthesisResponse(evidenceGroup({
      subject: "Radiohead",
      relationship: "stylistically similar to the reference artist",
      tracks: [
        "Radiohead — Weird Fishes/Arpeggi",
        "Other Lives — Tamer Animals",
      ],
    }));
    const synthesis = fastSynthesisCheckpoint(source, collectHostedCitationAttestations(source));
    const rows = parseFastExtraction({
      output_text: JSON.stringify({
        candidates: [
          { artist: "Radiohead", title: "Weird Fishes/Arpeggi", album: null, releaseYear: null, versionLabel: null, relationship: "stylistically similar", citationIndexes: [0] },
          { artist: "Other Lives", title: "Tamer Animals", album: null, releaseYear: null, versionLabel: null, relationship: "stylistically similar", citationIndexes: [0] },
        ],
      }),
    }, 120);

    const result = validateFastCandidates(rows, similarityBrief, synthesis);

    expect(result.candidates.map((candidate) => `${candidate.artist} — ${candidate.title}`))
      .toEqual(["Other Lives — Tamer Animals"]);
    expect(result.rejectedCandidateCount).toBe(1);
  });

  test("bounds the extraction schema to the server candidate ceiling", () => {
    const schema = fastExtractionSchema(999) as any;
    expect(schema.properties.candidates.maxItems).toBe(120);
  });

  test("preserves valid structured candidates when a sibling row is malformed", () => {
    const rows = parseFastExtraction({
      output_text: JSON.stringify({
        candidates: [
          { artist: "Valid Artist A", title: "Valid Track A", album: null, releaseYear: null, versionLabel: null, relationship: "is influential", citationIndexes: [0] },
          { artist: "", title: "Malformed Track", album: null, releaseYear: null, versionLabel: null, relationship: "is influential", citationIndexes: [] },
          { artist: "Valid Artist B", title: "Valid Track B", album: null, releaseYear: null, versionLabel: null, relationship: "is influential", citationIndexes: [1] },
        ],
      }),
    }, 120);

    expect(rows.map((row) => `${row.artist} — ${row.title}`)).toEqual([
      "Valid Artist A — Valid Track A",
      "Valid Artist B — Valid Track B",
    ]);
  });
});
