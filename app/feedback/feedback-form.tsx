"use client";

/* eslint-disable @next/next/no-img-element -- previews use prepared data URLs that Next Image cannot optimize */
import Link from "next/link";
import { ChangeEvent, FormEvent, useRef, useState } from "react";

type FeedbackKind = "bug" | "improvement";

type PreparedImage = {
  mimeType: "image/png" | "image/jpeg";
  dataBase64: string;
  width: number;
  height: number;
};

const MAX_SOURCE_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_BYTES = 1_250_000;
const MAX_IMAGE_EDGE = 1600;

function canvasBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("This image could not be prepared."));
    }, mimeType, quality);
  });
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("This image could not be read."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      if (separator < 0) reject(new Error("This image could not be read."));
      else resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Choose a valid PNG or JPEG image."));
    };
    image.src = url;
  });
}

async function prepareImage(file: File): Promise<PreparedImage> {
  if (!(["image/png", "image/jpeg"] as string[]).includes(file.type)) {
    throw new Error("Choose a PNG or JPEG image.");
  }
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error("Choose an image smaller than 12 MB.");
  }

  const image = await loadImage(file);
  if (!image.naturalWidth || !image.naturalHeight) throw new Error("Choose a valid PNG or JPEG image.");

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  let width = Math.max(1, Math.round(image.naturalWidth * scale));
  let height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare the image.");

  const draw = () => {
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
  };
  draw();

  let mimeType: PreparedImage["mimeType"] = file.type === "image/png" ? "image/png" : "image/jpeg";
  let blob = await canvasBlob(canvas, mimeType, mimeType === "image/jpeg" ? 0.84 : undefined);

  if (blob.size > MAX_OUTPUT_IMAGE_BYTES) {
    mimeType = "image/jpeg";
    for (const quality of [0.84, 0.72, 0.6]) {
      context.save();
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = "#30302e";
      context.fillRect(0, 0, width, height);
      context.restore();
      blob = await canvasBlob(canvas, mimeType, quality);
      if (blob.size <= MAX_OUTPUT_IMAGE_BYTES) break;
    }
  }

  while (blob.size > MAX_OUTPUT_IMAGE_BYTES && Math.max(width, height) > 640) {
    width = Math.max(1, Math.round(width * 0.8));
    height = Math.max(1, Math.round(height * 0.8));
    draw();
    blob = await canvasBlob(canvas, "image/jpeg", 0.68);
    mimeType = "image/jpeg";
  }

  if (blob.size > MAX_OUTPUT_IMAGE_BYTES) {
    throw new Error("This image is still too large after compression. Choose a smaller image.");
  }

  return {
    mimeType,
    dataBase64: await blobBase64(blob),
    width,
    height,
  };
}

function sourcePath(): string {
  try {
    const stored = window.sessionStorage.getItem("9enio.feedback.sourcePath") ?? "";
    window.sessionStorage.removeItem("9enio.feedback.sourcePath");
    if (stored.startsWith("/") && !stored.includes("?") && !stored.includes("#") && stored.length <= 240) return stored;
  } catch {
    // Use the current pathname below.
  }
  return window.location.pathname;
}

export function FeedbackForm() {
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [message, setMessage] = useState("");
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [source] = useState(() => typeof window === "undefined" ? "/feedback" : sourcePath());
  const [preparingImage, setPreparingImage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [received, setReceived] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);

  async function chooseImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setPreparingImage(true);
    setError("");
    try {
      setImage(await prepareImage(file));
    } catch (caught) {
      setImage(null);
      setError((caught as Error).message);
      event.target.value = "";
    } finally {
      setPreparingImage(false);
    }
  }

  function removeImage() {
    setImage(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanMessage = message.trim();
    if (cleanMessage.length < 10) {
      setError("Tell us a little more (at least 10 characters).");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/v1/feedback", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify({
          kind,
          message: cleanMessage,
          pagePath: source,
          appVersion: document.documentElement.dataset.buildVersion || null,
          image,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Feedback could not be submitted. Try again.");
      setReceived(true);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (received) {
    return (
      <section className="feedback-shell feedback-success" aria-labelledby="feedback-received-title">
        <div className="screen-index">/ FEEDBACK RECEIVED</div>
        <h1 id="feedback-received-title">THANK YOU.</h1>
        <p>Your note is now in the private owner inbox.</p>
        <Link className="action-button" href="/">RETURN HOME →</Link>
      </section>
    );
  }

  return (
    <section className="feedback-shell" aria-labelledby="feedback-title">
      <div className="screen-index">/ BUGS + IMPROVEMENTS</div>
      <h1 id="feedback-title">SEND FEEDBACK.</h1>
      <p>Describe what happened or what should change. Only the 9ênio owner can view submissions.</p>

      {error && <div className="feedback-error" role="alert">[ERROR] {error}</div>}

      <form className="feedback-form" onSubmit={submit}>
        <fieldset className="feedback-kind">
          <legend>TYPE</legend>
          <label>
            <input type="radio" name="feedback-kind" value="bug" checked={kind === "bug"} onChange={() => setKind("bug")} />
            <span>BUG</span>
          </label>
          <label>
            <input type="radio" name="feedback-kind" value="improvement" checked={kind === "improvement"} onChange={() => setKind("improvement")} />
            <span>IMPROVEMENT</span>
          </label>
        </fieldset>

        <label className="feedback-message">
          <span>DESCRIPTION</span>
          <textarea
            value={message}
            minLength={10}
            maxLength={4000}
            required
            autoFocus
            placeholder="What happened? What would make it better?"
            onChange={(event) => setMessage(event.target.value)}
          />
          <small>{message.length.toLocaleString()} / 4,000</small>
        </label>

        <div className="feedback-attachment">
          <div>
            <strong>SCREENSHOT</strong>
            <small>OPTIONAL · PNG OR JPEG</small>
          </div>
          {!image && (
            <label className="feedback-file-button">
              <span>{preparingImage ? "PREPARING…" : "ATTACH IMAGE"}</span>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg"
                disabled={preparingImage || submitting}
                onChange={(event) => void chooseImage(event)}
              />
            </label>
          )}
          {image && (
            <div className="feedback-preview">
              <img src={`data:${image.mimeType};base64,${image.dataBase64}`} alt="Screenshot ready to submit" />
              <button type="button" onClick={removeImage}>REMOVE IMAGE</button>
            </div>
          )}
        </div>

        <button className="action-button feedback-submit" type="submit" disabled={submitting || preparingImage || message.trim().length < 10}>
          {submitting ? "SENDING…" : "SUBMIT FEEDBACK →"}
        </button>
      </form>
    </section>
  );
}
