import type { CitationAttestationInput } from "../shared/types.ts";
import { sha256Hex, stableStringify } from "./security.ts";

export const MAX_CITATION_EXCERPT_CHARS = 1_000;

export interface HostedCitationAttestation extends CitationAttestationInput {
  sourceUrl: string;
}

/**
 * URL-citation offsets locate where the citation is used in output text, which
 * may be only the rendered citation marker. Derive a server-owned local line
 * around that marker so claim validation can inspect the supporting words
 * without trusting a model-provided excerpt.
 */
export function citationSupportWindow(
  text: string,
  citationStart: number,
  citationEnd: number,
): { startIndex: number; endIndex: number; excerpt: string } | null {
  if (!Number.isInteger(citationStart) || !Number.isInteger(citationEnd)
    || citationStart < 0 || citationEnd <= citationStart || citationEnd > text.length) return null;
  let startIndex = text.lastIndexOf("\n", Math.max(0, citationStart - 1)) + 1;
  const followingBreak = text.indexOf("\n", citationEnd);
  let endIndex = followingBreak === -1 ? text.length : followingBreak;
  while (startIndex < endIndex && /\s/u.test(text[startIndex]!)) startIndex += 1;
  while (endIndex > startIndex && /\s/u.test(text[endIndex - 1]!)) endIndex -= 1;
  if (endIndex <= startIndex || endIndex - startIndex > MAX_CITATION_EXCERPT_CHARS) return null;
  // JavaScript offsets are UTF-16 code units, while Postgres char_length and
  // provider offset units can differ for astral characters. Until the API
  // publishes an explicit unit contract, reject any ambiguous support line.
  for (let index = startIndex; index < endIndex; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdfff) return null;
  }
  const excerpt = text.slice(startIndex, endIndex);
  return excerpt.trim().length >= 8 ? { startIndex, endIndex, excerpt } : null;
}

function normalizeCitationPhrase(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

const RELATIONSHIP_STOPWORDS = new Set([
  "a", "an", "and", "at", "by", "for", "from", "in", "is", "of", "on", "or", "the", "to", "with",
]);

function meaningfulRelationshipTokens(value: string, identityTokens: ReadonlySet<string>): string[] {
  const phrase = normalizeCitationPhrase(value);
  const meaningful = phrase.split(" ").filter((token) => token.length >= 3 && !RELATIONSHIP_STOPWORDS.has(token));
  return meaningful.some((token) => !identityTokens.has(token)) ? meaningful : [];
}

export function citationTextIsLocalToClaim(
  excerpt: string,
  candidateTitle: string,
  subjectEntity: string,
  relationship: string,
): boolean {
  const normalized = normalizeCitationPhrase(excerpt);
  const title = normalizeCitationPhrase(candidateTitle);
  const subject = normalizeCitationPhrase(subjectEntity);
  const identityTokens = new Set(`${title} ${subject}`.split(" ").filter(Boolean));
  const relationshipTokens = meaningfulRelationshipTokens(relationship, identityTokens);
  return Boolean(title && subject && relationshipTokens.length > 0
    && normalized.includes(title)
    && normalized.includes(subject)
    // Function words and light grammatical inflections are not evidence. The
    // provider-attested line must contain every meaningful relationship token,
    // but "credited with percussion" must still bind to "is credited with
    // percussion". Requiring the model's full phrase verbatim discarded valid
    // groups whenever an extractor omitted a word such as "is".
    && relationshipTokens.every((token) => normalized.split(" ").includes(token)));
}

export function citationAttestationKey(attestation: HostedCitationAttestation): string {
  return sha256Hex(stableStringify([
    attestation.sourceUrl,
    attestation.responseId,
    attestation.outputItemId,
    attestation.contentIndex,
    attestation.startIndex,
    attestation.endIndex,
    attestation.excerpt,
  ]));
}
