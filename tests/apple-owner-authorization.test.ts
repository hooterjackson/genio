import { expect, test, vi } from "vitest";
import {
  appleAuthorizationErrorMessage,
  durableAppleAuthorizationMessage,
  requireMusicUserToken,
  waitForDurableAppleAuthorization,
} from "../app/owner/apple-authorization-status.ts";

test("owner authorization succeeds only after the durable record becomes valid", async () => {
  const read = vi.fn()
    .mockResolvedValueOnce({ configured: true, status: "unverified", storefront: "us" })
    .mockResolvedValueOnce({
      configured: true,
      status: "valid",
      storefront: "us",
      lastValidatedAt: "2026-07-15T12:00:00.000Z",
    });
  const wait = vi.fn(async () => undefined);

  const result = await waitForDurableAppleAuthorization(read, { attempts: 3, delayMs: 10, wait });

  expect(read).toHaveBeenCalledTimes(2);
  expect(wait).toHaveBeenCalledWith(10);
  expect(result.status).toBe("valid");
  expect(durableAppleAuthorizationMessage(result)).toBe(
    "APPLE MUSIC CONNECTED · US · TOKEN SAVED AND VALIDATED",
  );
});

test("a missing durable authorization fails instead of reporting success", async () => {
  await expect(waitForDurableAppleAuthorization(
    async () => ({ configured: false, status: "missing" }),
    { wait: async () => undefined },
  )).rejects.toThrow("was not saved");
});

test("an Apple rejection is surfaced immediately with its durable error", async () => {
  await expect(waitForDurableAppleAuthorization(async () => ({
    configured: true,
    status: "reauthorization_required",
    storefront: "us",
    lastError: "The owner must reauthorize Apple Music",
  }), { wait: async () => undefined })).rejects.toThrow("The owner must reauthorize Apple Music");
});

test("an authorization that never validates fails visibly at the polling deadline", async () => {
  const read = vi.fn(async () => ({ configured: true, status: "unverified", storefront: "us" }));
  const wait = vi.fn(async () => undefined);

  await expect(waitForDurableAppleAuthorization(read, { attempts: 3, delayMs: 1, wait }))
    .rejects.toThrow("validation timed out");
  expect(read).toHaveBeenCalledTimes(3);
  expect(wait).toHaveBeenCalledTimes(2);
});

test("MusicKit must return a nonempty user token before storefront lookup or persistence", () => {
  expect(requireMusicUserToken(`  ${"t".repeat(24)}  `)).toBe("t".repeat(24));
  expect(() => requireMusicUserToken(undefined)).toThrow("did not return an authorization token");
  expect(() => requireMusicUserToken("  ")).toThrow("did not return an authorization token");
});

test("non-Error MusicKit rejections always produce a visible fallback", () => {
  expect(appleAuthorizationErrorMessage(undefined)).toBe(
    "Apple Music authorization failed before it could be saved. Try again.",
  );
  expect(appleAuthorizationErrorMessage({})).toBe(
    "Apple Music authorization failed before it could be saved. Try again.",
  );
  expect(appleAuthorizationErrorMessage("Apple cancelled authorization")).toBe("Apple cancelled authorization");
});
