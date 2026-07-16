import { randomUUID } from "node:crypto";

const CONFIRMATION_FLAG = "--confirm-live-write";
const DEFAULT_ORIGIN = "https://9enio.com";
const TERMINAL_RUN_STATUSES = new Set(["complete", "partial", "failed", "expired", "deleted"]);
const REVIEW_RUN_STATUSES = new Set(["review", "visitor_review"]);
const DEFAULT_TRACKS = [
  { artist: "Michael Jackson", title: "Billie Jean" },
  { artist: "Madonna", title: "La Isla Bonita" },
  { artist: "Earth, Wind & Fire", title: "September" },
] as const;

interface SmokeArgs {
  confirmLiveWrite: boolean;
  origin: string;
}

type ApiResponse = Record<string, unknown>;

function asRecord(value: unknown): ApiResponse {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ApiResponse
    : {};
}

function parseArgs(argv: readonly string[]): SmokeArgs {
  let confirmLiveWrite = false;
  let origin = DEFAULT_ORIGIN;
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
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!confirmLiveWrite) throw new Error(`Hosted publication smoke tests require ${CONFIRMATION_FLAG}`);
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("--origin must be an HTTPS origin with no path, query, or credentials");
  }
  return { confirmLiveWrite, origin: parsed.origin };
}

function safeMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const object = payload as Record<string, unknown>;
    if (typeof object.error === "string") return object.error;
    if (typeof object.message === "string") return object.message;
  }
  return `9ênio returned HTTP ${status}`;
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
  const { origin } = parseArgs(process.argv.slice(2));
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
  const prompt = [
    "Build a playlist containing exactly these three original studio recordings, in this order:",
    ...DEFAULT_TRACKS.map((track, index) => `${index + 1}. ${track.artist} — ${track.title}`),
    "Exclude remixes, live versions, radio edits, covers, re-recordings, and duplicates.",
  ].join("\n");

  const briefKey = `hosted-smoke-brief-${randomUUID()}`;
  const briefStart = await request(origin, "/api/v1/brief", {
    method: "POST",
    headers: { "Idempotency-Key": briefKey },
    body: JSON.stringify({ prompt, idempotencyKey: briefKey }),
  });
  const briefRequestId = String(briefStart.payload.requestId ?? "");
  if (!briefRequestId) throw new Error("9ênio did not return a brief request ID");
  log("brief_queued", { briefRequestId });

  let briefPayload = briefStart.payload;
  for (let attempt = 0; !briefPayload.brief && attempt < 120; attempt += 1) {
    if (briefPayload.status === "failed") throw new Error(String(briefPayload.error ?? "Brief interpretation failed"));
    await wait(attempt < 20 ? 1_500 : 5_000);
    briefPayload = (await request(origin, `/api/v1/brief/${encodeURIComponent(briefRequestId)}`)).payload;
  }
  if (!briefPayload.brief) throw new Error("Brief interpretation did not finish within the smoke-test window");

  const interpreted = briefPayload.brief as Record<string, unknown>;
  const ambiguities = Array.isArray(interpreted.ambiguities)
    ? interpreted.ambiguities.filter((item): item is string => typeof item === "string")
    : [];
  const confirmedBrief = {
    ...interpreted,
    title: "[GÊNIO TEST] Hosted three-track flow",
    description: "A production smoke test containing exactly three specified original studio recordings.",
    mode: "hybrid",
    subjectEntities: DEFAULT_TRACKS.map((track) => `${track.artist} — ${track.title}`),
    relationship: "Include each of the three explicitly named artist-recording pairs and no others.",
    include: DEFAULT_TRACKS.map((track) => `${track.artist} — ${track.title}`),
    exclude: ["remixes", "live versions", "radio edits", "covers", "re-recordings", "duplicates"],
    versionPolicy: "Use the original full-length studio recording for each named track.",
    evidencePolicy: "Require stored track-level release evidence and a compatible Apple Music catalog match.",
    orderingPolicy: "Discovery order matching the three-track input sequence.",
    targetSize: { min: 3, max: 3 },
    ambiguities,
    ambiguityAcceptance: ambiguities,
  };
  log("brief_confirmed", { estimateUsd: Number(briefPayload.estimateUsd ?? 0), targetSize: 3 });

  const runKey = `hosted-smoke-run-${randomUUID()}`;
  const runStart = await request(origin, "/api/v1/runs", {
    method: "POST",
    headers: { "Idempotency-Key": runKey },
    body: JSON.stringify({ briefRequestId, brief: confirmedBrief, idempotencyKey: runKey }),
  });
  const initialRun = asRecord(runStart.payload.run ?? runStart.payload);
  const accessId = String(initialRun.id ?? "");
  const capability = String(runStart.payload.capability ?? runStart.payload.capabilityToken ?? "");
  if (!accessId || !capability) throw new Error("9ênio did not return a run access ID and capability");

  const exchanged = await request(origin, "/api/v1/capabilities/exchange", {
    method: "POST",
    body: JSON.stringify({ token: capability }),
  });
  let cookie = exchanged.cookie;
  if (!cookie) throw new Error("9ênio did not establish the scoped capability cookie");
  log("run_started", { accessId, status: initialRun.status });

  let run = initialRun;
  let awaitingBudgetSince: number | null = null;
  for (let attempt = 0; attempt < 360; attempt += 1) {
    if (REVIEW_RUN_STATUSES.has(String(run.status)) || TERMINAL_RUN_STATUSES.has(String(run.status))) break;
    if (run.status === "awaiting_budget") {
      if (awaitingBudgetSince === null) {
        awaitingBudgetSince = Date.now();
        log("awaiting_owner_budget", {
          accessId,
          actualCostUsd: Number(run.actualCostUsd ?? 0),
          approvedBudgetUsd: Number(run.approvedBudgetUsd ?? 0),
        });
      }
      if (Date.now() - awaitingBudgetSince > 30 * 60 * 1_000) {
        throw new Error("The smoke run was not approved within the 30-minute harness window");
      }
      await wait(10_000);
    } else {
      if (awaitingBudgetSince !== null) log("owner_budget_approved", { accessId });
      awaitingBudgetSince = null;
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
  if (!REVIEW_RUN_STATUSES.has(String(run.status))) {
    throw new Error(`Research did not reach review; final status was ${String(run.status)}`);
  }

  const exceptionsResponse = await request(
    origin,
    `/api/v1/runs/${encodeURIComponent(accessId)}/exceptions?page=1&pageSize=20`,
    {},
    cookie,
  );
  cookie = exceptionsResponse.cookie;
  const unresolvedCount = Number(exceptionsResponse.payload.unresolvedCount ?? exceptionsResponse.payload.total ?? 0);
  if (unresolvedCount > 0) {
    const items = Array.isArray(exceptionsResponse.payload.items) ? exceptionsResponse.payload.items : [];
    log("stopped_for_review", {
      accessId,
      unresolvedCount,
      tracks: items.slice(0, 20).map((item) => {
        const row = asRecord(item);
        return { artist: row.artist, title: row.title, status: row.status };
      }),
    });
    throw new Error("The smoke test found ambiguous or unavailable matches and refused to guess");
  }

  const manifestResponse = await request(origin, `/api/v1/runs/${encodeURIComponent(accessId)}/manifest`, {
    method: "POST",
    body: JSON.stringify({ mode: "reviewed" }),
  }, cookie);
  cookie = manifestResponse.cookie;
  const manifest = asRecord(manifestResponse.payload.manifest ?? manifestResponse.payload);
  const tracks = Array.isArray(manifest.tracks) ? manifest.tracks : [];
  if (tracks.length !== 3) throw new Error(`Smoke manifest contains ${tracks.length} tracks instead of 3`);
  log("manifest_locked", {
    manifestId: manifest.id,
    contentHash: manifest.contentHash,
    tracks: tracks.map((track) => {
      const row = asRecord(track);
      return { artist: row.artist, title: row.title, catalogId: row.catalogId };
    }),
  });

  const publicationStart = await request(origin, `/api/v1/runs/${encodeURIComponent(accessId)}/publish`, {
    method: "POST",
    headers: { "Idempotency-Key": `publish-${String(manifest.id)}` },
    body: JSON.stringify({ manifestId: manifest.id }),
  }, cookie);
  cookie = publicationStart.cookie;
  run = asRecord(publicationStart.payload.run ?? publicationStart.payload);
  log("publication_queued", { status: run.status });

  let result: ApiResponse = {};
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await wait(5_000);
    const runResponse = await request(origin, `/api/v1/runs/${encodeURIComponent(accessId)}`, {}, cookie);
    cookie = runResponse.cookie;
    const nextRun = asRecord(runResponse.payload.run ?? runResponse.payload);
    if (nextRun.status !== run.status || nextRun.phase !== run.phase) {
      log("publication_progress", { status: nextRun.status, phase: nextRun.phase });
    }
    run = nextRun;
    if (TERMINAL_RUN_STATUSES.has(String(run.status)) || run.status === "waiting_for_apple_authorization") break;
  }
  const resultResponse = await request(origin, `/api/v1/runs/${encodeURIComponent(accessId)}/result`, {}, cookie);
  result = resultResponse.payload;
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
  if (run.status !== "complete") throw new Error(`Hosted publication smoke test ended with status ${String(run.status)}`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: "hosted_publication_smoke_failed",
    message: error instanceof Error ? error.message : "Hosted publication smoke test failed",
  })}\n`);
  process.exitCode = 1;
});
