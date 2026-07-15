import { expect, test } from "vitest";
import { canonicalRecordingKey, normalizeMusicText, rankCatalogMatches } from "../lib/matching.ts";
import { assertPublicHttpsUrl, candidateIdentityKey, compactEvidenceNote, duplicateClusterKey, hmacBase64Url, sha256Hex } from "../server/security.ts";
import { decryptSecret, encryptSecret } from "../server/crypto.ts";
import { canonicalGatewayRequest, createGatewayVerifier } from "../server/gateway-auth.ts";
import { manifestContentHash } from "../server/publisher.ts";
import { playlistShareUrl } from "../server/apple.ts";
import { assertConfiguredAppleStorefront } from "../server/owner.ts";
import {
  BULK_SELECTION_BODY_LIMIT,
  DEFAULT_GATEWAY_BODY_LIMIT,
  forwardedCapabilityCookie,
  gatewayBodyLimit,
  isCrossSiteMutation,
  matchGatewayRoute,
} from "../worker/gateway-policy.ts";
import { manifestOrderSql } from "../server/repository.ts";
import { readFileSync } from "node:fs";

test("normalizes accents, punctuation, and featured artist markers", () => {
  expect(normalizeMusicText("Água de Beber (feat. João)")).toBe("agua de beber joao");
});

test("curated manifests always preserve editorial selection rank", () => {
  for (const orderingPolicy of ["editorial", "curated order", "playlist flow", "chronological"]) {
    expect(manifestOrderSql({ mode: "curated", orderingPolicy }))
      .toBe("c.selection_rank NULLS LAST,c.artist,c.title,c.id");
  }
  expect(manifestOrderSql({ mode: "exhaustive", orderingPolicy: "chronological by first release" }))
    .toContain("c.release_year NULLS LAST");
});

test("stable identifiers take precedence for canonical recording identity", () => {
  const base = { artist: "Artist", title: "Track", album: null, releaseYear: null, durationMs: null, versionLabel: null, evidence: [] };
  expect(canonicalRecordingKey({ ...base, isrc: "us-abc", musicbrainzId: "mbid" })).toBe("mb:mbid");
  expect(canonicalRecordingKey({ ...base, isrc: "us-abc", musicbrainzId: null })).toBe("isrc:US-ABC");
});

test("exact compatible identifiers are accepted", () => {
  const result = rankCatalogMatches("candidate", {
    artist: "Michael Jackson", title: "Human Nature", album: "Thriller", releaseYear: 1982,
    durationMs: 246000, isrc: "USSM19902991", musicbrainzId: null, versionLabel: null, evidence: [],
  }, [{
    id: "1", name: "Human Nature", artistName: "Michael Jackson", albumName: "Thriller",
    durationInMillis: 246100, isrc: "USSM19902991",
  }]);
  expect(result.status).toBe("accepted");
  expect(result.song?.id).toBe("1");
});

test("conflicting live versions are not auto-accepted", () => {
  const result = rankCatalogMatches("candidate", {
    artist: "Artist", title: "Song", album: "Album", releaseYear: 1982,
    durationMs: 240000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [],
  }, [{ id: "live", name: "Song (Live)", artistName: "Artist", albumName: "Album — Live", durationInMillis: 240000 }]);
  expect(result.status).not.toBe("accepted");
});

test("a conflicting ISRC can never be rescued by matching metadata", () => {
  const result = rankCatalogMatches("candidate", {
    artist: "Artist", title: "Song", album: "Album", releaseYear: 2020,
    durationMs: 240000, isrc: "USAAA2000001", musicbrainzId: null, versionLabel: null, evidence: [],
  }, [{
    id: "conflict", name: "Song", artistName: "Artist", albumName: "Album",
    releaseDate: "2020-01-01", durationInMillis: 240100, isrc: "USAAA2000002",
  }]);
  expect(result.status).not.toBe("accepted");
});

test("two exact metadata versions remain an exception", () => {
  const candidate = {
    artist: "Artist", title: "Song", album: "Album", releaseYear: 2020,
    durationMs: 240000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [],
  };
  const result = rankCatalogMatches("candidate", candidate, [
    { id: "a", name: "Song", artistName: "Artist", albumName: "Album", releaseDate: "2020-01-01", durationInMillis: 240000 },
    { id: "b", name: "Song", artistName: "Artist", albumName: "Album", releaseDate: "2020-01-01", durationInMillis: 240500 },
  ]);
  expect(result.status).toBe("review");
});

test("rejects private and non-HTTPS evidence URLs", () => {
  expect(() => assertPublicHttpsUrl("http://example.com")).toThrow();
  expect(() => assertPublicHttpsUrl("https://127.0.0.1/source")).toThrow();
  expect(() => assertPublicHttpsUrl("https://[::ffff:127.0.0.1]/source")).toThrow();
  expect(() => assertPublicHttpsUrl("https://[64:ff9b::7f00:1]/source")).toThrow();
  expect(() => assertPublicHttpsUrl("file:///tmp/source")).toThrow();
  expect(assertPublicHttpsUrl("https://musicbrainz.org/artist/123").hostname).toBe("musicbrainz.org");
});

test("stable identifiers deduplicate while metadata only creates a possible-duplicate cluster", () => {
  const first = {
    artist: "Artist", title: "Song", album: "Album", releaseYear: 2020,
    durationMs: 240000, isrc: "US-AAA-20-00001", musicbrainzId: null, versionLabel: null,
    evidence: [{ sourceUrl: "https://example.com/a", state: "verified" as const, supportScope: "track" as const, subjectEntity: "Artist", subjectRelationship: "performed on", relationship: "performed on", note: "liner notes" }],
  };
  const second = {
    ...first,
    isrc: "USAAA2000001",
    evidence: [{ sourceUrl: "https://example.org/b", state: "verified" as const, supportScope: "track" as const, subjectEntity: "Artist", subjectRelationship: "performed on", relationship: "performed on", note: "session log" }],
  };
  expect(candidateIdentityKey(first)).toBe(candidateIdentityKey(second));

  const withoutIdentifiersA = { ...first, isrc: null };
  const withoutIdentifiersB = { ...second, isrc: null };
  expect(candidateIdentityKey(withoutIdentifiersA)).toBe(candidateIdentityKey(withoutIdentifiersB));
  expect(duplicateClusterKey(withoutIdentifiersA)).toBe(duplicateClusterKey(withoutIdentifiersB));
});

test("gateway canonicalization binds method, path, body, client bucket, and owner", () => {
  const canonical = canonicalGatewayRequest({
    keyId: "v1",
    timestamp: "1783958400",
    nonce: "abcdefghijklmnopqrstuvwxyz012345",
    method: "post",
    path: "/api/v1/runs?view=full",
    bodyHash: "a".repeat(64),
    clientBucket: "2026-07-13.bucket|2026-07-12.previous",
    ownerEmail: "owner@example.com",
  });
  expect(canonical.split("\n")).toEqual([
    "v1", "1783958400", "abcdefghijklmnopqrstuvwxyz012345", "POST",
    "/api/v1/runs?view=full", "a".repeat(64),
    "2026-07-13.bucket|2026-07-12.previous", "owner@example.com",
  ]);
});

test("Sites gateway uses an explicit route matrix and rejects cross-site mutations", () => {
  expect(matchGatewayRoute("GET", "/api/v1/owner/status")).toMatchObject({ owner: true });
  expect(matchGatewayRoute("GET", "/health/live")).toMatchObject({ method: "GET" });
  expect(matchGatewayRoute("GET", "/health/live")?.owner).toBeUndefined();
  expect(matchGatewayRoute("GET", "/api/v1/runs")).toMatchObject({ method: "GET" });
  expect(matchGatewayRoute("GET", "/api/v1/runs/run-id/tracks")).toMatchObject({ method: "GET" });
  expect(matchGatewayRoute("POST", "/api/v1/runs/run-id/matching")).toMatchObject({ method: "POST" });
  expect(matchGatewayRoute("POST", "/api/v1/runs/run-id/selection")).toMatchObject({ method: "POST" });
  expect(matchGatewayRoute("POST", "/api/v1/owner/runs/run-id/catalog-import")).toMatchObject({ owner: true });
  expect(matchGatewayRoute("GET", "/api/v1/owner/unknown")).toBeNull();
  expect(matchGatewayRoute("PATCH", "/api/v1/owner/status")).toBeNull();
  expect(isCrossSiteMutation({
    method: "POST",
    origin: "https://attacker.example",
    expectedOrigin: "https://needle.example",
    fetchSite: "cross-site",
  })).toBe(true);
  expect(isCrossSiteMutation({
    method: "POST",
    origin: "https://needle.example",
    expectedOrigin: "https://needle.example",
    fetchSite: "same-origin",
  })).toBe(false);
});

test("bulk playlist selection has a larger but still bounded signed request limit", () => {
  expect(gatewayBodyLimit("POST", "/api/v1/runs/run-id/selection")).toBe(BULK_SELECTION_BODY_LIMIT);
  expect(gatewayBodyLimit("POST", "/api/v1/runs/run-id/publish")).toBe(DEFAULT_GATEWAY_BODY_LIMIT);
  expect(gatewayBodyLimit("GET", "/api/v1/runs/run-id/selection")).toBe(DEFAULT_GATEWAY_BODY_LIMIT);

  const selected = Array.from({ length: 6_000 }, (_, index) => ({
    candidateId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    catalogId: String(100_000_000_000 + index),
  }));
  const transmittedBody = new TextEncoder().encode(JSON.stringify({ selected }));
  expect(transmittedBody.byteLength).toBeGreaterThan(DEFAULT_GATEWAY_BODY_LIMIT);
  expect(transmittedBody.byteLength).toBeLessThan(BULK_SELECTION_BODY_LIMIT);
});

test("Sites forwards only Needle's capability cookie across the Railway boundary", () => {
  expect(forwardedCapabilityCookie(
    "chatgpt-session=private; __Host-needle-session=capability-token; analytics=tracking",
    true,
  )).toBe("__Host-needle-session=capability-token");
  expect(forwardedCapabilityCookie("needle-session=local-token; unrelated=private", false))
    .toBe("needle-session=local-token");
  expect(forwardedCapabilityCookie("chatgpt-session=private", true)).toBeNull();
  expect(() => forwardedCapabilityCookie(
    "__Host-needle-session=one; __Host-needle-session=two",
    true,
  )).toThrow(/Duplicate Needle capability cookies/);
});

test("Railway gateway rejects stale, body-tampered, signature-tampered, and replayed requests", async () => {
  const original = {
    keyId: process.env.GATEWAY_KEY_ID,
    secret: process.env.GATEWAY_HMAC_SECRET,
    keys: process.env.GATEWAY_KEYS_JSON,
  };
  const keyId = "unit-v1";
  const secret = "unit-gateway-secret-at-least-32-bytes";
  const path = "/api/v1/brief";
  const clientBucket = `2026-07-13.${"b".repeat(43)}`;
  const claimed = new Set<string>();
  try {
    process.env.GATEWAY_KEY_ID = keyId;
    process.env.GATEWAY_HMAC_SECRET = secret;
    delete process.env.GATEWAY_KEYS_JSON;
    const verify = createGatewayVerifier({
      async claimGatewayNonce(id, nonce) {
        const key = `${id}:${nonce}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
    });
    const request = (input: { body: Buffer; signedBody?: Buffer; timestamp?: string; nonce: string; corruptSignature?: boolean }) => {
      const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1_000));
      const signedBody = input.signedBody ?? input.body;
      const bodyHash = sha256Hex(signedBody);
      const validSignature = hmacBase64Url(secret, canonicalGatewayRequest({
        keyId,
        timestamp,
        nonce: input.nonce,
        method: "POST",
        path,
        bodyHash,
        clientBucket,
        ownerEmail: "",
      }));
      const signature = input.corruptSignature
        ? validSignature.slice(0, -1) + (validSignature.endsWith("a") ? "b" : "a")
        : validSignature;
      const headers: Record<string, string> = {
        "x-needle-key-id": keyId,
        "x-needle-timestamp": timestamp,
        "x-needle-nonce": input.nonce,
        "x-needle-body-sha256": bodyHash,
        "x-needle-client-bucket": clientBucket,
        "x-needle-signature": signature,
      };
      return {
        method: "POST",
        url: path,
        rawBody: input.body,
        raw: { rawHeaders: Object.entries(headers).flatMap(([name, value]) => [name, value]), url: path },
      } as never;
    };

    const valid = request({ body: Buffer.from("{}"), nonce: `nonce_${"a".repeat(32)}` });
    await expect(verify(valid)).resolves.toMatchObject({ keyId });
    await expect(verify(valid)).rejects.toMatchObject({ code: "gateway_replay" });
    await expect(verify(request({
      body: Buffer.from('{"changed":true}'),
      signedBody: Buffer.from("{}"),
      nonce: `nonce_${"b".repeat(32)}`,
    }))).rejects.toMatchObject({ code: "invalid_gateway_body" });
    await expect(verify(request({
      body: Buffer.from("{}"),
      nonce: `nonce_${"c".repeat(32)}`,
      corruptSignature: true,
    }))).rejects.toMatchObject({ code: "invalid_gateway_signature" });
    await expect(verify(request({
      body: Buffer.from("{}"),
      timestamp: String(Math.floor(Date.now() / 1_000) - 61),
      nonce: `nonce_${"d".repeat(32)}`,
    }))).rejects.toMatchObject({ code: "stale_gateway_request" });
  } finally {
    if (original.keyId === undefined) delete process.env.GATEWAY_KEY_ID;
    else process.env.GATEWAY_KEY_ID = original.keyId;
    if (original.secret === undefined) delete process.env.GATEWAY_HMAC_SECRET;
    else process.env.GATEWAY_HMAC_SECRET = original.secret;
    if (original.keys === undefined) delete process.env.GATEWAY_KEYS_JSON;
    else process.env.GATEWAY_KEYS_JSON = original.keys;
  }
});

test("Railway accepts current and previous gateway keys during rotation and rejects retired keys", async () => {
  const names = [
    "GATEWAY_KEY_ID",
    "GATEWAY_HMAC_SECRET",
    "GATEWAY_PREVIOUS_KEY_ID",
    "GATEWAY_PREVIOUS_HMAC_SECRET",
    "GATEWAY_KEYS_JSON",
  ] as const;
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const current = { id: "rotation-v2", secret: "rotation-current-secret-at-least-32-bytes" };
  const previous = { id: "rotation-v1", secret: "rotation-previous-secret-at-least-32-bytes" };
  const path = "/api/v1/brief";
  const body = Buffer.from("{}");
  const bodyHash = sha256Hex(body);
  const clientBucket = `2026-07-13.${"r".repeat(43)}`;
  const timestamp = String(Math.floor(Date.now() / 1_000));

  try {
    process.env.GATEWAY_KEY_ID = current.id;
    process.env.GATEWAY_HMAC_SECRET = current.secret;
    process.env.GATEWAY_PREVIOUS_KEY_ID = previous.id;
    process.env.GATEWAY_PREVIOUS_HMAC_SECRET = previous.secret;
    delete process.env.GATEWAY_KEYS_JSON;
    const claimed = new Set<string>();
    const verify = createGatewayVerifier({
      async claimGatewayNonce(keyId, nonce) {
        const key = `${keyId}:${nonce}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
    });
    const request = (key: { id: string; secret: string }, nonce: string) => {
      const signature = hmacBase64Url(key.secret, canonicalGatewayRequest({
        keyId: key.id,
        timestamp,
        nonce,
        method: "POST",
        path,
        bodyHash,
        clientBucket,
        ownerEmail: "",
      }));
      const headers = {
        "x-needle-key-id": key.id,
        "x-needle-timestamp": timestamp,
        "x-needle-nonce": nonce,
        "x-needle-body-sha256": bodyHash,
        "x-needle-client-bucket": clientBucket,
        "x-needle-signature": signature,
      };
      return {
        method: "POST",
        url: path,
        rawBody: body,
        raw: { rawHeaders: Object.entries(headers).flatMap(([name, value]) => [name, value]), url: path },
      } as never;
    };

    await expect(verify(request(previous, `nonce_${"p".repeat(32)}`)))
      .resolves.toMatchObject({ keyId: previous.id });
    await expect(verify(request(current, `nonce_${"c".repeat(32)}`)))
      .resolves.toMatchObject({ keyId: current.id });
    await expect(verify(request(
      { id: "rotation-retired", secret: "rotation-retired-secret-at-least-32-bytes" },
      `nonce_${"x".repeat(32)}`,
    ))).rejects.toMatchObject({ code: "invalid_gateway_signature" });
  } finally {
    for (const name of names) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Apple user-token envelopes authenticate ciphertext and support key rotation", () => {
  const original = {
    key: process.env.APPLE_TOKEN_ENCRYPTION_KEY,
    id: process.env.APPLE_TOKEN_ENCRYPTION_KEY_ID,
    ring: process.env.APPLE_TOKEN_DECRYPTION_KEYS_JSON,
  };
  const keyV1 = Buffer.alloc(32, 1).toString("base64url");
  const keyV2 = Buffer.alloc(32, 2).toString("base64url");
  try {
    process.env.APPLE_TOKEN_ENCRYPTION_KEY = keyV1;
    process.env.APPLE_TOKEN_ENCRYPTION_KEY_ID = "v1";
    process.env.APPLE_TOKEN_DECRYPTION_KEYS_JSON = "{}";
    const envelope = encryptSecret("private-user-token", "apple-music-user-token");
    expect(envelope).not.toContain("private-user-token");
    expect(decryptSecret(envelope, "apple-music-user-token")).toBe("private-user-token");

    process.env.APPLE_TOKEN_ENCRYPTION_KEY = keyV2;
    process.env.APPLE_TOKEN_ENCRYPTION_KEY_ID = "v2";
    process.env.APPLE_TOKEN_DECRYPTION_KEYS_JSON = JSON.stringify({ v1: keyV1 });
    expect(decryptSecret(envelope, "apple-music-user-token")).toBe("private-user-token");
    expect(() => decryptSecret(envelope.replace(/.$/, "x"), "apple-music-user-token")).toThrow();
  } finally {
    if (original.key === undefined) delete process.env.APPLE_TOKEN_ENCRYPTION_KEY;
    else process.env.APPLE_TOKEN_ENCRYPTION_KEY = original.key;
    if (original.id === undefined) delete process.env.APPLE_TOKEN_ENCRYPTION_KEY_ID;
    else process.env.APPLE_TOKEN_ENCRYPTION_KEY_ID = original.id;
    if (original.ring === undefined) delete process.env.APPLE_TOKEN_DECRYPTION_KEYS_JSON;
    else process.env.APPLE_TOKEN_DECRYPTION_KEYS_JSON = original.ring;
  }
});

test("manifest hashes bind exact order and duplicate occurrences", () => {
  const tracks = [
    { candidateId: "a", catalogId: "1", artist: "Artist", title: "One" },
    { candidateId: "b", catalogId: "1", artist: "Artist", title: "One again" },
  ];
  expect(manifestContentHash(tracks)).not.toBe(manifestContentHash([...tracks].reverse()));
  expect(manifestContentHash(tracks)).not.toBe(manifestContentHash(tracks.slice(0, 1)));
});

test("only public Apple Music playlist pages are accepted as share links", () => {
  const publicUrl = "https://music.apple.com/us/playlist/needle-test/pl.123456";
  expect(playlistShareUrl({ attributes: { url: publicUrl } })).toBe(publicUrl);
  expect(playlistShareUrl({ href: "/v1/me/library/playlists/p.123" })).toBeNull();
  expect(playlistShareUrl({ attributes: { url: "https://api.music.apple.com/v1/me/library/playlists/p.123" } })).toBeNull();
  expect(playlistShareUrl({ attributes: { url: "/us/playlist/needle-test/pl.123456" } })).toBeNull();
  expect(playlistShareUrl({ attributes: { url: "https://music.apple.com/us/album/not-a-playlist/1" } })).toBeNull();
});

test("owner Apple authorization must match the configured canonical storefront", () => {
  const original = process.env.APPLE_STOREFRONT;
  try {
    process.env.APPLE_STOREFRONT = "br";
    expect(assertConfiguredAppleStorefront("BR")).toBe("br");
    expect(() => assertConfiguredAppleStorefront("us")).toThrow(/configured for BR/i);
    expect(() => assertConfiguredAppleStorefront("brazil")).toThrow(/two-letter/i);
  } finally {
    if (original === undefined) delete process.env.APPLE_STOREFRONT;
    else process.env.APPLE_STOREFRONT = original;
  }
});

test("evidence notes are compact and bounded", () => {
  expect(compactEvidenceNote("  liner\n\nnotes  ")).toBe("liner notes");
  expect(compactEvidenceNote("a".repeat(900)).length).toBe(500);
});

test("frozen benchmark seeds are unique and evidence URLs are public", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/frozen-holdout.json", import.meta.url), "utf8"));
  for (const collection of [fixture.paulinho_da_costa, fixture.michael_jackson]) {
    const keys = collection.map((track: any) => `${track.artist}|${track.title}`.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  }
  fixture.paulinho_da_costa.forEach((track: any) => expect(assertPublicHttpsUrl(track.source).protocol).toBe("https:"));
  expect(fixture.berlin_techno_rubric.targetMin).toBe(50);
  expect(fixture.berlin_techno_rubric.targetMax).toBe(100);
});
