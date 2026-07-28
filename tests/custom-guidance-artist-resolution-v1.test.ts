import { describe, expect, test, vi } from "vitest";
import { AppleApiError } from "../server/apple.ts";
import {
  resolveCustomArtistIdentitiesV1,
} from "../server/custom-guidance-artist-resolution-v1.ts";

describe("custom guidance artist identity resolution", () => {
  test("finds an ambiguous exact-name duplicate on the second Apple page", async () => {
    const search = vi.fn(async (
      _storefront: string,
      _query: string,
      next: string | null,
    ) => next === null
      ? {
          artists: [{
            id: "1126808565",
            name: "Bad Bunny",
            genreNames: ["Latin"],
          }],
          next: "page-2",
        }
      : {
          artists: [{
            id: "998877",
            name: "Bad Bunny",
            genreNames: [],
          }],
          next: null,
        });

    await expect(resolveCustomArtistIdentitiesV1({
      customTexts: ["no Bad Bunny"],
      storefront: "us",
      search,
    })).resolves.toMatchObject({
      status: "needs_input",
      reason: "artist_identity_ambiguous",
      inputText: "Bad Bunny",
      candidates: [
        {
          catalogArtistId: "1126808565",
          displayName: "Bad Bunny",
          storefront: "us",
        },
        {
          catalogArtistId: "998877",
          displayName: "Bad Bunny",
          storefront: "us",
        },
      ],
    });
    expect(search).toHaveBeenCalledTimes(2);
  });

  test("quarantines malformed exact-name provider identity instead of reporting scarcity", async () => {
    await expect(resolveCustomArtistIdentitiesV1({
      customTexts: ["no Bad Bunny"],
      storefront: "us",
      search: async () => ({
        artists: [{
          id: "not-a-stable-id",
          name: "Bad Bunny",
          genreNames: [],
        }],
        next: null,
      }),
    })).resolves.toEqual({
      status: "technical_quarantine",
      reason: "configuration",
    });
  });

  test("quarantines one malformed exact-name identity even when valid duplicates are present", async () => {
    await expect(resolveCustomArtistIdentitiesV1({
      customTexts: ["no Bad Bunny"],
      storefront: "us",
      search: async () => ({
        artists: [
          { id: "1126808565", name: "Bad Bunny", genreNames: [] },
          { id: "998877", name: "Bad Bunny", genreNames: [] },
          { id: "malformed", name: "Bad Bunny", genreNames: [] },
        ],
        next: null,
      }),
    })).resolves.toEqual({
      status: "technical_quarantine",
      reason: "configuration",
    });
  });

  test("bounds untrusted profile metadata before returning ambiguity candidates", async () => {
    const result = await resolveCustomArtistIdentitiesV1({
      customTexts: ["no Bad Bunny"],
      storefront: "us",
      search: async () => ({
        artists: [
          {
            id: "1126808565",
            name: "Bad Bunny",
            genreNames: [
              `Latin ${"x".repeat(500)}`,
              "Reggaeton",
              "Reggaeton",
              "Pop",
              "Urban",
              "Extra",
            ],
            url: "javascript:alert(1)",
          },
          {
            id: "998877",
            name: "Bad Bunny",
            genreNames: ["Latin"],
            url: "https://music.apple.com/us/artist/bad-bunny/998877",
          },
        ],
        next: null,
      }),
    });
    expect(result).toMatchObject({
      status: "needs_input",
      reason: "artist_identity_ambiguous",
      candidates: [
        {
          catalogArtistId: "1126808565",
          genreNames: expect.any(Array),
        },
        {
          catalogArtistId: "998877",
          profileUrl:
            "https://music.apple.com/us/artist/bad-bunny/998877",
        },
      ],
    });
    if (result.status !== "needs_input" || !result.candidates) {
      throw new Error("expected bounded ambiguity candidates");
    }
    expect(result.candidates[0]!.profileUrl).toBeUndefined();
    expect(result.candidates[0]!.genreNames).toHaveLength(4);
    expect(result.candidates[0]!.genreNames!.every((genre) => (
      genre.length <= 80
    ))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8"))
      .toBeLessThan(64 * 1024);
  });

  test("requires separate editable review when one of several exact exclusions is ambiguous", async () => {
    const search = vi.fn(async (
      _storefront: string,
      query: string,
    ) => ({
      artists: query === "Bad Bunny"
        ? [
            { id: "1126808565", name: query, genreNames: [] },
            { id: "998877", name: query, genreNames: [] },
          ]
        : [{ id: "271256", name: query, genreNames: [] }],
      next: null,
    }));
    await expect(resolveCustomArtistIdentitiesV1({
      customTexts: ["no Bad Bunny; exclude Drake"],
      storefront: "us",
      search,
    })).resolves.toEqual({
      status: "needs_input",
      reason: "multiple_artist_exclusions_require_separate_review",
      inputText: "Bad Bunny",
    });
    expect(search).toHaveBeenCalledTimes(1);
  });

  test("never claims uniqueness while the bounded artist frontier remains incomplete", async () => {
    const search = vi.fn(async (
      _storefront: string,
      _query: string,
      next: string | null,
    ) => ({
      artists: [{
        id: "1126808565",
        name: "Bad Bunny",
        genreNames: ["Latin"],
      }],
      next: `${next ?? "page"}:next`,
    }));

    await expect(resolveCustomArtistIdentitiesV1({
      customTexts: ["no Bad Bunny"],
      storefront: "us",
      search,
    })).resolves.toMatchObject({
      status: "needs_input",
      reason: "artist_identity_frontier_incomplete",
      inputText: "Bad Bunny",
    });
    expect(search).toHaveBeenCalledTimes(8);
  });

  test("rejects more than four named exclusions before any Apple call", async () => {
    const search = vi.fn();
    await expect(resolveCustomArtistIdentitiesV1({
      customTexts: [
        "no Bad Bunny; exclude Drake; exclude Taylor Swift; exclude Lady Gaga; exclude Dua Lipa",
      ],
      storefront: "us",
      search,
    })).resolves.toMatchObject({
      status: "needs_input",
      reason: "too_many_artist_exclusions",
    });
    expect(search).not.toHaveBeenCalled();
  });

  test("shares one eight-page budget across every named artist candidate", async () => {
    const calls = new Map<string, number>();
    const artistId = new Map([
      ["Bad Bunny", "1126808565"],
      ["Drake", "271256"],
    ]);
    const search = vi.fn(async (
      _storefront: string,
      query: string,
    ) => {
      const count = (calls.get(query) ?? 0) + 1;
      calls.set(query, count);
      const complete = query !== "Taylor Swift" && count === 3;
      return {
        artists: complete
          ? [{
              id: artistId.get(query)!,
              name: query,
              genreNames: [],
            }]
          : [],
        next: complete ? null : `${query}:page:${count + 1}`,
      };
    });

    await expect(resolveCustomArtistIdentitiesV1({
      customTexts: [
        "no Bad Bunny; exclude Drake; exclude Taylor Swift",
      ],
      storefront: "us",
      search,
    })).resolves.toMatchObject({
      status: "needs_input",
      reason: "artist_identity_frontier_incomplete",
      inputText: "Taylor Swift",
    });
    expect(search).toHaveBeenCalledTimes(8);
    expect(Object.fromEntries(calls)).toEqual({
      "Bad Bunny": 3,
      Drake: 3,
      "Taylor Swift": 2,
    });
  });

  test.each([
    {
      error: new AppleApiError(
        "Apple temporarily unavailable",
        503,
        true,
        false,
        20_000,
      ),
      expected: {
        status: "blocked_dependency",
        retryAfterMs: 20_000,
      },
    },
    {
      error: new AppleApiError("Apple authorization failed", 401, false),
      expected: {
        status: "technical_quarantine",
        reason: "authorization",
      },
    },
    {
      error: new AppleApiError("Apple request invalid", 400, false),
      expected: {
        status: "technical_quarantine",
        reason: "configuration",
      },
    },
  ])("maps provider failure to $expected.status", async ({ error, expected }) => {
    await expect(resolveCustomArtistIdentitiesV1({
      customTexts: ["no Bad Bunny"],
      storefront: "us",
      search: async () => {
        throw error;
      },
    })).resolves.toMatchObject(expected);
  });
});
