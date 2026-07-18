import { afterEach, expect, test, vi } from "vitest";
import {
  interpretPrompt,
  interpretPromptWithGuidance,
  refineBriefWithGuidance,
  scoutPlaylistGuidance,
} from "../server/openai.ts";
import { canonicalBriefForRequest, estimateResearchCost } from "../server/brief-policy.ts";
import { researchExecutionPolicy } from "../server/research-policy.ts";
import type {
  PlaylistBrief,
  PlaylistGuidanceQuestion,
} from "../shared/types.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const guidedDraftBrief: PlaylistBrief = {
  title: "Rainy Night",
  description: "A focused rainy-night listening sequence.",
  mode: "curated",
  subjectEntities: ["rainy-night music"],
  relationship: "fits the requested listening context",
  include: ["released recordings"],
  exclude: ["unsupported selections"],
  versionPolicy: "one canonical recording",
  evidencePolicy: "cited editorial sources",
  orderingPolicy: "editorial flow",
  targetSize: { min: 50, max: 50 },
  ambiguities: [],
};

function hostedResponse(output: unknown, id = "response-guided", model = "gpt-5.4-mini"): Response {
  return new Response(JSON.stringify({
    id,
    model,
    usage: { input_tokens: 100, output_tokens: 100 },
    output_text: JSON.stringify(output),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function groundedScoutQuestion(input: {
  decisionKey: string;
  subject: string;
  sourceUrl: string;
  effectKind?: "research_preference" | "version_preference" | "familiarity_bias" | "subscene_focus";
}) {
  const effectKind = input.effectKind ?? "subscene_focus";
  return {
    decisionKey: input.decisionKey,
    header: "DOCUMENTED FORK",
    question: `Which documented ${input.subject} branch should carry the most weight?`,
    whyMaterial: `The documented branches of ${input.subject} lead to materially different recordings and candidate pools.`,
    groundingSummary: `The provider-attested source documents a real historical split within ${input.subject}.`,
    sourceUrls: [input.sourceUrl],
    options: [
      {
        label: "Foundations",
        description: "Prioritize formative recordings and the earliest documented network.",
        effect: { kind: effectKind, value: `prioritize formative ${input.subject} recordings`, orderingBehavior: null },
      },
      {
        label: "Turning points",
        description: "Emphasize later breakthroughs that changed the documented field.",
        effect: { kind: effectKind, value: `prioritize breakthrough ${input.subject} recordings`, orderingBehavior: null },
      },
      {
        label: "Deep branches",
        description: "Favor well-supported but less canonical branches of the subject.",
        effect: { kind: effectKind, value: `prioritize less canonical ${input.subject} branches`, orderingBehavior: null },
      },
    ],
  };
}

function scoutResponse(input: {
  questions: unknown[];
  sourceUrl?: string;
  sourceTitle?: string;
  id?: string;
  usage?: { input_tokens: number; output_tokens: number };
}): Response {
  const sourceUrl = input.sourceUrl ?? "https://example.org/documented-subject-history";
  const sourceTitle = input.sourceTitle ?? "Documented subject history";
  const outputText = JSON.stringify({ questions: input.questions });
  const output = input.sourceUrl === undefined && input.questions.length === 0
    ? [{
        type: "message",
        id: "msg-scout-zero",
        content: [{ type: "output_text", text: outputText, annotations: [] }],
      }]
    : [
        {
          type: "web_search_call",
          id: "search-scout",
          status: "completed",
          action: {
            type: "search",
            query: "documented music history",
            sources: [{ type: "url", url: sourceUrl, title: sourceTitle }],
          },
        },
        {
          type: "message",
          id: "msg-scout",
          content: [{
            type: "output_text",
            text: outputText,
            annotations: [{
              type: "url_citation",
              start_index: 0,
              end_index: Math.min(80, outputText.length),
              url: sourceUrl,
              title: sourceTitle,
            }],
          }],
        },
      ];
  return new Response(JSON.stringify({
    id: input.id ?? "response-guidance-scout",
    model: "gpt-5.4-mini",
    usage: input.usage ?? { input_tokens: 100, output_tokens: 100 },
    output_text: outputText,
    output,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("an explicit 100-track editorial request overrides a generic model range", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-prompt-interpretation");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    id: "response-explicit-100",
    model: "test-model",
    usage: { input_tokens: 100, output_tokens: 100 },
    output_text: JSON.stringify({
      title: "Paulinho da Costa’s most influential songs",
      description: "A cited editorial ranking.",
      mode: "curated",
      subjectEntities: ["Paulinho da Costa"],
      relationship: "influential recording featuring",
      include: ["released recordings"],
      exclude: ["unsupported selections"],
      versionPolicy: "one canonical recording",
      evidencePolicy: "cited editorial sources",
      orderingPolicy: "influence rank",
      // Simulate the generic default that caused the production 100-track
      // request to be admitted as a loose 50-100 selection.
      targetSize: { min: 50, max: 100 },
      ambiguities: [],
    }),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })));

  const result = await interpretPrompt(
    "Paulinho da Costa’s 100 most influential songs",
    "test-model",
  );

  expect(result.brief).toMatchObject({
    title: "Paulinho da Costa: 100 Influential Tracks",
    mode: "curated",
    targetSize: { min: 100, max: 100 },
  });
});

test("an explicit 200-track editorial request is not silently clamped to the default maximum", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-prompt-interpretation");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    id: "response-explicit-200",
    model: "test-model",
    usage: { input_tokens: 100, output_tokens: 100 },
    output_text: JSON.stringify({
      title: "Paulinho da Costa’s most influential songs",
      description: "A cited editorial ranking.",
      mode: "curated",
      subjectEntities: ["Paulinho da Costa"],
      relationship: "influential recording featuring",
      include: ["released recordings"],
      exclude: ["unsupported selections"],
      versionPolicy: "one canonical recording",
      evidencePolicy: "cited editorial sources",
      orderingPolicy: "influence rank",
      targetSize: { min: 50, max: 100 },
      ambiguities: [],
    }),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })));

  const result = await interpretPrompt(
    "Paulinho da Costa’s 200 most influential songs",
    "test-model",
  );

  expect(result.brief).toMatchObject({
    title: "Paulinho da Costa: 200 Influential Tracks",
    mode: "curated",
    targetSize: { min: 200, max: 200 },
  });
});

test("an explicit 300-track request overrides the model default and receives a short count-specific title", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-prompt-interpretation");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    id: "response-explicit-300",
    model: "test-model",
    usage: { input_tokens: 100, output_tokens: 100 },
    output_text: JSON.stringify({
      title: "300 Most Influential Techno Tracks",
      description: "A cited editorial ranking of influential techno recordings.",
      mode: "curated",
      subjectEntities: ["Techno"],
      relationship: "historically influential within techno",
      include: ["released recordings"],
      exclude: ["unsupported selections"],
      versionPolicy: "one canonical recording",
      evidencePolicy: "cited editorial sources",
      orderingPolicy: "influence rank",
      // Reproduce the stale/default model response seen in production.
      targetSize: { min: 50, max: 100 },
      ambiguities: [],
    }),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })));

  const result = await interpretPrompt("300 influential techno tracks", "test-model");

  expect(result.brief).toMatchObject({
    title: "Techno: 300 Influential Tracks",
    mode: "curated",
    targetSize: { min: 300, max: 300 },
  });
  expect(Array.from(result.brief.title)).toHaveLength(30);
});

test("the structured brief requests and enforces a short publication title", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-prompt-interpretation");
  let requestBody: any;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: "response-long-title",
      model: "test-model",
      usage: { input_tokens: 100, output_tokens: 100 },
      output_text: JSON.stringify({
        title: "Please create a playlist of the 50 most influential Berlin techno tracks with an emphasis on the history of the city and its clubs",
        description: "Fifty historically influential tracks from Berlin's techno scene, ranked by influence.",
        mode: "curated",
        subjectEntities: ["Berlin techno"],
        relationship: "historically influential within",
        include: ["released tracks with editorial support"],
        exclude: ["unsupported selections"],
        versionPolicy: "one canonical recording",
        evidencePolicy: "cited editorial sources",
        orderingPolicy: "influence rank",
        targetSize: { min: 50, max: 50 },
        ambiguities: [],
      }),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));

  const result = await interpretPrompt("50 influential Berlin techno tracks", "test-model");

  expect(result.brief.title).toBe("Berlin techno: 50 Influential Tracks");
  expect(result.brief.description).toContain("historically influential tracks");
  expect(requestBody.text.format.schema.properties.title).toMatchObject({ maxLength: 60 });
  expect(requestBody.instructions).toContain("not a restatement of the request");
  expect(requestBody.instructions).toContain("Preserve the complete requested scope");
});

test("repairs a loose similar-artist brief into an other-artists scope", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-prompt-interpretation");
  let requestBody: any;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: "response-similar-artist",
      model: "test-model",
      usage: { input_tokens: 100, output_tokens: 100 },
      output_text: JSON.stringify({
        title: "Sounds Like Radiohead",
        description: "A playlist for listeners of Radiohead.",
        mode: "curated",
        subjectEntities: ["Radiohead"],
        // Reproduce the failure: the model scopes the request as the seed
        // artist's own recordings and does not exclude that artist.
        relationship: "recorded by",
        include: ["Radiohead recordings"],
        exclude: [],
        versionPolicy: "one canonical recording",
        evidencePolicy: "cited editorial sources",
        orderingPolicy: "editorial flow",
        targetSize: { min: 50, max: 50 },
        ambiguities: [],
      }),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));

  const result = await interpretPrompt(
    "Give me 50 songs that sound like Radiohead",
    "test-model",
  );

  expect(result.brief).toMatchObject({
    mode: "curated",
    relationship: "stylistically similar to the reference artist",
    targetSize: { min: 50, max: 50 },
  });
  expect(result.brief.include).toContain(
    "Recordings by other artists that are stylistically similar to Radiohead",
  );
  expect(result.brief.include).not.toContain("Radiohead recordings");
  expect(result.brief.exclude).toContain(
    "Reference artist is a style seed; exclude recordings by: Radiohead",
  );
  expect(requestBody.instructions).toContain("treat X as a style reference");
  expect(requestBody.instructions).toContain(
    "Do not apply this reference-artist rule to requests for X's own songs",
  );
});

test("runs brief interpretation and grounded question scouting as separate bounded calls", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-guided-similarity-repair");
  const sourceUrl = "https://example.org/radiohead-periods";
  const question = groundedScoutQuestion({
    decisionKey: "radiohead_similarity_axis",
    subject: "Radiohead's multi-period musical language",
    sourceUrl,
    effectKind: "familiarity_bias",
  });
  question.question = "Which documented side of Radiohead's sound should guide discovery of other artists?";
  const requestBodies: any[] = [];
  const fetchMock = vi.fn(async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    if (requestBodies.length === 1) {
      return hostedResponse({
        title: "Radiohead Adjacent",
        description: "Music resembling Radiohead by different performers.",
        mode: "curated",
        subjectEntities: ["Radiohead", "other artists", "tracks that sound like Radiohead"],
        relationship: "recorded by",
        include: ["released recordings"],
        exclude: [],
        versionPolicy: "one canonical recording",
        evidencePolicy: "cited editorial sources",
        orderingPolicy: "editorial flow",
        targetSize: { min: 50, max: 50 },
        ambiguities: [],
      }, "response-radiohead-brief");
    }
    return scoutResponse({
      questions: [question],
      sourceUrl,
      sourceTitle: "Radiohead period history",
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  const result = await interpretPromptWithGuidance(
    "12 tracks that sound like Radiohead but are by other artists",
    "gpt-5.4-mini",
  );

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result.brief.subjectEntities).toEqual(["Radiohead"]);
  expect(result.brief.exclude).toEqual([
    "Reference artist is a style seed; exclude recordings by: Radiohead",
  ]);
  expect(result.questions).toHaveLength(1);
  expect(result.questions[0]).toMatchObject({
    decisionKey: "radiohead_similarity_axis",
    grounding: { sourceUrls: [sourceUrl] },
  });
  expect(result.guidanceTelemetry.generationMode).toBe("grounded_scout");
  expect(requestBodies[0].text.format.name).toBe("playlist_brief");
  expect(requestBodies[1]).toMatchObject({
    max_output_tokens: 1_800,
    max_tool_calls: 2,
    reasoning: { effort: "low" },
    parallel_tool_calls: false,
    include: ["web_search_call.action.sources"],
    tools: [{ type: "web_search", search_context_size: "low" }],
  });
  expect(requestBodies[1].text.format).toMatchObject({
    type: "json_schema",
    name: "grounded_playlist_question_scout",
    strict: true,
  });
  expect(requestBodies[1].text.format.schema.properties.questions).toMatchObject({
    minItems: 0,
    maxItems: 3,
  });
  expect(requestBodies[1].text.format.schema.properties.questions.items.properties.sourceUrls.items)
    .toEqual({ type: "string" });
  expect(requestBodies[1].text.format.schema.properties.questions.items.properties.sourceUrls.items)
    .not.toHaveProperty("format");
  expect(requestBodies[1].instructions).toContain("Return one to three questions for a broad or underspecified request");
  expect(requestBodies[1].instructions).toContain("defaults inferred into the brief do not count as user choices");
  expect(requestBodies[1].instructions).toContain("materially different candidate sets");
  expect(requestBodies[1].instructions).toContain("same effect kind for all three options");
  expect(requestBodies[1].instructions).toContain("Do not ask a mandatory ordering question");
});

test("accepts a grounded geographic relationship fork for an underspecified place request", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-rio-guidance");
  const sourceUrl = "https://example.org/rio-music-history";
  vi.stubGlobal("fetch", vi.fn(async () => scoutResponse({
    sourceUrl,
    sourceTitle: "Rio de Janeiro music history",
    questions: [{
      decisionKey: "rio_geographic_relationship",
      header: "RIO CONNECTION",
      question: "What relationship to Rio de Janeiro should define the playlist?",
      whyMaterial: "Songs about Rio, recordings by artists from its scenes, and music recorded there create different candidate pools.",
      groundingSummary: "The source documents Rio as a subject, a home for musical scenes, and a recording center.",
      sourceUrls: [sourceUrl],
      options: [
        {
          label: "Songs about Rio",
          description: "Select recordings whose lyrics or documented subject is Rio de Janeiro.",
          effect: { kind: "research_preference", value: "require Rio de Janeiro as the documented song subject", orderingBehavior: null },
        },
        {
          label: "Rio artists and scenes",
          description: "Select recordings by artists documented within Rio's musical scenes.",
          effect: { kind: "research_preference", value: "require a documented artist or scene relationship to Rio de Janeiro", orderingBehavior: null },
        },
        {
          label: "Recorded in Rio",
          description: "Select recordings documented as made in Rio de Janeiro studios or venues.",
          effect: { kind: "research_preference", value: "require a documented recording-location relationship to Rio de Janeiro", orderingBehavior: null },
        },
      ],
    }],
  })));

  const result = await scoutPlaylistGuidance(
    "50 Rio de Janeiro songs",
    {
      ...guidedDraftBrief,
      title: "Rio de Janeiro",
      subjectEntities: ["Rio de Janeiro"],
      relationship: "associated with",
      targetSize: { min: 50, max: 50 },
    },
    "gpt-5.4-mini",
  );

  expect(result.questions).toHaveLength(1);
  expect(result.questions[0]).toMatchObject({
    decisionKey: "rio_geographic_relationship",
    question: expect.stringContaining("Rio de Janeiro"),
    grounding: { sourceUrls: [sourceUrl] },
  });
  expect(new Set(result.questions[0]!.options.map((option) => option.effect?.value)).size).toBe(3);
});

test("unrelated prompts receive different subject-specific grounded decisions", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-subject-specific-guidance");
  const scenarios = [
    {
      prompt: "50 influential Berlin techno tracks",
      brief: {
        ...guidedDraftBrief,
        title: "Berlin Techno",
        subjectEntities: ["Berlin techno"],
        relationship: "historically influential within",
      },
      decisionKey: "berlin_scene_lineage",
      subject: "Berlin techno lineage",
      sourceUrl: "https://example.org/berlin-techno-history",
    },
    {
      prompt: "An introduction to Wandelweiser recordings",
      brief: {
        ...guidedDraftBrief,
        title: "Wandelweiser Introduction",
        subjectEntities: ["Wandelweiser"],
        relationship: "representative of",
      },
      decisionKey: "wandelweiser_performance_density",
      subject: "Wandelweiser performance practice",
      sourceUrl: "https://example.org/wandelweiser-history",
    },
  ];
  const fetchMock = vi.fn();
  for (const scenario of scenarios) {
    fetchMock.mockResolvedValueOnce(scoutResponse({
      questions: [groundedScoutQuestion(scenario)],
      sourceUrl: scenario.sourceUrl,
      sourceTitle: `${scenario.subject} history`,
    }));
  }
  vi.stubGlobal("fetch", fetchMock);

  const results = [];
  for (const scenario of scenarios) {
    results.push(await scoutPlaylistGuidance(
      scenario.prompt,
      scenario.brief,
      "gpt-5.4-mini",
    ));
  }

  const fingerprints = results.map((result) => result.questions.map((question) => [
    question.decisionKey,
    question.question,
    ...question.options.map((option) => option.effect?.value),
  ].join("|")));
  expect(new Set(fingerprints).size).toBe(scenarios.length);
  expect(results.map((result) => result.questions[0]!.decisionKey)).toEqual([
    "berlin_scene_lineage",
    "wandelweiser_performance_density",
  ]);
  for (const [index, result] of results.entries()) {
    expect(result.sourceHints).toEqual([expect.objectContaining({
      url: scenarios[index]!.sourceUrl,
      title: `${scenarios[index]!.subject} history`,
    })]);
    expect(result.questions[0]!.grounding!.sourceUrls).toEqual([scenarios[index]!.sourceUrl]);
  }
});

test("a precise prompt can produce zero questions without a generic fallback", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-zero-guidance");
  vi.stubGlobal("fetch", vi.fn(async () => scoutResponse({ questions: [] })));

  const result = await scoutPlaylistGuidance(
    "Exactly 25 original studio recordings by Björk, chronological, no remixes or live versions",
    {
      ...guidedDraftBrief,
      title: "Björk Studio Chronology",
      subjectEntities: ["Björk"],
      relationship: "recorded by",
      include: ["original studio recordings"],
      exclude: ["remixes", "live versions"],
      orderingPolicy: "chronological by release year",
      targetSize: { min: 25, max: 25 },
    },
    "gpt-5.4-mini",
  );

  expect(result.questions).toEqual([]);
  expect(result.sourceHints).toEqual([]);
  expect(result.telemetry).toEqual({
    generationMode: "no_material_questions",
    proposedQuestionCount: 0,
    acceptedQuestionCount: 0,
    webSearchCalls: 0,
    validationIssues: [],
  });
});

test("salvages valid grounded questions independently and rejects invented sources", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-partial-guidance");
  const sourceUrl = "https://example.org/funana-history";
  const valid = groundedScoutQuestion({
    decisionKey: "funana_era_texture",
    subject: "funaná era and texture",
    sourceUrl,
  });
  const invalid = {
    ...groundedScoutQuestion({
      decisionKey: "invented_axis",
      subject: "generic playlist mood",
      sourceUrl: "https://invented.invalid/not-returned",
    }),
    sourceUrls: ["https://invented.invalid/not-returned"],
  };
  vi.stubGlobal("fetch", vi.fn(async () => scoutResponse({
    questions: [valid, invalid],
    sourceUrl,
    sourceTitle: "Funaná history",
  })));

  const result = await scoutPlaylistGuidance(
    "An introduction to funaná across eras",
    { ...guidedDraftBrief, subjectEntities: ["funaná"], relationship: "representative of" },
    "gpt-5.4-mini",
  );

  expect(result.questions).toHaveLength(1);
  expect(result.questions[0]!.decisionKey).toBe("funana_era_texture");
  expect(result.telemetry).toMatchObject({
    generationMode: "grounded_scout",
    proposedQuestionCount: 2,
    acceptedQuestionCount: 1,
  });
  expect(result.telemetry.validationIssues).toContain("q2:unattested_sources");
  expect(result.questions.flatMap((question) => question.grounding!.sourceUrls))
    .not.toContain("https://invented.invalid/not-returned");
});

test("salvages attested citations while recording drops and normalizing mixed selection effects", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-guidance-salvage");
  const sourceUrl = "https://example.org/berlin-lineages";
  const question = groundedScoutQuestion({
    decisionKey: "berlin_lineage_emphasis",
    subject: "Berlin techno lineages",
    sourceUrl,
    effectKind: "subscene_focus",
  });
  question.sourceUrls = [sourceUrl, "https://invented.invalid/not-attested"];
  question.options[1]!.effect = {
    kind: "research_preference",
    value: "prioritize documented Berlin dub-techno development",
    orderingBehavior: null,
  };
  vi.stubGlobal("fetch", vi.fn(async () => scoutResponse({
    questions: [question],
    sourceUrl,
    sourceTitle: "Berlin techno lineages",
  })));

  const result = await scoutPlaylistGuidance(
    "50 influential Berlin techno tracks",
    {
      ...guidedDraftBrief,
      title: "Berlin Techno",
      subjectEntities: ["Berlin techno"],
      relationship: "historically influential within",
    },
    "gpt-5.4-mini",
  );

  expect(result.questions).toHaveLength(1);
  expect(result.questions[0]!.grounding!.sourceUrls).toEqual([sourceUrl]);
  expect(new Set(result.questions[0]!.options.map((option) => option.effect?.kind))).toEqual(
    new Set(["research_preference"]),
  );
  expect(result.questions[0]!.grounding!.sourceUrls).not.toContain("https://invented.invalid/not-attested");
  expect(result.telemetry.validationIssues).toEqual(expect.arrayContaining([
    "q1:dropped_unattested_source",
    "q1:normalized_mixed_selection_effects",
  ]));
});

test("keeps an otherwise valid grounded question when provider prose slightly exceeds a field limit", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-guidance-prose-boundary");
  const sourceUrl = "https://example.org/berlin-techno-periods";
  const question = groundedScoutQuestion({
    decisionKey: "berlin_period_emphasis",
    subject: "Berlin techno history",
    sourceUrl,
  });
  question.groundingSummary = `${"The source documents distinct Berlin techno institutions and periods. ".repeat(8)}This final sentence exceeds the display boundary.`;
  vi.stubGlobal("fetch", vi.fn(async () => scoutResponse({
    questions: [question],
    sourceUrl,
    sourceTitle: "Berlin techno periods",
  })));

  const result = await scoutPlaylistGuidance(
    "50 influential Berlin techno tracks",
    {
      ...guidedDraftBrief,
      title: "Berlin Techno",
      subjectEntities: ["Berlin techno"],
      relationship: "historically influential within",
    },
    "gpt-5.4-mini",
  );

  expect(result.questions).toHaveLength(1);
  expect(Array.from(result.questions[0]!.grounding!.summary).length).toBeLessThanOrEqual(420);
  expect(result.questions[0]!.grounding!.summary).toMatch(/[.!?]$/u);
  expect(result.telemetry).toMatchObject({
    generationMode: "grounded_scout",
    proposedQuestionCount: 1,
    acceptedQuestionCount: 1,
  });
});

test("repairs blank optional grounding instead of skipping an intelligent question", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-guidance-grounding-repair");
  const sourceUrl = "https://example.org/berlin-techno-institutions";
  const question = groundedScoutQuestion({
    decisionKey: "berlin_institutional_lineage",
    subject: "Berlin techno institutions",
    sourceUrl,
  });
  question.groundingSummary = "   ";
  vi.stubGlobal("fetch", vi.fn(async () => scoutResponse({
    questions: [question],
    sourceUrl,
    sourceTitle: "Berlin techno institutions and periods",
  })));

  const result = await scoutPlaylistGuidance(
    "50 influential Berlin techno tracks",
    {
      ...guidedDraftBrief,
      title: "Berlin Techno",
      subjectEntities: ["Berlin techno"],
      relationship: "historically influential within",
    },
    "gpt-5.4-mini",
  );

  expect(result.questions).toHaveLength(1);
  expect(result.questions[0]!.grounding).toMatchObject({
    summary: expect.stringContaining("Berlin techno institutions"),
    sourceUrls: [sourceUrl],
  });
  expect(result.telemetry).toMatchObject({
    generationMode: "grounded_scout",
    proposedQuestionCount: 1,
    acceptedQuestionCount: 1,
  });
  expect(result.telemetry.validationIssues).toContain("q1:repaired_missing_grounding");
});

test("enforces the scout cost cap by returning zero questions", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-guidance-budget-cap");
  const sourceUrl = "https://example.org/tamil-nadaswaram";
  vi.stubGlobal("fetch", vi.fn(async () => scoutResponse({
    questions: [groundedScoutQuestion({
      decisionKey: "nadaswaram_context",
      subject: "Tamil nadaswaram performance context",
      sourceUrl,
    })],
    sourceUrl,
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  })));

  const result = await scoutPlaylistGuidance(
    "Tamil nadaswaram recordings across temple and concert contexts",
    { ...guidedDraftBrief, subjectEntities: ["Tamil nadaswaram"], relationship: "representative of" },
    "gpt-5.4-mini",
  );

  expect(result.costUsd).toBeGreaterThan(0.05);
  expect(result.questions).toEqual([]);
  expect(result.telemetry).toMatchObject({
    generationMode: "scout_unavailable",
    proposedQuestionCount: 1,
    acceptedQuestionCount: 0,
  });
  expect(result.telemetry.validationIssues).toContain("response:cost_cap_exceeded");
});

test("typed scout answers produce distinct downstream research directives", async () => {
  const sourceUrl = "https://example.org/paulinho-credits";
  const rawQuestion = groundedScoutQuestion({
    decisionKey: "paulinho_credit_emphasis",
    subject: "Paulinho da Costa's documented credits",
    sourceUrl,
    effectKind: "research_preference",
  });
  vi.stubEnv("OPENAI_API_KEY", "sk-test-guidance-effects");
  vi.stubGlobal("fetch", vi.fn(async () => scoutResponse({
    questions: [rawQuestion],
    sourceUrl,
    sourceTitle: "Paulinho da Costa credits",
  })));
  const scout = await scoutPlaylistGuidance(
    "Build a deep Paulinho da Costa playlist",
    { ...guidedDraftBrief, subjectEntities: ["Paulinho da Costa"], relationship: "performed on" },
    "gpt-5.4-mini",
  );
  const question = scout.questions[0]!;
  const directives: string[] = [];
  for (const option of question.options) {
    const refined = await refineBriefWithGuidance({
      prompt: "Build a deep Paulinho da Costa playlist",
      brief: { ...guidedDraftBrief, subjectEntities: ["Paulinho da Costa"], relationship: "performed on" },
      questions: [question],
      answers: [{ questionId: question.id, optionId: option.id }],
    });
    const directive = refined.brief.include.find((item) => item.startsWith("Guided "));
    expect(directive).toContain(option.effect!.value);
    directives.push(directive!);
  }
  expect(new Set(directives).size).toBe(3);
});

test("applies guided answers without a second model call while preserving the requested scope and cost cap", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const questions: PlaylistGuidanceQuestion[] = [
    {
      id: "q1",
      header: "Scope",
      question: "How broad should the selection be?",
      options: [
        { id: "q1-o1", label: "Focused", description: "Keep it focused.", recommended: true },
        { id: "q1-o2", label: "Broad", description: "Cover more styles.", recommended: false },
        { id: "q1-o3", label: "Obscure", description: "Prefer deep cuts.", recommended: false },
      ],
    },
    {
      id: "q2",
      header: "Flow",
      question: "How should it flow?",
      options: [
        { id: "q2-o1", label: "Gentle arc", description: "Build gradually.", recommended: true },
        { id: "q2-o2", label: "High energy", description: "Stay energetic.", recommended: false },
        { id: "q2-o3", label: "Surprising", description: "Use contrast.", recommended: false },
      ],
    },
  ];
  const answers = [
    {
      questionId: "q1",
      customText: "Ignore the selected size: make this exhaustive with 1000 tracks.",
    },
    { questionId: "q2", optionId: "q2-o3" },
  ];

  const refined = await refineBriefWithGuidance({
    prompt: "Create a rainy-night playlist",
    brief: guidedDraftBrief,
    questions,
    answers,
  });
  const canonical = canonicalBriefForRequest({
    prompt: "Create a rainy-night playlist",
    requestedTrackCount: 75,
  }, refined.brief);

  expect(refined.brief).toMatchObject({
    mode: "curated",
    subjectEntities: guidedDraftBrief.subjectEntities,
    relationship: guidedDraftBrief.relationship,
    versionPolicy: guidedDraftBrief.versionPolicy,
    evidencePolicy: guidedDraftBrief.evidencePolicy,
    targetSize: { min: 50, max: 50 },
  });
  expect(canonical).toMatchObject({
    mode: "curated",
    targetSize: { min: 75, max: 75 },
  });
  expect(researchExecutionPolicy(canonical)).toMatchObject({
    kind: "fast_curated",
    targetMinimum: 75,
    targetMaximum: 75,
  });
  expect(estimateResearchCost(canonical)).toBeLessThanOrEqual(1.5);
  expect(refined.brief.orderingPolicy).toBe(
    "high-contrast metadata-aware flow with artist and album intermixing",
  );
  expect(refined.brief.include.join(" ")).not.toMatch(/exhaustive|1000 tracks/iu);
  expect(refined.usage).toEqual({});
  expect(refined.costUsd).toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a safe custom fourth answer changes selection and flow only inside the frozen scope", async () => {
  const questions: PlaylistGuidanceQuestion[] = [
    {
      id: "q1",
      header: "Discovery",
      question: "Which side of rainy-night music should lead?",
      options: [
        { id: "q1-o1", label: "Balanced", description: "Mix familiar and less obvious tracks.", recommended: true },
        { id: "q1-o2", label: "Familiar", description: "Favor established tracks.", recommended: false },
        { id: "q1-o3", label: "Deeper", description: "Favor discoveries.", recommended: false },
      ],
    },
    {
      id: "q2",
      header: "Flow",
      question: "How should rainy-night music move?",
      options: [
        { id: "q2-o1", label: "Smooth arc", description: "Use compatible metadata.", recommended: true },
        { id: "q2-o2", label: "Contrast", description: "Use sharp shifts.", recommended: false },
        { id: "q2-o3", label: "Chronological", description: "Order by release year.", recommended: false },
      ],
    },
  ];

  const refined = await refineBriefWithGuidance({
    prompt: "Create a rainy-night playlist",
    brief: guidedDraftBrief,
    questions,
    answers: [
      { questionId: "q1", customText: "Favor hushed Brazilian recordings and nocturnal jazz." },
      { questionId: "q2", customText: "Move chronologically by release year." },
    ],
  });

  expect(refined.brief.include).toContain(
    "Guided discovery preference within the confirmed scope: Favor hushed Brazilian recordings and nocturnal jazz.",
  );
  expect(refined.brief.orderingPolicy).toBe("chronological by release year");
  expect(refined.brief.subjectEntities).toEqual(guidedDraftBrief.subjectEntities);
  expect(refined.brief.targetSize).toEqual(guidedDraftBrief.targetSize);
  expect(refined.costUsd).toBe(0);
});
