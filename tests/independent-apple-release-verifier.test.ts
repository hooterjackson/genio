import { describe, expect, test, vi } from "vitest";
import {
  appleQaVerifierCredentialIdentityHash,
  independentAppleReleaseEvidence,
  parseApplePublicPlaylistUrl,
} from "../scripts/independent-apple-release-verifier.ts";
import { orderedAppleStableIdsHash } from "../server/publication-reconciliation-persistence.ts";

const token = [
  Buffer.from(JSON.stringify({ alg: "ES256", kid: "QAKEY12345" }))
    .toString("base64url"),
  Buffer.from(JSON.stringify({
    iss: "QATEAM1234",
    iat: 1_721_736_000,
    exp: 1_721_739_600,
  })).toString("base64url"),
  "a".repeat(86),
].join(".");
const revision = "b".repeat(40);

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("independent Apple release verifier", () => {
  test("accepts only canonical public Apple playlist URLs", () => {
    expect(parseApplePublicPlaylistUrl(
      "https://music.apple.com/us/playlist/release-control/pl.u-control",
    )).toEqual({
      shareUrl: "https://music.apple.com/us/playlist/release-control/pl.u-control",
      storefront: "us",
      playlistId: "pl.u-control",
    });
    for (const value of [
      "http://music.apple.com/us/playlist/x/pl.u-x",
      "https://example.com/us/playlist/x/pl.u-x",
      "https://music.apple.com/us/playlist/x/pl.u-x?token=secret",
      "https://music.apple.com/us/playlist/x/p.library",
    ]) {
      expect(() => parseApplePublicPlaylistUrl(value)).toThrow(/invalid_apple_share_url/u);
    }
  });

  test("independently rereads exact order and browser-visible public contents", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/pl.u-control")) {
        return json({
          data: [{
            id: "pl.u-control",
            type: "playlists",
            attributes: { name: "Release Control" },
          }],
        });
      }
      if (url.pathname.endsWith("/pl.u-control/tracks")) {
        return json({
          data: [
            { id: "101", attributes: { name: "First Song" } },
            { id: "202", attributes: { name: "Last Song" } },
          ],
        });
      }
      return new Response(null, { status: 404 });
    });
    const pageProbe = vi.fn(async () => ({
      screenshotHash: "c".repeat(64),
      titleVisible: true as const,
      firstTrackVisible: true as const,
      lastTrackVisible: true as const,
      countVisible: true as const,
    }));
    const expectedOrderedIdsHash = orderedAppleStableIdsHash(["101", "202"]);
    const evidence = await independentAppleReleaseEvidence({
      result: {
        volumes: [{
          index: 1,
          trackCount: 2,
          shareUrl: "https://music.apple.com/us/playlist/release-control/pl.u-control",
        }],
      },
      targetTrackCount: 2,
      expectedOrderedIdsHash,
      canaryId: "fixed-control",
      environment: "staging",
      candidateRevision: revision,
      artifactDirectory: "/tmp/genio-apple-verifier-test",
      now: "2026-07-23T12:00:00.000Z",
    }, {
      environment: {
        APPLE_QA_VERIFIER_DEVELOPER_TOKEN: token,
        APPLE_QA_VERIFIER_CREDENTIAL_VERSION: "qa-apple-v1",
      },
      fetchImpl: fetchMock as typeof fetch,
      pageProbe,
    });

    expect(evidence).toMatchObject({
      schemaVersion: "genio-independent-apple-release-evidence/v1",
      targetTrackCount: 2,
      expectedOrderedIdsHash,
      observedOrderedIdsHash: expectedOrderedIdsHash,
      exactOrderedReadback: true,
      verifierCredentialIdentityHash:
        appleQaVerifierCredentialIdentityHash(token),
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      browserChecks: [{
        volumeIndex: 1,
        titleVisible: true,
        firstTrackVisible: true,
        lastTrackVisible: true,
        countVisible: true,
      }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pageProbe).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(evidence)).not.toContain("pl.u-control");
    expect(JSON.stringify(evidence)).not.toContain(token);
  });

  test("fails closed on order drift and missing independent credentials", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname.endsWith("/tracks")
        ? json({ data: [{ id: "wrong", attributes: { name: "Wrong" } }] })
        : json({
          data: [{
            id: "pl.u-control",
            type: "playlists",
            attributes: { name: "Release Control" },
          }],
        });
    });
    const input = {
      result: {
        volumes: [{
          index: 1,
          trackCount: 1,
          shareUrl: "https://music.apple.com/us/playlist/release-control/pl.u-control",
        }],
      },
      targetTrackCount: 1,
      expectedOrderedIdsHash: orderedAppleStableIdsHash(["expected"]),
      canaryId: "fixed-control",
      environment: "production" as const,
      candidateRevision: revision,
      artifactDirectory: "/tmp/genio-apple-verifier-test",
    };
    await expect(independentAppleReleaseEvidence(input, {
      environment: {
        APPLE_QA_VERIFIER_DEVELOPER_TOKEN: token,
        APPLE_QA_VERIFIER_CREDENTIAL_VERSION: "qa-apple-v1",
      },
      fetchImpl: fetchMock as typeof fetch,
      pageProbe: vi.fn(),
    })).rejects.toThrow(/independent_apple_order_mismatch/u);
    await expect(independentAppleReleaseEvidence(input, {
      environment: {},
      fetchImpl: fetchMock as typeof fetch,
      pageProbe: vi.fn(),
    })).rejects.toThrow(/credential/u);
    await expect(independentAppleReleaseEvidence({
      ...input,
      deadlineAt: Date.now() - 1,
    }, {
      environment: {
        APPLE_QA_VERIFIER_DEVELOPER_TOKEN: token,
        APPLE_QA_VERIFIER_CREDENTIAL_VERSION: "qa-apple-v1",
      },
      fetchImpl: fetchMock as typeof fetch,
      pageProbe: vi.fn(),
    })).rejects.toThrow(/deadline/u);
  });
});
