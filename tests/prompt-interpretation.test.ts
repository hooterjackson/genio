import { afterEach, expect, test, vi } from "vitest";
import { interpretPrompt } from "../server/openai.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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
