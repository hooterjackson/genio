import type {
  EvidenceClaimInput,
  EvidenceState,
  SourceRecordInput,
  TrackCandidateInput,
} from "../shared/types.ts";
import { assertPublicHttpsUrl, candidateIdentityKey, compactEvidenceNote, HttpError } from "./security.ts";

export const OWNER_CATALOG_IMPORT_LIMITS = Object.freeze({
  maxRows: 10_000,
  maxColumns: 24,
  maxCsvBytes: 4 * 1024 * 1024,
  maxRawFieldLength: 4_096,
});

export type OwnerCatalogImportRequest =
  | readonly unknown[]
  | { format: "json"; data: readonly unknown[] }
  | { format: "csv"; data: string };

export interface OwnerCatalogImportResult {
  sources: SourceRecordInput[];
  candidates: TrackCandidateInput[];
}

export function unverifiedImportedCandidates(candidates: TrackCandidateInput[]): TrackCandidateInput[] {
  return candidates.map((candidate) => ({
    ...candidate,
    evidence: candidate.evidence.map((claim) => ({ ...claim, state: "inferred" as const })),
  }));
}

type SupportScope = NonNullable<EvidenceClaimInput["supportScope"]>;
type ImportRow = Record<string, unknown>;

const COLUMN_ALIASES = new Map<string, string>([
  ["artist", "artist"],
  ["artistname", "artist"],
  ["title", "title"],
  ["track", "title"],
  ["tracktitle", "title"],
  ["song", "title"],
  ["album", "album"],
  ["releaseyear", "releaseYear"],
  ["year", "releaseYear"],
  ["durationms", "durationMs"],
  ["isrc", "isrc"],
  ["musicbrainzid", "musicbrainzId"],
  ["mbid", "musicbrainzId"],
  ["versionlabel", "versionLabel"],
  ["version", "versionLabel"],
  ["sourceurl", "sourceUrl"],
  ["source", "sourceUrl"],
  ["url", "sourceUrl"],
  ["sourcetitle", "sourceTitle"],
  ["provenanceroot", "provenanceRoot"],
  ["evidencestate", "evidenceState"],
  ["state", "evidenceState"],
  ["confidence", "evidenceState"],
  ["supportscope", "supportScope"],
  ["scope", "supportScope"],
  ["relationship", "relationship"],
  ["evidencenote", "evidenceNote"],
  ["note", "evidenceNote"],
  ["sourcenote", "sourceNote"],
]);

const EVIDENCE_STATES = new Map<string, EvidenceState>([
  ["verified", "verified"],
  ["explicit", "verified"],
  ["tracklevel", "verified"],
  ["primary", "verified"],
  ["corroborated", "corroborated"],
  ["confirmed", "corroborated"],
  ["secondary", "corroborated"],
  ["editorial", "editorial"],
  ["curated", "editorial"],
  ["influential", "editorial"],
  ["inferred", "inferred"],
  ["probable", "inferred"],
  ["albumlevel", "inferred"],
  ["unspecified", "inferred"],
]);

const SUPPORT_SCOPES = new Map<string, SupportScope>([
  ["track", "track"],
  ["recording", "track"],
  ["song", "track"],
  ["album", "album"],
  ["release", "album"],
  ["session", "session"],
  ["collection", "collection"],
  ["discography", "collection"],
  ["editorial", "editorial"],
  ["curated", "editorial"],
]);

function importError(message: string, row?: number, field?: string): never {
  const location = [row == null ? null : `row ${row}`, field ?? null].filter(Boolean).join(", ");
  throw new HttpError(400, location ? `${message} (${location})` : message, "invalid_catalog_import");
}

function canonicalColumn(value: string, row?: number): string {
  assertSafeRawText(value, row, "column");
  const alias = COLUMN_ALIASES.get(value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, ""));
  if (!alias) importError(`Unsupported catalogue column: ${value}`, row, "column");
  return alias;
}

function assertSafeRawText(value: string, row?: number, field?: string): void {
  if (value.length > OWNER_CATALOG_IMPORT_LIMITS.maxRawFieldLength) {
    importError("Catalogue field exceeds the size limit", row, field);
  }
  if (/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    importError("Catalogue fields cannot contain control characters", row, field);
  }
  const formulaProbe = value.normalize("NFKC").replace(/^[\s\uFEFF\u200B-\u200D]+/u, "");
  if (/^[=+\-@]/u.test(formulaProbe)) {
    importError("Spreadsheet formulas are not allowed in catalogue fields", row, field);
  }
}

function normalizeText(value: unknown, options: {
  row: number;
  field: string;
  max: number;
  required?: boolean;
}): string | null {
  if (value == null || value === "") {
    if (options.required) importError("Required catalogue field is missing", options.row, options.field);
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    importError("Catalogue fields must be strings or numbers", options.row, options.field);
  }
  const raw = String(value);
  assertSafeRawText(raw, options.row, options.field);
  const normalized = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized && options.required) importError("Required catalogue field is empty", options.row, options.field);
  if (normalized.length > options.max) importError("Catalogue field exceeds the size limit", options.row, options.field);
  return normalized || null;
}

function optionalInteger(value: unknown, row: number, field: string, minimum: number, maximum: number): number | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") importError("Numeric catalogue field is invalid", row, field);
  const raw = String(value).trim();
  assertSafeRawText(raw, row, field);
  if (!/^\d+$/u.test(raw)) importError("Numeric catalogue field must be a whole number", row, field);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    importError("Numeric catalogue field is outside the allowed range", row, field);
  }
  return parsed;
}

function normalizeIsrc(value: unknown, row: number): string | null {
  const raw = normalizeText(value, { row, field: "isrc", max: 32 });
  if (!raw) return null;
  const normalized = raw.toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/u.test(normalized)) importError("ISRC is invalid", row, "isrc");
  return normalized;
}

function normalizeMusicBrainzId(value: unknown, row: number): string | null {
  const raw = normalizeText(value, { row, field: "musicbrainzId", max: 80 });
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    importError("MusicBrainz recording ID is invalid", row, "musicbrainzId");
  }
  return normalized;
}

function normalizeEvidenceState(value: unknown, row: number): EvidenceState {
  const raw = normalizeText(value, { row, field: "evidenceState", max: 40 });
  if (!raw) return "inferred";
  const state = EVIDENCE_STATES.get(raw.toLowerCase().replace(/[^a-z0-9]/g, ""));
  if (!state) importError("Evidence state is unsupported", row, "evidenceState");
  return state;
}

function normalizeSupportScope(value: unknown, row: number): SupportScope {
  const raw = normalizeText(value, { row, field: "supportScope", max: 40 });
  if (!raw) return "track";
  const scope = SUPPORT_SCOPES.get(raw.toLowerCase().replace(/[^a-z0-9]/g, ""));
  if (!scope) importError("Evidence support scope is unsupported", row, "supportScope");
  return scope;
}

function scopeAdjustedState(state: EvidenceState, scope: SupportScope): EvidenceState {
  if (scope === "track") return state;
  if (scope === "editorial") return state === "inferred" ? "inferred" : "editorial";
  return "inferred";
}

function corroborationSubjectKey(candidate: TrackCandidateInput): string | null {
  // Metadata similarity is deliberately not recording identity. Automatic
  // cross-source corroboration is available only when both rows name the same
  // stable recording identifier; metadata-only rows stay separate clusters.
  return candidate.isrc || candidate.musicbrainzId ? candidateIdentityKey(candidate) : null;
}

function normalizeRowKeys(input: unknown, row: number): ImportRow {
  if (!input || typeof input !== "object" || Array.isArray(input)) importError("Each JSON catalogue row must be an object", row);
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > OWNER_CATALOG_IMPORT_LIMITS.maxColumns) importError("Catalogue row has too many fields", row);
  const result: ImportRow = {};
  for (const [rawKey, value] of entries) {
    const key = canonicalColumn(rawKey, row);
    if (Object.hasOwn(result, key)) importError("Catalogue row contains duplicate fields", row, key);
    result[key] = value;
  }
  return result;
}

function parseCsv(text: string): ImportRow[] {
  if (Buffer.byteLength(text, "utf8") > OWNER_CATALOG_IMPORT_LIMITS.maxCsvBytes) {
    importError("CSV catalogue exceeds the request size limit");
  }
  const input = text.replace(/^\uFEFF/u, "");
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;

  const finishField = () => {
    assertSafeRawText(field, records.length + 1, `column ${record.length + 1}`);
    record.push(field);
    field = "";
    closedQuote = false;
  };
  const finishRecord = () => {
    finishField();
    records.push(record);
    if (records.length > OWNER_CATALOG_IMPORT_LIMITS.maxRows + 1) importError("Catalogue exceeds the row limit");
    record = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
        if (field.length > OWNER_CATALOG_IMPORT_LIMITS.maxRawFieldLength) importError("Catalogue field exceeds the size limit");
      }
      continue;
    }
    if (closedQuote && character !== "," && character !== "\r" && character !== "\n") {
      importError("Characters after a closing CSV quote are not allowed", records.length + 1);
    }
    if (character === '"') {
      if (field.length > 0 || closedQuote) importError("CSV quote must begin a field", records.length + 1);
      quoted = true;
    } else if (character === ",") {
      finishField();
      if (record.length > OWNER_CATALOG_IMPORT_LIMITS.maxColumns) importError("CSV catalogue has too many columns");
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      finishRecord();
    } else {
      field += character;
      if (field.length > OWNER_CATALOG_IMPORT_LIMITS.maxRawFieldLength) importError("Catalogue field exceeds the size limit");
    }
  }
  if (quoted) importError("CSV catalogue contains an unclosed quoted field");
  if (field.length > 0 || record.length > 0 || closedQuote) finishRecord();
  while (records.length > 0 && records.at(-1)!.every((value) => value === "")) records.pop();
  if (records.length < 2) importError("CSV catalogue must contain a header and at least one row");

  const rawHeaders = records.shift()!;
  if (rawHeaders.length > OWNER_CATALOG_IMPORT_LIMITS.maxColumns) importError("CSV catalogue has too many columns");
  const headers = rawHeaders.map((header) => canonicalColumn(header, 1));
  if (new Set(headers).size !== headers.length) importError("CSV catalogue contains duplicate columns", 1);
  for (const required of ["artist", "title", "sourceUrl"]) {
    if (!headers.includes(required)) importError(`CSV catalogue is missing the ${required} column`, 1);
  }
  if (records.length > OWNER_CATALOG_IMPORT_LIMITS.maxRows) importError("Catalogue exceeds the row limit");

  return records.map((values, index) => {
    if (values.length !== headers.length) importError("CSV row does not match the header column count", index + 2);
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
}

function requestRows(input: unknown): ImportRow[] {
  if (Array.isArray(input)) {
    if (input.length > OWNER_CATALOG_IMPORT_LIMITS.maxRows) importError("Catalogue exceeds the row limit");
    return input.map((row, index) => normalizeRowKeys(row, index + 1));
  }
  if (!input || typeof input !== "object") importError("Catalogue request must be a JSON array or a format/data object");
  const request = input as Record<string, unknown>;
  if (request.format === "json" && Array.isArray(request.data)) {
    if (request.data.length > OWNER_CATALOG_IMPORT_LIMITS.maxRows) importError("Catalogue exceeds the row limit");
    return request.data.map((row, index) => normalizeRowKeys(row, index + 1));
  }
  if (request.format === "csv" && typeof request.data === "string") return parseCsv(request.data);
  importError("Catalogue request format and data do not match");
}

function normalizeRow(row: ImportRow, rowNumber: number): { source: SourceRecordInput; candidate: TrackCandidateInput } {
  const artist = normalizeText(row.artist, { row: rowNumber, field: "artist", max: 240, required: true })!;
  const title = normalizeText(row.title, { row: rowNumber, field: "title", max: 240, required: true })!;
  const sourceValue = normalizeText(row.sourceUrl, { row: rowNumber, field: "sourceUrl", max: 2_048, required: true })!;
  const sourceUrl = assertPublicHttpsUrl(sourceValue).toString();
  const sourceHost = new URL(sourceUrl).hostname.toLowerCase();
  const supportScope = normalizeSupportScope(row.supportScope, rowNumber);
  const evidenceState = scopeAdjustedState(normalizeEvidenceState(row.evidenceState, rowNumber), supportScope);
  const relationship = normalizeText(row.relationship, { row: rowNumber, field: "relationship", max: 240 })
    ?? "owner catalogue attribution";
  const evidenceNote = compactEvidenceNote(normalizeText(row.evidenceNote, {
    row: rowNumber,
    field: "evidenceNote",
    max: 500,
  }) ?? "Owner catalogue row references this source.");
  const sourceNote = compactEvidenceNote(normalizeText(row.sourceNote, {
    row: rowNumber,
    field: "sourceNote",
    max: 500,
  }) ?? "Imported owner catalogue source.");

  return {
    source: {
      url: sourceUrl,
      title: normalizeText(row.sourceTitle, { row: rowNumber, field: "sourceTitle", max: 240 }) ?? sourceHost,
      sourceClass: "import",
      // Unknown roots intentionally collapse together: two different hosts are
      // not evidence of independence and may mirror one underlying database.
      provenanceRoot: normalizeText(row.provenanceRoot, { row: rowNumber, field: "provenanceRoot", max: 240 }) ?? "unclassified",
      note: sourceNote,
    },
    candidate: {
      artist,
      title,
      album: normalizeText(row.album, { row: rowNumber, field: "album", max: 240 }),
      releaseYear: optionalInteger(row.releaseYear, rowNumber, "releaseYear", 1860, new Date().getUTCFullYear() + 2),
      durationMs: optionalInteger(row.durationMs, rowNumber, "durationMs", 1, 24 * 60 * 60 * 1_000),
      isrc: normalizeIsrc(row.isrc, rowNumber),
      musicbrainzId: normalizeMusicBrainzId(row.musicbrainzId, rowNumber),
      versionLabel: normalizeText(row.versionLabel, { row: rowNumber, field: "versionLabel", max: 120 }),
      evidence: [{ sourceUrl, state: evidenceState, supportScope, relationship, note: evidenceNote }],
    },
  };
}

export function parseOwnerCatalogImport(input: unknown): OwnerCatalogImportResult {
  const rows = requestRows(input);
  if (rows.length === 0) importError("Catalogue must contain at least one row");
  const normalizedRows = rows.map((row, index) => normalizeRow(row, index + 1));
  const rootsByCandidate = new Map<string, Set<string>>();
  for (const normalized of normalizedRows) {
    const key = corroborationSubjectKey(normalized.candidate);
    if (!key) continue;
    const roots = rootsByCandidate.get(key) ?? new Set<string>();
    if (["verified", "corroborated"].includes(normalized.candidate.evidence[0]?.state ?? "")) {
      roots.add(normalized.source.provenanceRoot);
    }
    rootsByCandidate.set(key, roots);
  }

  const candidates: TrackCandidateInput[] = [];
  const sourcesByUrl = new Map<string, SourceRecordInput>();

  normalizedRows.forEach((normalized, index) => {
    const existing = sourcesByUrl.get(normalized.source.url);
    if (existing && existing.provenanceRoot !== normalized.source.provenanceRoot) {
      importError("A source URL cannot have conflicting provenance roots", index + 1, "provenanceRoot");
    }
    if (!existing) sourcesByUrl.set(normalized.source.url, normalized.source);
    const claim = normalized.candidate.evidence[0]!;
    const corroborationKey = corroborationSubjectKey(normalized.candidate);
    const independentRoots = corroborationKey ? rootsByCandidate.get(corroborationKey)?.size ?? 0 : 0;
    candidates.push(claim.state === "corroborated" && independentRoots < 2
      ? { ...normalized.candidate, evidence: [{ ...claim, state: "inferred" }] }
      : normalized.candidate);
  });

  return { sources: [...sourcesByUrl.values()], candidates };
}
