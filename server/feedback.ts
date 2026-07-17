import { HttpError, sha256Hex, stableStringify } from "./security.ts";

export const FEEDBACK_BODY_BYTES = 2 * 1024 * 1024;
export const FEEDBACK_IMAGE_BYTES = Math.floor(1.25 * 1024 * 1024);
export const FEEDBACK_MESSAGE_MINIMUM = 10;
export const FEEDBACK_MESSAGE_MAXIMUM = 4_000;
export const FEEDBACK_MAX_IMAGE_DIMENSION = 4_096;
export const FEEDBACK_MAX_IMAGE_PIXELS = 12_000_000;

export type FeedbackKind = "bug" | "improvement";
export type FeedbackStatus = "new" | "reviewed" | "resolved";
export type FeedbackImageMimeType = "image/png" | "image/jpeg";

export interface FeedbackImage {
  mimeType: FeedbackImageMimeType;
  dataBase64: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
}

export interface FeedbackSubmissionInput {
  kind: FeedbackKind;
  message: string;
  pagePath: string | null;
  appVersion: string | null;
  image: FeedbackImage | null;
}

export interface FeedbackSubmissionRecord extends FeedbackSubmissionInput {
  id: string;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackListItem extends Omit<FeedbackSubmissionRecord, "image"> {
  image: Omit<FeedbackImage, "dataBase64"> | null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Feedback is invalid", "invalid_feedback");
  }
  return value as Record<string, unknown>;
}

export function parseFeedbackKind(value: unknown): FeedbackKind {
  if (value !== "bug" && value !== "improvement") {
    throw new HttpError(400, "Choose bug or improvement", "invalid_feedback_kind");
  }
  return value;
}

export function parseFeedbackStatus(value: unknown): FeedbackStatus {
  if (value !== "new" && value !== "reviewed" && value !== "resolved") {
    throw new HttpError(400, "Feedback status is invalid", "invalid_feedback_status");
  }
  return value;
}

function parseMessage(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "Describe the bug or improvement", "invalid_feedback_message");
  }
  const message = value.trim();
  if (
    message.length < FEEDBACK_MESSAGE_MINIMUM
    || message.length > FEEDBACK_MESSAGE_MAXIMUM
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message)
  ) {
    throw new HttpError(
      400,
      `Feedback must be ${FEEDBACK_MESSAGE_MINIMUM}–${FEEDBACK_MESSAGE_MAXIMUM.toLocaleString("en-US")} characters`,
      "invalid_feedback_message",
    );
  }
  return message;
}

function parsePagePath(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 300 || !value.startsWith("/") || /[?#\\\u0000-\u001f\u007f]/u.test(value)) {
    throw new HttpError(400, "Feedback page path is invalid", "invalid_feedback_path");
  }
  try {
    const parsed = new URL(value, "https://9enio.invalid");
    if (parsed.origin !== "https://9enio.invalid" || parsed.pathname !== value || parsed.search || parsed.hash) throw new Error("non-canonical");
  } catch {
    throw new HttpError(400, "Feedback page path is invalid", "invalid_feedback_path");
  }
  return value;
}

function parseAppVersion(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "App version is invalid", "invalid_feedback_version");
  const version = value.trim();
  if (!version || version.length > 120 || /[\u0000-\u001f\u007f]/u.test(version)) {
    throw new HttpError(400, "App version is invalid", "invalid_feedback_version");
  }
  return version;
}

function canonicalBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(FEEDBACK_IMAGE_BYTES / 3) * 4 + 4) {
    throw new HttpError(400, "Screenshot is invalid", "invalid_feedback_image");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const unpadded = padding > 0 ? value.slice(0, -padding) : value;
  if (
    value.length % 4 !== 0
    || /[^A-Za-z0-9+/=]/.test(value)
    || unpadded.includes("=")
    || (padding === 1 && unpadded.length % 4 !== 3)
    || (padding === 2 && unpadded.length % 4 !== 2)
  ) {
    throw new HttpError(400, "Screenshot must use canonical base64", "invalid_feedback_image");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > FEEDBACK_IMAGE_BYTES || bytes.toString("base64") !== value) {
    throw new HttpError(400, "Screenshot is too large or invalid", "invalid_feedback_image");
  }
  return bytes;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 45 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new HttpError(400, "Screenshot contents do not match image/png", "invalid_feedback_image");
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new HttpError(400, "PNG screenshot is malformed", "invalid_feedback_image");
  }
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) {
      throw new HttpError(400, "PNG screenshot is malformed", "invalid_feedback_image");
    }
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") throw new HttpError(400, "Animated screenshots are not supported", "invalid_feedback_image");
    offset += length + 12;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== bytes.length) throw new HttpError(400, "PNG screenshot is malformed", "invalid_feedback_image");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new HttpError(400, "Screenshot contents do not match image/jpeg", "invalid_feedback_image");
  }
  let offset = 2;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 7) break;
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw new HttpError(400, "JPEG screenshot is malformed", "invalid_feedback_image");
}

function parseImage(value: unknown): FeedbackImage | null {
  if (value === undefined || value === null) return null;
  const input = object(value);
  const mimeType = input.mimeType;
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
    throw new HttpError(400, "Screenshot must be PNG or JPEG", "invalid_feedback_image_type");
  }
  const bytes = canonicalBase64(input.dataBase64);
  const dimensions = mimeType === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (
    dimensions.width < 1
    || dimensions.height < 1
    || dimensions.width > FEEDBACK_MAX_IMAGE_DIMENSION
    || dimensions.height > FEEDBACK_MAX_IMAGE_DIMENSION
    || dimensions.width * dimensions.height > FEEDBACK_MAX_IMAGE_PIXELS
  ) {
    throw new HttpError(400, "Screenshot dimensions are too large or invalid", "invalid_feedback_image_dimensions");
  }
  if (
    (input.width !== undefined && input.width !== dimensions.width)
    || (input.height !== undefined && input.height !== dimensions.height)
  ) {
    throw new HttpError(400, "Screenshot dimensions do not match its contents", "invalid_feedback_image_dimensions");
  }
  return {
    mimeType,
    dataBase64: bytes.toString("base64"),
    byteSize: bytes.length,
    width: dimensions.width,
    height: dimensions.height,
    sha256: sha256Hex(bytes),
  };
}

export function parseFeedbackSubmission(value: unknown): FeedbackSubmissionInput {
  const input = object(value);
  return {
    kind: parseFeedbackKind(input.kind),
    message: parseMessage(input.message),
    pagePath: parsePagePath(input.pagePath),
    appVersion: parseAppVersion(input.appVersion),
    image: parseImage(input.image),
  };
}

export function feedbackPayloadHash(input: FeedbackSubmissionInput): string {
  return sha256Hex(stableStringify({
    kind: input.kind,
    message: input.message,
    pagePath: input.pagePath,
    appVersion: input.appVersion,
    image: input.image ? {
      mimeType: input.image.mimeType,
      byteSize: input.image.byteSize,
      width: input.image.width,
      height: input.image.height,
      sha256: input.image.sha256,
    } : null,
  }));
}

export function feedbackListItem(record: FeedbackSubmissionRecord): FeedbackListItem {
  return {
    ...record,
    image: record.image ? {
      mimeType: record.image.mimeType,
      byteSize: record.image.byteSize,
      width: record.image.width,
      height: record.image.height,
      sha256: record.image.sha256,
    } : null,
  };
}
