import { describe, expect, test } from "vitest";
import { musicIntentEnvelopeV1 } from "../server/music-intent-envelope-v1.ts";
import { createRunSpecV3 } from "../server/selection-plan-v3.ts";

describe("MusicIntentEnvelopeV1", () => {
  test("removes personal narrative names and locations from scouting data", () => {
    const prompt = "R&B for Maya and me inspired by when we met 10 years ago between Long Island and Del Mar";
    const envelope = musicIntentEnvelopeV1(createRunSpecV3({
      prompt,
      requestedTrackCount: 50,
      storefront: "us",
    }));
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toMatch(/Maya|Long Island|Del Mar|when we met/iu);
    expect(serialized).toContain("genre");
    expect(serialized).toMatch(/r b|rhythm and blues/iu);
    expect(envelope.requestedTrackCount).toBe(50);
  });

  test("contains no raw prompt or custom-answer field", () => {
    const envelope = musicIntentEnvelopeV1(createRunSpecV3({
      prompt: "Late-Night Smoke: hazy music for a slow midnight drive",
      requestedTrackCount: 25,
      storefront: "us",
    }));
    expect(envelope).not.toHaveProperty("prompt");
    expect(envelope).not.toHaveProperty("rawPrompt");
    expect(envelope).not.toHaveProperty("customAnswers");
    expect(envelope.envelopeHash).toMatch(/^[a-f0-9]{64}$/u);
  });
});
