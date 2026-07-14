import { describe, expect, test } from "vitest";
import {
  OWNER_CATALOG_IMPORT_LIMITS,
  parseOwnerCatalogImport,
  unverifiedImportedCandidates,
} from "../server/catalog-import.ts";

const sourceUrl = "https://credits.example.org/releases/one";

describe("owner catalogue import", () => {
  test("normalizes JSON rows into import sources and track candidates", () => {
    const result = parseOwnerCatalogImport({
      format: "json",
      data: [{
        artistName: "  Paulinho   da Costa ",
        trackTitle: "Água de Beber",
        album: "  Example   Album ",
        year: "1982",
        durationMs: "240000",
        isrc: "US-ABC-82-12345",
        mbid: "123e4567-e89b-42d3-a456-426614174000",
        version: " Studio  version ",
        source: `${sourceUrl}#credit`,
        sourceTitle: " Release credits ",
        provenanceRoot: "Original liner notes",
        confidence: "explicit",
        scope: "recording",
        subject: "Paulinho da Costa",
        subjectRelationship: "performed on",
        relationship: " performed   on ",
        note: " Credited on the individual track. ",
      }],
    });

    expect(result.sources).toEqual([{
      url: sourceUrl,
      title: "Release credits",
      sourceClass: "import",
      provenanceRoot: "Original liner notes",
      note: "Imported owner catalogue source.",
    }]);
    expect(result.candidates).toEqual([{
      artist: "Paulinho da Costa",
      title: "Água de Beber",
      album: "Example Album",
      releaseYear: 1982,
      durationMs: 240000,
      isrc: "USABC8212345",
      musicbrainzId: "123e4567-e89b-42d3-a456-426614174000",
      versionLabel: "Studio version",
      evidence: [{
        sourceUrl,
        state: "verified",
        supportScope: "track",
        subjectEntity: "Paulinho da Costa",
        subjectRelationship: "performed on",
        relationship: "performed on",
        note: "Credited on the individual track.",
      }],
    }]);
  });

  test("parses RFC4180 quoted commas, escaped quotes, CRLF, and embedded newlines", () => {
    const csv = [
      "artist,title,album,sourceUrl,evidenceState,supportScope,evidenceNote",
      `"Artist, The","A ""Quoted"" Song","Album, One",${sourceUrl},confirmed,track,"Line one`,
      `Line two"`,
      `Second Artist,Second Song,,${sourceUrl},editorial,editorial,Curator selection`,
      "",
    ].join("\r\n");
    const result = parseOwnerCatalogImport({ format: "csv", data: csv });

    expect(result.sources).toHaveLength(1);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      artist: "Artist, The",
      title: 'A "Quoted" Song',
      album: "Album, One",
      evidence: [{ state: "inferred", supportScope: "track", note: "Line one Line two" }],
    });
    expect(result.candidates[1]?.evidence[0]).toMatchObject({ state: "editorial", supportScope: "editorial" });
  });

  test("conservatively downgrades non-track evidence and defaults unspecified evidence to inferred", () => {
    const result = parseOwnerCatalogImport([
      { artist: "Artist", title: "Album claim", sourceUrl, evidenceState: "verified", supportScope: "album" },
      { artist: "Artist", title: "Session claim", sourceUrl, evidenceState: "corroborated", supportScope: "session" },
      { artist: "Artist", title: "Unspecified claim", sourceUrl },
    ]);
    expect(result.candidates.map((item) => item.evidence[0]?.state)).toEqual(["inferred", "inferred", "inferred"]);
    expect(result.candidates.map((item) => item.evidence[0]?.supportScope)).toEqual(["album", "session", "track"]);
  });

  test("requires two independent provenance roots for corroborated imports", () => {
    const one = parseOwnerCatalogImport([
      { artist: "Artist", title: "Song", sourceUrl, evidenceState: "corroborated", supportScope: "track", provenanceRoot: "source-a" },
    ]);
    expect(one.candidates[0]?.evidence[0]?.state).toBe("inferred");

    const two = parseOwnerCatalogImport([
      { artist: "Artist", title: "Song", isrc: "USAAA2000001", sourceUrl, evidenceState: "corroborated", supportScope: "track", provenanceRoot: "source-a" },
      { artist: "Artist", title: "Song", isrc: "USAAA2000001", sourceUrl: "https://credits.example.net/releases/one", evidenceState: "corroborated", supportScope: "track", provenanceRoot: "source-b" },
    ]);
    expect(two.candidates.map((candidate) => candidate.evidence[0]?.state)).toEqual(["corroborated", "corroborated"]);

    const metadataOnly = parseOwnerCatalogImport([
      { artist: "Artist", title: "Song", sourceUrl, evidenceState: "corroborated", supportScope: "track", provenanceRoot: "source-a" },
      { artist: "Artist", title: "Song", sourceUrl: "https://credits.example.net/releases/two", evidenceState: "corroborated", supportScope: "track", provenanceRoot: "source-b" },
    ]);
    expect(metadataOnly.candidates.map((candidate) => candidate.evidence[0]?.state)).toEqual(["inferred", "inferred"]);

    const unknownRoots = parseOwnerCatalogImport([
      { artist: "Artist", title: "Song", isrc: "USAAA2000002", sourceUrl, evidenceState: "corroborated", supportScope: "track" },
      { artist: "Artist", title: "Song", isrc: "USAAA2000002", sourceUrl: "https://mirror.example.net/song", evidenceState: "corroborated", supportScope: "track" },
    ]);
    expect(unknownRoots.sources.map((source) => source.provenanceRoot)).toEqual(["unclassified", "unclassified"]);
    expect(unknownRoots.candidates.map((candidate) => candidate.evidence[0]?.state)).toEqual(["inferred", "inferred"]);

    const mirrored = parseOwnerCatalogImport([
      { artist: "Artist", title: "Song", isrc: "USAAA2000003", sourceUrl, evidenceState: "corroborated", supportScope: "track", provenanceRoot: "underlying-ledger" },
      { artist: "Artist", title: "Song", isrc: "USAAA2000003", sourceUrl: "https://mirror.example.net/song", evidenceState: "corroborated", supportScope: "track", provenanceRoot: "underlying-ledger" },
    ]);
    expect(mirrored.candidates.map((candidate) => candidate.evidence[0]?.state)).toEqual(["inferred", "inferred"]);

    const circular = parseOwnerCatalogImport([
      { artist: "Artist", title: "Song", isrc: "USAAA2000004", sourceUrl: "https://circular-one.example/song", evidenceState: "corroborated", supportScope: "track", provenanceRoot: "circular-two.example" },
      { artist: "Artist", title: "Song", isrc: "USAAA2000004", sourceUrl: "https://circular-two.example/song", evidenceState: "corroborated", supportScope: "track", provenanceRoot: "circular-one.example" },
    ]);
    expect(circular.candidates.map((candidate) => candidate.evidence[0]?.state)).toEqual(["inferred", "inferred"]);
  });

  test("retains a conflicting track assertion as disputed and demotes positive support", () => {
    const parsed = parseOwnerCatalogImport([
      { artist: "Artist", title: "Contested", isrc: "USAAA2000005", sourceUrl, evidenceState: "verified", supportScope: "track", provenanceRoot: "source-a" },
      { artist: "Artist", title: "Contested", isrc: "USAAA2000005", sourceUrl: "https://corrections.example.net/song", evidenceState: "disputed", supportScope: "track", provenanceRoot: "source-b", relationship: "not credited as performer" },
    ]);
    expect(parsed.candidates.map((candidate) => candidate.evidence[0]?.state)).toEqual(["inferred", "disputed"]);
  });

  test("production ingestion cannot self-promote owner-declared evidence", () => {
    const parsed = parseOwnerCatalogImport([
      { artist: "Artist", title: "Song", sourceUrl, evidenceState: "verified", supportScope: "track" },
      { artist: "Curator", title: "Selection", sourceUrl: "https://credits.example.net/list", evidenceState: "editorial", supportScope: "editorial" },
    ]);
    expect(parsed.candidates.map((candidate) => candidate.evidence[0]?.state)).toEqual(["verified", "editorial"]);
    expect(unverifiedImportedCandidates(parsed.candidates).map((candidate) => candidate.evidence[0]?.state)).toEqual(["inferred", "inferred"]);
  });

  test("requires artist, title, and an explicit public HTTPS source", () => {
    expect(() => parseOwnerCatalogImport([{ title: "Song", sourceUrl }])).toThrow(/artist/i);
    expect(() => parseOwnerCatalogImport([{ artist: "Artist", sourceUrl }])).toThrow(/title/i);
    expect(() => parseOwnerCatalogImport([{ artist: "Artist", title: "Song" }])).toThrow(/sourceUrl/i);
    expect(() => parseOwnerCatalogImport([{ artist: "Artist", title: "Song", sourceUrl: "http://example.com" }])).toThrow(/HTTPS/i);
    expect(() => parseOwnerCatalogImport([{ artist: "Artist", title: "Song", sourceUrl: "https://127.0.0.1/credit" }])).toThrow(/Private-network/i);
  });

  test("rejects spreadsheet formulas and control-character payloads", () => {
    for (const artist of ["=HYPERLINK(\"https://bad.example\")", "+SUM(1,1)", "-1+2", "@command"]) {
      expect(() => parseOwnerCatalogImport([{ artist, title: "Song", sourceUrl }])).toThrow(/formulas/i);
    }
    expect(() => parseOwnerCatalogImport([{ artist: "Safe\u0000Hidden", title: "Song", sourceUrl }])).toThrow(/control characters/i);
    expect(() => parseOwnerCatalogImport({
      format: "csv",
      data: `artist,title,sourceUrl\r\n"\t=FORMULA",Song,${sourceUrl}`,
    })).toThrow(/formulas/i);
  });

  test("rejects malformed or ambiguous CSV structures", () => {
    expect(() => parseOwnerCatalogImport({
      format: "csv",
      data: `artist,title,sourceUrl\r\n"Unclosed,Song,${sourceUrl}`,
    })).toThrow(/unclosed/i);
    expect(() => parseOwnerCatalogImport({
      format: "csv",
      data: `artist,title,title,sourceUrl\r\nArtist,One,Two,${sourceUrl}`,
    })).toThrow(/duplicate columns/i);
    expect(() => parseOwnerCatalogImport({
      format: "csv",
      data: `artist,title,sourceUrl,unknown\r\nArtist,Song,${sourceUrl},value`,
    })).toThrow(/Unsupported catalogue column/i);
    expect(() => parseOwnerCatalogImport({
      format: "csv",
      data: `artist,title,sourceUrl\r\nArtist,Song,${sourceUrl},extra`,
    })).toThrow(/column count/i);
  });

  test("enforces row, input, field, and metadata bounds", () => {
    const tooManyRows = Array.from({ length: OWNER_CATALOG_IMPORT_LIMITS.maxRows + 1 }, () => ({
      artist: "Artist",
      title: "Song",
      sourceUrl,
    }));
    expect(() => parseOwnerCatalogImport(tooManyRows)).toThrow(/row limit/i);
    expect(() => parseOwnerCatalogImport([{
      artist: "A".repeat(OWNER_CATALOG_IMPORT_LIMITS.maxRawFieldLength + 1),
      title: "Song",
      sourceUrl,
    }])).toThrow(/size limit/i);
    expect(() => parseOwnerCatalogImport({ format: "csv", data: "x".repeat(OWNER_CATALOG_IMPORT_LIMITS.maxCsvBytes + 1) })).toThrow(/request size/i);
    expect(() => parseOwnerCatalogImport([{ artist: "Artist", title: "Song", sourceUrl, releaseYear: "1800" }])).toThrow(/allowed range/i);
    expect(() => parseOwnerCatalogImport([{ artist: "Artist", title: "Song", sourceUrl, durationMs: "1.5" }])).toThrow(/whole number/i);
    expect(() => parseOwnerCatalogImport([{ artist: "Artist", title: "Song", sourceUrl, isrc: "not-an-isrc" }])).toThrow(/ISRC/i);
    expect(() => parseOwnerCatalogImport([{ artist: "Artist", title: "Song", sourceUrl, mbid: "not-a-mbid" }])).toThrow(/MusicBrainz/i);
  });

  test("deduplicates source records and rejects conflicting provenance for one URL", () => {
    const result = parseOwnerCatalogImport([
      { artist: "One", title: "Track", sourceUrl, provenanceRoot: "Original database" },
      { artist: "Two", title: "Track", sourceUrl, provenanceRoot: "Original database" },
    ]);
    expect(result.sources).toHaveLength(1);
    expect(result.candidates).toHaveLength(2);
    expect(() => parseOwnerCatalogImport([
      { artist: "One", title: "Track", sourceUrl, provenanceRoot: "Database A" },
      { artist: "Two", title: "Track", sourceUrl, provenanceRoot: "Database B" },
    ])).toThrow(/conflicting provenance/i);
  });
});
