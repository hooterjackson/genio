import type { PlaylistBrief } from "../shared/types.ts";

export const PLAYLIST_TITLE_MAX_LENGTH = 60;

type PlaylistTitleContext = Pick<
  PlaylistBrief,
  "mode" | "subjectEntities" | "relationship" | "targetSize"
>;

const PROMPT_LEAD = /^(?:(?:please|can you|could you|would you|i want you to|i(?:'|’)d like you to)\s+)*(?:(?:give|show|find|make|build|create|generate|assemble|compile|research|put together)\s+(?:me\s+)?)?/iu;
const PLAYLIST_WRAPPER = /^(?:(?:a|an|the)\s+)?(?:apple music\s+)?playlist(?:\s+(?:of|with|for|containing))?\s*/iu;
const GENERIC_OR_SCOPE_LEAD = /^(?:every|all|the\s+\d[\d,]*\s+most)\b/iu;
const GENERIC_TITLE = /^(?:(?:the|my)\s+)?(?:(?:best|top|essential|influential|selected|complete|ultimate|definitive|favorite|favourite|greatest)\s*)?(?:music|songs?|tracks?|recordings?|playlist|essentials|favorites?|favourites?|deep cuts|greatest hits|discography)$/iu;
const MAX_EDITORIAL_WORDS = 10;

const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function cleanInlineText(value: string): string {
  return value
    .normalize("NFKC")
    // Remove control, bidi, and invisible separator characters while retaining
    // the zero-width joiner used inside valid emoji grapheme clusters.
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => character === "\u200d" ? character : " ")
    .replace(/[*_`]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^["'‘’“”\s]+|["'‘’“”\s]+$/gu, "")
    .replace(/[\s:;,.!?\-–—]+$/gu, "")
    .trim();
}

function graphemes(value: string): string[] {
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(value), (segment) => segment.segment)
    : Array.from(value);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function truncateTitle(value: string, maximum = PLAYLIST_TITLE_MAX_LENGTH): string {
  if (codePointLength(value) <= maximum) return value;
  if (maximum <= 1) return "…".slice(0, maximum);
  const budget = maximum - 1;
  let used = 0;
  const retained: string[] = [];
  for (const grapheme of graphemes(value)) {
    const size = codePointLength(grapheme);
    if (used + size > budget) break;
    retained.push(grapheme);
    used += size;
  }
  const raw = retained.join("");
  const lastSpace = raw.lastIndexOf(" ");
  const boundary = lastSpace >= Math.floor(maximum * 0.55) ? raw.slice(0, lastSpace) : raw;
  return `${boundary.trimEnd()}…`;
}

function capitalizeFirst(value: string): string {
  const [first, ...rest] = graphemes(value);
  return first ? `${first.toLocaleUpperCase()}${rest.join("")}` : value;
}

function wordCount(value: string): number {
  return value ? value.split(/\s+/u).length : 0;
}

function exactTargetCount(context: PlaylistTitleContext): number | null {
  const target = context.targetSize;
  return target && target.min === target.max ? target.max : null;
}

function fallbackDescriptor(context: PlaylistTitleContext): string {
  const relationship = context.relationship.toLocaleLowerCase();
  if (/influen|important|landmark/u.test(relationship)) return "Influential Tracks";
  if (/essential|representative|canonical/u.test(relationship)) return "Essential Tracks";
  if (/collab|duet|recorded together|performed together/u.test(relationship)) return "Collaborations";
  if (/remix/u.test(relationship)) return "Remixes";
  if (/cover|interpretation of|versions? of/u.test(relationship)) return "Covers";
  if (/live recording|concert performance/u.test(relationship)) return "Live Recordings";
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
  const subjects = context.subjectEntities
    .map(cleanInlineText)
    .filter(Boolean)
    .filter((subject, index, all) => all.findIndex((other) => other.toLocaleLowerCase() === subject.toLocaleLowerCase()) === index);
  const primarySubject = subjects[0] ?? "Music";
  const count = exactTargetCount(context);
  const qualifier = `${count === null ? "" : `${count} `}${fallbackDescriptor(context)}`;
  // Two named subjects are material for comparisons and collaborations. Keep
  // both when they fit; broader entity lists fall back to the primary subject.
  const joinedSubject = subjects.length === 2 ? `${subjects[0]} + ${subjects[1]}` : primarySubject;
  const complete = `${joinedSubject}: ${qualifier}`;
  if (codePointLength(complete) <= PLAYLIST_TITLE_MAX_LENGTH) return complete;

  const primaryComplete = `${primarySubject}: ${qualifier}`;
  if (codePointLength(primaryComplete) <= PLAYLIST_TITLE_MAX_LENGTH) return primaryComplete;

  const shortQualifier = `${count === null ? "" : `${count} `}Tracks`;
  const suffix = `: ${shortQualifier}`;
  const available = Math.max(8, PLAYLIST_TITLE_MAX_LENGTH - codePointLength(suffix));
  return `${truncateTitle(primarySubject, available)}${suffix}`;
}

function beginsWithScopeCount(value: string, context: PlaylistTitleContext): boolean {
  if (exactTargetCount(context) === null) return false;
  return /^(?:the\s+)?[\d,]+\b/iu.test(value);
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
    || GENERIC_TITLE.test(candidate)
    || GENERIC_OR_SCOPE_LEAD.test(candidate)
    || beginsWithScopeCount(candidate, context)
    || editorialPromptTitle
    || codePointLength(candidate) > PLAYLIST_TITLE_MAX_LENGTH
    || wordCount(candidate) > MAX_EDITORIAL_WORDS
    || (hadCommandLead && /\b(?:that|which|whose|where)\b/iu.test(candidate));

  return truncateTitle(unsuitable ? fallbackTitle(context) : candidate);
}

/** Append a date or volume marker while retaining the suffix and overall cap. */
export function appendPlaylistTitleSuffix(title: string, suffix: string): string {
  const cleanTitle = cleanInlineText(title) || "Music";
  const cleanSuffix = truncateTitle(cleanInlineText(suffix), PLAYLIST_TITLE_MAX_LENGTH - 2);
  if (!cleanSuffix) return truncateTitle(cleanTitle);
  const suffixText = ` ${cleanSuffix}`;
  const suffixLength = codePointLength(suffixText);
  const available = Math.max(1, PLAYLIST_TITLE_MAX_LENGTH - suffixLength);
  return `${truncateTitle(cleanTitle, available)}${suffixText}`;
}
