import {
  EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS,
  PUBLIC_PLAYLIST_MAXIMUM_TRACKS,
  PUBLIC_PLAYLIST_MINIMUM_TRACKS,
} from "../shared/product-policy.ts";

export type PlaylistTrackCountAdmission =
  | {
    status: "accepted";
    expanded: boolean;
    maximumTrackCount: number;
    requiredBriefContractVersion: 3 | null;
  }
  | {
    status: "invalid";
    expanded: false;
    maximumTrackCount: number;
    requiredBriefContractVersion: null;
  }
  | {
    status: "activation_required";
    expanded: true;
    maximumTrackCount: number;
    requiredBriefContractVersion: 3;
  };

/**
 * Custom guidance may use the executable 1,000-track ceiling only when the
 * HTTP boundary has independently verified both the owner identity and the
 * canonical activation fence. Generic compiler callers are public by
 * default; a missing or malformed authority therefore cannot expand access.
 */
export type CustomGuidanceTrackCountAuthorityV1 =
  | { kind: "public" }
  | {
    kind: "authenticated_owner";
    canonicalActivationReady: true;
  };

export const PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1:
CustomGuidanceTrackCountAuthorityV1 = Object.freeze({ kind: "public" });

export const AUTHENTICATED_OWNER_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1:
CustomGuidanceTrackCountAuthorityV1 = Object.freeze({
  kind: "authenticated_owner",
  canonicalActivationReady: true,
});

export function normalizeCustomGuidanceTrackCountAuthorityV1(
  value: unknown,
): CustomGuidanceTrackCountAuthorityV1 {
  if (value && typeof value === "object") {
    const candidate = value as {
      kind?: unknown;
      canonicalActivationReady?: unknown;
    };
    if (candidate.kind === "authenticated_owner"
      && candidate.canonicalActivationReady === true) {
      return AUTHENTICATED_OWNER_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1;
    }
  }
  return PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1;
}

/**
 * The anonymous product boundary and executable owner boundary are separate.
 * Counts above 300 are admitted only for an authenticated owner after the
 * schema-19 activation fence, and always require contract 3.
 */
export function playlistTrackCountAdmission(input: {
  requestedTrackCount: number | null | undefined;
  owner: boolean;
  canonicalActivationReady: boolean;
}): PlaylistTrackCountAdmission {
  const maximumTrackCount = input.owner
    ? EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS
    : PUBLIC_PLAYLIST_MAXIMUM_TRACKS;
  const count = input.requestedTrackCount;
  if (count === undefined || count === null) {
    return {
      status: "accepted",
      expanded: false,
      maximumTrackCount,
      requiredBriefContractVersion: null,
    };
  }
  if (!Number.isSafeInteger(count)
    || count < PUBLIC_PLAYLIST_MINIMUM_TRACKS
    || count > maximumTrackCount) {
    return {
      status: "invalid",
      expanded: false,
      maximumTrackCount,
      requiredBriefContractVersion: null,
    };
  }
  if (count > PUBLIC_PLAYLIST_MAXIMUM_TRACKS) {
    return input.canonicalActivationReady
      ? {
        status: "accepted",
        expanded: true,
        maximumTrackCount,
        requiredBriefContractVersion: 3,
      }
      : {
        status: "activation_required",
        expanded: true,
        maximumTrackCount,
        requiredBriefContractVersion: 3,
      };
  }
  return {
    status: "accepted",
    expanded: false,
    maximumTrackCount,
    requiredBriefContractVersion: null,
  };
}

export function customGuidanceTrackCountAdmission(input: {
  requestedTrackCount: number | null | undefined;
  authority?: CustomGuidanceTrackCountAuthorityV1 | null;
}): PlaylistTrackCountAdmission {
  const authenticatedOwner =
    normalizeCustomGuidanceTrackCountAuthorityV1(input.authority).kind
      === "authenticated_owner";
  return playlistTrackCountAdmission({
    requestedTrackCount: input.requestedTrackCount,
    owner: authenticatedOwner,
    canonicalActivationReady: authenticatedOwner,
  });
}
