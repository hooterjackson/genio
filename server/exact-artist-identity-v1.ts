import type { AppleCatalogArtist } from "./apple.ts";

export interface ExactArtistExclusionCandidateV1 {
  readonly inputText: string;
}

export interface ResolvedExactArtistIdentityV1 {
  readonly inputText: string;
  readonly catalogArtistId: string;
  readonly displayName: string;
  readonly storefront: string;
}

export type ExactArtistExclusionIntentV1 =
  | { readonly status: "none" }
  | {
    readonly status: "needs_clarification";
    readonly inputText: string;
    readonly reason: "semantic_category" | "artist_name_not_explicit";
  }
  | {
    readonly status: "candidates";
    readonly candidates: readonly ExactArtistExclusionCandidateV1[];
  };

export type ExactArtistIdentityResolutionV1 =
  | {
    readonly status: "resolved";
    readonly identity: ResolvedExactArtistIdentityV1;
  }
  | {
    readonly status: "needs_clarification";
    readonly inputText: string;
    readonly reason: "artist_not_found" | "artist_identity_ambiguous";
  };

export type ExactArtistResolutionProviderStateV1 =
  | {
    readonly status: "blocked_dependency";
    readonly retryAfterMs: number;
  }
  | {
    readonly status: "technical_quarantine";
    readonly reason: "authorization" | "configuration";
  };

export class ExactArtistIdentityIntegrityError extends Error {
  readonly name = "ExactArtistIdentityIntegrityError";

  constructor() {
    super("invalid_exact_artist_catalog_identity");
  }
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function identityKey(value: string): string {
  return normalized(value)
    .toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "");
}

export function exactArtistResolutionProviderStateV1(input: {
  retriable: boolean;
  status: number | null;
  retryAfterMs: number | null;
}): ExactArtistResolutionProviderStateV1 {
  if (!input.retriable) {
    return {
      status: "technical_quarantine",
      reason: input.status === 401 || input.status === 403
        ? "authorization"
        : "configuration",
    };
  }
  return {
    status: "blocked_dependency",
    retryAfterMs: Math.max(
      5_000,
      Math.min(input.retryAfterMs ?? 60_000, 24 * 60 * 60_000),
    ),
  };
}

const TYPED_CONTENT_EXCLUSION = /^explicit(?:\s+(?:lyrics|content))?$/iu;
const SEMANTIC_CATEGORY = /\b(?:artists?|bands?|groups?|duos?|rappers?|singers?|women|woman|female|men|man|male|songs?|tracks?|recordings?|versions?|remixes?|covers?|karaoke|tribute|live|sad|happy|reggaeton|dembow|latin(?:\s+urban)?|urban|crossover|pop|rock|jazz|ambient|country)\b/iu;
const NAME_TOKEN = /^(?:[\p{Lu}\p{Lt}\d][\p{L}\p{N}'’.-]*|(?:of|the|and|&|x))$/u;

/**
 * Parse only an explicit, proper-name-shaped artist exclusion candidate.
 * This function does not prove identity; the candidate remains inert until a
 * server-owned Apple catalog resolver returns one exact stable artist ID.
 */
export function exactArtistExclusionIntentsV1(
  customText: string,
): ExactArtistExclusionIntentV1 {
  const text = normalized(customText);
  if (!text) return { status: "none" };
  const candidates: ExactArtistExclusionCandidateV1[] = [];
  for (const segment of text.split(/[,;]/u)) {
    const match = normalized(segment).match(
      /\b(?:no|without|exclude|excluding)\s+(.+)$/iu,
    );
    const inputText = normalized(match?.[1] ?? "")
      .replace(/[.!?]+$/u, "")
      .trim();
    if (!inputText || TYPED_CONTENT_EXCLUSION.test(inputText)) continue;
    if (SEMANTIC_CATEGORY.test(inputText)) {
      return {
        status: "needs_clarification",
        inputText,
        reason: "semantic_category",
      };
    }
    const tokens = inputText.split(/\s+/u);
    if (inputText.length > 160
      || tokens.length > 5
      || tokens.some((token) => !NAME_TOKEN.test(token))) {
      return {
        status: "needs_clarification",
        inputText,
        reason: "artist_name_not_explicit",
      };
    }
    if (!candidates.some((candidate) => (
      identityKey(candidate.inputText) === identityKey(inputText)
    ))) {
      candidates.push({ inputText });
    }
  }
  return candidates.length > 0
    ? { status: "candidates", candidates }
    : { status: "none" };
}

/**
 * Bind an inert proper-name candidate to exactly one Apple artist identity.
 * Search results are untrusted provider data; only strict normalized name
 * equality and a unique stable catalog ID can create executable authority.
 */
export async function resolveExactArtistIdentityV1(input: {
  candidate: ExactArtistExclusionCandidateV1;
  storefront: string;
  search: (
    storefront: string,
    query: string,
  ) => Promise<readonly AppleCatalogArtist[]>;
}): Promise<ExactArtistIdentityResolutionV1> {
  const storefront = normalized(input.storefront).toLocaleLowerCase("en-US");
  if (!/^[a-z]{2}$/u.test(storefront)) throw new Error("invalid_exact_artist_storefront");
  const expected = identityKey(input.candidate.inputText);
  const results = await input.search(
    storefront,
    input.candidate.inputText,
  );
  const exact = new Map<string, AppleCatalogArtist>();
  let malformedExactIdentity = false;
  for (const artist of results) {
    const catalogArtistId = artist.id.trim();
    if (identityKey(artist.name) !== expected) continue;
    if (!/^\d{1,32}$/u.test(catalogArtistId)) {
      malformedExactIdentity = true;
      continue;
    }
    exact.set(catalogArtistId, artist);
  }
  if (malformedExactIdentity) {
    throw new ExactArtistIdentityIntegrityError();
  }
  if (exact.size === 0) {
    return {
      status: "needs_clarification",
      inputText: input.candidate.inputText,
      reason: "artist_not_found",
    };
  }
  if (exact.size !== 1) {
    return {
      status: "needs_clarification",
      inputText: input.candidate.inputText,
      reason: "artist_identity_ambiguous",
    };
  }
  const [artist] = exact.values();
  return {
    status: "resolved",
    identity: {
      inputText: input.candidate.inputText,
      catalogArtistId: artist!.id.trim(),
      displayName: normalized(artist!.name),
      storefront,
    },
  };
}
