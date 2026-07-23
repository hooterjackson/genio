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
 * The anonymous product boundary and executable owner boundary are separate.
 * Counts above 300 are admitted only for an authenticated owner after the
 * schema-18 activation fence, and always require contract 3/schema 4.
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
