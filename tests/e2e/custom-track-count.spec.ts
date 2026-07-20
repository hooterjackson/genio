import { expect, test, type Page } from "@playwright/test";
import type { PlaylistBrief } from "../../shared/types";

const customTrackCount = 150;
const playlistPrompt = "Brazilian disco heard in Rio clubs during the late 1970s";

const selectedBrief: PlaylistBrief = {
  title: "Rio Disco Nights",
  description: "Brazilian disco associated with Rio de Janeiro nightlife in the late 1970s.",
  mode: "curated",
  subjectEntities: ["Brazilian disco", "Rio de Janeiro"],
  relationship: "associated with the documented scene",
  include: ["playable released recordings"],
  exclude: ["unrelated songs about Rio de Janeiro"],
  versionPolicy: "one canonical studio version per recording",
  evidencePolicy: "track-level scene or editorial evidence",
  orderingPolicy: "intermix artists and albums",
  targetSize: { min: customTrackCount, max: customTrackCount },
  ambiguities: [],
};

const guidanceQuestion = {
  id: "scene-focus",
  header: "SCENE",
  question: "Which side of Rio disco should lead the selection?",
  options: [
    {
      id: "dancefloor",
      label: "Dancefloor staples",
      description: "Prioritize recordings documented in the city’s disco culture.",
      recommended: true,
    },
    {
      id: "brazilian-productions",
      label: "Brazilian productions",
      description: "Favor locally produced disco recordings.",
      recommended: false,
    },
    {
      id: "international-crossover",
      label: "International crossover",
      description: "Include imported hits alongside Brazilian recordings.",
      recommended: false,
    },
  ],
};

const researchingRun = {
  id: "run-custom-150",
  prompt: playlistPrompt,
  brief: selectedBrief,
  status: "researching",
  estimatedCostUsd: 0.5,
  actualCostUsd: 0,
  approvedBudgetUsd: 1,
  phase: "fast_research",
  error: null,
  candidateCount: 0,
  sourceCount: 0,
  unresolvedCount: 0,
  frontier: [],
  autoPublish: true,
};

function requestField(page: Page) {
  return page.getByRole("textbox", { name: /playlist request/i });
}

function exactTrackCountField(page: Page) {
  return page.getByRole("textbox", { name: /^exact track count$/i });
}

async function openComposerWithCustomCount(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create a playlist" })).toBeVisible();
  await requestField(page).fill(playlistPrompt);
  await page.getByRole("button", { name: /^custom size$/i }).click();
  await expect(exactTrackCountField(page)).toBeVisible();
}

async function installRunRoutes(
  page: Page,
  onRun: (body: Record<string, unknown>) => void,
): Promise<void> {
  await page.route("**/api/v1/runs", async (route) => {
    onRun(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ run: researchingRun, capability: "custom-150-capability" }),
    });
  });
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runId: researchingRun.id }),
    });
  });
  await page.route("**/api/v1/runs/run-custom-150", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(researchingRun),
    });
  });
}

async function installImmediateBriefRoute(
  page: Page,
  onBrief: (body: Record<string, unknown>) => void,
): Promise<void> {
  await page.route("**/api/v1/brief", async (route) => {
    onBrief(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        requestId: "brief-custom-150",
        status: "complete",
        brief: selectedBrief,
      }),
    });
  });
}

test("custom 150 survives button submission, guidance, and run creation", async ({ page }) => {
  let briefBody: Record<string, unknown> | null = null;
  let runBody: Record<string, unknown> | null = null;

  await page.route("**/api/v1/brief**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/v1/brief" && request.method() === "POST") {
      briefBody = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requestId: "brief-guided-150",
          status: "awaiting_answers",
          brief: selectedBrief,
          questions: [guidanceQuestion],
        }),
      });
      return;
    }
    if (pathname === "/api/v1/brief/brief-guided-150/answers") {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ requestId: "brief-guided-150", status: "finalizing", pollAfterMs: 1 }),
      });
      return;
    }
    if (pathname === "/api/v1/brief/brief-guided-150") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ requestId: "brief-guided-150", status: "complete", brief: selectedBrief }),
      });
      return;
    }
    await route.fallback();
  });
  await installRunRoutes(page, (body) => { runBody = body; });

  await openComposerWithCustomCount(page);
  await exactTrackCountField(page).fill(String(customTrackCount));
  await expect(exactTrackCountField(page)).toHaveValue("150");
  await page.getByRole("button", { name: /create playlist/i }).click();

  await expect(page.getByText("QUESTION 1 OF 1", { exact: true })).toBeVisible();
  const option = page.getByRole("radio", { name: /dancefloor staples/i });
  await option.locator("..").click();
  await expect(option).toBeChecked();
  await page.getByRole("button", { name: /create playlist/i }).click();

  await expect(page.getByRole("heading", { name: "Researching your playlist" })).toBeVisible();
  expect(briefBody).toMatchObject({ prompt: playlistPrompt, targetTrackCount: customTrackCount });
  expect(runBody).toMatchObject({
    briefRequestId: "brief-guided-150",
    brief: { targetSize: { min: customTrackCount, max: customTrackCount } },
    targetTrackCount: customTrackCount,
  });
});

test("pressing Enter submits the visible custom 150 count", async ({ page }) => {
  let briefBody: Record<string, unknown> | null = null;
  let runBody: Record<string, unknown> | null = null;
  await installImmediateBriefRoute(page, (body) => { briefBody = body; });
  await installRunRoutes(page, (body) => { runBody = body; });

  await openComposerWithCustomCount(page);
  await exactTrackCountField(page).fill(String(customTrackCount));
  await expect(exactTrackCountField(page)).toHaveValue("150");
  await exactTrackCountField(page).press("Enter");

  await expect(page.getByRole("heading", { name: "Researching your playlist" })).toBeVisible();
  expect(briefBody).toMatchObject({ prompt: playlistPrompt, targetTrackCount: customTrackCount });
  expect(runBody).toMatchObject({
    brief: { targetSize: { min: customTrackCount, max: customTrackCount } },
    targetTrackCount: customTrackCount,
  });
});

test("same-tick form submission reads the custom count visible in the DOM", async ({ page }) => {
  let briefBody: Record<string, unknown> | null = null;
  await installImmediateBriefRoute(page, (body) => { briefBody = body; });
  await installRunRoutes(page, () => undefined);

  await openComposerWithCustomCount(page);
  await exactTrackCountField(page).evaluate((element, nextValue) => {
    const input = element as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!valueSetter || !input.form) throw new Error("Could not update and submit the custom-count form");
    valueSetter.call(input, nextValue);
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: nextValue,
      inputType: "insertText",
    }));
    input.form.requestSubmit();
  }, String(customTrackCount));

  await expect.poll(() => briefBody).toMatchObject({
    prompt: playlistPrompt,
    targetTrackCount: customTrackCount,
  });
});
