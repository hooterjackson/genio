import { expect, test } from "vitest";
import {
  FEEDBACK_IMAGE_BYTES,
  feedbackListItem,
  feedbackPayloadHash,
  parseFeedbackStatus,
  parseFeedbackSubmission,
} from "../server/feedback.ts";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

test("validates and normalizes a feedback submission without exposing image bytes in owner lists", () => {
  const submission = parseFeedbackSubmission({
    kind: "bug",
    message: "  The playlist button did not respond.  ",
    pagePath: "/feedback",
    appVersion: "release-123",
    image: {
      mimeType: "image/png",
      dataBase64: ONE_PIXEL_PNG,
      width: 1,
      height: 1,
    },
  });
  expect(submission).toMatchObject({
    kind: "bug",
    message: "The playlist button did not respond.",
    pagePath: "/feedback",
    appVersion: "release-123",
    image: { mimeType: "image/png", width: 1, height: 1 },
  });
  expect(submission.image?.byteSize).toBe(Buffer.from(ONE_PIXEL_PNG, "base64").length);
  expect(submission.image?.sha256).toMatch(/^[a-f0-9]{64}$/);

  const listItem = feedbackListItem({
    id: "00000000-0000-4000-8000-000000000001",
    status: "new",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    ...submission,
  });
  expect(listItem.image).not.toHaveProperty("dataBase64");
  expect(JSON.stringify(listItem)).not.toContain(ONE_PIXEL_PNG);
});

test("feedback payload hashing is stable and binds the private screenshot", () => {
  const first = parseFeedbackSubmission({
    kind: "improvement",
    message: "Please add a compact playlist view.",
    pagePath: "/",
    image: { mimeType: "image/png", dataBase64: ONE_PIXEL_PNG },
  });
  expect(feedbackPayloadHash(first)).toBe(feedbackPayloadHash({ ...first }));
  expect(feedbackPayloadHash(first)).not.toBe(feedbackPayloadHash({ ...first, message: `${first.message}!` }));
});

test("rejects unsupported, mismatched, malformed, animated, and oversized screenshots", () => {
  const base = { kind: "bug", message: "This is enough detail for feedback." };
  expect(() => parseFeedbackSubmission({
    ...base,
    image: { mimeType: "image/gif", dataBase64: ONE_PIXEL_PNG },
  })).toThrow(/PNG or JPEG/);
  expect(() => parseFeedbackSubmission({
    ...base,
    image: { mimeType: "image/jpeg", dataBase64: ONE_PIXEL_PNG },
  })).toThrow(/image\/jpeg/);
  expect(() => parseFeedbackSubmission({
    ...base,
    image: { mimeType: "image/png", dataBase64: `${ONE_PIXEL_PNG}\n` },
  })).toThrow(/canonical base64/);
  expect(() => parseFeedbackSubmission({
    ...base,
    image: { mimeType: "image/png", dataBase64: ONE_PIXEL_PNG, width: 2, height: 1 },
  })).toThrow(/dimensions do not match/);
  const oversized = Buffer.alloc(FEEDBACK_IMAGE_BYTES + 1, 0).toString("base64");
  expect(() => parseFeedbackSubmission({
    ...base,
    image: { mimeType: "image/png", dataBase64: oversized },
  })).toThrow(/invalid|large/i);
});

test("feedback accepts only constrained text, pathname-only context, and exact statuses", () => {
  expect(() => parseFeedbackSubmission({ kind: "complaint", message: "This message is long enough." })).toThrow(/bug or improvement/);
  expect(() => parseFeedbackSubmission({ kind: "bug", message: "short" })).toThrow(/10/);
  expect(() => parseFeedbackSubmission({ kind: "bug", message: "This message is long enough.\u0000" })).toThrow(/characters/);
  expect(() => parseFeedbackSubmission({ kind: "bug", message: "This message is long enough.", pagePath: "/jobs?secret=1" })).toThrow(/path/);
  expect(() => parseFeedbackSubmission({ kind: "bug", message: "This message is long enough.", pagePath: "https://example.com/jobs" })).toThrow(/path/);
  expect(parseFeedbackStatus("reviewed")).toBe("reviewed");
  expect(() => parseFeedbackStatus("published")).toThrow(/status/);
});
