import { createHash } from "node:crypto";

export const MUSIC_CONCEPT_POLICY_VERSION = "music_concepts_v3_2_0" as const;

export type MusicConceptAmbiguity = "none" | "context_required";

export interface MusicConceptV3 {
  readonly id: string;
  readonly label: string;
  /** Exact eligibility aliases are OR values inside one membership predicate. */
  readonly eligibilityAliases: readonly string[];
  /** Broader terms may find leads but can never qualify a recording. */
  readonly discoveryOnlyTerms: readonly string[];
  /** Server-owned patterns may attest the concept without literal label equality. */
  readonly evidencePatterns: readonly RegExp[];
  readonly ambiguity: MusicConceptAmbiguity;
}

function normalize(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[’']/gu, "'")
    .replace(/[^a-z0-9'\s-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const CONCEPTS: readonly MusicConceptV3[] = [
  {
    id: "genre:funk-carioca",
    label: "funk carioca",
    eligibilityAliases: ["funk carioca", "baile funk"],
    discoveryOnlyTerms: ["Brazilian funk", "mandelao", "mandelão", "tamborzao", "tamborzão"],
    evidencePatterns: [
      /\b(?:funk\s+carioca|baile\s+funk)\b/iu,
      /\b(?:mandel[aã]o|tamborz[aã]o)\b[^.!?\n]{0,120}\b(?:funk|baile)\b/iu,
    ],
    ambiguity: "none",
  },
  {
    id: "genre:brazilian-funk-ambiguous",
    label: "Brazilian funk",
    eligibilityAliases: ["Brazilian funk"],
    discoveryOnlyTerms: ["funk carioca", "baile funk", "Brazilian soul funk", "samba funk"],
    evidencePatterns: [/\bBrazilian\s+funk\b/iu],
    ambiguity: "context_required",
  },
  {
    id: "genre:house-music",
    label: "house music",
    eligibilityAliases: ["house music", "house"],
    discoveryOnlyTerms: ["Chicago house", "deep house", "acid house", "garage house"],
    evidencePatterns: [
      /\bhouse\s+music\b/iu,
      /\b(?:Chicago|deep|acid|garage|progressive|tech|Afro)\s+house\b/iu,
      /\bhouse\b[^.!?\n]{0,80}\b(?:genre|scene|DJ|club|dance\s+music)\b/iu,
    ],
    ambiguity: "context_required",
  },
  {
    id: "scene:american-drill",
    label: "American drill",
    eligibilityAliases: ["American drill", "US drill", "U.S. drill"],
    discoveryOnlyTerms: ["Chicago drill", "Brooklyn drill", "New York drill"],
    evidencePatterns: [/\b(?:American|U\.?S\.?)\s+drill\b/iu],
    ambiguity: "none",
  },
  {
    id: "scene:brazilian-disco",
    label: "Brazilian disco",
    eligibilityAliases: ["Brazilian disco"],
    discoveryOnlyTerms: ["Brazil disco", "discoteca brasileira", "Brazilian boogie"],
    evidencePatterns: [/\bBrazil(?:ian)?\s+(?:disco|boogie)\b/iu, /\bdiscoteca\s+brasileira\b/iu],
    ambiguity: "none",
  },
  {
    id: "editorial:tiktok-virality",
    label: "TikTok virality",
    eligibilityAliases: ["TikTok virality", "TikTok breakout"],
    discoveryOnlyTerms: ["viral on TikTok", "TikTok trend", "TikTok hit"],
    evidencePatterns: [
      /\b(?:went|became|has\s+gone|going)\s+viral\s+on\s+TikTok\b/iu,
      /\bTikTok\b[^.!?\n]{0,100}\b(?:viral|virality|trend(?:ed|ing)?|breakout|hit)\b/iu,
      /\b(?:viral|virality|trend(?:ed|ing)?|breakout|hit)\b[^.!?\n]{0,100}\bTikTok\b/iu,
    ],
    ambiguity: "none",
  },
] as const;

const BY_EXACT_ALIAS = new Map<string, MusicConceptV3>();
const BY_DISCOVERY_TERM = new Map<string, MusicConceptV3>();
for (const concept of CONCEPTS) {
  for (const alias of concept.eligibilityAliases) BY_EXACT_ALIAS.set(normalize(alias), concept);
  for (const term of concept.discoveryOnlyTerms) BY_DISCOVERY_TERM.set(normalize(term), concept);
}

export function musicConceptRegistryV3(): readonly MusicConceptV3[] {
  return CONCEPTS;
}

export function musicConceptByIdV3(id: string): MusicConceptV3 | null {
  return CONCEPTS.find((concept) => concept.id === id) ?? null;
}

export function exactMusicConceptV3(value: string): MusicConceptV3 | null {
  return BY_EXACT_ALIAS.get(normalize(value)) ?? null;
}

export function discoveryMusicConceptV3(value: string): MusicConceptV3 | null {
  return BY_EXACT_ALIAS.get(normalize(value)) ?? BY_DISCOVERY_TERM.get(normalize(value)) ?? null;
}

/**
 * Returns only eligibility aliases. A discovery-only term can never expand
 * membership, which prevents broad "funk" or ambiguous "Brazilian funk"
 * from qualifying funk carioca recordings by accident.
 */
export function eligibilityAliasesForMusicConceptV3(value: string): readonly string[] {
  const concept = exactMusicConceptV3(value);
  return concept ? concept.eligibilityAliases : [value.trim()].filter(Boolean);
}

export function musicConceptEvidenceMatchesV3(conceptId: string, evidenceText: string): boolean {
  const concept = musicConceptByIdV3(conceptId);
  return concept ? concept.evidencePatterns.some((pattern) => pattern.test(evidenceText)) : false;
}

export function fallbackMusicConceptIdV3(value: string): string {
  const normalizedValue = normalize(value);
  const slug = normalizedValue.replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 64) || "unknown";
  const digest = createHash("sha256").update(normalizedValue).digest("hex").slice(0, 12);
  return `term:${slug}:${digest}`;
}

export function canonicalMusicConceptIdV3(value: string): string {
  return exactMusicConceptV3(value)?.id ?? fallbackMusicConceptIdV3(value);
}
