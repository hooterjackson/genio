import type {
  AppleCatalogArtist,
} from "./apple.ts";
import { AppleApiError } from "./apple.ts";
import {
  ExactArtistIdentityIntegrityError,
  exactArtistExclusionIntentsV1,
  exactArtistResolutionProviderStateV1,
  resolveExactArtistIdentityV1,
  type ResolvedExactArtistIdentityV1,
} from "./exact-artist-identity-v1.ts";

export type CustomArtistIdentityResolutionV1 =
  | {
      status: "ready";
      identities: ResolvedExactArtistIdentityV1[];
    }
  | {
      status: "needs_input";
      reason:
        | "semantic_category"
        | "artist_name_not_explicit"
        | "artist_not_found"
        | "artist_identity_ambiguous"
        | "artist_identity_frontier_incomplete"
        | "multiple_artist_exclusions_require_separate_review"
        | "too_many_artist_exclusions";
      inputText: string;
      /**
       * Bounded, storefront-bound stable identities for a future persisted
       * correctness question. These remain inert data until a typed patch is
       * selected under a fresh question-set fence.
       */
      candidates?: readonly {
        catalogArtistId: string;
        displayName: string;
        storefront: string;
        profileUrl?: string;
        genreNames?: readonly string[];
      }[];
    }
  | {
      status: "blocked_dependency";
      retryAfterMs: number;
    }
  | {
      status: "technical_quarantine";
    reason: "authorization" | "configuration";
  };

function artistNameKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "");
}

function boundedProviderText(value: string, maxLength: number): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function safeAppleMusicProfileUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 500) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname !== "music.apple.com") {
      return undefined;
    }
    return parsed.toString().slice(0, 500);
  } catch {
    return undefined;
  }
}

export async function resolveCustomArtistIdentitiesV1(input: {
  customTexts: readonly string[];
  storefront: string;
  search: (
    storefront: string,
    query: string,
    next: string | null,
  ) => Promise<{
    artists: readonly AppleCatalogArtist[];
    next: string | null;
  }>;
}): Promise<CustomArtistIdentityResolutionV1> {
  const candidates = new Map<string, { inputText: string }>();
  for (const customText of input.customTexts) {
    const intent = exactArtistExclusionIntentsV1(customText);
    if (intent.status === "needs_clarification") {
      return {
        status: "needs_input",
        reason: intent.reason,
        inputText: intent.inputText,
      };
    }
    if (intent.status === "candidates") {
      for (const candidate of intent.candidates) {
        candidates.set(
          candidate.inputText
            .normalize("NFKC")
            .replace(/\s+/gu, " ")
            .trim()
            .toLocaleLowerCase("en-US"),
          candidate,
        );
        if (candidates.size > 4) {
          return {
            status: "needs_input",
            reason: "too_many_artist_exclusions",
            inputText: candidate.inputText,
          };
        }
      }
    }
  }
  const identities: ResolvedExactArtistIdentityV1[] = [];
  let remainingPageBudget = 8;
  try {
    for (const candidate of candidates.values()) {
      const artists: AppleCatalogArtist[] = [];
      let next: string | null = null;
      let frontierComplete = false;
      while (remainingPageBudget > 0) {
        remainingPageBudget -= 1;
        const page = await input.search(
          input.storefront,
          candidate.inputText,
          next,
        );
        artists.push(...page.artists);
        next = page.next;
        if (!next) {
          frontierComplete = true;
          break;
        }
      }
      if (!frontierComplete) {
        return {
          status: "needs_input",
          reason: "artist_identity_frontier_incomplete",
          inputText: candidate.inputText,
        };
      }
      const expectedName = artistNameKey(candidate.inputText);
      const exactNameArtists = artists.filter((artist) => (
        artistNameKey(artist.name) === expectedName
      ));
      if (exactNameArtists.some((artist) => (
        !/^\d{1,32}$/u.test(artist.id.trim())
      ))) {
        throw new ExactArtistIdentityIntegrityError();
      }
      const exactIdentities = [...new Map(exactNameArtists.map((artist) => {
        const profileUrl = safeAppleMusicProfileUrl(artist.url);
        return [artist.id.trim(), {
              catalogArtistId: artist.id.trim(),
              displayName: boundedProviderText(artist.name, 160),
              storefront: input.storefront,
              ...(profileUrl ? { profileUrl } : {}),
              ...(artist.genreNames.length > 0
                ? {
                    genreNames: [...new Set(artist.genreNames
                      .map((value) => boundedProviderText(value, 80))
                      .filter(Boolean))]
                      .slice(0, 4),
                  }
                : {}),
            }] as const;
      })).values()].sort((left, right) => (
        left.catalogArtistId.localeCompare(right.catalogArtistId)
      ));
      if (exactIdentities.length > 1) {
        if (candidates.size !== 1) {
          return {
            status: "needs_input",
            reason: "multiple_artist_exclusions_require_separate_review",
            inputText: candidate.inputText,
          };
        }
        return {
          status: "needs_input",
          reason: "artist_identity_ambiguous",
          inputText: candidate.inputText,
          candidates: exactIdentities.slice(0, 3),
        };
      }
      const resolution = await resolveExactArtistIdentityV1({
        candidate,
        storefront: input.storefront,
        search: async () => artists,
      });
      if (resolution.status === "needs_clarification") {
        return {
          status: "needs_input",
          reason: resolution.reason,
          inputText: resolution.inputText,
        };
      }
      identities.push(resolution.identity);
    }
  } catch (error) {
    if (error instanceof ExactArtistIdentityIntegrityError) {
      return {
        status: "technical_quarantine",
        reason: "configuration",
      };
    }
    if (!(error instanceof AppleApiError)) throw error;
    return exactArtistResolutionProviderStateV1(error);
  }
  return { status: "ready", identities };
}

export function customArtistNeedsInputMessageV1(
  resolution: Extract<
    CustomArtistIdentityResolutionV1,
    { status: "needs_input" }
  >,
): string {
  if (resolution.reason === "semantic_category"
    || resolution.reason === "artist_name_not_explicit") {
    return `"${resolution.inputText}" is not a uniquely named artist. Edit the interpretation to name one exact artist or express this as a separate playlist rule.`;
  }
  if (resolution.reason === "artist_identity_ambiguous") {
    return `More than one Apple Music artist exactly matches "${resolution.inputText}". Choose the exact artist before applying this exclusion.`;
  }
  if (resolution.reason === "artist_identity_frontier_incomplete") {
    return `Apple Music returned too many artist results to prove that "${resolution.inputText}" identifies one unique artist. Edit the interpretation with a more specific artist name.`;
  }
  if (resolution.reason === "too_many_artist_exclusions") {
    return "Review at most four exact artist exclusions at a time.";
  }
  if (resolution.reason
    === "multiple_artist_exclusions_require_separate_review") {
    return `More than one exact artist exclusion was requested and "${resolution.inputText}" has multiple Apple Music profiles. Review each exact artist exclusion separately.`;
  }
  return `Apple Music could not verify an exact artist named "${resolution.inputText}". Check the artist name before applying this exclusion.`;
}
