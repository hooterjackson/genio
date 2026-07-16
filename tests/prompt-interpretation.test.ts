import { afterEach, expect, test, vi } from "vitest";
import {
  interpretPrompt,
  interpretPromptWithGuidance,
  refineBriefWithGuidance,
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

function guidedQuestion(
  header: string,
  question: string,
  prefix: string,
): {
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
} {
  return {
    header,
    question,
    options: [1, 2, 3].map((index) => ({
      label: `${prefix} ${index}`,
      description: `${prefix} choice ${index}.`,
    })),
  };
}

function specificScopeQuestion(
  category: "selection_scope" | "era",
  header: string,
  question: string,
) {
  return {
    category,
    header,
    question,
    options: [
      { label: "Foundations", description: "Prioritize formative recordings and scene foundations." },
      { label: "Breakthroughs", description: "Emphasize recognized turning points and wider impact." },
      { label: "Discoveries", description: "Favor less obvious recordings with strong support." },
    ],
  };
}

function supportedFlowQuestion() {
  return {
    header: "Flow",
    question: "How should rainy-night music move from beginning to end?",
    options: [
      { label: "Smooth arc", description: "Use compatible metadata and gradual transitions." },
      { label: "High contrast", description: "Use deliberate contrast and sharper shifts." },
      { label: "Chronological", description: "Order the tracks by release year." },
    ],
  };
}

function hostedResponse(output: unknown, id = "response-guided"): Response {
  return new Response(JSON.stringify({
    id,
    model: "test-model",
    usage: { input_tokens: 100, output_tokens: 100 },
    output_text: JSON.stringify(output),
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

test("repairs contaminated similarity entities and replaces awkward guided wording", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-guided-similarity-repair");
  let requestBody: any;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return hostedResponse({
      brief: {
        title: "Radiohead Adjacent",
        description: "Music resembling Radiohead by different performers.",
        mode: "curated",
        subjectEntities: [
          "Radiohead",
          "other artists",
          "tracks that sound like Radiohead",
        ],
        relationship: "recorded by",
        include: ["released recordings"],
        exclude: [],
        versionPolicy: "one canonical recording",
        evidencePolicy: "cited editorial sources",
        orderingPolicy: "editorial flow",
        targetSize: { min: 50, max: 50 },
        ambiguities: [],
      },
      scopeQuestions: [{
        category: "familiarity",
        header: "Similarity",
        question: "How far should other artists and tracks that sound like Radiohead reach?",
        options: [
          { label: "Close", description: "Prioritize close stylistic parallels." },
          { label: "Balanced", description: "Balance close and adjacent discoveries." },
          { label: "Broad", description: "Explore a wider stylistic orbit." },
        ],
      }],
      flowQuestion: {
        header: "Flow",
        question: "How should tracks that sound like Radiohead move?",
        options: [
          { label: "Smooth arc", description: "Use compatible metadata and gradual transitions." },
          { label: "High contrast", description: "Use deliberate contrast and sharper shifts." },
          { label: "Chronological", description: "Order the tracks by release year." },
        ],
      },
    });
  }));

  const result = await interpretPromptWithGuidance(
    "12 tracks that sound like Radiohead but are by other artists",
    "test-model",
  );

  expect(result.brief.subjectEntities).toEqual(["Radiohead"]);
  expect(result.brief.exclude).toEqual([
    "Reference artist is a style seed; exclude recordings by: Radiohead",
  ]);
  expect(result.questions).toHaveLength(2);
  expect(result.questions[0]!.question).toBe(
    "How closely should this selection resemble Radiohead?",
  );
  expect(result.questions[1]!.question).toBe(
    "How should the Radiohead-inspired selection move from track to track?",
  );
  expect(result.questions.map((question) => question.question).join(" "))
    .not.toMatch(/other artists|tracks that sound like/iu);
  expect(requestBody.instructions).toContain(
    "never emit filler phrases such as 'other artists'",
  );
});

test.each([
  {
    label: "two",
    scopeQuestions: [
      specificScopeQuestion(
        "selection_scope",
        "Selection",
        "What should define the rainy-night music selection?",
      ),
    ],
    expectedCount: 2,
  },
  {
    label: "three",
    scopeQuestions: [
      specificScopeQuestion(
        "selection_scope",
        "Selection",
        "What should define the rainy-night music selection?",
      ),
      specificScopeQuestion(
        "era",
        "Era",
        "Which eras of rainy-night music should lead?",
      ),
    ],
    expectedCount: 3,
  },
])("creates $label specific guided questions in one structured preflight call", async ({
  scopeQuestions,
  expectedCount,
}) => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-guided-preflight");
  let requestBody: any;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return hostedResponse({
      brief: guidedDraftBrief,
      scopeQuestions,
      flowQuestion: supportedFlowQuestion(),
    });
  }));

  const result = await interpretPromptWithGuidance(
    "Create 50 songs for a rainy night",
    "test-model",
  );

  expect(result.brief).toMatchObject({
    mode: "curated",
    targetSize: { min: 50, max: 50 },
  });
  expect(result.questions).toHaveLength(expectedCount);
  expect(result.questions.at(-1)).toMatchObject({
    id: `q${expectedCount}`,
    header: "Flow",
  });
  for (const [questionIndex, question] of result.questions.entries()) {
    expect(question.options).toHaveLength(3);
    expect(question.options.map((option) => option.id)).toEqual([
      `q${questionIndex + 1}-o1`,
      `q${questionIndex + 1}-o2`,
      `q${questionIndex + 1}-o3`,
    ]);
    expect(question.options.map((option) => option.recommended)).toEqual([true, false, false]);
  }
  expect(requestBody.text.format).toMatchObject({
    type: "json_schema",
    name: "guided_playlist_preflight",
    strict: true,
  });
  expect(requestBody.text.format.schema.properties.scopeQuestions).toMatchObject({
    minItems: 1,
    maxItems: 2,
  });
  expect(requestBody.text.format.schema.properties.flowQuestion.properties.options).toMatchObject({
    minItems: 3,
    maxItems: 3,
  });
  expect(requestBody.instructions).toContain("Do not ask for track count");
  expect(requestBody.instructions).toContain("exactly one playlist-flow question");
});

test.each([
  {
    label: "no scope question",
    scopeQuestions: [],
    flowQuestion: guidedQuestion("Flow", "How should the playlist flow?", "Flow"),
  },
  {
    label: "three scope questions",
    scopeQuestions: [
      { category: "mood", ...guidedQuestion("Mood", "Choose the mood.", "Mood") },
      { category: "era", ...guidedQuestion("Era", "Choose the era.", "Era") },
      { category: "energy", ...guidedQuestion("Energy", "Choose the energy.", "Energy") },
    ],
    flowQuestion: guidedQuestion("Flow", "How should the playlist flow?", "Flow"),
  },
  {
    label: "only two options",
    scopeQuestions: [{
      category: "mood",
      ...guidedQuestion("Mood", "Choose the mood.", "Mood"),
      options: guidedQuestion("Mood", "Choose the mood.", "Mood").options.slice(0, 2),
    }],
    flowQuestion: guidedQuestion("Flow", "How should the playlist flow?", "Flow"),
  },
  {
    label: "a track-count question",
    scopeQuestions: [{
      category: "selection_scope",
      ...guidedQuestion("Length", "How many songs should this playlist contain?", "Length"),
    }],
    flowQuestion: guidedQuestion("Flow", "How should the playlist flow?", "Flow"),
  },
])("replaces guided model output with $label with a safe prompt-specific fallback", async ({
  scopeQuestions,
  flowQuestion,
}) => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-guided-validation");
  vi.stubGlobal("fetch", vi.fn(async () => hostedResponse({
    brief: guidedDraftBrief,
    scopeQuestions,
    flowQuestion,
  })));

  const result = await interpretPromptWithGuidance("A rainy-night playlist", "test-model");
  expect(result.questions).toHaveLength(2);
  expect(result.questions.map((question) => question.options.length)).toEqual([3, 3]);
  expect(result.questions[0]!.question).toMatch(/rainy-night music/iu);
  expect(result.questions[1]!.header).toBe("Flow");
  expect(result.questions.map((question) => `${question.header} ${question.question}`).join(" "))
    .not.toMatch(/how many|track count|playlist size/iu);
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
