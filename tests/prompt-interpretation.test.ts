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
    mode: "curated",
    targetSize: { min: 100, max: 100 },
  });
});
