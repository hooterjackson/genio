import { expect, test, vi } from "vitest";
import { configureFreshMusicKit, type MusicKitApi } from "../app/music-kit.ts";

test("every Apple authorization attempt configures MusicKit with the fresh developer token", async () => {
  const instance = { authorize: vi.fn(async () => "music-user-token") };
  const configure = vi.fn(async () => undefined);
  const MusicKit: MusicKitApi = { configure, getInstance: () => instance };

  await expect(configureFreshMusicKit(MusicKit, "developer-token-one")).resolves.toBe(instance);
  await expect(configureFreshMusicKit(MusicKit, "developer-token-two")).resolves.toBe(instance);
  expect(configure).toHaveBeenNthCalledWith(1, expect.objectContaining({ developerToken: "developer-token-one" }));
  expect(configure).toHaveBeenNthCalledWith(2, expect.objectContaining({ developerToken: "developer-token-two" }));
});
