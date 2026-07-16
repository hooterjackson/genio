import { createHash, randomUUID } from "node:crypto";
import type {
  PlaylistBrief,
  PlaylistGuidanceAnswer,
  PlaylistGuidanceQuestion,
} from "../shared/types.ts";
import { normalizeBriefTarget, preserveExplicitTrackCount } from "./brief-policy.ts";
import { normalizePlaylistTitle, PLAYLIST_TITLE_MAX_LENGTH } from "./playlist-title.ts";
import { requireSecret } from "./secrets.ts";
import {
  openAIContextPriceMultipliers,
  readCostConfiguration,
  readOpenAITokenPricing,
} from "./cost-config.ts";
import { boundedResponseText } from "./bounded-response.ts";
import { applySimilaritySeedPolicy } from "./similarity-policy.ts";

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

const guidanceOptionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string", minLength: 1, maxLength: 60 },
    description: { type: "string", minLength: 1, maxLength: 180 },
  },
  required: ["label", "description"],
};

const guidanceQuestionProperties = {
  header: { type: "string", minLength: 1, maxLength: 28 },
  question: { type: "string", minLength: 1, maxLength: 180 },
  options: {
    type: "array",
    minItems: 3,
    maxItems: 3,
    items: guidanceOptionSchema,
  },
};

const preflightSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    brief: briefSchema,
    scopeQuestions: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: {
            type: "string",
            enum: ["selection_scope", "era", "mood", "versions", "geography", "familiarity", "energy"],
          },
          ...guidanceQuestionProperties,
        },
        required: ["category", "header", "question", "options"],
      },
    },
    flowQuestion: {
      type: "object",
      additionalProperties: false,
      properties: guidanceQuestionProperties,
      required: ["header", "question", "options"],
    },
  },
  required: ["brief", "scopeQuestions", "flowQuestion"],
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

function boundedGuidanceText(value: unknown, label: string, maximum: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || Array.from(text).length > maximum) {
    throw new Error(`OpenAI returned an invalid guided ${label}`);
  }
  return text;
}

type GuidanceCategory =
  | "selection_scope"
  | "era"
  | "mood"
  | "versions"
  | "geography"
  | "familiarity"
  | "energy";

type GuidanceOrderingBehavior = "smooth" | "contrast" | "chronological" | "editorial";

const GUIDANCE_STOP_WORDS = new Set([
  "about",
  "after",
  "along",
  "also",
  "beginning",
  "before",
  "choice",
  "choose",
  "create",
  "from",
  "give",
  "into",
  "lead",
  "make",
  "music",
  "option",
  "playlist",
  "recording",
  "recordings",
  "selection",
  "should",
  "song",
  "songs",
  "track",
  "tracks",
  "what",
  "which",
  "with",
  "would",
  "your",
]);

function guidanceTokens(value: string): Set<string> {
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase();
  return new Set(
    normalized
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 3 && !/^\d+$/u.test(token) && !GUIDANCE_STOP_WORDS.has(token)),
  );
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = guidanceTokens(left);
  const rightTokens = guidanceTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function guidanceOrderingBehavior(value: string): GuidanceOrderingBehavior | null {
  if (/\b(?:chronolog|release\s+(?:date|year)|by\s+year|through\s+time)\b/iu.test(value)) {
    return "chronological";
  }
  if (/\b(?:rank|editorial|historical\s+impact|influence\s+order)\b/iu.test(value)) {
    return "editorial";
  }
  if (/\b(?:contrast|surpris|eclectic|zig\s*zag|sharp\s+shift)\b/iu.test(value)) {
    return "contrast";
  }
  if (/\b(?:smooth|cohesive|gradual|gentle\s+arc|compatible\s+metadata)\b/iu.test(value)) {
    return "smooth";
  }
  return null;
}

function guidanceCategoryAlreadySpecified(category: GuidanceCategory, prompt: string): boolean {
  const checks: Record<GuidanceCategory, RegExp> = {
    selection_scope: /\b(?:commercial|chart|critical(?:ly)?|historical\s+(?:impact|importance)|cultural\s+impact|innovation|scene\s+foundation)\b/iu,
    era: /\b(?:(?:19|20)\d{2}s?|['’]\d{2}s|early|mid|late)[ -]?(?:\d{2}s|century|era)?\b|\b(?:classic|current|modern|recent|contemporary)\b/iu,
    mood: /\b(?:mood|vibe|rainy|romantic|melanchol|happy|sad|dark|dreamy|relax|atmospher)\w*\b/iu,
    versions: /\b(?:album|single|studio|live|remix(?:es)?|edit(?:s)?|original|alternate|acoustic|demo)\s+(?:cut|mix|recording|release|version)?s?\b/iu,
    geography: /\b(?:berlin|detroit|chicago|brazil(?:ian)?|german(?:y)?|uk|british|japan(?:ese)?|new\s+york|los\s+angeles|west\s+coast|east\s+coast)\b/iu,
    familiarity: /\b(?:hit|famous|popular|mainstream|underground|obscure|deep\s+cut|discovery|discoveries|essential|canonical)\w*\b/iu,
    energy: /\b(?:energy|energetic|mellow|calm|upbeat|dancefloor|ambient|intense|driving|peak[- ]time)\b/iu,
  };
  return checks[category].test(prompt);
}

function isTrackCountQuestion(value: string): boolean {
  return /\b(?:how\s+(?:many|long|large)|number\s+of|track\s*count|song\s*count|playlist\s+(?:length|size)|target\s+(?:length|size)|\d{1,4}\s*(?:songs?|tracks?|recordings?))\b/iu.test(value);
}

function questionIsPromptSpecific(
  question: string,
  header: string,
  prompt: string,
  brief: PlaylistBrief,
): boolean {
  const questionTokens = guidanceTokens(`${header} ${question}`);
  const contextTokens = guidanceTokens(`${prompt} ${brief.subjectEntities.join(" ")}`);
  for (const token of questionTokens) {
    if (contextTokens.has(token)) return true;
  }
  return false;
}

function compactGuidanceSubject(brief: PlaylistBrief): string {
  const source = brief.subjectEntities.slice(0, 2).join(" and ").replace(/\s+/gu, " ").trim()
    || "this playlist";
  const characters = Array.from(source);
  return characters.length <= 72 ? source : `${characters.slice(0, 69).join("").trim()}…`;
}

function fallbackScopeQuestion(
  prompt: string,
  brief: PlaylistBrief,
): Omit<PlaylistGuidanceQuestion, "id"> {
  const subject = compactGuidanceSubject(brief);
  const similarityRequest = /\b(?:sounds?\s+like|similar\s+to|artists?\s+like|for\s+fans?\s+of|in\s+the\s+style\s+of)\b/iu.test(prompt);
  const influenceRequest = /\b(?:influential|important|essential|definitive|best|greatest)\b/iu.test(prompt);
  const factualCredits = brief.mode !== "curated"
    || /\b(?:performed|played|credited|discograph|catalog|every|all)\w*\b/iu.test(prompt);

  if (similarityRequest && !guidanceCategoryAlreadySpecified("familiarity", prompt)) {
    return {
      header: "Similarity",
      question: `How far should ${subject} reach beyond the reference sound?`,
      options: [
        { id: "", label: "Close matches", description: "Prioritize the strongest sonic and stylistic parallels.", recommended: true },
        { id: "", label: "Balanced discovery", description: "Mix close matches with adjacent artists and scenes.", recommended: false },
        { id: "", label: "Wider orbit", description: "Explore looser connections while preserving the core character.", recommended: false },
      ],
    };
  }

  if (influenceRequest && !guidanceCategoryAlreadySpecified("selection_scope", prompt)) {
    return {
      header: "Influence",
      question: `What kind of influence should matter most for ${subject}?`,
      options: [
        { id: "", label: "Lasting impact", description: "Balance innovation, historical importance, and later influence.", recommended: true },
        { id: "", label: "Scene foundations", description: "Favor recordings that shaped the originating artists and scene.", recommended: false },
        { id: "", label: "Cultural reach", description: "Favor recordings whose impact traveled beyond the original scene.", recommended: false },
      ],
    };
  }

  if (factualCredits && !guidanceCategoryAlreadySpecified("versions", prompt)) {
    return {
      header: "Versions",
      question: `Which released versions should represent ${subject}?`,
      options: [
        { id: "", label: "Canonical releases", description: "Use one principal released recording of each song.", recommended: true },
        { id: "", label: "Distinct versions", description: "Include materially different released versions when separately supported.", recommended: false },
        { id: "", label: "Expanded releases", description: "Also consider supported live, remix, and alternate releases.", recommended: false },
      ],
    };
  }

  if (!guidanceCategoryAlreadySpecified("familiarity", prompt)) {
    return {
      header: "Discovery",
      question: `How familiar should the ${subject} selection feel?`,
      options: [
        { id: "", label: "Known and discovered", description: "Balance defining recordings with well-supported discoveries.", recommended: true },
        { id: "", label: "Defining tracks", description: "Favor established, widely recognized recordings.", recommended: false },
        { id: "", label: "Deeper exploration", description: "Favor less obvious recordings without weakening the evidence bar.", recommended: false },
      ],
    };
  }

  return {
    header: "Emphasis",
    question: `What should lead the ${subject} selection?`,
    options: [
      { id: "", label: "Balanced view", description: "Balance historical relevance, musical fit, and variety.", recommended: true },
      { id: "", label: "Historical weight", description: "Favor documented importance and lasting influence.", recommended: false },
      { id: "", label: "Musical range", description: "Favor stylistic breadth within the confirmed request.", recommended: false },
    ],
  };
}

function fallbackGuidanceQuestions(prompt: string, brief: PlaylistBrief): PlaylistGuidanceQuestion[] {
  const subject = compactGuidanceSubject(brief);
  const scope = fallbackScopeQuestion(prompt, brief);
  const editorialThird = /\b(?:influential|important|essential|definitive|best|greatest)\b/iu.test(prompt);
  const flow: Omit<PlaylistGuidanceQuestion, "id"> = {
    header: "Flow",
    question: `How should ${subject} move from track to track?`,
    options: [
      {
        id: "",
        label: "Smooth arc",
        description: "Intermix artists and albums while favoring compatible metadata.",
        recommended: true,
      },
      {
        id: "",
        label: "Contrasting arc",
        description: "Intermix artists and albums while favoring deliberate contrast.",
        recommended: false,
      },
      editorialThird
        ? {
            id: "",
            label: "Influence first",
            description: "Follow the editorial research rank from most to least influential.",
            recommended: false,
          }
        : {
            id: "",
            label: "Chronological arc",
            description: "Order the recordings chronologically by release year.",
            recommended: false,
          },
    ],
  };
  return [scope, flow].map((question, questionIndex) => {
    const questionId = `q${questionIndex + 1}`;
    return {
      ...question,
      id: questionId,
      options: question.options.map((option, optionIndex) => ({
        ...option,
        id: `${questionId}-o${optionIndex + 1}`,
        recommended: optionIndex === 0,
      })),
    };
  });
}

function strictlyValidatedGuidanceQuestions(
  value: unknown,
  prompt: string,
  brief: PlaylistBrief,
): PlaylistGuidanceQuestion[] {
  if (!value || typeof value !== "object") throw new Error("OpenAI returned invalid guided questions");
  const raw = value as Record<string, unknown>;
  const scopeQuestions = raw.scopeQuestions;
  if (!Array.isArray(scopeQuestions) || scopeQuestions.length < 1 || scopeQuestions.length > 2) {
    throw new Error("OpenAI returned an invalid number of guided scope questions");
  }
  const scopeCategories = new Set<string>();
  const rawQuestions = [...scopeQuestions, raw.flowQuestion] as unknown[];
  const questions = rawQuestions.map((candidate, questionIndex): PlaylistGuidanceQuestion => {
    if (!candidate || typeof candidate !== "object") throw new Error("OpenAI returned an invalid guided question");
    const question = candidate as Record<string, unknown>;
    if (questionIndex < scopeQuestions.length) {
      const category = boundedGuidanceText(question.category, "question category", 40);
      if (scopeCategories.has(category)) throw new Error("OpenAI returned overlapping guided questions");
      if (guidanceCategoryAlreadySpecified(category as GuidanceCategory, prompt)) {
        throw new Error("OpenAI returned a guided question already answered by the request");
      }
      scopeCategories.add(category);
    }
    const questionPrompt = boundedGuidanceText(question.question, "question", 180);
    const header = boundedGuidanceText(question.header, "question header", 28);
    if (isTrackCountQuestion(`${header} ${questionPrompt}`)) {
      throw new Error("OpenAI returned a track-count guidance question");
    }
    if (
      questionIndex < scopeQuestions.length
      && /\b(?:flow|order|sequence|from\s+(?:start|beginning)\s+to\s+(?:finish|end)|track\s+to\s+track)\b/iu.test(`${header} ${questionPrompt}`)
    ) {
      throw new Error("OpenAI returned more than one guided flow question");
    }
    if (!questionIsPromptSpecific(questionPrompt, header, prompt, brief)) {
      throw new Error("OpenAI returned a generic guided question");
    }
    if (!Array.isArray(question.options) || question.options.length !== 3) {
      throw new Error("OpenAI returned an invalid number of guided options");
    }
    const optionLabels = new Set<string>();
    const optionTexts: string[] = [];
    const questionId = `q${questionIndex + 1}`;
    const options = question.options.map((candidateOption, optionIndex) => {
      if (!candidateOption || typeof candidateOption !== "object") throw new Error("OpenAI returned an invalid guided option");
      const option = candidateOption as Record<string, unknown>;
      const label = boundedGuidanceText(option.label, "option label", 60);
      const normalizedLabel = label.toLocaleLowerCase();
      if (optionLabels.has(normalizedLabel)) throw new Error("OpenAI returned duplicate guided options");
      optionLabels.add(normalizedLabel);
      const description = boundedGuidanceText(option.description, "option description", 180);
      const optionText = `${label} ${description}`;
      if (optionTexts.some((existing) => tokenSimilarity(existing, optionText) >= 0.72)) {
        throw new Error("OpenAI returned overlapping guided options");
      }
      optionTexts.push(optionText);
      return {
        id: `${questionId}-o${optionIndex + 1}`,
        label,
        description,
        recommended: optionIndex === 0,
      };
    });
    if (questionIndex === rawQuestions.length - 1) {
      const behaviors = options.map((option) =>
        guidanceOrderingBehavior(`${option.label}: ${option.description}`));
      if (behaviors.some((behavior) => behavior === null) || new Set(behaviors).size !== 3) {
        throw new Error("OpenAI returned unsupported or overlapping guided flow options");
      }
    }
    return {
      id: questionId,
      header,
      question: questionPrompt,
      options,
    };
  });
  for (const [questionIndex, question] of questions.entries()) {
    if (questions.slice(0, questionIndex).some((existing) =>
      tokenSimilarity(`${existing.header} ${existing.question}`, `${question.header} ${question.question}`) >= 0.72)) {
      throw new Error("OpenAI returned overlapping guided questions");
    }
  }
  return questions;
}

function validatedGuidanceQuestions(
  value: unknown,
  prompt: string,
  brief: PlaylistBrief,
): PlaylistGuidanceQuestion[] {
  try {
    return strictlyValidatedGuidanceQuestions(value, prompt, brief);
  } catch {
    return fallbackGuidanceQuestions(prompt, brief);
  }
}

function uniqueGuidanceRules(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeGuidancePreference(value: string, custom: boolean): string | null {
  const text = value.trim().replace(/\s+/gu, " ").slice(0, 500);
  if (!text) return null;
  if (custom && (
    /\b(?:ignore|disregard|override|forget|replace|change|instead|system\s+prompt|developer\s+message|research\s+(?:a|an|the)?|return\s+only)\b/iu.test(text)
    || /\b\d{2,5}\s*(?:songs?|tracks?|recordings?)\b/iu.test(text)
  )) {
    return null;
  }
  return text;
}

function guidanceOrderingPolicy(
  questions: readonly PlaylistGuidanceQuestion[],
  answers: readonly PlaylistGuidanceAnswer[],
  fallback: string,
): string {
  const flowQuestion = questions.at(-1);
  if (!flowQuestion) return fallback;
  const answer = answers.find((item) => item.questionId === flowQuestion.id);
  const option = flowQuestion.options.find((item) => item.id === answer?.optionId);
  const preference = safeGuidancePreference(
    option ? `${option.label}: ${option.description}` : answer?.customText ?? "",
    !option,
  );
  if (!preference) return fallback;
  const behavior = guidanceOrderingBehavior(preference);
  if (behavior === "chronological") return "chronological by release year";
  if (behavior === "editorial") return "editorial progression by research rank";
  if (behavior === "contrast") return "high-contrast metadata-aware flow with artist and album intermixing";
  if (behavior === "smooth") return "smooth metadata-aware flow with artist and album intermixing";
  if (/\b(?:alphabet|by\s+title|title\s+order)\b/iu.test(preference)) return "alphabetical by title";
  return fallback;
}

/**
 * Guided answers may tune a confirmed brief but can never replace its
 * foundational subject, factual relationship, evidence boundary, version
 * scope, workload class, or exact size. Model output is deliberately treated
 * as a suggestion; only bounded preference directives and an implemented
 * ordering strategy cross this trust boundary.
 */
function safelyApplyGuidance(
  input: {
    brief: PlaylistBrief;
    questions: PlaylistGuidanceQuestion[];
    answers: PlaylistGuidanceAnswer[];
  },
): PlaylistBrief {
  const scopeDirectives: string[] = [];
  for (const question of input.questions.slice(0, -1)) {
    const answer = input.answers.find((item) => item.questionId === question.id);
    const option = question.options.find((item) => item.id === answer?.optionId);
    const preference = safeGuidancePreference(
      option ? `${option.label}: ${option.description}` : answer?.customText ?? "",
      !option,
    );
    if (!preference) continue;
    scopeDirectives.push(
      `Guided ${question.header.toLocaleLowerCase()} preference within the confirmed scope: ${preference}`,
    );
  }
  return {
    ...input.brief,
    include: uniqueGuidanceRules([...input.brief.include, ...scopeDirectives]),
    exclude: [...input.brief.exclude],
    orderingPolicy: guidanceOrderingPolicy(
      input.questions,
      input.answers,
      input.brief.orderingPolicy,
    ),
    subjectEntities: [...input.brief.subjectEntities],
    targetSize: input.brief.targetSize ? { ...input.brief.targetSize } : null,
    ambiguities: [...input.brief.ambiguities],
    ...(input.brief.ambiguityAcceptance
      ? { ambiguityAcceptance: [...input.brief.ambiguityAcceptance] }
      : {}),
  };
}

const BRIEF_INTERPRETATION_INSTRUCTIONS = "Convert a playlist request into a neutral research brief. Use exhaustive only for factual enumeration, curated for subjective or ranked requests such as most influential, best, essential, representative, or music similar to a reference artist, and hybrid for constrained factual enumeration. A requested number does not make an editorial ranking exhaustive. Never invent artist-specific rules. For requests such as 'sounds like X', 'similar to X', 'artists like X', or 'for fans of X', treat X as a style reference rather than the requested recording artist: select tracks by other artists and exclude recordings by X unless the requester explicitly asks to include X. Do not apply this reference-artist rule to requests for X's own songs, discography, credits, or exhaustive catalog. Default subjective playlists to 50-100 tracks. Set title to a short, specific Apple Music playlist name of at most 60 characters, not a restatement of the request: remove command phrases such as 'give me' or 'create a playlist of', prefer the key artist, topic, or scene plus a compact qualifier, and include a requested count only when it helps distinguish the playlist. Preserve the complete requested scope in description and the structured scope fields. Explicitly surface only ambiguity that materially changes scope.";

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
    instructions: BRIEF_INTERPRETATION_INSTRUCTIONS,
    input: prompt.slice(0, 4_000),
    text: { format: { type: "json_schema", name: "playlist_brief", strict: true, schema: briefSchema } },
  }, { ...context, operation: context.operation ?? "brief.interpret", idempotencyKey: stableKey });
  const countScopedBrief = preserveExplicitTrackCount(
    prompt,
    validatedBrief(JSON.parse(extractOutputText(response))),
  );
  const scopedBrief = applySimilaritySeedPolicy(prompt, countScopedBrief);
  const brief = {
    ...scopedBrief,
    title: normalizePlaylistTitle(scopedBrief.title, scopedBrief),
  };
  return { brief, usage: response.usage ?? {}, costUsd: responseCostUsd(response) };
}

export async function interpretPromptWithGuidance(
  prompt: string,
  model: string,
  context: OpenAIRequestContext = {},
): Promise<{ brief: PlaylistBrief; questions: PlaylistGuidanceQuestion[]; usage: any; costUsd: number }> {
  const stableKey = context.idempotencyKey
    ?? createHash("sha256").update(`brief-guided:${model}:${prompt}`).digest("hex");
  const response = await createOpenAIResponse({
    model,
    reasoning: { effort: "none" },
    max_output_tokens: 2_000,
    instructions: `${BRIEF_INTERPRETATION_INSTRUCTIONS}

In the same response, create exactly two or three concise guided questions that materially improve this specific playlist. Generate one or two non-overlapping scope questions plus exactly one playlist-flow question. Each question must have exactly three mutually exclusive options. Put the broadly best default first; the client labels it recommended. Do not ask for track count. Do not ask for information already explicit in the request. Do not ask generic filler questions. The required flow question must choose among implemented behaviors: smooth metadata-aware artist/album intermixing, high-contrast metadata-aware intermixing, chronological release order, or editorial research-rank progression. Adapt the labels and descriptions to the request, choose three distinct behaviors, and never claim BPM or harmonic-key analysis unless that metadata is available. Keep labels short enough for a mobile choice card. A visitor may also type a custom fourth answer, so the three supplied choices should cover distinct useful defaults.`,
    input: prompt.slice(0, 4_000),
    text: { format: { type: "json_schema", name: "guided_playlist_preflight", strict: true, schema: preflightSchema } },
  }, { ...context, operation: context.operation ?? "brief.preflight", idempotencyKey: stableKey });
  const parsed = JSON.parse(extractOutputText(response)) as Record<string, unknown>;
  const countScopedBrief = preserveExplicitTrackCount(prompt, validatedBrief(parsed.brief));
  const scopedBrief = applySimilaritySeedPolicy(prompt, countScopedBrief);
  const brief = {
    ...scopedBrief,
    title: normalizePlaylistTitle(scopedBrief.title, scopedBrief),
  };
  return {
    brief,
    questions: validatedGuidanceQuestions(parsed, prompt, brief),
    usage: response.usage ?? {},
    costUsd: responseCostUsd(response),
  };
}

export async function refineBriefWithGuidance(
  input: {
    prompt: string;
    brief: PlaylistBrief;
    questions: PlaylistGuidanceQuestion[];
    answers: PlaylistGuidanceAnswer[];
  },
): Promise<{ brief: PlaylistBrief; usage: any; costUsd: number }> {
  // The preflight model already generated the prompt-specific choices. Once
  // the visitor answers, an allowlisted deterministic merge is both safer and
  // faster than paying for a second model to regenerate the same brief.
  // Custom scope text becomes a bounded research directive; custom flow text
  // affects ordering only when it maps to an implemented behavior.
  const guidedBrief = safelyApplyGuidance(input);
  const countScopedBrief = preserveExplicitTrackCount(input.prompt, guidedBrief);
  const scopedBrief = applySimilaritySeedPolicy(input.prompt, countScopedBrief);
  const brief = {
    ...scopedBrief,
    title: normalizePlaylistTitle(scopedBrief.title, scopedBrief),
  };
  return { brief, usage: {}, costUsd: 0 };
}

export function responseCostUsd(response: any): number {
  const input = Number(response.usage?.input_tokens ?? 0);
  const cachedInput = Number(response.usage?.input_tokens_details?.cached_tokens ?? 0);
  const output = Number(response.usage?.output_tokens ?? 0);
  const webCalls = (response.output ?? []).filter((item: any) => item.type === "web_search_call").length;
  if (
    !Number.isFinite(input)
    || input < 0
    || !Number.isFinite(cachedInput)
    || cachedInput < 0
    || cachedInput > input
    || !Number.isFinite(output)
    || output < 0
  ) {
    throw new Error("OpenAI returned invalid usage accounting");
  }
  const pricing = readCostConfiguration();
  const model = typeof response.model === "string" ? response.model : "";
  const tokenPricing = readOpenAITokenPricing(model);
  const multipliers = openAIContextPriceMultipliers(model, input);
  const uncachedInput = input - cachedInput;
  return (
    uncachedInput / 1_000_000 * tokenPricing.inputUsdPerMillion
      + cachedInput / 1_000_000 * tokenPricing.cachedInputUsdPerMillion
  ) * multipliers.input
    + output / 1_000_000 * tokenPricing.outputUsdPerMillion * multipliers.output
    + webCalls * pricing.openAIWebSearchUsd;
}
