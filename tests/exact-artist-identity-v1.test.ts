import { describe, expect, test, vi } from "vitest";
import {
  ExactArtistIdentityIntegrityError,
  exactArtistExclusionIntentsV1,
  exactArtistResolutionProviderStateV1,
  resolveExactArtistIdentityV1,
} from "../server/exact-artist-identity-v1.ts";

describe("exact artist identity exclusions", () => {
  test("extracts every explicit proper-name candidate without treating content as an artist", () => {
    expect(exactArtistExclusionIntentsV1(
      "mostly women, no explicit content, no Bad Bunny; exclude Drake",
    )).toEqual({
      status: "candidates",
      candidates: [
        { inputText: "Bad Bunny" },
        { inputText: "Drake" },
      ],
    });
  });

  test.each([
    "mostly women, clean, no Bad Bunny.",
    "mostly women, clean, no Bad Bunny!",
    "mostly women, clean, no Bad Bunny?",
  ])("treats terminal sentence punctuation as syntax in %j", (text) => {
    expect(exactArtistExclusionIntentsV1(text)).toEqual({
      status: "candidates",
      candidates: [{ inputText: "Bad Bunny" }],
    });
  });

  test.each([
    "no male artists",
    "without reggaeton artists",
    "no sad songs",
    "without live recordings",
    "exclude Latin urban crossover",
  ])("keeps semantic exclusion %j out of exact identity capability", (text) => {
    expect(exactArtistExclusionIntentsV1(text)).toMatchObject({
      status: "needs_clarification",
      reason: "semantic_category",
    });
  });

  test.each([
    "no bad bunny",
    "exclude imaginary person",
  ])("does not infer an exact identity from unresolved lowercase text %j", (text) => {
    expect(exactArtistExclusionIntentsV1(text)).toMatchObject({
      status: "needs_clarification",
      reason: "artist_name_not_explicit",
    });
  });

  test("resolves only one strict exact Apple artist identity", async () => {
    const search = vi.fn(async () => [
      { id: "1126808565", name: "Bad Bunny", genreNames: ["Latin"] },
      { id: "999", name: "Bad Bunny Radio", genreNames: [] },
    ]);
    await expect(resolveExactArtistIdentityV1({
      candidate: { inputText: "Bad Bunny" },
      storefront: "us",
      search,
    })).resolves.toEqual({
      status: "resolved",
      identity: {
        inputText: "Bad Bunny",
        catalogArtistId: "1126808565",
        displayName: "Bad Bunny",
        storefront: "us",
      },
    });
  });

  test("requires clarification for zero or ambiguous exact catalog matches", async () => {
    await expect(resolveExactArtistIdentityV1({
      candidate: { inputText: "Imaginary Person" },
      storefront: "us",
      search: async () => [],
    })).resolves.toMatchObject({
      status: "needs_clarification",
      reason: "artist_not_found",
    });
    await expect(resolveExactArtistIdentityV1({
      candidate: { inputText: "Shared Name" },
      storefront: "us",
      search: async () => [
        { id: "1", name: "Shared Name", genreNames: [] },
        { id: "2", name: "Shared Name", genreNames: [] },
      ],
    })).resolves.toMatchObject({
      status: "needs_clarification",
      reason: "artist_identity_ambiguous",
    });
  });

  test("quarantines an exact-name provider row whose stable ID is malformed", async () => {
    await expect(resolveExactArtistIdentityV1({
      candidate: { inputText: "Bad Bunny" },
      storefront: "us",
      search: async () => [{
        id: "not-a-stable-id",
        name: "Bad Bunny",
        genreNames: [],
      }],
    })).rejects.toBeInstanceOf(ExactArtistIdentityIntegrityError);
  });

  test("quarantines mixed valid and malformed rows because uniqueness is not proven", async () => {
    await expect(resolveExactArtistIdentityV1({
      candidate: { inputText: "Bad Bunny" },
      storefront: "us",
      search: async () => [
        {
          id: "not-a-stable-id",
          name: "Bad Bunny",
          genreNames: [],
        },
        {
          id: "1126808565",
          name: "Bad Bunny",
          genreNames: ["Latin"],
        },
      ],
    })).rejects.toBeInstanceOf(ExactArtistIdentityIntegrityError);
  });

  test("keeps transient Apple failures retryable and quarantines permanent configuration failures", () => {
    expect(exactArtistResolutionProviderStateV1({
      retriable: true,
      status: 503,
      retryAfterMs: 20_000,
    })).toEqual({
      status: "blocked_dependency",
      retryAfterMs: 20_000,
    });
    expect(exactArtistResolutionProviderStateV1({
      retriable: true,
      status: 429,
      retryAfterMs: 2 * 60 * 60_000,
    })).toEqual({
      status: "blocked_dependency",
      retryAfterMs: 2 * 60 * 60_000,
    });
    expect(exactArtistResolutionProviderStateV1({
      retriable: false,
      status: 401,
      retryAfterMs: null,
    })).toEqual({
      status: "technical_quarantine",
      reason: "authorization",
    });
    expect(exactArtistResolutionProviderStateV1({
      retriable: false,
      status: 400,
      retryAfterMs: null,
    })).toEqual({
      status: "technical_quarantine",
      reason: "configuration",
    });
  });
});
