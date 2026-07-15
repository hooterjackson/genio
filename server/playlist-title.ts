import type { PlaylistBrief } from "../shared/types.ts";

export const PLAYLIST_TITLE_MAX_LENGTH = 60;

type PlaylistTitleContext = Pick<
  PlaylistBrief,
  "mode" | "subjectEntities" | "relationship" | "targetSize"
>;

const PROMPT_LEAD = /^(?:(?:please|can you|could you|would you|i want you to|i(?:'|’)d like you to)\s+)*(?:(?:give|show|find|make|build|create|generate|assemble|compile|research|put together)\s+(?:me\s+)?)?/iu;
const PLAYLIST_WRAPPER = /^(?:(?:a|an|the)\s+)?(?:apple music\s+)?playlist(?:\s+(?:of|with|for|containing))?\s*/iu;
const GENERIC_OR_SCOPE_LEAD = /^(?:every|all|the\s+\d[\d,]*\s+most)\b/iu;

function cleanInlineText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/[*_`]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^["'‘’“”\s]+|["'‘’“”\s]+$/gu, "")
    .replace(/[\s:;,.!?\-–—]+$/gu, "")
    .trim();
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function truncateTitle(value: string, maximum = PLAYLIST_TITLE_MAX_LENGTH): string {
  const points = codePoints(value);
  if (points.length <= maximum) return value;
  if (maximum <= 1) return "…".slice(0, maximum);
  const raw = points.slice(0, maximum - 1).join("");
  const lastSpace = raw.lastIndexOf(" ");
  const boundary = lastSpace >= Math.floor(maximum * 0.55) ? raw.slice(0, lastSpace) : raw;
  return `${boundary.trimEnd()}…`;
}

function capitalizeFirst(value: string): string {
  const [first, ...rest] = codePoints(value);
  return first ? `${first.toLocaleUpperCase()}${rest.join("")}` : value;
}

function exactTargetCount(context: PlaylistTitleContext): number | null {
  const target = context.targetSize;
  return target && target.min === target.max ? target.max : null;
}

function fallbackDescriptor(context: PlaylistTitleContext): string {
  const relationship = context.relationship.toLocaleLowerCase();
  if (/influen|important|landmark/u.test(relationship)) return "Influential Tracks";
  if (/essential|representative|canonical/u.test(relationship)) return "Essential Tracks";
  if (/perform|played on|session|contribut/u.test(relationship)) return "Performance Credits";
  if (/produc/u.test(relationship)) return "Production Credits";
  if (/wrote|written|songwrit|compos/u.test(relationship)) return "Songwriting Credits";
  if (/sampl/u.test(relationship)) return "Sampled Tracks";
  if (/lyric|theme|songs? about|recordings? about/u.test(relationship)) return "Songs";
  if (/recorded by|released by|primary artist|discograph|songs? by/u.test(relationship)) {
    return context.mode === "exhaustive" ? "Discography" : "Essential Tracks";
  }
  return context.mode === "exhaustive" ? "Complete Recordings" : "Selected Tracks";
}

function fallbackTitle(context: PlaylistTitleContext): string {
  const subject = cleanInlineText(context.subjectEntities[0] ?? "Music") || "Music";
  const count = exactTargetCount(context);
  const qualifier = `${count === null ? "" : `${count} `}${fallbackDescriptor(context)}`;
  const complete = `${subject}: ${qualifier}`;
  if (codePoints(complete).length <= PLAYLIST_TITLE_MAX_LENGTH) return complete;

  const shortQualifier = `${count === null ? "" : `${count} `}Tracks`;
  const suffix = `: ${shortQualifier}`;
  const available = Math.max(8, PLAYLIST_TITLE_MAX_LENGTH - codePoints(suffix).length);
  return `${truncateTitle(subject, available)}${suffix}`;
}

/**
 * Normalize an LLM-proposed display title without changing any scope fields.
 * Concise editorial titles are preserved; long or request-shaped titles use a
 * deterministic subject/relationship fallback so publication never inherits
 * an entire natural-language prompt.
 */
export function normalizePlaylistTitle(value: string, context: PlaylistTitleContext): string {
  const original = cleanInlineText(value);
  const hadCommandLead = /^(?:please|can you|could you|would you|i want|i(?:'|’)d like|give|show|find|make|build|create|generate|assemble|compile|research|put together)\b/iu.test(original);
  let candidate = original.replace(PROMPT_LEAD, "").trim();
  candidate = candidate.replace(PLAYLIST_WRAPPER, "").trim();
  candidate = candidate.replace(/\s+(?:apple music\s+)?playlist$/iu, "").trim();
  candidate = capitalizeFirst(cleanInlineText(candidate));

  const relationship = context.relationship.toLocaleLowerCase();
  const editorialPromptTitle = /\bmost\s+(?:influential|important|essential|representative)\b/iu.test(candidate)
    && /influen|essential|important|representative|landmark/u.test(relationship);
  const unsuitable = !candidate
    || /^(?:playlist|music|songs?|tracks?)$/iu.test(candidate)
    || GENERIC_OR_SCOPE_LEAD.test(candidate)
    || editorialPromptTitle
    || codePoints(candidate).length > PLAYLIST_TITLE_MAX_LENGTH
    || (hadCommandLead && /\b(?:that|which)\b/iu.test(candidate));

  return truncateTitle(unsuitable ? fallbackTitle(context) : candidate);
}

/** Append a date or volume marker while retaining the suffix and overall cap. */
export function appendPlaylistTitleSuffix(title: string, suffix: string): string {
  const cleanTitle = cleanInlineText(title) || "Music";
  const cleanSuffix = truncateTitle(cleanInlineText(suffix), PLAYLIST_TITLE_MAX_LENGTH - 2);
  if (!cleanSuffix) return truncateTitle(cleanTitle);
  const suffixText = ` ${cleanSuffix}`;
  const suffixLength = codePoints(suffixText).length;
  const available = Math.max(1, PLAYLIST_TITLE_MAX_LENGTH - suffixLength);
  return `${truncateTitle(cleanTitle, available)}${suffixText}`;
}
