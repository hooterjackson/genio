import type {
  PlaylistGuidanceQuestion,
} from "../shared/types.ts";
import type {
  ResolvedExactArtistIdentityV1,
} from "./exact-artist-identity-v1.ts";
import type {
  CustomArtistIdentityResolutionV1,
} from "./custom-guidance-artist-resolution-v1.ts";
import type {
  CustomGuidanceTrackCountAuthorityV1,
} from "./playlist-count-policy.ts";

export type BriefAnswersPreflightV1 =
  | {
      status: "ready";
      contractVersion: 1 | 2 | 3;
      storefront: string | null;
      questionSetHash: string | null;
      questions: PlaylistGuidanceQuestion[];
    }
  | {
      status: "prior";
      resultStatus: "finalizing" | "complete";
    }
  | {
      status: "prior_awaiting_answers";
      questionSetHash: string;
      questions: PlaylistGuidanceQuestion[];
    }
  | {
      status: "stale_question_set";
      questionSetHash: string;
      questions: PlaylistGuidanceQuestion[];
    };

export type BriefAnswersSubmissionV1 =
  | {
      status: "awaiting_answers";
      created: boolean;
      questionSetHash: string;
      questions: PlaylistGuidanceQuestion[];
    }
  | {
      status: "finalizing" | "complete";
      created: boolean;
    }
  | {
      status: "stale_question_set";
      created: false;
      questionSetHash: string;
      questions: PlaylistGuidanceQuestion[];
    };

export type BriefGuidanceSubmissionOutcomeV1 =
  | {
      status: "submitted";
      submission: BriefAnswersSubmissionV1;
    }
  | Extract<BriefAnswersPreflightV1, { status: "stale_question_set" }>
  | (
      Exclude<CustomArtistIdentityResolutionV1, { status: "ready" }>
      & {
        questionSetHash?: string | null;
        questions?: PlaylistGuidanceQuestion[];
      }
    );

/**
 * Service boundary for initial guidance answers. The first read-only preflight
 * intentionally precedes new-work gates and provider calls so a durable replay
 * or stale tab can never be masked by a worker/provider outage.
 */
export async function submitBriefGuidanceAnswersV1(input: {
  customTexts: readonly string[];
  preflight: (
    authority?: CustomGuidanceTrackCountAuthorityV1,
  ) => Promise<BriefAnswersPreflightV1>;
  authorizeNewWork: () => Promise<CustomGuidanceTrackCountAuthorityV1>;
  resolveCustomArtistIdentities: (input: {
    customTexts: readonly string[];
    storefront: string;
  }) => Promise<CustomArtistIdentityResolutionV1>;
  submit: (input: {
    authority: CustomGuidanceTrackCountAuthorityV1;
    resolvedExactArtistIdentities: readonly ResolvedExactArtistIdentityV1[];
  }) => Promise<BriefAnswersSubmissionV1>;
  submitAmbiguity?: (input: {
    authority: CustomGuidanceTrackCountAuthorityV1;
    ambiguity: Extract<
      CustomArtistIdentityResolutionV1,
      { status: "needs_input" }
    >;
  }) => Promise<BriefAnswersSubmissionV1>;
}): Promise<BriefGuidanceSubmissionOutcomeV1> {
  const replay = (
    preflight: BriefAnswersPreflightV1,
  ): BriefGuidanceSubmissionOutcomeV1 | null => {
    if (preflight.status === "prior") {
      return {
        status: "submitted",
        submission: {
          status: preflight.resultStatus,
          created: false,
        },
      };
    }
    if (preflight.status === "prior_awaiting_answers") {
      return {
        status: "submitted",
        submission: {
          status: "awaiting_answers",
          created: false,
          questionSetHash: preflight.questionSetHash,
          questions: preflight.questions,
        },
      };
    }
    return preflight.status === "stale_question_set"
      ? preflight
      : null;
  };

  const initial = await input.preflight();
  const initialReplay = replay(initial);
  if (initialReplay) return initialReplay;

  const authority = await input.authorizeNewWork();
  const admitted = await input.preflight(authority);
  const admittedReplay = replay(admitted);
  if (admittedReplay) return admittedReplay;
  if (admitted.status !== "ready") {
    throw new Error("invalid_brief_guidance_preflight_state");
  }

  let resolvedExactArtistIdentities: readonly ResolvedExactArtistIdentityV1[] = [];
  if (input.customTexts.length > 0 && admitted.contractVersion === 3) {
    if (!admitted.storefront) {
      return {
        status: "technical_quarantine",
        reason: "configuration",
        questionSetHash: admitted.questionSetHash,
        questions: admitted.questions,
      };
    }
    const resolution = await input.resolveCustomArtistIdentities({
      customTexts: input.customTexts,
      storefront: admitted.storefront,
    });
    if (resolution.status !== "ready") {
      // A concurrent request may have committed while the provider lookup was
      // in flight. Durable state wins over the now-irrelevant provider result.
      const afterFailure = await input.preflight();
      const concurrentReplay = replay(afterFailure);
      if (concurrentReplay) return concurrentReplay;
      if (resolution.status === "needs_input"
        && resolution.reason === "artist_identity_ambiguous"
        && resolution.candidates
        && resolution.candidates.length >= 2
        && resolution.candidates.length <= 3
        && input.submitAmbiguity) {
        return {
          status: "submitted",
          submission: await input.submitAmbiguity({
            authority,
            ambiguity: resolution,
          }),
        };
      }
      return {
        ...resolution,
        ...(afterFailure.status === "ready"
          ? {
              questionSetHash: afterFailure.questionSetHash,
              questions: afterFailure.questions,
            }
          : {}),
      };
    }
    resolvedExactArtistIdentities = resolution.identities;
    const afterLookup = await input.preflight(authority);
    const concurrentReplay = replay(afterLookup);
    if (concurrentReplay) return concurrentReplay;
  }

  return {
    status: "submitted",
    submission: await input.submit({
      authority,
      resolvedExactArtistIdentities,
    }),
  };
}
