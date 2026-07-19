import type { PlaylistBrief, SourceRecordInput, TrackCandidateInput } from "../shared/types.ts";
import type { HostedCitationAttestation } from "./citation-attestation.ts";
import { citationTextIsLocalToClaim } from "./citation-attestation.ts";
import { extractOutputText } from "./openai.ts";
import { evidenceRelationshipIsMaterial } from "./evidence-relationship-policy.ts";
import { boundedFastCandidateLimit } from "./research-policy.ts";
import { assertPublicHttpsUrl, compactEvidenceNote } from "./security.ts";
import { isExcludedReferenceArtist } from "./similarity-policy.ts";

export const FAST_RESEARCH_CHECKPOINT_VERSION = "fast_curated_v3";

export type FastResearchContractErrorCode =
  | "candidate_schema"
  | "citation_contract"
  | "hosted_search_limit"
  | "request_cost_ceiling"
  | "response_size";

/** A provider response completed, but failed Needle's local fast-run contract. */
export class FastResearchContractError extends Error {
  readonly name = "FastResearchContractError";

  constructor(
    message: string,
    readonly code: FastResearchContractErrorCode,
  ) {
    super(message);
  }
}

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
        maxItems: boundedFastCandidateLimit(candidateLimit),
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

/**
 * The synthesis protocol needs one scalar SUBJECT field, while a confirmed
 * brief may contain several ordered subject entities.  Render that field in a
 * deterministic form so the validator can distinguish the complete confirmed
 * subject from a model-invented paraphrase or a partial subject list.
 */
export function canonicalFastResearchSubject(subjectEntities: readonly string[]): string {
  return subjectEntities.map((entity) => safeText(entity, 240)).filter(Boolean).join(", ");
}

function canonicalEvidenceSubject(
  evidenceSubject: string,
  subjectEntities: readonly string[],
): string | null {
  const canonicalSubjects = subjectEntities.map((entity) => safeText(entity, 240)).filter(Boolean);
  if (canonicalSubjects.length === 0) return null;
  const normalizedEvidenceSubject = normalizeEvidencePhrase(evidenceSubject);

  // A single confirmed entity remains the canonical stored claim subject.
  const individual = canonicalSubjects.find((entity) => (
    normalizeEvidencePhrase(entity) === normalizedEvidenceSubject
  ));
  if (individual) return individual;

  // A multi-entity brief is represented by the complete ordered set.  Accept
  // only that exact aggregate; subsets, reordered entities, and prose added by
  // the model remain unsupported.  Persist the first confirmed entity because
  // evidence eligibility intentionally binds claims to one of the original
  // brief.subjectEntities values.
  const aggregate = canonicalFastResearchSubject(canonicalSubjects);
  return canonicalSubjects.length > 1
    && evidenceSubject === aggregate
    ? canonicalSubjects[0]!
    : null;
}

function evidenceContainsExactPhrase(excerpt: string, phrase: string): boolean {
  const normalizedExcerpt = normalizeEvidencePhrase(excerpt);
  const normalizedPhrase = normalizeEvidencePhrase(phrase);
  return Boolean(normalizedExcerpt && normalizedPhrase
    && ` ${normalizedExcerpt} `.includes(` ${normalizedPhrase} `));
}

interface FastEvidencePair {
  artist: string;
  title: string;
}

interface FastEvidenceGroup {
  subjectEntity: string;
  relationship: string;
  tracks: FastEvidencePair[];
  containers: FastEvidencePair[];
}

function evidencePairs(value: string): FastEvidencePair[] {
  return value.split(";").map((entry): FastEvidencePair | null => {
    // The synthesis contract requires an em dash surrounded by spaces. An en
    // dash is accepted defensively because it cannot be confused with a
    // hyphen inside an artist or recording title.
    const match = entry.trim().match(/^(.+?)\s+[—–]\s+(.+?)\s*$/u);
    if (!match) return null;
    const artist = safeText(match[1], 240);
    const title = safeText(match[2], 240);
    return artist && title ? { artist, title } : null;
  }).filter((pair: FastEvidencePair | null): pair is FastEvidencePair => pair !== null);
}

function withoutTrailingCitationMarkers(value: string): string {
  let current = value.trim();
  let previous = "";
  while (current !== previous) {
    previous = current;
    current = current.replace(
      /\s*(?:\(\[[^\]\r\n]+\]\(https?:\/\/[^)\s]+\)\)|\[[^\]\r\n]+\]\(https?:\/\/[^)\s]+\)|\[[^\]]+\]|【[^】]+】|cite[^]*)\s*$/iu,
      "",
    ).trim();
    // The model occasionally renders the protocol placeholder literally
    // before the provider appends the real URL citation. It carries no
    // evidence and must not become part of a track or container title.
    current = current.replace(/\s*<\s*inline\s+citations?\s*>\s*$/iu, "").trim();
  }
  return current;
}

/**
 * TRACKS may end at the provider citation when CONTAINERS is omitted. Strip
 * only recognizable citation syntax here: the broader container cleanup also
 * accepts arbitrary bracketed markers, which would corrupt legitimate version
 * labels such as `Song [Live]` or `Mix [Radio Edit]` when used on a track.
 */
function withoutTrailingTrackCitationMarkers(value: string): string {
  let current = value.trim();
  let previous = "";
  while (current !== previous) {
    previous = current;
    current = current.replace(
      /\s*(?:\(\[[^\]\r\n]+\]\(https?:\/\/[^)\s]+\)\)|\[[^\]\r\n]+\]\(https?:\/\/[^)\s]+\)|\[(?:(?:source|citation|cite|ref(?:erence)?|turn\w*)\b[^\]]*|\d+)\]|【[^】]+】|cite[^]*|<\s*inline\s+citations?\s*>)\s*$/iu,
      "",
    ).trim();
  }
  return current;
}

/**
 * Parse the deliberately rigid, one-line synthesis protocol. Keeping tracks
 * and source containers in separate tagged fields prevents an extractor from
 * turning a cited album, EP, compilation, or release title into a recording.
 */
function parseFastEvidenceGroup(excerpt: string): FastEvidenceGroup | null {
  // The tagged fields, rather than the human-readable heading before them,
  // are the security boundary. Production responses sometimes substitute a
  // descriptive heading (for example `FOUNDATIONAL HOUSE RECORDINGS`) for
  // the requested `EVIDENCE GROUP` marker. CONTAINERS is also optional when
  // the cited line contains only explicit Artist — Track pairs. Downstream
  // validation still binds the tagged subject and relationship to the
  // confirmed brief and every pair to this provider-attested support window.
  const match = excerpt.match(
    /^\s*[^|\r\n]{1,240}\s*\|\s*SUBJECT:\s*([^|]+?)\s*\|\s*RELATIONSHIP:\s*([^|]+?)\s*\|\s*TRACKS:\s*([^|]+?)(?:\s*\|\s*CONTAINERS:\s*(.+?))?\s*$/iu,
  );
  if (!match) return null;
  const subjectEntity = safeText(match[1], 240);
  const relationship = safeText(match[2], 240);
  const tracks = evidencePairs(withoutTrailingTrackCitationMarkers(match[3] ?? ""));
  const containers = evidencePairs(withoutTrailingCitationMarkers(match[4] ?? ""));
  if (!subjectEntity || !relationship || tracks.length === 0) return null;
  return { subjectEntity, relationship, tracks, containers };
}

function unambiguousTrackAlbum(group: FastEvidenceGroup, track: FastEvidencePair): string | null {
  const artistKey = normalizeEvidencePhrase(track.artist);
  const artistTracks = group.tracks.filter(
    (candidate) => normalizeEvidencePhrase(candidate.artist) === artistKey,
  );
  if (artistTracks.length !== 1) return null;
  const albums = [...new Map(group.containers
    .filter((container) => normalizeEvidencePhrase(container.artist) === artistKey)
    .map((container) => [normalizeEvidencePhrase(container.title), container.title])).values()];
  return albums.length === 1 ? albums[0]! : null;
}

/**
 * Recover candidates directly from the rigid synthesis protocol. The hosted
 * response has already emitted explicit Artist — Track pairs inside
 * provider-attested citation windows, so sending the same text through a
 * second model only adds latency and another failure boundary. Keep the model
 * extractor as a compatibility fallback for older/non-conforming checkpoints.
 */
export function extractFastCandidatesFromSynthesis(
  synthesis: FastSynthesisCheckpoint,
  candidateLimit: number,
): RawFastCandidate[] {
  const limit = boundedFastCandidateLimit(candidateLimit);
  const candidates = new Map<string, RawFastCandidate>();

  for (let citationIndex = 0; citationIndex < synthesis.citationAttestations.length; citationIndex += 1) {
    const attestation = synthesis.citationAttestations[citationIndex]!;
    if (!Object.hasOwn(synthesis.sourceTitles, attestation.sourceUrl)) continue;
    const group = parseFastEvidenceGroup(attestation.excerpt);
    if (!group) continue;

    for (const track of group.tracks) {
      const key = `${normalizeEvidencePhrase(track.artist)}\u0000${normalizeEvidencePhrase(track.title)}`;
      const existing = candidates.get(key);
      if (existing) {
        if (!existing.citationIndexes.includes(citationIndex) && existing.citationIndexes.length < 5) {
          existing.citationIndexes.push(citationIndex);
        }
        continue;
      }
      candidates.set(key, {
        artist: track.artist,
        title: track.title,
        // CONTAINERS are never extracted as songs. When a cited evidence line
        // contains exactly one track and one release for the same artist, the
        // association is unambiguous enough to preserve as Apple-match
        // metadata. Ambiguous multi-track/multi-release groups remain null.
        album: unambiguousTrackAlbum(group, track),
        releaseYear: null,
        versionLabel: null,
        relationship: group.relationship,
        citationIndexes: [citationIndex],
      });
      if (candidates.size >= limit) return [...candidates.values()];
    }
  }

  return [...candidates.values()];
}

function evidencePairEquals(left: FastEvidencePair, right: FastEvidencePair): boolean {
  return normalizeEvidencePhrase(left.artist) === normalizeEvidencePhrase(right.artist)
    && normalizeEvidencePhrase(left.title) === normalizeEvidencePhrase(right.title);
}

function groupExplicitlySupportsTrack(group: FastEvidenceGroup, row: RawFastCandidate): boolean {
  const candidate = { artist: row.artist, title: row.title };
  return group.tracks.some((pair) => evidencePairEquals(pair, candidate))
    && !group.containers.some((pair) => evidencePairEquals(pair, candidate));
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
  if (outputText.length > 80_000) {
    throw new FastResearchContractError(
      "Fast research synthesis exceeded the persisted text limit",
      "response_size",
    );
  }
  const sourceTitles = citationSourceTitles(response);
  const supported = citationAttestations
    .filter((attestation) => Object.hasOwn(sourceTitles, attestation.sourceUrl))
    .slice(0, 1_000);
  if (supported.length === 0) {
    throw new FastResearchContractError(
      "Fast research returned no provider-attested citations",
      "citation_contract",
    );
  }
  return {
    version: FAST_RESEARCH_CHECKPOINT_VERSION,
    status: "complete",
    responseId: safeText(response?.id, 240),
    outputText,
    citationAttestations: supported,
    sourceTitles,
    // The Responses API may emit open_page/find_in_page items while following
    // citations returned by a bounded search. Those are page inspections, not
    // additional hosted searches, and must not cause a completed cited response
    // to be discarded as over budget. Unknown action types still count so a
    // future provider action cannot silently bypass this guard.
    webSearchCalls: (Array.isArray(response?.output) ? response.output : [])
      .filter((item: any) => item?.type === "web_search_call")
      .filter((item: any) => !["open_page", "find_in_page"].includes(item?.action?.type))
      .length,
    updatedAt: new Date().toISOString(),
  };
}

export function parseFastExtraction(response: any, candidateLimit: number): RawFastCandidate[] {
  let payload: unknown;
  try { payload = JSON.parse(extractOutputText(response)); } catch {
    throw new FastResearchContractError(
      "Fast research extraction returned malformed JSON",
      "candidate_schema",
    );
  }
  const rows = payload && typeof payload === "object" && Array.isArray((payload as any).candidates)
    ? (payload as any).candidates.slice(0, boundedFastCandidateLimit(candidateLimit))
    : [];
  const parsed: RawFastCandidate[] = [];
  for (const value of rows) {
    // Structured output is still untrusted input. Validate each row in
    // isolation so one malformed candidate cannot discard valid siblings.
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const artist = safeText(row.artist, 240);
    const title = safeText(row.title, 240);
    const relationship = safeText(row.relationship, 240);
    const citationIndexes: number[] = [...new Set<number>((Array.isArray(row.citationIndexes) ? row.citationIndexes : [])
      .filter((index: unknown): index is number => typeof index === "number" && Number.isInteger(index) && index >= 0 && index <= 999))]
      .slice(0, 5);
    if (!artist || !title || !relationship || citationIndexes.length === 0) continue;
    parsed.push({
      artist,
      title,
      album: row.album === null ? null : safeText(row.album, 240) || null,
      releaseYear: Number.isInteger(row.releaseYear)
        && Number(row.releaseYear) >= 1800
        && Number(row.releaseYear) <= 2200
        ? Number(row.releaseYear)
        : null,
      versionLabel: row.versionLabel === null ? null : safeText(row.versionLabel, 120) || null,
      relationship,
      citationIndexes,
    });
  }
  return parsed;
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
    if (isExcludedReferenceArtist(brief, row.artist)) {
      rejectedCandidateCount += 1;
      continue;
    }
    const evidence: TrackCandidateInput["evidence"] = [];
    for (const index of row.citationIndexes) {
      const attestation = synthesis.citationAttestations[index];
      if (!attestation || !Object.hasOwn(synthesis.sourceTitles, attestation.sourceUrl)) continue;
      const evidenceGroup = parseFastEvidenceGroup(attestation.excerpt);
      if (!evidenceGroup || !groupExplicitlySupportsTrack(evidenceGroup, row)) continue;
      const subjectEntity = canonicalEvidenceSubject(
        evidenceGroup.subjectEntity,
        brief.subjectEntities,
      );
      if (!subjectEntity
        || !evidenceRelationshipIsMaterial(evidenceGroup.relationship)
        || !citationTextIsLocalToClaim(
          attestation.excerpt,
          row.title,
          subjectEntity,
          // The provider-attested EVIDENCE GROUP owns the source wording.
          // Recover it deterministically instead of trusting a paraphrase in
          // the separate extraction response.
          evidenceGroup.relationship,
        )
        || !citationSupportsExtractedMetadata(attestation.excerpt, row, subjectEntity)) continue;
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
        relationship: evidenceGroup.relationship,
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
