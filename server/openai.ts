import { createHash, randomUUID } from "node:crypto";
import type { PlaylistBrief } from "../shared/types.ts";
import { normalizeBriefTarget, preserveExplicitTrackCount } from "./brief-policy.ts";
import { normalizePlaylistTitle, PLAYLIST_TITLE_MAX_LENGTH } from "./playlist-title.ts";
import { requireSecret } from "./secrets.ts";
import { readCostConfiguration, readOpenAITokenPricing } from "./cost-config.ts";
import { boundedResponseText } from "./bounded-response.ts";

const OPENAI_BASE = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface ProviderUsageEvent {
  provider: "openai";
  operation: string;
  runId?: string;
  requestId?: string;
  responseId?: string;
  usage: Record<string, unknown>;
  costUsd: number;
}

export interface OpenAIRequestContext {
  operation?: string;
  runId?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  onUsage?: (event: ProviderUsageEvent) => void | Promise<void>;
}

export class ProviderRequestError extends Error {
  readonly name = "ProviderRequestError";

  constructor(
    message: string,
    readonly provider: string,
    readonly status: number | null,
    readonly retriable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error("Request aborted"));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("Request aborted"));
  }, { once: true });
});

function retryDelay(response: Response | null, attempt: number): number {
  const header = response?.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1_000, 250), 15_000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 250), 15_000);
  }
  return Math.min(500 * 2 ** attempt + Math.floor(Math.random() * 250), 8_000);
}

async function boundedJson(response: Response): Promise<any> {
  const text = await boundedResponseText(
    response,
    MAX_RESPONSE_BYTES,
    "OpenAI response exceeded the configured size limit",
  );
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error("OpenAI returned malformed JSON"); }
}

function combinedSignal(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Number(process.env.OPENAI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS));
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

async function openAIRequest(
  path: string,
  init: RequestInit,
  context: OpenAIRequestContext = {},
): Promise<{ payload: any; requestId?: string }> {
  const apiKey = requireSecret("OPENAI_API_KEY");
  const idempotencyKey = context.idempotencyKey ?? randomUUID();
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await fetch(`${OPENAI_BASE}${path}`, {
        ...init,
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          ...(init.headers ?? {}),
        },
        signal: combinedSignal(context.signal),
      });
      const payload = await boundedJson(response);
      if (response.ok) return { payload, requestId: response.headers.get("x-request-id") ?? undefined };

      const message = payload.error?.message ?? `OpenAI request failed (${response.status})`;
      const retriable = response.status === 429 || response.status >= 500;
      const error = new ProviderRequestError(message, "openai", response.status, retriable, retriable ? retryDelay(response, attempt) : null);
      if (!retriable || attempt === 2) throw error;
      lastError = error;
      await wait(error.retryAfterMs!, context.signal);
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        if (!error.retriable || attempt === 2) throw error;
        lastError = error;
        continue;
      }
      if (context.signal?.aborted) throw context.signal.reason ?? error;
      lastError = error;
      if (attempt === 2) {
        throw new ProviderRequestError("OpenAI could not be reached after three attempts", "openai", null, true);
      }
      await wait(retryDelay(response, attempt), context.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("OpenAI request failed");
}

/** Retained for health checks; production always uses OPENAI_API_KEY. */
export async function validateOpenAIKey(apiKey = requireSecret("OPENAI_API_KEY")): Promise<void> {
  const response = await fetch(`${OPENAI_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new ProviderRequestError(
      response.status === 401 ? "OpenAI rejected the service API key" : `OpenAI connection failed (${response.status})`,
      "openai",
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }
}

export function extractOutputText(response: any): string {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new Error("OpenAI returned no text output");
}

export async function createOpenAIResponse(body: Record<string, unknown>, context: OpenAIRequestContext = {}): Promise<any> {
  const { payload, requestId } = await openAIRequest("/responses", {
    method: "POST",
    body: JSON.stringify(body),
  }, context);
  if (context.onUsage) {
    await context.onUsage({
      provider: "openai",
      operation: context.operation ?? "responses.create",
      runId: context.runId,
      requestId,
      responseId: payload.id,
      usage: payload.usage ?? {},
      costUsd: responseCostUsd(payload),
    });
  }
  return payload;
}

const briefSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: PLAYLIST_TITLE_MAX_LENGTH,
      description: "A concise Apple Music playlist name, not a restatement of the request.",
    },
    description: { type: "string" },
    mode: { type: "string", enum: ["exhaustive", "curated", "hybrid"] },
    subjectEntities: { type: "array", items: { type: "string" } },
    relationship: { type: "string" },
    include: { type: "array", items: { type: "string" } },
    exclude: { type: "array", items: { type: "string" } },
    versionPolicy: { type: "string" },
    evidencePolicy: { type: "string" },
    orderingPolicy: { type: "string" },
    targetSize: {
      anyOf: [
        { type: "null" },
        { type: "object", additionalProperties: false, properties: { min: { type: "integer", minimum: 1, maximum: 10_000 }, max: { type: "integer", minimum: 1, maximum: 10_000 } }, required: ["min", "max"] },
      ],
    },
    ambiguities: { type: "array", items: { type: "string" } },
  },
  required: ["title", "description", "mode", "subjectEntities", "relationship", "include", "exclude", "versionPolicy", "evidencePolicy", "orderingPolicy", "targetSize", "ambiguities"],
};

function validatedBrief(value: unknown): PlaylistBrief {
  if (!value || typeof value !== "object") throw new Error("OpenAI returned an invalid playlist brief");
  const raw = value as Record<string, unknown>;
  if (!(["exhaustive", "curated", "hybrid"] as unknown[]).includes(raw.mode)) throw new Error("OpenAI returned an invalid playlist mode");
  const string = (key: string, max: number): string => {
    const result = typeof raw[key] === "string" ? raw[key].trim().slice(0, max) : "";
    if (!result) throw new Error(`OpenAI returned an invalid ${key}`);
    return result;
  };
  const strings = (key: string, maxItems: number): string[] => {
    if (!Array.isArray(raw[key])) throw new Error(`OpenAI returned an invalid ${key}`);
    return (raw[key] as unknown[]).slice(0, maxItems).filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 240)).filter(Boolean);
  };
  if (!Object.hasOwn(raw, "targetSize")) throw new Error("OpenAI returned a playlist brief without target size");
  let targetSize: PlaylistBrief["targetSize"] = null;
  if (raw.targetSize !== null) {
    const target = raw.targetSize as { min?: unknown; max?: unknown };
    if (!Number.isInteger(target?.min) || !Number.isInteger(target?.max)) throw new Error("OpenAI returned an invalid target size");
    const min = Number(target.min);
    const max = Number(target.max);
    if (min < 1 || max < min || max > 10_000) throw new Error("OpenAI returned an invalid target size range");
    targetSize = { min, max };
  }
  const mode = raw.mode as PlaylistBrief["mode"];
  const subjectEntities = strings("subjectEntities", 25);
  if (subjectEntities.length === 0) throw new Error("OpenAI returned a playlist brief without a subject entity");
  const relationship = string("relationship", 500);
  const normalizedTarget = normalizeBriefTarget(mode, targetSize);
  return {
    title: string("title", 1_000),
    description: string("description", 1_000),
    mode,
    subjectEntities,
    relationship,
    include: strings("include", 50),
    exclude: strings("exclude", 50),
    versionPolicy: string("versionPolicy", 500),
    evidencePolicy: string("evidencePolicy", 500),
    orderingPolicy: string("orderingPolicy", 500),
    targetSize: normalizedTarget,
    ambiguities: strings("ambiguities", 25),
  };
}

export async function interpretPrompt(
  prompt: string,
  model: string,
  context: OpenAIRequestContext = {},
): Promise<{ brief: PlaylistBrief; usage: any; costUsd: number }> {
  const stableKey = context.idempotencyKey ?? createHash("sha256").update(`brief:${model}:${prompt}`).digest("hex");
  const response = await createOpenAIResponse({
    model,
    reasoning: { effort: "none" },
    max_output_tokens: 1_200,
    instructions: "Convert a playlist request into a neutral research brief. Use exhaustive only for factual enumeration, curated for subjective or ranked requests such as most influential, best, essential, or representative, and hybrid for constrained factual enumeration. A requested number does not make an editorial ranking exhaustive. Never invent artist-specific rules. Default subjective playlists to 50-100 tracks. Set title to a short, specific Apple Music playlist name of at most 60 characters, not a restatement of the request: remove command phrases such as 'give me' or 'create a playlist of', prefer the key artist, topic, or scene plus a compact qualifier, and include a requested count only when it helps distinguish the playlist. Preserve the complete requested scope in description and the structured scope fields. Explicitly surface only ambiguity that materially changes scope.",
    input: prompt.slice(0, 4_000),
    text: { format: { type: "json_schema", name: "playlist_brief", strict: true, schema: briefSchema } },
  }, { ...context, operation: context.operation ?? "brief.interpret", idempotencyKey: stableKey });
  const scopedBrief = preserveExplicitTrackCount(
    prompt,
    validatedBrief(JSON.parse(extractOutputText(response))),
  );
  const brief = {
    ...scopedBrief,
    title: normalizePlaylistTitle(scopedBrief.title, scopedBrief),
  };
  return { brief, usage: response.usage ?? {}, costUsd: responseCostUsd(response) };
}

export function responseCostUsd(response: any): number {
  const input = Number(response.usage?.input_tokens ?? 0);
  const output = Number(response.usage?.output_tokens ?? 0);
  const webCalls = (response.output ?? []).filter((item: any) => item.type === "web_search_call").length;
  if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
    throw new Error("OpenAI returned invalid usage accounting");
  }
  const pricing = readCostConfiguration();
  const tokenPricing = readOpenAITokenPricing(typeof response.model === "string" ? response.model : "");
  return input / 1_000_000 * tokenPricing.inputUsdPerMillion
    + output / 1_000_000 * tokenPricing.outputUsdPerMillion
    + webCalls * pricing.openAIWebSearchUsd;
}
