import { sha256Hex } from "./security.ts";

export const LEGACY_PLAYLIST_CONTRACT_ONTOLOGY_VERSION =
  "playlist_music_ontology_v3" as const;
export const PLAYLIST_CONTRACT_ONTOLOGY_VERSION =
  "playlist_music_ontology_v4" as const;

export type MusicConceptKindV1 =
  | "genre"
  | "scene"
  | "theme"
  | "mood"
  | "activity"
  | "artist"
  | "geography"
  | "language"
  | "editorial";

export type MusicConceptResolutionStatusV1 =
  | "resolved"
  | "ambiguous"
  | "discovery_only"
  | "unresolved";

export interface MusicConceptDefinitionV1 {
  readonly id: string;
  readonly kind: MusicConceptKindV1;
  readonly label: string;
  readonly aliases: readonly string[];
  /** These terms may retrieve leads but can never establish eligibility. */
  readonly discoveryOnlyTerms: readonly string[];
  readonly parentIds: readonly string[];
  readonly adjacentIds: readonly string[];
}

export interface MusicConceptCandidateV1 {
  readonly conceptId: string;
  readonly kind: MusicConceptKindV1;
  readonly label: string;
  readonly confidence: number;
  readonly matchKind: "canonical_label" | "eligibility_alias" | "discovery_term";
  readonly parentIds: readonly string[];
  readonly adjacentIds: readonly string[];
}

export interface MusicConceptResolutionV1 {
  readonly status: MusicConceptResolutionStatusV1;
  readonly originalText: string;
  readonly normalizedText: string;
  readonly ontologyVersion: typeof PLAYLIST_CONTRACT_ONTOLOGY_VERSION;
  readonly selectedConceptId: string | null;
  readonly candidates: readonly MusicConceptCandidateV1[];
  /**
   * Stable audit identity for unresolved text. It is deliberately not an
   * eligibility concept and must never be promoted to a hard predicate.
   */
  readonly unresolvedTermId: string | null;
  readonly discoveryHint: string | null;
}

export interface ResolveMusicConceptInputV1 {
  readonly text: string;
  readonly expectedKind?: MusicConceptKindV1 | null;
  /** A server-confirmed or user-confirmed choice from the returned candidates. */
  readonly selectedConceptId?: string | null;
}

export function normalizeMusicConceptTextV1(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[’']/gu, "'")
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9'\s-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const CONCEPTS: readonly MusicConceptDefinitionV1[] = [
  {
    id: "genre:latin-music",
    kind: "genre",
    label: "Latin music",
    aliases: ["Latin music"],
    discoveryOnlyTerms: ["Latin"],
    parentIds: [],
    adjacentIds: ["genre:latin-urban", "genre:latin-pop"],
  },
  {
    id: "genre:latin-urban",
    kind: "genre",
    label: "Latin urban",
    aliases: ["Latin urban", "urbano latino", "Latin urbano", "música urbana latina"],
    discoveryOnlyTerms: ["urbano", "urban Latin"],
    parentIds: ["genre:latin-music"],
    adjacentIds: ["genre:reggaeton", "genre:dembow", "genre:latin-pop"],
  },
  {
    id: "genre:reggaeton",
    kind: "genre",
    label: "reggaeton",
    aliases: ["reggaeton", "reguetón", "reggaetón"],
    discoveryOnlyTerms: ["perreo", "old-school reggaeton", "reggaeton pop"],
    parentIds: ["genre:latin-urban"],
    adjacentIds: ["genre:dembow", "genre:latin-pop"],
  },
  {
    id: "genre:dembow",
    kind: "genre",
    label: "dembow",
    aliases: ["dembow", "Dominican dembow"],
    discoveryOnlyTerms: ["dembow dominicano"],
    parentIds: ["genre:latin-urban"],
    adjacentIds: ["genre:reggaeton"],
  },
  {
    id: "genre:latin-pop",
    kind: "genre",
    label: "Latin pop",
    aliases: ["Latin pop", "pop latino"],
    discoveryOnlyTerms: ["Latin crossover", "Latin pop crossover"],
    parentIds: ["genre:latin-music"],
    adjacentIds: ["genre:latin-urban", "genre:reggaeton"],
  },
  {
    id: "genre:funk-carioca",
    kind: "genre",
    label: "funk carioca",
    aliases: ["funk carioca", "baile funk", "Brazilian funk"],
    discoveryOnlyTerms: ["mandelão", "mandelao", "tamborzão", "tamborzao"],
    parentIds: [],
    adjacentIds: ["scene:brazilian-club"],
  },
  {
    id: "genre:brazilian-soul-funk",
    kind: "genre",
    label: "Brazilian soul-funk",
    aliases: ["Brazilian soul-funk", "samba funk", "Brazilian funk"],
    discoveryOnlyTerms: ["Brazilian boogie", "samba soul"],
    parentIds: [],
    adjacentIds: ["scene:brazilian-disco"],
  },
  {
    id: "genre:house-music",
    kind: "genre",
    label: "house music",
    aliases: ["house music", "house"],
    discoveryOnlyTerms: ["deep house", "Chicago house", "acid house", "garage house"],
    parentIds: [],
    adjacentIds: [],
  },
  {
    id: "genre:ambient",
    kind: "genre",
    label: "ambient",
    aliases: ["ambient music", "ambient"],
    discoveryOnlyTerms: ["dark ambient", "drone ambient", "sleep ambient"],
    parentIds: [],
    adjacentIds: [],
  },
  {
    id: "genre:jazz",
    kind: "genre",
    label: "jazz",
    aliases: ["jazz music", "jazz"],
    discoveryOnlyTerms: ["spiritual jazz", "modal jazz", "free jazz"],
    parentIds: [],
    adjacentIds: [],
  },
  {
    id: "genre:disco",
    kind: "genre",
    label: "disco",
    aliases: ["disco music", "disco"],
    discoveryOnlyTerms: ["cosmic disco", "Italo disco", "nu-disco"],
    parentIds: [],
    adjacentIds: ["scene:brazilian-disco"],
  },
  {
    id: "genre:rock",
    kind: "genre",
    label: "rock",
    aliases: ["rock music", "rock"],
    discoveryOnlyTerms: ["alternative rock", "indie rock"],
    parentIds: [],
    adjacentIds: [],
  },
  {
    id: "genre:hip-hop",
    kind: "genre",
    label: "hip-hop",
    aliases: ["hip-hop", "hip hop", "rap"],
    discoveryOnlyTerms: ["rap music", "hip-hop culture"],
    parentIds: [],
    adjacentIds: ["genre:r-and-b", "genre:grime"],
  },
  {
    id: "genre:drill",
    kind: "genre",
    label: "drill",
    aliases: ["drill", "drill music", "UK drill", "British drill"],
    discoveryOnlyTerms: ["Chicago drill", "Brooklyn drill", "New York drill"],
    parentIds: [],
    adjacentIds: ["genre:hip-hop", "genre:grime"],
  },
  {
    id: "genre:grime",
    kind: "genre",
    label: "grime",
    aliases: ["grime", "grime music", "UK grime"],
    discoveryOnlyTerms: ["UK rap", "UK garage", "garage"],
    parentIds: [],
    adjacentIds: ["genre:hip-hop", "genre:drill"],
  },
  {
    id: "genre:r-and-b",
    kind: "genre",
    label: "R&B",
    aliases: ["R&B", "R and B", "rhythm and blues"],
    discoveryOnlyTerms: ["contemporary R&B", "alternative R&B"],
    parentIds: [],
    adjacentIds: ["genre:soul", "genre:hip-hop"],
  },
  {
    id: "genre:pop",
    kind: "genre",
    label: "pop",
    aliases: ["pop music", "pop"],
    discoveryOnlyTerms: ["indie pop", "dance-pop"],
    parentIds: [],
    adjacentIds: ["genre:latin-pop"],
  },
  {
    id: "genre:reggae",
    kind: "genre",
    label: "reggae",
    aliases: ["reggae music", "reggae"],
    discoveryOnlyTerms: ["roots reggae", "dancehall"],
    parentIds: [],
    adjacentIds: [],
  },
  {
    id: "genre:techno",
    kind: "genre",
    label: "techno",
    aliases: ["techno music", "techno"],
    discoveryOnlyTerms: ["Detroit techno", "minimal techno"],
    parentIds: [],
    adjacentIds: [],
  },
  {
    id: "genre:soul",
    kind: "genre",
    label: "soul",
    aliases: ["soul music", "soul"],
    discoveryOnlyTerms: ["neo soul", "Northern soul"],
    parentIds: [],
    adjacentIds: ["genre:brazilian-soul-funk"],
  },
  {
    id: "genre:metal",
    kind: "genre",
    label: "metal",
    aliases: ["heavy metal", "metal music", "metal"],
    discoveryOnlyTerms: ["doom metal", "black metal"],
    parentIds: [],
    adjacentIds: [],
  },
  {
    id: "genre:classical",
    kind: "genre",
    label: "classical",
    aliases: ["classical music", "classical"],
    discoveryOnlyTerms: ["modern classical", "contemporary classical"],
    parentIds: [],
    adjacentIds: [],
  },
  {
    id: "theme:houses-and-homes",
    kind: "theme",
    label: "houses and homes",
    aliases: ["house", "houses", "home", "homes"],
    discoveryOnlyTerms: ["domestic space"],
    parentIds: [],
    adjacentIds: [],
  },
  {
    id: "scene:brazilian-disco",
    kind: "scene",
    label: "Brazilian disco",
    aliases: ["Brazilian disco", "discoteca brasileira"],
    discoveryOnlyTerms: ["Brazilian boogie", "Brazil disco"],
    parentIds: [],
    adjacentIds: ["genre:brazilian-soul-funk"],
  },
  {
    id: "scene:brazilian-club",
    kind: "scene",
    label: "Brazilian club music",
    aliases: ["Brazilian club music"],
    discoveryOnlyTerms: ["Brazilian dance music"],
    parentIds: [],
    adjacentIds: ["genre:funk-carioca"],
  },
] as const;

interface IndexedConcept {
  readonly definition: MusicConceptDefinitionV1;
  readonly matchKind: MusicConceptCandidateV1["matchKind"];
}

const ELIGIBILITY_INDEX = new Map<string, IndexedConcept[]>();
const DISCOVERY_INDEX = new Map<string, IndexedConcept[]>();

function indexConcept(
  index: Map<string, IndexedConcept[]>,
  text: string,
  value: IndexedConcept,
): void {
  const key = normalizeMusicConceptTextV1(text);
  const existing = index.get(key) ?? [];
  if (!existing.some((entry) => entry.definition.id === value.definition.id)) {
    existing.push(value);
    index.set(key, existing);
  }
}

for (const definition of CONCEPTS) {
  indexConcept(ELIGIBILITY_INDEX, definition.label, { definition, matchKind: "canonical_label" });
  for (const alias of definition.aliases) {
    indexConcept(ELIGIBILITY_INDEX, alias, { definition, matchKind: "eligibility_alias" });
  }
  for (const term of definition.discoveryOnlyTerms) {
    indexConcept(DISCOVERY_INDEX, term, { definition, matchKind: "discovery_term" });
  }
}

function candidateFromIndex(entry: IndexedConcept): MusicConceptCandidateV1 {
  return {
    conceptId: entry.definition.id,
    kind: entry.definition.kind,
    label: entry.definition.label,
    confidence: entry.matchKind === "canonical_label"
      ? 1
      : entry.matchKind === "eligibility_alias"
        ? 0.98
        : 0.65,
    matchKind: entry.matchKind,
    parentIds: [...entry.definition.parentIds],
    adjacentIds: [...entry.definition.adjacentIds],
  };
}

function uniqueCandidates(entries: readonly IndexedConcept[]): MusicConceptCandidateV1[] {
  const byId = new Map<string, MusicConceptCandidateV1>();
  for (const entry of entries) {
    const candidate = candidateFromIndex(entry);
    const current = byId.get(candidate.conceptId);
    if (!current || candidate.confidence > current.confidence) byId.set(candidate.conceptId, candidate);
  }
  return [...byId.values()].sort((left, right) => (
    right.confidence - left.confidence || left.conceptId.localeCompare(right.conceptId)
  ));
}

export function musicConceptRegistryV1(): readonly MusicConceptDefinitionV1[] {
  return CONCEPTS;
}

export function musicConceptDefinitionV1(conceptId: string): MusicConceptDefinitionV1 | null {
  return CONCEPTS.find((concept) => concept.id === conceptId) ?? null;
}

export function resolveMusicConceptV1(input: ResolveMusicConceptInputV1): MusicConceptResolutionV1 {
  const originalText = input.text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const normalizedText = normalizeMusicConceptTextV1(originalText);
  if (!normalizedText) throw new Error("empty_music_concept");

  const filterKind = (entries: readonly IndexedConcept[]): IndexedConcept[] => entries.filter((entry) => (
    !input.expectedKind || entry.definition.kind === input.expectedKind
  ));
  const eligibleCandidates = uniqueCandidates(filterKind(ELIGIBILITY_INDEX.get(normalizedText) ?? []));
  const discoveryCandidates = uniqueCandidates(filterKind(DISCOVERY_INDEX.get(normalizedText) ?? []));
  const candidates = eligibleCandidates.length > 0 ? eligibleCandidates : discoveryCandidates;

  if (input.selectedConceptId) {
    const selected = candidates.find((candidate) => candidate.conceptId === input.selectedConceptId);
    if (!selected || selected.matchKind === "discovery_term") throw new Error("invalid_selected_music_concept");
    return {
      status: "resolved",
      originalText,
      normalizedText,
      ontologyVersion: PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
      selectedConceptId: selected.conceptId,
      candidates,
      unresolvedTermId: null,
      discoveryHint: null,
    };
  }

  if (eligibleCandidates.length === 1) {
    return {
      status: "resolved",
      originalText,
      normalizedText,
      ontologyVersion: PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
      selectedConceptId: eligibleCandidates[0]!.conceptId,
      candidates: eligibleCandidates,
      unresolvedTermId: null,
      discoveryHint: null,
    };
  }
  if (eligibleCandidates.length > 1) {
    return {
      status: "ambiguous",
      originalText,
      normalizedText,
      ontologyVersion: PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
      selectedConceptId: null,
      candidates: eligibleCandidates,
      unresolvedTermId: null,
      discoveryHint: originalText,
    };
  }
  if (discoveryCandidates.length > 0) {
    return {
      status: "discovery_only",
      originalText,
      normalizedText,
      ontologyVersion: PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
      selectedConceptId: null,
      candidates: discoveryCandidates,
      unresolvedTermId: null,
      discoveryHint: originalText,
    };
  }
  return {
    status: "unresolved",
    originalText,
    normalizedText,
    ontologyVersion: PLAYLIST_CONTRACT_ONTOLOGY_VERSION,
    selectedConceptId: null,
    candidates: [],
    unresolvedTermId: `unresolved:${sha256Hex(normalizedText).slice(0, 16)}`,
    discoveryHint: originalText,
  };
}
