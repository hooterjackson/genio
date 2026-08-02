import { describe, expect, test, vi } from "vitest";
import { AppleApiError } from "../server/apple.ts";
import {
  submitBriefGuidanceAnswersV1,
  type BriefAnswersPreflightV1,
} from "../server/brief-guidance-submission-v1.ts";
import {
  resolveCustomArtistIdentitiesV1,
} from "../server/custom-guidance-artist-resolution-v1.ts";
import {
  PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
} from "../server/playlist-count-policy.ts";

const readyPreflight: BriefAnswersPreflightV1 = {
  status: "ready",
  contractVersion: 3,
  storefront: "us",
  questionSetHash: "a".repeat(64),
  questions: [],
};

describe("initial brief guidance submission service", () => {
  test("persists review without consulting new-work gates or providers", async () => {
    const executionAction = {
      decisionHash: "1".repeat(64),
      optionId: "review_interpretation",
      kind: "review_interpretation" as const,
      startsResearch: false,
      actionHash: "2".repeat(64),
    };
    const preflight = vi.fn(async () => ({
      ...readyPreflight,
      executionAction,
    }));
    const authorizeNewWork = vi.fn();
    const resolveCustomArtistIdentities = vi.fn();
    const submit = vi.fn(async ({ authority }) => {
      expect(authority).toBeUndefined();
      return {
        status: "review_required" as const,
        created: true,
        executionAction,
      };
    });

    await expect(submitBriefGuidanceAnswersV1({
      customTexts: [],
      preflight,
      authorizeNewWork,
      resolveCustomArtistIdentities,
      submit,
    })).resolves.toEqual({
      status: "submitted",
      submission: {
        status: "review_required",
        created: true,
        executionAction,
      },
    });
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(authorizeNewWork).not.toHaveBeenCalled();
    expect(resolveCustomArtistIdentities).not.toHaveBeenCalled();
  });

  test("replays a durable cancellation before new-work gates", async () => {
    const executionAction = {
      decisionHash: "3".repeat(64),
      optionId: "cancel_request",
      kind: "cancel_request" as const,
      startsResearch: false,
      actionHash: "4".repeat(64),
    };
    const authorizeNewWork = vi.fn();
    const submit = vi.fn();

    await expect(submitBriefGuidanceAnswersV1({
      customTexts: [],
      preflight: vi.fn(async () => ({
        status: "prior" as const,
        resultStatus: "cancelled" as const,
        executionAction,
      })),
      authorizeNewWork,
      resolveCustomArtistIdentities: vi.fn(),
      submit,
    })).resolves.toEqual({
      status: "submitted",
      submission: {
        status: "cancelled",
        created: false,
        executionAction,
      },
    });
    expect(authorizeNewWork).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test("returns a durable prior before new-work gates or providers", async () => {
    const preflight = vi.fn(async () => ({
      status: "prior" as const,
      resultStatus: "finalizing" as const,
    }));
    const authorizeNewWork = vi.fn();
    const resolveCustomArtistIdentities = vi.fn();
    const submit = vi.fn();

    await expect(submitBriefGuidanceAnswersV1({
      customTexts: ["no Bad Bunny"],
      preflight,
      authorizeNewWork,
      resolveCustomArtistIdentities,
      submit,
    })).resolves.toEqual({
      status: "submitted",
      submission: {
        status: "finalizing",
        created: false,
      },
    });
    expect(authorizeNewWork).not.toHaveBeenCalled();
    expect(resolveCustomArtistIdentities).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test("adopts a persisted artist-identity child after a lost response without provider work", async () => {
    const child = {
      status: "prior_awaiting_answers" as const,
      questionSetHash: "9".repeat(64),
      questions: [{
        id: "guidance:artist-identity:lost-response",
        header: "Choose exact artist",
        question: "Which exact artist?",
        criticality: "required" as const,
        selectionMode: "single" as const,
        allowCustom: false,
        trigger: "correctness" as const,
        axis: "exact_artist_identity",
        whyMaterial: "Stable identity is required.",
        options: [{
          id: "keep_current_interpretation",
          label: "Keep current interpretation",
          description: "Discard the proposed exclusion.",
          recommended: true,
        }],
      }],
    };
    const authorizeNewWork = vi.fn();
    const resolveCustomArtistIdentities = vi.fn();
    const submit = vi.fn();

    await expect(submitBriefGuidanceAnswersV1({
      customTexts: ["no Bad Bunny"],
      preflight: vi.fn(async () => child),
      authorizeNewWork,
      resolveCustomArtistIdentities,
      submit,
    })).resolves.toEqual({
      status: "submitted",
      submission: {
        status: "awaiting_answers",
        created: false,
        questionSetHash: child.questionSetHash,
        questions: child.questions,
      },
    });
    expect(authorizeNewWork).not.toHaveBeenCalled();
    expect(resolveCustomArtistIdentities).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test("returns a stale question set before new-work gates or providers", async () => {
    const stale = {
      status: "stale_question_set" as const,
      questionSetHash: "b".repeat(64),
      questions: [],
    };
    const authorizeNewWork = vi.fn();
    const resolveCustomArtistIdentities = vi.fn();
    const submit = vi.fn();

    await expect(submitBriefGuidanceAnswersV1({
      customTexts: ["no Bad Bunny"],
      preflight: vi.fn(async () => stale),
      authorizeNewWork,
      resolveCustomArtistIdentities,
      submit,
    })).resolves.toEqual(stale);
    expect(authorizeNewWork).not.toHaveBeenCalled();
    expect(resolveCustomArtistIdentities).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test("prefers a concurrent stale revision over an in-flight provider failure", async () => {
    const stale = {
      status: "stale_question_set" as const,
      questionSetHash: "c".repeat(64),
      questions: [],
    };
    const preflight = vi.fn()
      .mockResolvedValueOnce(readyPreflight)
      .mockResolvedValueOnce(readyPreflight)
      .mockResolvedValueOnce(stale);
    const submit = vi.fn();

    await expect(submitBriefGuidanceAnswersV1({
      customTexts: ["no Bad Bunny"],
      preflight,
      authorizeNewWork: vi.fn(async () => (
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1
      )),
      resolveCustomArtistIdentities: vi.fn(async () => ({
        status: "blocked_dependency" as const,
        retryAfterMs: 20_000,
      })),
      submit,
    })).resolves.toEqual(stale);
    expect(preflight).toHaveBeenCalledTimes(3);
    expect(submit).not.toHaveBeenCalled();
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
  ])("returns actionable $expected.status only while durable state remains ready", async ({
    error,
    expected,
  }) => {
    const search = vi.fn(async () => {
      throw error;
    });
    const preflight = vi.fn(async () => readyPreflight);
    const submit = vi.fn();

    await expect(submitBriefGuidanceAnswersV1({
      customTexts: ["no Bad Bunny"],
      preflight,
      authorizeNewWork: vi.fn(async () => (
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1
      )),
      resolveCustomArtistIdentities: ({ customTexts, storefront }) => (
        resolveCustomArtistIdentitiesV1({
          customTexts,
          storefront,
          search,
        })
      ),
      submit,
    })).resolves.toMatchObject(expected);
    expect(preflight).toHaveBeenCalledTimes(3);
    expect(submit).not.toHaveBeenCalled();
  });

  test("passes a resolved stable artist identity into the durable submit boundary", async () => {
    const submit = vi.fn(async ({ resolvedExactArtistIdentities }) => {
      expect(resolvedExactArtistIdentities).toEqual([{
        inputText: "Bad Bunny",
        catalogArtistId: "1126808565",
        displayName: "Bad Bunny",
        storefront: "us",
      }]);
      return {
        status: "awaiting_answers" as const,
        created: true as const,
        questionSetHash: "d".repeat(64),
        questions: [],
      };
    });

    await expect(submitBriefGuidanceAnswersV1({
      customTexts: ["no Bad Bunny"],
      preflight: vi.fn(async () => readyPreflight),
      authorizeNewWork: vi.fn(async () => (
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1
      )),
      resolveCustomArtistIdentities: ({ customTexts, storefront }) => (
        resolveCustomArtistIdentitiesV1({
          customTexts,
          storefront,
          search: async () => ({
            artists: [{
              id: "1126808565",
              name: "Bad Bunny",
              genreNames: ["Latin"],
            }],
            next: null,
          }),
        })
      ),
      submit,
    })).resolves.toMatchObject({
      status: "submitted",
      submission: {
        status: "awaiting_answers",
        created: true,
      },
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  test("persists a bounded exact-name ambiguity through the dedicated submit boundary", async () => {
    const submit = vi.fn();
    const submitAmbiguity = vi.fn(async ({ ambiguity }) => {
      expect(ambiguity).toMatchObject({
        status: "needs_input",
        reason: "artist_identity_ambiguous",
        inputText: "Bad Bunny",
        candidates: [
          { catalogArtistId: "1126808565", storefront: "us" },
          { catalogArtistId: "998877", storefront: "us" },
        ],
      });
      return {
        status: "awaiting_answers" as const,
        created: true as const,
        questionSetHash: "e".repeat(64),
        questions: [],
      };
    });

    await expect(submitBriefGuidanceAnswersV1({
      customTexts: ["no Bad Bunny"],
      preflight: vi.fn(async () => readyPreflight),
      authorizeNewWork: vi.fn(async () => (
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1
      )),
      resolveCustomArtistIdentities: vi.fn(async () => ({
        status: "needs_input" as const,
        reason: "artist_identity_ambiguous" as const,
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
      })),
      submit,
      submitAmbiguity,
    })).resolves.toMatchObject({
      status: "submitted",
      submission: {
        status: "awaiting_answers",
        created: true,
      },
    });
    expect(submit).not.toHaveBeenCalled();
    expect(submitAmbiguity).toHaveBeenCalledTimes(1);
  });
});
