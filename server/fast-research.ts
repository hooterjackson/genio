import type { PlaylistBrief, SourceRecordInput, TrackCandidateInput } from "../shared/types.ts";
import type { HostedCitationAttestation } from "./citation-attestation.ts";
import { citationTextIsLocalToClaim } from "./citation-attestation.ts";
import { extractOutputText } from "./openai.ts";
import { assertPublicHttpsUrl, compactEvidenceNote } from "./security.ts";

export const FAST_RESEARCH_CHECKPOINT_VERSION = "fast_curated_v2";

export interface FastSynthesisCheckpoint {
  version: typeof FAST_RESEARCH_CHECKPOINT_VERSION;
  status: "complete";
  responseId: string;
  outputText: string;
  citationAttestations: HostedCitationAttestation[];
  sourceTitles: Record<string, string>;
  webSearchCalls: number;
  updatedAt: string;
}

export interface RawFastCandidate {
  artist: string;
  title: string;
  album: string | null;
  releaseYear: number | null;
  versionLabel: string | null;
  relationship: string;
  citationIndexes: number[];
}

export function fastExtractionSchema(candidateLimit: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      candidates: {
        type: "array",
        maxItems: Math.max(1, Math.min(120, Math.floor(candidateLimit))),
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            artist: { type: "string" },
            title: { type: "string" },
            album: { type: ["string", "null"] },
            releaseYear: { type: ["integer", "null"] },
            versionLabel: { type: ["string", "null"] },
            relationship: { type: "string" },
            citationIndexes: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              items: { type: "integer", minimum: 0, maximum: 999 },
            },
          },
          required: ["artist", "title", "album", "releaseYear", "versionLabel", "relationship", "citationIndexes"],
        },
      },
    },
    required: ["candidates"],
  };
}

function safeText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { return assertPublicHttpsUrl(value).toString(); } catch { return null; }
}

function normalizeEvidencePhrase(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function evidenceContainsExactPhrase(excerpt: string, phrase: string): boolean {
  const normalizedExcerpt = normalizeEvidencePhrase(excerpt);
  const normalizedPhrase = normalizeEvidencePhrase(phrase);
  return Boolean(normalizedExcerpt && normalizedPhrase
    && ` ${normalizedExcerpt} `.includes(` ${normalizedPhrase} `));
}

/**
 * Fast extraction metadata is model output, so every non-null disambiguator
 * used by Apple matching must also occur in the provider-attested support
 * window. When the confirmed subject is itself the recording artist, the one
 * subject mention already required by citationTextIsLocalToClaim satisfies the
 * artist binding; the source does not need to repeat the artist name.
 */
function citationSupportsExtractedMetadata(
  excerpt: string,
  row: RawFastCandidate,
  subjectEntity: string,
): boolean {
  const artistIsSubject = normalizeEvidencePhrase(row.artist) === normalizeEvidencePhrase(subjectEntity);
  if (!artistIsSubject && !evidenceContainsExactPhrase(excerpt, row.artist)) return false;
  if (row.album && !evidenceContainsExactPhrase(excerpt, row.album)) return false;
  if (row.releaseYear !== null && !evidenceContainsExactPhrase(excerpt, String(row.releaseYear))) return false;
  if (row.versionLabel && !evidenceContainsExactPhrase(excerpt, row.versionLabel)) return false;
  return true;
}

export function citationSourceTitles(response: any): Record<string, string> {
  const titles: Record<string, string> = {};
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== "message") continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type !== "output_text") continue;
      for (const annotation of Array.isArray(content.annotations) ? content.annotations : []) {
        if (annotation?.type !== "url_citation") continue;
        const url = normalizeUrl(annotation.url);
        if (!url) continue;
        titles[url] = safeText(annotation.title, 240) || new URL(url).hostname;
      }
    }
  }
  return titles;
}

export function fastSynthesisCheckpoint(
  response: any,
  citationAttestations: readonly HostedCitationAttestation[],
): FastSynthesisCheckpoint {
  const outputText = extractOutputText(response);
  if (outputText.length > 80_000) throw new Error("Fast research synthesis exceeded the persisted text limit");
  const sourceTitles = citationSourceTitles(response);
  const supported = citationAttestations
    .filter((attestation) => Object.hasOwn(sourceTitles, attestation.sourceUrl))
    .slice(0, 1_000);
  if (supported.length === 0) throw new Error("Fast research returned no provider-attested citations");
  return {
    version: FAST_RESEARCH_CHECKPOINT_VERSION,
    status: "complete",
    responseId: safeText(response?.id, 240),
    outputText,
    citationAttestations: supported,
    sourceTitles,
    webSearchCalls: (Array.isArray(response?.output) ? response.output : [])
      .filter((item: any) => item?.type === "web_search_call").length,
    updatedAt: new Date().toISOString(),
  };
}

export function parseFastExtraction(response: any, candidateLimit: number): RawFastCandidate[] {
  let payload: unknown;
  try { payload = JSON.parse(extractOutputText(response)); } catch {
    throw new Error("Fast research extraction returned malformed JSON");
  }
  const rows = payload && typeof payload === "object" && Array.isArray((payload as any).candidates)
    ? (payload as any).candidates.slice(0, Math.max(1, Math.min(120, candidateLimit)))
    : [];
  return rows.map((row: any): RawFastCandidate | null => {
    const artist = safeText(row?.artist, 240);
    const title = safeText(row?.title, 240);
    const relationship = safeText(row?.relationship, 240);
    const citationIndexes: number[] = [...new Set<number>((Array.isArray(row?.citationIndexes) ? row.citationIndexes : [])
      .filter((index: unknown): index is number => typeof index === "number" && Number.isInteger(index) && index >= 0 && index <= 999))]
      .slice(0, 5);
    if (!artist || !title || !relationship || citationIndexes.length === 0) return null;
    return {
      artist,
      title,
      album: row.album === null ? null : safeText(row.album, 240) || null,
      releaseYear: Number.isInteger(row.releaseYear) && row.releaseYear >= 1800 && row.releaseYear <= 2200 ? row.releaseYear : null,
      versionLabel: row.versionLabel === null ? null : safeText(row.versionLabel, 120) || null,
      relationship,
      citationIndexes,
    };
  }).filter((row: RawFastCandidate | null): row is RawFastCandidate => row !== null);
}

export function validateFastCandidates(
  rows: readonly RawFastCandidate[],
  brief: PlaylistBrief,
  synthesis: FastSynthesisCheckpoint,
): { sources: SourceRecordInput[]; candidates: TrackCandidateInput[]; rejectedCandidateCount: number } {
  const sourcesByUrl = new Map<string, SourceRecordInput>();
  const candidates: TrackCandidateInput[] = [];
  let rejectedCandidateCount = 0;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const evidence: TrackCandidateInput["evidence"] = [];
    for (const index of row.citationIndexes) {
      const attestation = synthesis.citationAttestations[index];
      if (!attestation || !Object.hasOwn(synthesis.sourceTitles, attestation.sourceUrl)) continue;
      const subjectEntity = brief.subjectEntities.find((entity) => citationTextIsLocalToClaim(
        attestation.excerpt,
        row.title,
        entity,
        row.relationship,
      ) && citationSupportsExtractedMetadata(attestation.excerpt, row, entity));
      if (!subjectEntity) continue;
      sourcesByUrl.set(attestation.sourceUrl, {
        url: attestation.sourceUrl,
        title: synthesis.sourceTitles[attestation.sourceUrl]!,
        sourceClass: "web",
        provenanceRoot: "unclassified",
        note: compactEvidenceNote("Provider-attested hosted-web source used by the fast editorial synthesis."),
      });
      evidence.push({
        sourceUrl: attestation.sourceUrl,
        state: "editorial",
        supportScope: "editorial",
        subjectEntity,
        subjectRelationship: brief.relationship,
        relationship: row.relationship,
        note: compactEvidenceNote("Track appears in a cited editorial evidence group from the fast research pass."),
        sourceClass: "web",
        citationSupport: {
          responseId: attestation.responseId,
          outputItemId: attestation.outputItemId,
          contentIndex: attestation.contentIndex,
          startIndex: attestation.startIndex,
          endIndex: attestation.endIndex,
          excerpt: attestation.excerpt,
        },
      });
    }
    if (evidence.length === 0) {
      rejectedCandidateCount += 1;
      continue;
    }
    candidates.push({
      selectionRank: rowIndex + 1,
      artist: row.artist,
      title: row.title,
      album: row.album,
      releaseYear: row.releaseYear,
      durationMs: null,
      isrc: null,
      musicbrainzId: null,
      versionLabel: row.versionLabel,
      evidence,
    });
  }

  return { sources: [...sourcesByUrl.values()], candidates, rejectedCandidateCount };
}
