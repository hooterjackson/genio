import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  PUBLIC_PLAYLIST_MAXIMUM_TRACKS,
  PUBLIC_PLAYLIST_MINIMUM_TRACKS,
} from "../shared/product-policy.ts";

const CONFIRMATION_FLAG = "--confirm-live-write";
const DEFAULT_ORIGIN = "https://9enio.com";
const TERMINAL_RUN_STATUSES = new Set(["complete", "partial", "failed", "expired", "deleted"]);
const REVIEW_RUN_STATUSES = new Set(["review", "visitor_review"]);
const DEFAULT_TRACKS = [
  { artist: "Michael Jackson", title: "Billie Jean" },
  { artist: "Madonna", title: "La Isla Bonita" },
  { artist: "Earth, Wind & Fire", title: "September" },
] as const;

export interface SmokeArgs {
  confirmLiveWrite: boolean;
  origin: string;
  prompt: string;
  targetTrackCount: number;
}

type ApiResponse = Record<string, unknown>;

function asRecord(value: unknown): ApiResponse {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ApiResponse
    : {};
}

export function parseHostedSmokeArgs(argv: readonly string[]): SmokeArgs {
  let confirmLiveWrite = false;
  let origin = DEFAULT_ORIGIN;
  let prompt = [
    "Build a playlist containing exactly these three original studio recordings, in this order:",
    ...DEFAULT_TRACKS.map((track, index) => `${index + 1}. ${track.artist} — ${track.title}`),
    "Exclude remixes, live versions, radio edits, covers, re-recordings, and duplicates.",
  ].join("\n");
  let targetTrackCount: number = DEFAULT_TRACKS.length;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === CONFIRMATION_FLAG) {
      confirmLiveWrite = true;
      continue;
    }
    if (argument === "--origin") {
      const value = argv[index + 1];
      if (!value) throw new Error("--origin requires a value");
      origin = value;
      index += 1;
      continue;
    }
    if (argument === "--prompt") {
      const value = argv[index + 1]?.trim();
      if (!value) throw new Error("--prompt requires a value");
      prompt = value;
      index += 1;
      continue;
    }
    if (argument === "--count") {
      const value = Number(argv[index + 1]);
      if (
        !Number.isInteger(value)
        || value < PUBLIC_PLAYLIST_MINIMUM_TRACKS
        || value > PUBLIC_PLAYLIST_MAXIMUM_TRACKS
      ) {
        throw new Error(
          `--count must be an integer from ${PUBLIC_PLAYLIST_MINIMUM_TRACKS} to ${PUBLIC_PLAYLIST_MAXIMUM_TRACKS}`,
        );
      }
      targetTrackCount = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!confirmLiveWrite) throw new Error(`Hosted publication smoke tests require ${CONFIRMATION_FLAG}`);
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("--origin must be an HTTPS origin with no path, query, or credentials");
  }
  return { confirmLiveWrite, origin: parsed.origin, prompt, targetTrackCount };
}

export function recommendedGuidanceAnswers(payload: unknown): Array<{ questionId: string; optionId: string }> {
  const record = asRecord(payload);
  const questions = Array.isArray(record.questions) ? record.questions.map(asRecord) : [];
  if (questions.length < 1 || questions.length > 3) {
    throw new Error("gênio requested guidance without returning 1–3 valid questions");
  }
  return questions.map((question) => {
    if (typeof question.id !== "string" || !question.id.trim()) {
      throw new Error("A guidance question has no valid ID");
    }
    const options = Array.isArray(question.options) ? question.options.map(asRecord) : [];
    if (options.length !== 3) throw new Error("A guidance question does not contain exactly three options");
    const recommended = options.filter((option) => option.recommended === true);
    if (recommended.length !== 1) {
      throw new Error("A guidance question does not contain exactly one recommendation");
    }
    const optionId = recommended[0]?.id;
    if (typeof optionId !== "string" || !optionId.trim()) {
      throw new Error("A guidance recommendation has no valid option ID");
    }
    return { questionId: question.id, optionId };
  });
}

function appleShareUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "music.apple.com";
  } catch {
    return false;
  }
}

export function assertHostedPublication(
  runValue: unknown,
  resultValue: unknown,
  targetTrackCount: number,
): void {
  const run = asRecord(runValue);
  const result = asRecord(resultValue);
  if (run.status !== "complete") {
    throw new Error(`Hosted publication smoke test ended with status ${String(run.status)}`);
  }
  if (result.status !== "complete") {
    throw new Error(`Hosted publication result ended with status ${String(result.status)}`);
  }
  if (run.error || result.error) throw new Error("Hosted publication completed with a retained run error");
  const manifest = asRecord(result.manifest);
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new Error("Published manifest has no playlist name");
  }
  if (Number(manifest.trackCount ?? result.totalTracks ?? 0) !== targetTrackCount) {
    throw new Error(
      `Published manifest contains ${String(manifest.trackCount ?? result.totalTracks ?? 0)} tracks instead of ${targetTrackCount}`,
    );
  }
  if (Number(result.totalTracks ?? 0) !== targetTrackCount) {
    throw new Error(`Published result contains ${String(result.totalTracks ?? 0)} tracks instead of ${targetTrackCount}`);
  }
  if (Number(result.completedTracks ?? 0) !== targetTrackCount) {
    throw new Error(
      `Apple publication completed ${String(result.completedTracks ?? 0)} tracks instead of ${targetTrackCount}`,
    );
  }
  const volumes = Array.isArray(result.volumes) ? result.volumes.map(asRecord) : [];
  if (volumes.length === 0) throw new Error("Apple publication returned no playlist volumes");
  if (volumes.some((volume) => volume.status !== "complete")) {
    throw new Error("Apple publication returned an incomplete playlist volume");
  }
  if (volumes.some((volume) => !appleShareUrl(volume.shareUrl))) {
    throw new Error("Apple publication did not return a valid public Apple Music link for every volume");
  }
  const volumeTrackCount = volumes.reduce((sum, volume) => sum + Number(volume.trackCount ?? 0), 0);
  const appendedTrackCount = volumes.reduce((sum, volume) => sum + Number(volume.appendedCount ?? 0), 0);
  if (volumeTrackCount !== targetTrackCount || appendedTrackCount !== targetTrackCount) {
    throw new Error("Apple publication volume counts do not match the approved manifest");
  }
}

function safeMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const object = payload as Record<string, unknown>;
    if (typeof object.error === "string") return object.error;
    if (typeof object.message === "string") return object.message;
  }
  return `gênio returned HTTP ${status}`;
}

function scopedCapabilityCookie(setCookie: string | null, current: string): string {
  if (!setCookie) return current;
  for (const name of ["__Host-needle-session", "needle_session"]) {
    const match = setCookie.match(new RegExp(`(?:^|,\\s*)(${name}=[^;,\\s]+)`, "u"));
    if (match?.[1]) return match[1];
  }
  return current;
}

async function request(
  origin: string,
  path: string,
  init: RequestInit = {},
  cookie = "",
): Promise<{ payload: ApiResponse; cookie: string }> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${origin}${path}`, { ...init, headers, redirect: "error" });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => ({})) as ApiResponse
    : { text: await response.text().catch(() => "") };
  if (!response.ok) throw new Error(safeMessage(payload, response.status));
  const setCookie = response.headers.get("set-cookie");
  const nextCookie = scopedCapabilityCookie(setCookie, cookie);
  return { payload, cookie: nextCookie };
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function log(event: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
}

async function main(): Promise<void> {
  const { origin, prompt, targetTrackCount } = parseHostedSmokeArgs(process.argv.slice(2));
  const live = await request(origin, "/health/live");
  const build = asRecord(live.payload.build);
  const revision = typeof build.revision === "string" ? build.revision.toLowerCase() : "";
  if (!/^[0-9a-f]{7,64}$/u.test(revision)) {
    throw new Error("Hosted API did not expose a valid deployment revision");
  }
  log("build_verified", {
    identifier: build.identifier,
    version: build.version,
    revision,
  });
  const briefKey = `hosted-smoke-brief-${randomUUID()}`;
  let briefCookie = "";
  const briefStart = await request(origin, "/api/v1/brief", {
    method: "POST",
    headers: { "Idempotency-Key": briefKey },
    body: JSON.stringify({ prompt, targetTrackCount, idempotencyKey: briefKey }),
  }, briefCookie);
  briefCookie = briefStart.cookie;
  const briefRequestId = String(briefStart.payload.requestId ?? "");
  if (!briefRequestId) throw new Error("gênio did not return a brief request ID");
  log("brief_queued", { briefRequestId });

  let briefPayload = briefStart.payload;
  let submittedAnswers = false;
  for (let attempt = 0; briefPayload.status !== "complete" && attempt < 160; attempt += 1) {
    if (briefPayload.status === "failed") throw new Error(String(briefPayload.error ?? "Brief interpretation failed"));
    if (briefPayload.status === "awaiting_answers" && !submittedAnswers) {
      const answers = recommendedGuidanceAnswers(briefPayload);
      const answerKey = `hosted-smoke-answers-${randomUUID()}`;
      const answered = await request(origin, `/api/v1/brief/${encodeURIComponent(briefRequestId)}/answers`, {
        method: "POST",
        headers: { "Idempotency-Key": answerKey },
        body: JSON.stringify({ answers, idempotencyKey: answerKey }),
      }, briefCookie);
      briefCookie = answered.cookie;
      briefPayload = answered.payload;
      submittedAnswers = true;
      log("guidance_answered", { questionCount: answers.length });
      continue;
    }
    await wait(attempt < 20 ? 1_500 : 5_000);
    const briefPoll = await request(origin, `/api/v1/brief/${encodeURIComponent(briefRequestId)}`, {}, briefCookie);
    briefCookie = briefPoll.cookie;
    briefPayload = briefPoll.payload;
  }
  if (briefPayload.status !== "complete" || !briefPayload.brief) {
    throw new Error("Brief interpretation did not finish within the smoke-test window");
  }

  const interpreted = briefPayload.brief as Record<string, unknown>;
  log("brief_confirmed", { estimateUsd: Number(briefPayload.estimateUsd ?? 0), targetSize: targetTrackCount });

  const runKey = `hosted-smoke-run-${randomUUID()}`;
  const runStart = await request(origin, "/api/v1/runs", {
    method: "POST",
    headers: { "Idempotency-Key": runKey },
    // The server rebuilds the exact canonical brief from the stored request.
    // Echo the interpreted brief instead of pretending browser fields such as
    // title or ambiguity acceptance can override server-owned policy.
    body: JSON.stringify({ briefRequestId, brief: interpreted, idempotencyKey: runKey }),
  }, briefCookie);
  const initialRun = asRecord(runStart.payload.run ?? runStart.payload);
  const accessId = String(initialRun.id ?? "");
  const capability = String(runStart.payload.capability ?? runStart.payload.capabilityToken ?? "");
  if (!accessId || !capability) throw new Error("gênio did not return a run access ID and capability");

  const exchanged = await request(origin, "/api/v1/capabilities/exchange", {
    method: "POST",
    body: JSON.stringify({ token: capability }),
  });
  let cookie = exchanged.cookie;
  if (!cookie) throw new Error("gênio did not establish the scoped capability cookie");
  log("run_started", { accessId, status: initialRun.status });

  let run = initialRun;
  for (let attempt = 0; attempt < 480; attempt += 1) {
    if (REVIEW_RUN_STATUSES.has(String(run.status)) || TERMINAL_RUN_STATUSES.has(String(run.status))
      || run.status === "waiting_for_apple_authorization") break;
    if (run.status === "awaiting_budget") {
      throw new Error("A bounded public smoke run unexpectedly stopped for owner budget approval");
    } else {
      await wait(5_000);
    }
    const response = await request(origin, `/api/v1/runs/${encodeURIComponent(accessId)}`, {}, cookie);
    cookie = response.cookie;
    const nextRun = asRecord(response.payload.run ?? response.payload);
    if (nextRun.status !== run.status || nextRun.phase !== run.phase) {
      log("run_progress", {
        status: nextRun.status,
        phase: nextRun.phase,
        candidates: Number(nextRun.candidateCount ?? asRecord(nextRun.coverage).candidateCount ?? 0),
        actualCostUsd: Number(nextRun.actualCostUsd ?? 0),
      });
    }
    run = nextRun;
  }
  if (REVIEW_RUN_STATUSES.has(String(run.status))) {
    throw new Error("Automatic one-command publication unexpectedly stopped for manual review");
  }
  if (run.status === "waiting_for_apple_authorization") {
    throw new Error("Apple Music owner authorization is not currently valid");
  }
  const resultResponse = await request(origin, `/api/v1/runs/${encodeURIComponent(accessId)}/result`, {}, cookie);
  const result = resultResponse.payload;
  log("smoke_complete", {
    accessId,
    status: run.status,
    error: run.error ?? result.error ?? null,
    volumes: Array.isArray(result.volumes)
      ? result.volumes.map((volume) => {
        const row = asRecord(volume);
        return {
          index: row.index ?? row.volumeNumber,
          playlistId: row.playlistId ?? row.applePlaylistId,
          shareUrl: row.shareUrl ?? row.appleShareUrl ?? null,
          appendedCount: row.appendedCount,
          status: row.status,
        };
      })
      : [],
  });
  if (!TERMINAL_RUN_STATUSES.has(String(run.status))) {
    throw new Error(`Publication did not reach a terminal status; final status was ${String(run.status)}`);
  }
  assertHostedPublication(run, result, targetTrackCount);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "hosted_publication_smoke_failed",
      message: error instanceof Error ? error.message : "Hosted publication smoke test failed",
    })}\n`);
    process.exitCode = 1;
  });
}
