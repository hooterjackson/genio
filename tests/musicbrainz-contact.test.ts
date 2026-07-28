import { describe, expect, test } from "vitest";
import {
  DEFAULT_MUSICBRAINZ_CONTACT,
  MUSICBRAINZ_CONTACT_POLICY_VERSION,
  musicBrainzContactConfigurationLabel,
  musicBrainzUserAgent,
  musicBrainzUserAgentContact,
} from "../server/musicbrainz-contact.ts";

describe("MusicBrainz contact readiness", () => {
  test("uses one valid public default without leaking operator identity", () => {
    expect(musicBrainzUserAgentContact({})).toBe(DEFAULT_MUSICBRAINZ_CONTACT);
    expect(musicBrainzContactConfigurationLabel(undefined)).toBe(
      `${MUSICBRAINZ_CONTACT_POLICY_VERSION}:default_public_url`,
    );
    expect(musicBrainzUserAgent({}, "1.0")).toBe(
      `9enio/1.0 (${DEFAULT_MUSICBRAINZ_CONTACT})`,
    );
  });

  test("classifies valid configured contacts without retaining their value", () => {
    expect(musicBrainzContactConfigurationLabel("owner@example.com")).toBe(
      `${MUSICBRAINZ_CONTACT_POLICY_VERSION}:configured_email`,
    );
    expect(musicBrainzContactConfigurationLabel("other@example.net")).toBe(
      `${MUSICBRAINZ_CONTACT_POLICY_VERSION}:configured_email`,
    );
    expect(musicBrainzContactConfigurationLabel("https://9enio.com/contact")).toBe(
      `${MUSICBRAINZ_CONTACT_POLICY_VERSION}:configured_https_url`,
    );
  });

  test.each([
    "operator-contact-not-configured.invalid",
    "http://9enio.com/about",
    "https://user:password@9enio.com/about",
    "owner@example.com (operator)",
  ])("rejects an unusable or unsafe contact: %s", (contact) => {
    expect(() => musicBrainzUserAgentContact({
      MUSICBRAINZ_CONTACT: contact,
    })).toThrow(/valid email address or HTTPS URL/u);
  });
});
