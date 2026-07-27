import { describe, expect, test } from "vitest";
import {
  AUTHENTICATED_OWNER_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
  customGuidanceTrackCountAdmission,
  playlistTrackCountAdmission,
  PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
} from "../server/playlist-count-policy.ts";

describe("playlist count admission", () => {
  test("keeps the anonymous product boundary at 300", () => {
    expect(playlistTrackCountAdmission({
      requestedTrackCount: 300,
      owner: false,
      canonicalActivationReady: true,
    })).toMatchObject({
      status: "accepted",
      expanded: false,
      maximumTrackCount: 300,
      requiredBriefContractVersion: null,
    });
    expect(playlistTrackCountAdmission({
      requestedTrackCount: 301,
      owner: false,
      canonicalActivationReady: true,
    })).toMatchObject({
      status: "invalid",
      maximumTrackCount: 300,
    });
  });

  test.each([301, 1_000])(
    "admits an authenticated owner count of %i only after activation and forces contract 3",
    (requestedTrackCount) => {
      expect(playlistTrackCountAdmission({
        requestedTrackCount,
        owner: true,
        canonicalActivationReady: false,
      })).toMatchObject({
        status: "activation_required",
        expanded: true,
        maximumTrackCount: 1_000,
        requiredBriefContractVersion: 3,
      });
      expect(playlistTrackCountAdmission({
        requestedTrackCount,
        owner: true,
        canonicalActivationReady: true,
      })).toEqual({
        status: "accepted",
        expanded: true,
        maximumTrackCount: 1_000,
        requiredBriefContractVersion: 3,
      });
    },
  );

  test("rejects an owner request above the executable abuse boundary", () => {
    expect(playlistTrackCountAdmission({
      requestedTrackCount: 1_001,
      owner: true,
      canonicalActivationReady: true,
    })).toMatchObject({
      status: "invalid",
      maximumTrackCount: 1_000,
    });
  });

  test("keeps omitted, malformed, and public custom guidance at 300", () => {
    expect(customGuidanceTrackCountAdmission({
      requestedTrackCount: 300,
    })).toMatchObject({
      status: "accepted",
      maximumTrackCount: 300,
    });
    for (const requestedTrackCount of [301, 999, 1_000, 1_001]) {
      expect(customGuidanceTrackCountAdmission({
        requestedTrackCount,
        authority: PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      })).toMatchObject({
        status: "invalid",
        maximumTrackCount: 300,
      });
      expect(customGuidanceTrackCountAdmission({
        requestedTrackCount,
        authority: {
          kind: "authenticated_owner",
          canonicalActivationReady: false,
        } as never,
      })).toMatchObject({
        status: "invalid",
        maximumTrackCount: 300,
      });
    }
  });

  test("admits custom owner counts only through the activated authority", () => {
    for (const requestedTrackCount of [301, 999, 1_000]) {
      expect(customGuidanceTrackCountAdmission({
        requestedTrackCount,
        authority:
          AUTHENTICATED_OWNER_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      })).toMatchObject({
        status: "accepted",
        maximumTrackCount: 1_000,
      });
    }
    expect(customGuidanceTrackCountAdmission({
      requestedTrackCount: 1_001,
      authority:
        AUTHENTICATED_OWNER_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
    })).toMatchObject({
      status: "invalid",
      maximumTrackCount: 1_000,
    });
  });
});
