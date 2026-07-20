import { expect, test, type Page } from "@playwright/test";
import type { PlaylistBrief } from "../../shared/types";

function srgbChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foreground: string, background: string): number {
  const channels = (value: string) => {
    const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/u);
    if (!match) throw new Error(`Could not parse browser color: ${value}`);
    return match.slice(1, 4).map((channel) => srgbChannel(Number(channel)));
  };
  const luminance = (value: string) => {
    const [red, green, blue] = channels(value);
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

const brief: PlaylistBrief = {
  title: "Paulinho da Costa — released performances",
  description: "Released recordings with evidence that Paulinho da Costa performed on the track.",
  mode: "exhaustive",
  subjectEntities: ["Paulinho da Costa"],
  relationship: "performed on",
  include: ["officially released recordings"],
  exclude: ["unsupported album-wide expansion"],
  versionPolicy: "one entry per documented recording version",
  evidencePolicy: "verified or corroborated track-level evidence",
  orderingPolicy: "chronological by first release",
  targetSize: null,
  ambiguities: [],
};

const run = {
  id: "run-1",
  prompt: "Every released song Paulinho da Costa performed on",
  brief,
  status: "visitor_review",
  estimatedCostUsd: 8,
  actualCostUsd: 2.14,
  approvedBudgetUsd: 8,
  phase: "exception_review",
  error: null,
  candidateCount: 127,
  sourceCount: 18,
  unresolvedCount: 3,
  frontier: [],
};

const curatedBrief: PlaylistBrief = {
  ...brief,
  title: "Influential Berlin techno",
  description: "A cited editorial selection of historically influential Berlin techno.",
  mode: "curated",
  subjectEntities: ["Berlin techno"],
  relationship: "historically influential within",
  include: ["released tracks with editorial support"],
  exclude: ["unsupported selections"],
  versionPolicy: "one canonical version per track",
  evidencePolicy: "citation-attested editorial evidence",
  orderingPolicy: "editorial rank",
  targetSize: { min: 50, max: 100 },
};

const scopeQuestion = {
  id: "scope-focus",
  header: "SELECTION",
  question: "What should lead the selection?",
  options: [
    {
      id: "historical-impact",
      label: "Historical impact",
      description: "Prioritize tracks with documented influence.",
      recommended: true,
    },
    {
      id: "deep-cuts",
      label: "Deep cuts",
      description: "Favor less obvious discoveries.",
      recommended: false,
    },
    {
      id: "balanced",
      label: "A balanced mix",
      description: "Combine recognized tracks and discoveries.",
      recommended: false,
    },
  ],
};

const eraQuestion = {
  id: "era-balance",
  header: "TIME",
  question: "How should the eras be balanced?",
  options: [
    {
      id: "full-history",
      label: "Across the full history",
      description: "Represent each important period.",
      recommended: true,
    },
    {
      id: "early-years",
      label: "Emphasize the early years",
      description: "Give foundational recordings more space.",
      recommended: false,
    },
    {
      id: "recent-work",
      label: "Emphasize recent work",
      description: "Give later recordings more space.",
      recommended: false,
    },
  ],
};

const flowQuestion = {
  id: "playlist-flow",
  header: "FLOW",
  question: "How should the playlist move?",
  options: [
    {
      id: "smooth-arc",
      label: "A smooth arc",
      description: "Intermix artists and build natural transitions.",
      recommended: true,
    },
    {
      id: "chronological",
      label: "Chronologically",
      description: "Move through the music by release date.",
      recommended: false,
    },
    {
      id: "high-contrast",
      label: "With contrast",
      description: "Alternate moods and energy more aggressively.",
      recommended: false,
    },
  ],
};

async function openPrompt(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create a playlist" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /playlist request/i })).toBeVisible();
  for (const count of [25, 50, 100] as const) {
    await expect(trackCountPreset(page, count)).toBeVisible();
  }
  await expect(customSizeButton(page)).toBeVisible();
  await expect(exactTrackCountField(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /create playlist/i })).toBeVisible();
}

async function expectQuestionAtTop(page: Page): Promise<void> {
  const position = await page.evaluate(() => ({
    scrollY: window.scrollY,
    viewportHeight: window.innerHeight,
  }));
  expect(position.scrollY).toBeLessThanOrEqual(Math.ceil(position.viewportHeight / 4));
}

function requestField(page: Page) {
  return page.getByRole("textbox", { name: /playlist request/i });
}

function trackCountPreset(page: Page, count: 25 | 50 | 100) {
  return page.getByRole("button", { name: new RegExp(`^${count} tracks$`, "i") });
}

function customSizeButton(page: Page) {
  return page.getByRole("button", { name: /^custom size$/i });
}

function exactTrackCountField(page: Page) {
  return page.getByRole("textbox", { name: /^exact track count$/i });
}

async function choosePresetTrackCount(page: Page, count: 25 | 50 | 100): Promise<void> {
  if ((await trackCountPreset(page, count).count()) === 0) {
    await page.getByRole("button", { name: "PRESETS", exact: true }).click();
  }
  await trackCountPreset(page, count).click();
  await expect(trackCountPreset(page, count)).toHaveAttribute("aria-pressed", "true");
  await expect(exactTrackCountField(page)).toHaveCount(0);
}

async function chooseCustomTrackCount(page: Page, value: string): Promise<void> {
  if ((await exactTrackCountField(page).count()) === 0) {
    await customSizeButton(page).click();
  }
  await expect(customSizeButton(page)).toHaveCount(0);
  await expect(exactTrackCountField(page)).toBeVisible();
  await exactTrackCountField(page).fill(value);
}

function continueWithTracksButton(page: Page) {
  return page.getByRole("button", { name: /continue(?: with \d+)?/i });
}

async function mockGuidedBrief(
  page: Page,
  {
    requestId,
    initialBrief,
    finalBrief = initialBrief,
    questions,
    onAnswers,
    answerFailures = 0,
  }: {
    requestId: string;
    initialBrief: PlaylistBrief;
    finalBrief?: PlaylistBrief;
    questions: Array<typeof scopeQuestion>;
    onAnswers?: (body: Record<string, unknown>, idempotencyKey: string) => void;
    answerFailures?: number;
  },
): Promise<void> {
  let remainingAnswerFailures = answerFailures;
  await page.route("**/api/v1/brief**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === `/api/v1/brief/${requestId}/answers`) {
      onAnswers?.(
        request.postDataJSON() as Record<string, unknown>,
        request.headers()["idempotency-key"] ?? "",
      );
      if (remainingAnswerFailures > 0) {
        remainingAnswerFailures -= 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary guided-finalization failure" }),
        });
        return;
      }
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ requestId, status: "finalizing", pollAfterMs: 1 }),
      });
      return;
    }
    if (pathname === `/api/v1/brief/${requestId}`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ requestId, status: "complete", brief: finalBrief }),
      });
      return;
    }
    if (pathname === "/api/v1/brief" && request.method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requestId,
          status: "awaiting_answers",
          brief: initialBrief,
          questions,
        }),
      });
      return;
    }
    await route.fallback();
  });
}

async function selectGuidedOption(page: Page, label: string): Promise<void> {
  const radio = page.getByRole("radio", { name: new RegExp(label, "i") });
  await radio.locator("..").click();
  await expect(radio).toBeChecked();
}

test("the gênio intro is brief, skippable, mobile-safe, and shown once per session", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");

  const intro = page.getByTestId("brand-intro");
  await expect(intro).toBeVisible();
  const lockup = intro.locator(".brand-intro-lockup");
  const typedAscii = intro.locator(".brand-intro-typed");
  const skip = page.getByRole("button", { name: "Skip intro" });
  await expect.poll(async () => Number(await lockup.getAttribute("data-character-count"))).toBeGreaterThan(0);
  const partialCharacterCount = Number(await lockup.getAttribute("data-character-count"));
  const totalCharacterCount = Number(await lockup.getAttribute("data-character-total"));
  expect(partialCharacterCount).toBeLessThan(totalCharacterCount);
  await page.waitForTimeout(650);
  const laterCharacterCount = Number(await lockup.getAttribute("data-character-count"));
  expect(laterCharacterCount).toBeGreaterThan(partialCharacterCount);
  expect(laterCharacterCount).toBeLessThan(totalCharacterCount);
  await expect(skip).toBeFocused();
  const skipBox = await skip.boundingBox();
  expect(skipBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(skipBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  await intro.click({ position: { x: 8, y: 8 } });
  await expect(requestField(page)).not.toBeFocused();
  await expect.poll(async () => Number(await lockup.getAttribute("data-character-count"))).toBeGreaterThan(partialCharacterCount);
  await expect(typedAscii).toContainText("/\\");
  await expect(typedAscii).toContainText("____", { timeout: 3_000 });
  await expect(intro.locator(".sr-only")).toHaveText("gênio");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await skip.click();
  await expect(intro).toHaveCount(0);
  await page.waitForTimeout(1_500);
  await expect(intro).toHaveCount(0);
  await expect(requestField(page)).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("brand-intro")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "gênio home" })).toBeVisible();
});

test("the gênio intro is omitted when reduced motion is requested", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByTestId("brand-intro")).toHaveCount(0);
  await expect(requestField(page)).toBeVisible();
});

test("the gênio intro returns keyboard focus to the composer after automatic completion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await expect(page.getByTestId("brand-intro")).toBeVisible();
  await expect(page.getByTestId("brand-intro")).toHaveCount(0, { timeout: 5_000 });
  await expect(requestField(page)).toBeFocused();
});

test("the one-command composer remains usable at mobile widths", async ({ page }, testInfo) => {
  await openPrompt(page);
  await expect(page.getByText("Describe what you want to hear.")).toBeVisible();
  const supportingCopy = page.getByText("gênio researches the music, finds the tracks, and builds it in Apple Music.");
  if (testInfo.project.name === "desktop") await expect(supportingCopy).toBeVisible();
  else await expect(supportingCopy).toBeHidden();
  await expect(trackCountPreset(page, 50)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("2 MIN TARGET", { exact: true })).toHaveText("2 MIN TARGET");
  for (const count of [25, 50, 100] as const) {
    await choosePresetTrackCount(page, count);
    await expect(page.getByText("2 MIN TARGET", { exact: true })).toHaveText("2 MIN TARGET");
  }
  for (const [count, windowLabel] of [["200", "4 MIN"], ["300", "6 MIN"]] as const) {
    await chooseCustomTrackCount(page, count);
    await expect(page.getByText(`${windowLabel} TARGET`, { exact: true })).toHaveText(`${windowLabel} TARGET`);
    const textFits = await exactTrackCountField(page).evaluate((element) => {
      const input = element as HTMLInputElement;
      const style = window.getComputedStyle(input);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) return false;
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const textWidth = context.measureText(input.value).width;
      const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      return textWidth + horizontalPadding <= input.clientWidth + 1;
    });
    expect(textFits).toBe(true);
    const overflowAtCount = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowAtCount).toBeLessThanOrEqual(1);
  }
  await choosePresetTrackCount(page, 50);
  const example = "Paulinho da Costa’s most influential recordings";
  await requestField(page).focus();
  await expect(requestField(page)).toHaveAttribute("placeholder", example);
  await requestField(page).fill(example);
  await expect(requestField(page)).toHaveValue("Paulinho da Costa’s most influential recordings");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const sizes = await Promise.all([
    requestField(page).boundingBox(),
    trackCountPreset(page, 25).boundingBox(),
    trackCountPreset(page, 50).boundingBox(),
    trackCountPreset(page, 100).boundingBox(),
    customSizeButton(page).boundingBox(),
    page.getByRole("button", { name: /create playlist/i }).boundingBox(),
  ]);
  expect(sizes.every((box) => box && box.height >= 44)).toBe(true);
});

test("mobile create keeps playlist size above the fold and pins the primary action safely", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "The persistent action is intentionally mobile-only.");
  await openPrompt(page);

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const request = await requestField(page).boundingBox();
  const sizeHeading = await page.getByRole("heading", { name: "CHOOSE PLAYLIST SIZE" }).boundingBox();
  const selectedSize = await trackCountPreset(page, 50).boundingBox();
  const submit = page.getByRole("button", { name: /create playlist/i });
  const submitBox = await submit.boundingBox();
  const actionTray = submit.locator("..");
  const trayBox = await actionTray.boundingBox();

  expect(request).not.toBeNull();
  expect(sizeHeading).not.toBeNull();
  expect(selectedSize).not.toBeNull();
  expect(submitBox).not.toBeNull();
  expect(trayBox).not.toBeNull();
  expect(request!.height).toBeLessThanOrEqual(132);
  expect(sizeHeading!.y).toBeGreaterThanOrEqual(request!.y + request!.height);
  expect(selectedSize!.y + selectedSize!.height).toBeLessThan(trayBox!.y);
  expect(selectedSize!.y + selectedSize!.height).toBeLessThanOrEqual(viewport!.height);
  expect(submitBox!.y + submitBox!.height).toBeLessThanOrEqual(viewport!.height);
  await expect(actionTray).toHaveCSS("position", "fixed");

  const reservedBottomSpace = await page.locator(".one-command-body").evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).paddingBottom),
  );
  expect(reservedBottomSpace).toBeGreaterThanOrEqual(trayBox!.height);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const pinnedAfterScroll = await submit.boundingBox();
  expect(Math.abs(pinnedAfterScroll!.y - submitBox!.y)).toBeLessThanOrEqual(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("preset and custom sizes switch cleanly and malformed custom counts are never coerced", async ({ page }) => {
  await openPrompt(page);
  await requestField(page).fill("Esoteric electroacoustic recordings made with bowed cymbals");
  const submit = page.getByRole("button", { name: /create playlist/i });

  await expect(trackCountPreset(page, 50)).toHaveAttribute("aria-pressed", "true");
  await expect(submit).toBeEnabled();

  await choosePresetTrackCount(page, 25);
  await expect(trackCountPreset(page, 50)).toHaveAttribute("aria-pressed", "false");
  await expect(submit).toBeEnabled();

  await chooseCustomTrackCount(page, "1");
  await expect(exactTrackCountField(page)).toHaveValue("1");
  await expect(exactTrackCountField(page)).toHaveAttribute("aria-invalid", "false");
  await expect(submit).toBeEnabled();

  await exactTrackCountField(page).fill("300");
  await expect(exactTrackCountField(page)).toHaveValue("300");
  await expect(exactTrackCountField(page)).toHaveAttribute("aria-invalid", "false");
  await expect(submit).toBeEnabled();

  await exactTrackCountField(page).fill("0");
  await expect(exactTrackCountField(page)).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#playlist-track-count-note")).toContainText("Choose 1–300 tracks.");
  await expect(submit).toBeDisabled();

  await exactTrackCountField(page).fill("301");
  await expect(exactTrackCountField(page)).toHaveValue("301");
  await expect(exactTrackCountField(page)).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText("Enter a whole number from 1 to 300.");
  await expect(submit).toBeDisabled();

  for (const malformed of ["12.5", "-5", "1e2", "tracks"] as const) {
    await exactTrackCountField(page).fill(malformed);
    await expect(exactTrackCountField(page)).toHaveValue(malformed);
    await expect(exactTrackCountField(page)).toHaveAttribute("aria-invalid", "true");
    await expect(submit).toBeDisabled();
  }

  await exactTrackCountField(page).fill("37");
  await expect(exactTrackCountField(page)).toHaveAttribute("aria-invalid", "false");
  await expect(page.locator("#playlist-track-count-note")).toContainText("selected track count is exact");
  await expect(submit).toBeEnabled();

  await choosePresetTrackCount(page, 100);
  await expect(customSizeButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(submit).toBeEnabled();
});

test("the selected count stays authoritative through guided questions", async ({ page }) => {
  const selectedBrief = { ...curatedBrief, targetSize: { min: 50, max: 50 } };
  const startedRun = {
    ...run,
    id: "run-one-command",
    prompt: "300 influential techno tracks",
    brief: selectedBrief,
    status: "researching",
    phase: "fast_research",
    autoPublish: true,
  };
  let briefBody: Record<string, unknown> | null = null;
  await mockGuidedBrief(page, {
    requestId: "brief-one-command",
    initialBrief: selectedBrief,
    questions: [scopeQuestion, flowQuestion],
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/brief" && request.method() === "POST") {
      briefBody = request.postDataJSON() as Record<string, unknown>;
    }
  });
  let runBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/runs", async (route) => {
    runBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ run: startedRun, capability: "one-command-capability" }),
    });
  });
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: startedRun.id }) });
  });
  await page.route("**/api/v1/runs/run-one-command", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(startedRun) });
  });

  await openPrompt(page);
  await requestField(page).fill("300 influential techno tracks");
  await choosePresetTrackCount(page, 50);
  await page.getByRole("button", { name: /create playlist/i }).click();
  await selectGuidedOption(page, "Historical impact");
  await page.getByRole("button", { name: /next/i }).click();
  await selectGuidedOption(page, "A smooth arc");
  await page.getByRole("button", { name: /create playlist/i }).click();
  await expect(page.getByRole("heading", { name: "Researching your playlist" })).toBeVisible();
  expect(briefBody).toMatchObject({ prompt: "300 influential techno tracks", targetTrackCount: 50 });
  expect(runBody).toMatchObject({
    briefRequestId: "brief-one-command",
    brief: { targetSize: { min: 50, max: 50 } },
  });
  await expect(page.getByRole("button", { name: /review request/i })).toHaveCount(0);
});

test("a custom count remains visible when editing the request from guidance", async ({ page }) => {
  const customBrief = { ...curatedBrief, targetSize: { min: 75, max: 75 } };
  await mockGuidedBrief(page, {
    requestId: "brief-custom-edit",
    initialBrief: customBrief,
    questions: [scopeQuestion],
  });

  await openPrompt(page);
  await requestField(page).fill("A deep history of Brazilian jazz-funk percussion");
  await chooseCustomTrackCount(page, "75");
  await page.getByRole("button", { name: /create playlist/i }).click();
  await expect(page.getByText("QUESTION 1 OF 1", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /edit request/i }).click();
  await expect(exactTrackCountField(page)).toBeVisible();
  await expect(exactTrackCountField(page)).toHaveValue("75");
  await expect(customSizeButton(page)).toHaveCount(0);
});

test("a two-question guided flow accepts a custom fourth answer before creating the run", async ({ page }) => {
  const selectedBrief = {
    ...curatedBrief,
    title: "Berlin Techno Foundations",
    targetSize: { min: 50, max: 50 },
    orderingPolicy: "smooth energy arc with artist intermixing",
  };
  const startedRun = {
    ...run,
    id: "run-guided-custom",
    prompt: "Berlin techno foundations",
    brief: selectedBrief,
    status: "researching",
    phase: "fast_research",
    autoPublish: true,
  };
  let answersBody: Record<string, unknown> | null = null;
  await mockGuidedBrief(page, {
    requestId: "brief-guided-custom",
    initialBrief: selectedBrief,
    finalBrief: selectedBrief,
    questions: [scopeQuestion, flowQuestion],
    onAnswers: (body) => { answersBody = body; },
  });
  let runCreates = 0;
  let runBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/runs", async (route) => {
    runCreates += 1;
    runBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ run: startedRun, capability: "guided-custom-capability" }),
    });
  });
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: startedRun.id }) });
  });
  await page.route("**/api/v1/runs/run-guided-custom", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(startedRun) });
  });

  await openPrompt(page);
  await requestField(page).fill("Berlin techno foundations");
  await page.getByRole("button", { name: /create playlist/i }).click();

  await expect(page.getByText("QUESTION 1 OF 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: scopeQuestion.question })).toBeVisible();
  expect(runCreates).toBe(0);
  await selectGuidedOption(page, "Historical impact");
  await page.getByRole("button", { name: /next/i }).click();

  await expect(page.getByText("QUESTION 2 OF 2", { exact: true })).toBeVisible();
  const customChoice = page.getByRole("radio", { name: /something else/i });
  const custom = page.getByRole("textbox", { name: "Something else" });
  await customChoice.locator("..").click();
  await expect(customChoice).toBeChecked();
  await custom.fill("Start sparse, then build toward peak-time tracks");
  await expect(custom).toHaveValue("Start sparse, then build toward peak-time tracks");
  await expect(page.getByRole("button", { name: /create playlist/i })).toBeEnabled();
  expect(runCreates).toBe(0);
  await page.getByRole("button", { name: /create playlist/i }).click();

  await expect(page.getByRole("heading", { name: "Researching your playlist" })).toBeVisible();
  expect(answersBody).toMatchObject({
    answers: [
      { questionId: scopeQuestion.id, optionId: "historical-impact" },
      {
        questionId: flowQuestion.id,
        customText: "Start sparse, then build toward peak-time tracks",
      },
    ],
  });
  expect(runCreates).toBe(1);
  expect(runBody).toMatchObject({
    briefRequestId: "brief-guided-custom",
    brief: { targetSize: { min: 50, max: 50 } },
  });
});

test("three guided screens preserve earlier answers and remain usable at mobile widths", async ({ page }, testInfo) => {
  const selectedBrief = {
    ...curatedBrief,
    targetSize: { min: 75, max: 75 },
  };
  await mockGuidedBrief(page, {
    requestId: "brief-guided-three",
    initialBrief: selectedBrief,
    questions: [scopeQuestion, eraQuestion, flowQuestion],
  });

  await openPrompt(page);
  await requestField(page).fill("A deep history of influential Berlin techno");
  await chooseCustomTrackCount(page, "75");
  await page.getByRole("button", { name: /create playlist/i }).click();

  await expect(page.getByText("QUESTION 1 OF 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(4);
  await selectGuidedOption(page, "Deep cuts");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.getByRole("button", { name: /next/i }).click();
  await expect(page.getByRole("heading", { name: eraQuestion.question })).toBeFocused();
  await expectQuestionAtTop(page);
  await selectGuidedOption(page, "Across the full history");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.getByRole("button", { name: /next/i }).click();
  await expect(page.getByText("QUESTION 3 OF 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: flowQuestion.question })).toBeFocused();
  await expectQuestionAtTop(page);

  await page.getByRole("button", { name: /back/i }).click();
  await expect(page.getByRole("heading", { name: eraQuestion.question })).toBeFocused();
  await expect(page.getByRole("radio", { name: /across the full history/i })).toBeChecked();
  await page.getByRole("button", { name: /back/i }).click();
  await expect(page.getByRole("radio", { name: /deep cuts/i })).toBeChecked();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const targets = await page.locator(".guided-option-card, .guided-custom-card, .guided-question-footer button").evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  );
  expect(targets.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
  if (testInfo.project.name.startsWith("mobile-")) {
    expect(["mobile-320", "mobile-390", "mobile-430"]).toContain(testInfo.project.name);
  }
});

test("a failed guided finalization retries the identical frozen submission", async ({ page }) => {
  const selectedBrief = {
    ...curatedBrief,
    targetSize: { min: 50, max: 50 },
  };
  const startedRun = {
    ...run,
    id: "run-guided-retry",
    prompt: "Berlin techno foundations",
    brief: selectedBrief,
    status: "researching",
    phase: "fast_research",
    autoPublish: true,
  };
  const attempts: Array<{ body: Record<string, unknown>; key: string }> = [];
  await mockGuidedBrief(page, {
    requestId: "brief-guided-retry",
    initialBrief: selectedBrief,
    questions: [scopeQuestion, flowQuestion],
    answerFailures: 1,
    onAnswers: (body, key) => attempts.push({ body, key }),
  });
  await page.route("**/api/v1/runs", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ run: startedRun, capability: "guided-retry-capability" }),
    });
  });
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runId: startedRun.id }),
    });
  });
  await page.route("**/api/v1/runs/run-guided-retry", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(startedRun),
    });
  });

  await openPrompt(page);
  await requestField(page).fill("Berlin techno foundations");
  await page.getByRole("button", { name: /create playlist/i }).click();
  await selectGuidedOption(page, "Historical impact");
  await page.getByRole("button", { name: /next/i }).click();
  await selectGuidedOption(page, "A smooth arc");
  await page.getByRole("button", { name: /create playlist/i }).click();

  await expect(page.getByText("Temporary guided-finalization failure")).toBeVisible();
  await expect(page.getByRole("radio", { name: /a smooth arc/i })).toBeDisabled();
  await expect(page.getByRole("button", { name: /retry create/i })).toBeVisible();
  await page.getByRole("button", { name: /retry create/i }).click();

  await expect(page.getByRole("heading", { name: "Researching your playlist" })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.key).not.toBe("");
  expect(attempts[1]!.key).toBe(attempts[0]!.key);
  expect(attempts[1]!.body).toEqual(attempts[0]!.body);
});

test("leaving the composer cancels a pending guided request", async ({ page }) => {
  let runCreates = 0;
  await page.route("**/api/v1/brief", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requestId: "stale-brief", brief: curatedBrief }),
    }).catch(() => undefined);
  });
  await page.route("**/api/v1/runs", async (route) => {
    if (route.request().method() === "POST") {
      runCreates += 1;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "stale run" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });

  await openPrompt(page);
  await requestField(page).fill("Berlin techno foundations");
  await page.getByRole("button", { name: /create playlist/i }).click();
  await page.getByRole("link", { name: "JOBS", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Your jobs" })).toBeVisible();
  await page.waitForTimeout(650);
  expect(runCreates).toBe(0);
});

test("an explicit 100-track request stays at 100 through research, matching, and publication", async ({ page }) => {
  const prompt = "Paulinho da Costa’s 100 most influential songs";
  const exactBrief = {
    ...curatedBrief,
    title: "Paulinho da Costa’s 100 most influential songs",
    description: "A cited ranking of 100 influential recordings featuring Paulinho da Costa.",
    subjectEntities: ["Paulinho da Costa"],
    relationship: "influential recording featuring",
    targetSize: { min: 100, max: 100 },
  };
  const fastRun = {
    ...run,
    id: "run-100",
    prompt,
    brief: exactBrief,
    status: "researching",
    phase: "fast_research",
    candidateCount: 0,
    sourceCount: 0,
    unresolvedCount: 0,
    autoPublish: true,
  };
  const publishingRun = {
    ...fastRun,
    status: "publishing",
    phase: "publication_queued",
    candidateCount: 100,
    sourceCount: 10,
  };
  const completeRun = { ...publishingRun, status: "complete", phase: "published" };

  let briefBody: Record<string, unknown> | null = null;
  await mockGuidedBrief(page, {
    requestId: "brief-100",
    initialBrief: exactBrief,
    questions: [scopeQuestion, flowQuestion],
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/brief" && request.method() === "POST") {
      briefBody = request.postDataJSON() as Record<string, unknown>;
    }
  });

  let runBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/runs", async (route) => {
    runBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ run: fastRun, capability: "one-time-100-track-capability" }),
    });
  });
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: fastRun.id }) });
  });

  let statusRead = 0;
  await page.route(/.*\/api\/v1\/runs\/run-100(?:\?.*)?$/, async (route) => {
    const states = [publishingRun, completeRun];
    const next = states[Math.min(statusRead, states.length - 1)]!;
    statusRead += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(next) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-100\/result(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runId: fastRun.id,
        status: "complete",
        requestedTrackCount: 100,
        sourceCount: 10,
        unresolvedGapCount: 0,
        coverageSummary: "Published from 10 documented sources with 0 visible gaps.",
        outcomeCounts: { accepted: 100 },
        volumes: [{
          index: 1,
          name: exactBrief.title,
          url: "https://music.apple.com/us/playlist/test/pl.u-test",
          trackCount: 100,
          status: "complete",
        }],
      }),
    });
  });

  let browserMutationCount = 0;
  page.on("request", (request) => {
    if (/\/runs\/run-100\/(?:selection|publish)$/u.test(new URL(request.url()).pathname)) browserMutationCount += 1;
  });

  await openPrompt(page);
  await requestField(page).fill(prompt);
  await choosePresetTrackCount(page, 100);
  await page.getByRole("button", { name: /create playlist/i }).click();
  await selectGuidedOption(page, "Historical impact");
  await page.getByRole("button", { name: /next/i }).click();
  await selectGuidedOption(page, "A smooth arc");
  await page.getByRole("button", { name: /create playlist/i }).click();

  await expect(page.getByRole("heading", { name: "Playlist published" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("100 tracks", { exact: true })).toBeVisible();

  expect(briefBody).toMatchObject({ prompt, targetTrackCount: 100 });
  expect(runBody).toMatchObject({ brief: { targetSize: { min: 100, max: 100 } } });
  expect(browserMutationCount).toBe(0);
});

test("a 50-track request uses reserve matches but generates exactly 50 tracks", async ({ page }) => {
  const exactBrief = {
    ...curatedBrief,
    title: "Berlin Techno: 50 Influential Tracks",
    targetSize: { min: 50, max: 50 },
  };
  const exactRun = {
    ...run,
    id: "run-exact-50",
    prompt: "50 influential Berlin techno tracks",
    brief: exactBrief,
    status: "visitor_review",
    phase: "exception_review",
    candidateCount: 100,
    sourceCount: 8,
    unresolvedCount: 44,
  };
  const items = Array.from({ length: 100 }, (_, index) => {
    const matched = index < 56;
    const song = matched ? {
      id: `apple-50-${index}`,
      name: `Berlin track ${index + 1}`,
      artistName: `Berlin artist ${index + 1}`,
    } : null;
    return {
      position: index,
      candidateId: `candidate-50-${index}`,
      artist: `Berlin artist ${index + 1}`,
      title: `Berlin track ${index + 1}`,
      status: matched ? "review" : "unavailable",
      catalogId: song?.id ?? null,
      song,
      alternatives: [],
      evidenceEligible: true,
      selected: false,
      selectable: matched,
    };
  });

  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: exactRun.id }) });
  });
  await page.route("**/api/v1/runs/run-exact-50", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(exactRun) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-exact-50\/tracks.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items,
        page: 1,
        pageSize: 500,
        total: items.length,
        totalPages: 1,
        selectableCount: 56,
        unmatchedCount: 44,
        retryableCount: 0,
        matchingComplete: true,
        requestedTrackCount: 50,
      }),
    });
  });

  let selectionBody: Record<string, unknown> | null = null;
  const manifestTracks = items.slice(0, 50).map((item, position) => ({
    position,
    candidateId: item.candidateId,
    catalogId: item.song!.id,
    artist: item.artist,
    title: item.title,
  }));
  await page.route("**/api/v1/runs/run-exact-50/selection", async (route) => {
    selectionBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "manifest-exact-50",
        runId: exactRun.id,
        name: exactBrief.title,
        trackCount: 50,
        tracks: manifestTracks,
      }),
    });
  });
  await page.route("**/api/v1/runs/run-exact-50/publish", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ ...exactRun, status: "publishing", phase: "publication" }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-exact-50");
  await expect(page.getByText("50 OF 56 MATCHED TRACKS SELECTED", { exact: true })).toBeVisible();
  await continueWithTracksButton(page).click();

  await expect.poll(() => selectionBody).toEqual({
    useRecommended: true,
    excludedCandidateIds: Array.from({ length: 6 }, (_, index) => `candidate-50-${index + 50}`),
    overrides: [],
  });
  await expect(page.getByRole("heading", { name: "50 tracks ready" })).toBeVisible();
});

test("a 200-track request selects exactly 200 tracks from its 300-candidate reserve", async ({ page }) => {
  const exactBrief = {
    ...curatedBrief,
    title: "Paulinho da Costa: 200 Essential Tracks",
    subjectEntities: ["Paulinho da Costa"],
    targetSize: { min: 200, max: 200 },
  };
  const exactRun = {
    ...run,
    id: "run-exact-200",
    prompt: "Paulinho da Costa's 200 most influential songs",
    brief: exactBrief,
    status: "visitor_review",
    phase: "exception_review",
    candidateCount: 300,
    sourceCount: 20,
    unresolvedCount: 0,
  };
  const items = Array.from({ length: 300 }, (_, index) => ({
    position: index,
    candidateId: `candidate-200-${index}`,
    artist: `Artist ${index + 1}`,
    title: `Influential recording ${index + 1}`,
    status: "review",
    catalogId: `apple-200-${index}`,
    song: {
      id: `apple-200-${index}`,
      name: `Influential recording ${index + 1}`,
      artistName: `Artist ${index + 1}`,
    },
    alternatives: [],
    evidenceEligible: true,
    selected: false,
    selectable: true,
  }));

  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: exactRun.id }) });
  });
  await page.route("**/api/v1/runs/run-exact-200", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(exactRun) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-exact-200\/tracks.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items,
        page: 1,
        pageSize: 500,
        total: items.length,
        totalPages: 1,
        selectableCount: 300,
        unmatchedCount: 0,
        retryableCount: 0,
        matchingComplete: true,
        requestedTrackCount: 200,
      }),
    });
  });

  let selectionBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/runs/run-exact-200/selection", async (route) => {
    selectionBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "manifest-exact-200",
        runId: exactRun.id,
        name: exactBrief.title,
        trackCount: 200,
        tracks: items.slice(0, 200).map((item, position) => ({
          position,
          candidateId: item.candidateId,
          catalogId: item.catalogId,
          artist: item.artist,
          title: item.title,
        })),
      }),
    });
  });
  await page.route("**/api/v1/runs/run-exact-200/publish", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ ...exactRun, status: "publishing", phase: "publication" }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-exact-200");
  await expect(page.getByText("200 OF 300 MATCHED TRACKS SELECTED", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(300);
  await continueWithTracksButton(page).click();

  await expect.poll(() => selectionBody).toEqual({
    useRecommended: true,
    excludedCandidateIds: Array.from({ length: 100 }, (_, index) => `candidate-200-${index + 200}`),
    overrides: [],
  });
  await expect(page.getByRole("heading", { name: "200 tracks ready" })).toBeVisible();
});

test("an active fast run keeps its profile and concise phase message visible", async ({ page }) => {
  // Keep this accessibility assertion independent of project/device merge
  // behavior. The following scenario explicitly opts back into motion.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fastRun = {
    ...run,
    id: "run-fast",
    brief: curatedBrief,
    status: "researching",
    phase: "fast_research",
    candidateCount: 24,
    sourceCount: 4,
    unresolvedCount: 0,
    pipelineVersion: "curated_v2",
    candidateStageCounts: {
      discovered: 4,
      scope_qualified: 8,
      claim_verified: 6,
      playable: 6,
    },
    selectionPlan: {
      requestedTrackCount: 50,
      reserveTrackCount: 5,
      intents: ["genre_scene"],
      storefront: "us",
    },
    createdAt: new Date(Date.now() - 43_000).toISOString(),
    updatedAt: new Date().toISOString(),
    progress: {
      targetTrackCount: 50,
      latestActivityAt: new Date().toISOString(),
      sourceSummary: {
        total: 4,
        recentSources: [
          { title: "A field guide to Berlin techno", domain: "example.org", sourceClass: "web" },
          { title: "Berlin scene archive", domain: "archive.example", sourceClass: "web" },
        ],
      },
      frontierSummary: {
        total: 3,
        complete: 1,
        active: 2,
        unresolved: 0,
        inaccessible: 0,
        discoveredCount: 24,
        recoveredCount: 18,
      },
      containerSummary: {
        total: 5,
        complete: 2,
        active: 3,
        unresolved: 0,
        inaccessible: 0,
        advertisedCount: 80,
        recoveredCount: 42,
      },
      matchSummary: {
        attempted: 10,
        accepted: 6,
        review: 1,
        unavailable: 1,
        duplicate: 1,
        rejected: 1,
        unsupported: 0,
        overflow: 0,
        shortfall: 44,
      },
      publicationSummary: {
        volumeCount: 0,
        completedVolumes: 0,
        totalTracks: 0,
        appendedTracks: 0,
        currentVolume: null,
        status: null,
      },
    },
    frontier: [{
      sourceClass: "editorial",
      strategy: "Berlin scene histories",
      status: "pending",
      discoveredCount: 4,
      recoveredCount: 3,
    }],
  };
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: fastRun.id }) });
  });
  await page.route("**/api/v1/runs/run-fast", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fastRun) });
  });

  await page.goto("/#cap=one-time-secret&run=run-fast");
  await expect(page.getByText("[CURATED · RESEARCHING]", { exact: true })).toBeVisible();
  await expect(page.getByText("Finding and verifying cited tracks within the 2-minute window.")).toBeVisible();
  const indicator = page.getByTestId("working-indicator");
  await expect(indicator).toBeVisible();
  await expect(indicator.locator(".working-live-state")).toContainText("LIVE");
  await expect(indicator.locator("[aria-current='step']")).toContainText("DISCOVER");
  await expect(indicator.locator(".working-facts")).toContainText("TARGET50");
  await expect(indicator.locator(".working-facts")).toContainText("DISCOVERED24");
  await expect(indicator.locator(".working-facts")).toContainText("QUALIFIED20");
  await expect(indicator.locator(".working-facts")).toContainText("APPLE READY6");
  await expect(indicator.getByText("A field guide to Berlin techno", { exact: true })).toBeVisible();
  await expect(indicator.getByText("example.org", { exact: true })).toBeVisible();
  await expect(indicator.getByText("Berlin scene histories", { exact: true })).toBeVisible();
  await expect(indicator.getByText("RUN DETAILS", { exact: true })).toBeVisible();
  await expect(indicator.locator("[role='status']")).toHaveCount(1);
  await expect(page.locator(".research-progress")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await indicator.locator(".working-trace-pulse").first().evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
});

test("the active process signal moves when motion is allowed", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const activeRun = {
    ...run,
    id: "run-moving-signal",
    brief: curatedBrief,
    status: "matching",
    phase: "catalog_matching",
    candidateCount: 41,
    sourceCount: 9,
  };
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: activeRun.id }) });
  });
  await page.route("**/api/v1/runs/run-moving-signal", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(activeRun) });
  });

  await page.goto("/#cap=one-time-secret&run=run-moving-signal");
  const indicator = page.getByTestId("working-indicator");
  await expect(indicator.locator("[aria-current='step']")).toContainText("MATCH");
  const animationName = await indicator.locator(".working-trace-lane.is-active .working-trace-pulse")
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(animationName).toContain("working-trace-scan");
});

test("an automatic review handoff stays in the assembly state and keeps polling", async ({ page }) => {
  const automaticRun = {
    ...run,
    id: "run-automatic-handoff",
    autoPublish: true,
    status: "visitor_review",
    phase: "exception_review",
  };
  let runReads = 0;
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runId: automaticRun.id }),
    });
  });
  await page.route("**/api/v1/runs/run-automatic-handoff", async (route) => {
    runReads += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(automaticRun),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-automatic-handoff");

  await expect(page.getByText("[EXHAUSTIVE · ASSEMBLING]", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Creating your playlist" })).toBeVisible();
  await expect(page.getByTestId("working-indicator").getByRole("status")).toContainText(
    "Locking the selected recording versions into the final playlist order before publication.",
  );
  await expect(page.getByRole("heading", { name: "Choose tracks" })).toHaveCount(0);
  await expect(page.getByTestId("working-indicator").locator("[aria-current='step']")).toContainText("SEQUENCE");
  await expect.poll(() => runReads, { timeout: 4_000 }).toBeGreaterThanOrEqual(3);
});

test("the jobs screen lists and opens earlier jobs for this browser", async ({ page }) => {
  const earlierRun = {
    ...run,
    id: "run-earlier",
    status: "researching",
    phase: "track_verification",
    createdAt: "2026-07-14T12:00:00.000Z",
    updatedAt: "2026-07-14T12:05:00.000Z",
  };
  await page.route("**/api/v1/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [earlierRun] }),
    });
  });
  await page.route("**/api/v1/runs/run-earlier", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(earlierRun) });
  });

  await openPrompt(page);
  await page.getByRole("link", { name: "JOBS", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your jobs" })).toBeVisible();
  await expect(page.getByText(brief.title)).toBeVisible();
  await page.getByRole("button", { name: `Open ${brief.title} — Researching` }).click();
  await expect(page.getByRole("heading", { name: "Researching your playlist" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.search)).toBe("?run=run-earlier");
});

test("an active job never blocks starting a new request", async ({ page }) => {
  const activeRun = {
    ...run,
    id: "run-active",
    status: "researching",
    phase: "track_verification",
  };
  const deletes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE") deletes.push(request.url());
  });
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: activeRun.id }) });
  });
  await page.route("**/api/v1/runs/run-active", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(activeRun) });
  });

  await page.goto("/#cap=one-time-secret&run=run-active");
  await expect(page.getByRole("heading", { name: "Researching your playlist" })).toBeVisible();
  await page.getByRole("link", { name: "gênio home" }).click();
  await expect(requestField(page)).toBeVisible();
  await expect(trackCountPreset(page, 50)).toHaveAttribute("aria-pressed", "true");
  await expect(exactTrackCountField(page)).toHaveCount(0);
  await expect(requestField(page)).toHaveValue("");
  expect(deletes).toEqual([]);
});

test("the optimistic flow preserves material assumptions without claiming user acceptance", async ({ page }) => {
  const ambiguities = ["Include credited guest appearances", "Use the first released studio version"];
  const ambiguousBrief = { ...curatedBrief, targetSize: { min: 50, max: 50 }, ambiguities };
  await mockGuidedBrief(page, {
    requestId: "brief-ambiguous",
    initialBrief: ambiguousBrief,
    finalBrief: ambiguousBrief,
    questions: [scopeQuestion, flowQuestion],
  });

  let captureRun!: (body: Record<string, unknown>) => void;
  const runRequest = new Promise<Record<string, unknown>>((resolve) => { captureRun = resolve; });
  await page.route("**/api/v1/runs", async (route) => {
    captureRun(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "Stopped after request capture" }),
    });
  });

  await openPrompt(page);
  await requestField(page).fill("Every released song Paulinho da Costa performed on");
  await page.getByRole("button", { name: /create playlist/i }).click();
  await selectGuidedOption(page, "Historical impact");
  await page.getByRole("button", { name: /next/i }).click();
  await selectGuidedOption(page, "Chronologically");
  await page.getByRole("button", { name: /create playlist/i }).click();

  const body = await runRequest;
  const confirmed = body.brief as typeof ambiguousBrief & { ambiguityAcceptance?: string[] };
  expect(confirmed.ambiguities).toEqual(ambiguities);
  expect(confirmed.ambiguityAcceptance).toBeUndefined();
});

test("capabilities are exchanged and removed from the URL fragment", async ({ page }) => {
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-1\/tracks.*/, async (route) => {
    const items = Array.from({ length: 21 }, (_, index) => ({
      position: index,
      candidateId: `candidate-${index}`,
      artist: "Artist",
      title: `Matched track ${index + 1}`,
      album: "Album",
      status: "accepted",
      catalogId: `apple-${index}`,
      song: { id: `apple-${index}`, name: `Matched track ${index + 1}`, artistName: "Artist", albumName: "Album" },
      alternatives: [],
      evidenceEligible: true,
      selected: true,
      selectable: true,
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items,
        page: 1,
        pageSize: 200,
        total: 21,
        totalPages: 1,
        selectableCount: 21,
        unmatchedCount: 0,
        retryableCount: 0,
        matchingComplete: true,
      }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  await expect(page.getByRole("heading", { name: "Choose tracks" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await expect(page.getByText("21 OF 21 MATCHED TRACKS SELECTED", { exact: true })).toBeVisible();
  await expect(page.getByText("Matched track 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Matched track 21", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(21);
  expect(await page.getByRole("checkbox").evaluateAll((checkboxes) => checkboxes.every((checkbox) => (checkbox as HTMLInputElement).checked))).toBe(true);
});

test("the whole list can be cleared, restored, and edited without reviewing tracks one by one", async ({ page }) => {
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-1\/tracks.*/, async (route) => {
    const matched = (index: number) => ({
      position: index,
      candidateId: `candidate-${index}`,
      artist: "Artist",
      title: `Track ${index + 1}`,
      status: index === 0 ? "review" : "accepted",
      catalogId: `apple-${index}`,
      song: { id: `apple-${index}`, name: `Track ${index + 1}`, artistName: "Artist" },
      alternatives: [],
      evidenceEligible: true,
      selected: index !== 0,
      selectable: true,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          matched(0),
          matched(1),
          {
            ...matched(2),
            title: "Previously excluded track",
            status: "rejected",
            selected: false,
          },
          {
            position: 3,
            candidateId: "candidate-unavailable",
            artist: "Artist",
            title: "Unavailable track",
            status: "unavailable",
            catalogId: null,
            song: null,
            alternatives: [],
            evidenceEligible: true,
            selected: false,
            selectable: false,
          },
        ],
        page: 1,
        pageSize: 200,
        total: 4,
        totalPages: 1,
        selectableCount: 3,
        unmatchedCount: 1,
        retryableCount: 0,
        matchingComplete: true,
      }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  const generate = continueWithTracksButton(page);
  await expect(page.getByText("3 tracks matched. Omitted: 1 unavailable track.", { exact: true })).toBeVisible();
  await expect(page.getByText("2 OF 3 MATCHED TRACKS SELECTED", { exact: true })).toBeVisible();
  const list = page.getByRole("list", { name: "Playlist tracks" });
  await expect(list.getByRole("listitem")).toHaveCount(4);
  await expect(page.getByRole("checkbox", { name: /unavailable track/i })).toBeDisabled();
  await expect(page.getByText("UNAVAILABLE", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /previously excluded track/i })).not.toBeChecked();
  await expect(page.getByText("EXCLUDED", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "CLEAR", exact: true }).click();
  await expect(generate).toBeDisabled();
  await page.getByRole("button", { name: "SELECT ALL", exact: true }).click();
  await expect(generate).toBeEnabled();
  await page.getByRole("checkbox", { name: /track 2/i }).uncheck();
  await expect(page.getByText("2 OF 3 MATCHED TRACKS SELECTED", { exact: true })).toBeVisible();

  const touchTargets = await page.locator(".selection-toolbar button, .review-footer button, .track-selection-row > label:first-child").evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  );
  expect(touchTargets.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("reserve matches stay visible but default and Select all stop at the requested track count", async ({ page }) => {
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-1\/tracks.*/, async (route) => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      position: index,
      candidateId: `candidate-reserve-${index}`,
      artist: "Artist",
      title: `Reserve track ${index + 1}`,
      status: "accepted",
      catalogId: `apple-reserve-${index}`,
      song: { id: `apple-reserve-${index}`, name: `Reserve track ${index + 1}`, artistName: "Artist" },
      alternatives: [],
      evidenceEligible: true,
      selected: true,
      selectable: true,
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items,
        page: 1,
        pageSize: 200,
        total: 5,
        totalPages: 1,
        selectableCount: 5,
        unmatchedCount: 0,
        retryableCount: 0,
        matchingComplete: true,
        requestedTrackCount: 3,
      }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  await expect(page.getByText("3 OF 5 MATCHED TRACKS SELECTED", { exact: true })).toBeVisible();
  await expect(page.getByText("3 tracks selected from 5 tracks matched. Additional matches are available as replacements.", { exact: true })).toBeVisible();
  const checkboxes = page.getByRole("checkbox");
  await expect(checkboxes).toHaveCount(5);
  expect(await checkboxes.evaluateAll((items) => items.map((item) => (item as HTMLInputElement).checked))).toEqual([
    true, true, true, false, false,
  ]);

  await checkboxes.nth(4).check();
  expect(await checkboxes.evaluateAll((items) => items.map((item) => (item as HTMLInputElement).checked))).toEqual([
    true, true, false, false, true,
  ]);
  await expect(page.getByText("3 OF 5 MATCHED TRACKS SELECTED", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "CLEAR", exact: true }).click();
  await page.getByRole("button", { name: "SELECT ALL", exact: true }).click();
  expect(await checkboxes.evaluateAll((items) => items.map((item) => (item as HTMLInputElement).checked))).toEqual([
    true, true, true, false, false,
  ]);
});

test("an unresolved Apple shortfall cannot silently generate fewer tracks than requested", async ({ page }) => {
  const shortfallRun = {
    ...run,
    id: "run-catalog-shortfall",
    brief: {
      ...curatedBrief,
      targetSize: { min: 50, max: 50 },
    },
    status: "visitor_review",
    phase: "catalog_matching_shortfall",
    error: "Apple Music matching found 28 safe catalog matches for the required 50; 22 remain unresolved.",
  };
  const items = Array.from({ length: 50 }, (_, index) => {
    const matched = index < 28;
    return {
      position: index,
      candidateId: `candidate-shortfall-${index}`,
      artist: `Artist ${index + 1}`,
      title: `Track ${index + 1}`,
      status: matched ? "review" : "unavailable",
      catalogId: matched ? `apple-shortfall-${index}` : null,
      song: matched ? {
        id: `apple-shortfall-${index}`,
        name: `Track ${index + 1}`,
        artistName: `Artist ${index + 1}`,
      } : null,
      alternatives: [],
      evidenceEligible: true,
      selected: false,
      selectable: matched,
    };
  });

  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: shortfallRun.id }) });
  });
  await page.route("**/api/v1/runs/run-catalog-shortfall", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(shortfallRun) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-catalog-shortfall\/tracks.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items,
        page: 1,
        pageSize: 200,
        total: items.length,
        totalPages: 1,
        selectableCount: 28,
        unmatchedCount: 22,
        retryableCount: 0,
        matchingComplete: true,
        // Exercise the browser-side fallback used while an older gateway is
        // still serving a response that predates requestedTrackCount.
      }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-catalog-shortfall");
  await expect(page.getByText("28 of 50 requested tracks are ready. Resolve 22 more Apple Music matches to generate the playlist.", { exact: true })).toBeVisible();
  await expect(continueWithTracksButton(page)).toBeDisabled();
});

test("legacy timed-out Apple matches recover automatically before selection", async ({ page }) => {
  let currentRun = run;
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentRun) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-1\/tracks.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{
          position: 0,
          candidateId: "candidate-timeout",
          artist: "Artist",
          title: "Timed-out track",
          status: "review",
          basis: "Apple catalog lookup did not complete inside the absolute fast-run window",
          catalogId: null,
          song: null,
          alternatives: [],
          evidenceEligible: true,
          selected: false,
          selectable: false,
        }],
        page: 1,
        pageSize: 200,
        total: 1,
        totalPages: 1,
        selectableCount: 0,
        unmatchedCount: 1,
        retryableCount: 1,
        matchingComplete: false,
      }),
    });
  });
  let matchingRequests = 0;
  await page.route("**/api/v1/runs/run-1/matching", async (route) => {
    matchingRequests += 1;
    currentRun = { ...run, status: "matching", phase: "catalog_matching_recovery" };
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ queued: true, state: "queued", retryableCount: 1, run: currentRun }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  await expect(page.getByRole("heading", { name: "Researching your playlist" })).toBeVisible();
  expect(matchingRequests).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a failed automatic Apple retry leaves the list available for a manual retry", async ({ page }) => {
  let currentRun = run;
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentRun) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-1\/tracks.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{
          position: 0,
          candidateId: "candidate-timeout",
          artist: "Artist",
          title: "Timed-out track",
          status: "review",
          basis: "Apple catalog recovery could not resolve this track after retry attempts",
          catalogId: null,
          song: null,
          alternatives: [],
          evidenceEligible: true,
          selected: false,
          selectable: false,
          retryable: true,
        }],
        page: 1,
        pageSize: 200,
        total: 1,
        totalPages: 1,
        selectableCount: 0,
        unmatchedCount: 1,
        retryableCount: 1,
        matchingComplete: false,
      }),
    });
  });
  let attempts = 0;
  await page.route("**/api/v1/runs/run-1/matching", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Apple matching is temporarily unavailable" }) });
      return;
    }
    currentRun = { ...run, status: "matching", phase: "catalog_matching_recovery" };
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ run: currentRun }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(page.getByRole("heading", { name: "Choose tracks" })).toBeVisible();
  await expect(page.getByText("Apple Music matching is incomplete for 1 track. Retry matching before generating a playlist.", { exact: true })).toBeVisible();
  await expect(page.getByText("NEEDS MATCH", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "SELECT ALL", exact: true })).toBeDisabled();
  await expect(continueWithTracksButton(page)).toBeDisabled();
  const retry = page.getByRole("button", { name: "Retry Apple Music matching for 1 track" });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.getByRole("heading", { name: "Researching your playlist" })).toBeVisible();
  expect(attempts).toBe(2);
});

test("terminal Apple matching failures are distinct from unavailable tracks and expose no inert controls", async ({ page }) => {
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-1\/tracks.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{
          position: 0,
          candidateId: "candidate-failed",
          artist: "Artist",
          title: "Matching failed",
          status: "review",
          basis: "Apple catalog recovery could not resolve this track after retry attempts",
          catalogId: null,
          song: null,
          alternatives: [],
          evidenceEligible: true,
          selected: false,
          selectable: false,
        }, {
          position: 1,
          candidateId: "candidate-unavailable",
          artist: "Artist",
          title: "Unavailable recording",
          status: "unavailable",
          basis: "No compatible catalog result",
          catalogId: null,
          song: null,
          alternatives: [],
          evidenceEligible: true,
          selected: false,
          selectable: false,
        }],
        page: 1,
        pageSize: 200,
        total: 2,
        totalPages: 1,
        selectableCount: 0,
        unmatchedCount: 2,
        retryableCount: 0,
        matchingComplete: true,
      }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  await expect(page.getByText("Apple Music matching failed for 1 track. 1 track is unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByText("MATCH FAILED", { exact: true })).toBeVisible();
  await expect(page.getByText("UNAVAILABLE", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "SELECT ALL", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "CLEAR", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: /retry apple music matching/i })).toHaveCount(0);
  await expect(continueWithTracksButton(page)).toBeDisabled();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("a no-primary Apple alternative requires an explicit version choice before bulk selection", async ({ page }) => {
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-1\/tracks.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{
          position: 0,
          candidateId: "candidate-manual-choice",
          artist: "Expected Artist",
          title: "Expected Track",
          status: "review",
          basis: "Multiple title matches require visitor review",
          catalogId: null,
          song: null,
          alternatives: [{
            id: "apple-title-only-alternative",
            name: "Expected Track",
            artistName: "Different Artist",
            albumName: "Catalog Result",
          }],
          evidenceEligible: true,
          selected: false,
          selectable: false,
        }],
        page: 1,
        pageSize: 200,
        total: 1,
        totalPages: 1,
        selectableCount: 0,
        unmatchedCount: 1,
        retryableCount: 0,
        matchingComplete: true,
      }),
    });
  });

  let selectionBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/runs/run-1/selection", async (route) => {
    selectionBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "manifest-manual-choice", runId: run.id, name: "Manual choice", tracks: [] }),
    });
  });
  await page.route("**/api/v1/runs/run-1/publish", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ ...run, status: "publishing", phase: "publication" }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  await expect(page.getByText("CHOOSE VERSION", { exact: true })).toBeVisible();
  await expect(page.getByText("0 tracks matched. Choose an Apple Music version for 1 track to make those tracks selectable.", { exact: true })).toBeVisible();
  const checkbox = page.getByRole("checkbox", { name: /expected track/i });
  const selectAll = page.getByRole("button", { name: "SELECT ALL", exact: true });
  const version = page.getByRole("combobox", { name: /apple music version/i });
  await expect(checkbox).toBeDisabled();
  await expect(checkbox).not.toBeChecked();
  await expect(selectAll).toBeDisabled();
  await expect(version).toHaveValue("");
  await expect(version.locator("option").nth(1)).toHaveText("Expected Track — Different Artist / Catalog Result");

  await version.selectOption("apple-title-only-alternative");
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).not.toBeChecked();
  await expect(selectAll).toBeEnabled();
  await selectAll.click();
  await expect(checkbox).toBeChecked();
  await continueWithTracksButton(page).click();
  await expect.poll(() => selectionBody).toEqual({
    selected: [{ candidateId: "candidate-manual-choice", catalogId: "apple-title-only-alternative" }],
  });
});

test("one track-list continuation saves the list and starts Apple publication", async ({ page }) => {
  let currentRun = run;
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentRun) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-1\/tracks.*/, async (route) => {
    const primary = { id: "apple-primary", name: "Primary recording", artistName: "Artist", albumName: "Album" };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{
          position: 0,
          candidateId: "candidate-primary",
          artist: "Artist",
          title: "Uncertain track",
          album: "Album",
          basis: "version conflict",
          status: "review",
          catalogId: null,
          song: primary,
          alternatives: [
            primary,
            { id: "apple-alternative", name: "Alternate recording", artistName: "Artist", albumName: "Album" },
          ],
          evidenceEligible: true,
          selected: true,
          selectable: true,
        }],
        page: 1,
        pageSize: 200,
        total: 1,
        totalPages: 1,
        selectableCount: 1,
        unmatchedCount: 0,
        retryableCount: 0,
        matchingComplete: true,
      }),
    });
  });

  let captureSelection!: (body: Record<string, unknown>) => void;
  const selectionRequest = new Promise<Record<string, unknown>>((resolve) => { captureSelection = resolve; });
  await page.route("**/api/v1/runs/run-1/selection", async (route) => {
    captureSelection(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "manifest-1",
        runId: run.id,
        name: "Result playlist",
        description: "Selected tracks",
        contentHash: "abc",
        tracks: [{ position: 0, candidateId: "candidate-primary", catalogId: "apple-primary", artist: "Artist", title: "Uncertain track" }],
      }),
    });
  });
  let capturePublish!: (body: Record<string, unknown>) => void;
  const publishRequest = new Promise<Record<string, unknown>>((resolve) => { capturePublish = resolve; });
  await page.route("**/api/v1/runs/run-1/publish", async (route) => {
    capturePublish(route.request().postDataJSON() as Record<string, unknown>);
    currentRun = { ...run, status: "publishing", phase: "publication" };
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify(currentRun),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  const version = page.getByRole("combobox", { name: /apple music version/i });
  await expect(version.locator("option")).toHaveCount(2);
  await expect(page.getByRole("checkbox", { name: /uncertain track/i })).toBeChecked();
  await version.selectOption("apple-alternative");
  await continueWithTracksButton(page).click();
  const selectionBody = await selectionRequest;
  expect(selectionBody).toEqual({
    selected: [{ candidateId: "candidate-primary", catalogId: "apple-alternative" }],
  });
  expect(await publishRequest).toEqual({ manifestId: "manifest-1" });
  await expect(page.getByText("Creating the playlist in Apple Music.")).toBeVisible();
});

test("compact recommended selection preserves a catalog-only deselection", async ({ page }) => {
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-1\/tracks.*/, async (route) => {
    const items = Array.from({ length: 30 }, (_, index) => {
      const song = { id: `apple-${index}`, name: `Track ${index + 1}`, artistName: "Artist" };
      return {
        position: index,
        candidateId: `candidate-${index}`,
        artist: "Artist",
        title: `Track ${index + 1}`,
        status: "accepted",
        catalogId: song.id,
        song: index === 29 ? null : song,
        alternatives: index === 29 ? [song] : [],
        evidenceEligible: true,
        selected: true,
        selectable: true,
      };
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items,
        page: 1,
        pageSize: 200,
        total: items.length,
        totalPages: 1,
        selectableCount: items.length,
        unmatchedCount: 0,
        retryableCount: 0,
        matchingComplete: true,
      }),
    });
  });

  let selectionBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/runs/run-1/selection", async (route) => {
    selectionBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "manifest-compact",
        runId: run.id,
        name: "Compact playlist",
        tracks: [],
      }),
    });
  });
  await page.route("**/api/v1/runs/run-1/publish", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ ...run, status: "publishing", phase: "publication" }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  await page.getByRole("checkbox", { name: /track 30/i }).uncheck();
  await continueWithTracksButton(page).click();
  await expect.poll(() => selectionBody).toEqual({
    useRecommended: true,
    excludedCandidateIds: ["candidate-29"],
    overrides: [],
  });
});

test("leaving during playlist generation prevents stale publication and state", async ({ page }) => {
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-1\/tracks.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{
          position: 0,
          candidateId: "candidate-ready",
          artist: "Artist",
          title: "Ready track",
          status: "accepted",
          catalogId: "apple-ready",
          song: { id: "apple-ready", name: "Ready track", artistName: "Artist" },
          alternatives: [],
          evidenceEligible: true,
          selected: true,
          selectable: true,
        }],
        page: 1,
        pageSize: 200,
        total: 1,
        totalPages: 1,
        selectableCount: 1,
        unmatchedCount: 0,
        retryableCount: 0,
        matchingComplete: true,
      }),
    });
  });
  let releaseSelection!: () => void;
  const selectionGate = new Promise<void>((resolve) => { releaseSelection = resolve; });
  let selectionStarted!: () => void;
  const started = new Promise<void>((resolve) => { selectionStarted = resolve; });
  await page.route("**/api/v1/runs/run-1/selection", async (route) => {
    selectionStarted();
    await selectionGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "stale-manifest", runId: run.id, name: "Stale", tracks: [] }),
    }).catch(() => undefined);
  });
  let publishRequests = 0;
  await page.route("**/api/v1/runs/run-1/publish", async (route) => {
    publishRequests += 1;
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ...run, status: "publishing" }) });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  await continueWithTracksButton(page).click();
  await started;
  await page.getByRole("link", { name: "gênio home" }).click();
  await expect(requestField(page)).toBeVisible();
  releaseSelection();
  await page.waitForTimeout(50);
  await expect(requestField(page)).toBeVisible();
  expect(publishRequests).toBe(0);
});

test("the current publication result shape keeps run coverage and evidence context", async ({ page }) => {
  const completeRun = {
    ...run,
    id: "run-result",
    status: "complete",
    phase: "complete",
    sourceCount: 18,
    unresolvedCount: 3,
  };
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: completeRun.id }) });
  });
  await page.route("**/api/v1/runs/run-result", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(completeRun) });
  });
  await page.route("**/api/v1/runs/run-result/result", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "complete",
        manifest: { id: "manifest-1", name: "Result playlist", contentHash: "abc", trackCount: 2 },
        volumes: [{
          volumeNumber: 1,
          volumeCount: 1,
          startPosition: 0,
          endPosition: 1,
          status: "complete",
          appleShareUrl: "https://music.apple.com/us/playlist/result/pl.test",
          appendedCount: 2,
        }],
        outcomeCounts: { accepted: 2 },
      }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-result");
  const resultHeading = page.getByRole("heading", { name: "Playlist published with gaps" });
  await expect(resultHeading).toBeVisible();
  await expect(resultHeading.locator("br")).toHaveCount(0);
  await expect(page.getByText("2 tracks published.", { exact: true })).toBeVisible();
  await expect(page.getByText("Evidence: 18 documented sources; 3 open gaps.", { exact: true })).toBeVisible();
  await expect(page.getByText("2 tracks", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /view evidence/i })).toHaveAttribute(
    "href",
    "/api/v1/runs/run-result/evidence",
  );
});

test("an exact curated target is complete even when reserve candidates were omitted", async ({ page }) => {
  const exactRun = {
    ...run,
    id: "run-exact-result",
    status: "partial",
    phase: "published_partial",
    brief: {
      ...curatedBrief,
      targetSize: { min: 50, max: 50 },
    },
    sourceCount: 10,
    unresolvedCount: 0,
  };
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: exactRun.id }) });
  });
  await page.route("**/api/v1/runs/run-exact-result", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(exactRun) });
  });
  await page.route("**/api/v1/runs/run-exact-result/result", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "partial",
        manifest: { id: "manifest-exact", name: "Berlin Techno Essentials", contentHash: "abc", trackCount: 50 },
        volumes: [{
          volumeNumber: 1,
          volumeCount: 1,
          startPosition: 0,
          endPosition: 49,
          status: "complete",
          appleShareUrl: "https://music.apple.com/us/playlist/berlin-techno-essentials/pl.test",
          appendedCount: 50,
        }],
        outcomeCounts: { accepted: 50, rejected: 50 },
      }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-exact-result");
  await expect(page.getByRole("heading", { name: "Playlist published" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /with gaps/i })).toHaveCount(0);
  await expect(page.getByText("50 tracks published.", { exact: true })).toBeVisible();
  await expect(page.getByText("Evidence: 10 documented sources; 0 open gaps.", { exact: true })).toBeVisible();
  await expect(page.getByText("50 tracks", { exact: true })).toBeVisible();
});

test("a below-target automatic playlist renders as a published partial result, never a failed task", async ({ page }) => {
  const partialRun = {
    ...run,
    id: "run-partial-shortfall-result",
    status: "partial",
    phase: "published_partial",
    error: null,
    brief: {
      ...curatedBrief,
      title: "Baile Funk Icons",
      targetSize: { min: 50, max: 50 },
    },
    sourceCount: 12,
    unresolvedCount: 0,
  };
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: partialRun.id }) });
  });
  await page.route("**/api/v1/runs/run-partial-shortfall-result", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(partialRun) });
  });
  await page.route("**/api/v1/runs/run-partial-shortfall-result/result", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "partial",
        manifest: { id: "manifest-partial", name: "Baile Funk Icons", contentHash: "partial", trackCount: 23 },
        volumes: [{
          volumeNumber: 1,
          volumeCount: 1,
          startPosition: 0,
          endPosition: 22,
          status: "complete",
          appleShareUrl: "https://music.apple.com/us/playlist/baile-funk-icons/pl.partial",
          appendedCount: 23,
        }],
        outcomeCounts: { accepted: 23, unavailable: 27 },
      }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-partial-shortfall-result");

  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Playlist published with gaps" })).toBeVisible();
  await expect(page.getByText("23 of 50 requested tracks published.", { exact: true })).toBeVisible();
  await expect(page.getByText("Evidence: 12 documented sources; 0 open gaps.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /open in apple music/i })).toHaveAttribute(
    "href",
    "https://music.apple.com/us/playlist/baile-funk-icons/pl.partial",
  );
  await expect(page.getByText(/failed task|no playlist was published/i)).toHaveCount(0);
});

test("a zero-match bounded search ends neutrally without claiming a playlist was published", async ({ page }) => {
  const emptyRun = {
    ...run,
    id: "run-empty-partial-result",
    status: "partial",
    phase: "catalog_matching_empty",
    error: null,
    brief: {
      ...curatedBrief,
      title: "Extremely obscure recordings",
      targetSize: { min: 25, max: 25 },
    },
    sourceCount: 2,
    unresolvedCount: 4,
  };
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: emptyRun.id }) });
  });
  await page.route("**/api/v1/runs/run-empty-partial-result", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyRun) });
  });
  await page.route("**/api/v1/runs/run-empty-partial-result/result", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "partial", manifest: null, volumes: [], outcomeCounts: {} }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-empty-partial-result");

  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No compatible tracks found" })).toBeVisible();
  await expect(page.getByText("0 of 25 requested tracks published.", { exact: true })).toBeVisible();
  await expect(page.getByText("[NO PLAYLIST]", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /open in apple music/i })).toHaveCount(0);
});

test("a transient restore failure preserves the durable run URL", async ({ page }) => {
  await page.route("**/api/v1/runs/run-transient", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Temporary service failure" }),
    });
  });

  await page.goto("/?run=run-transient");
  await expect(page.getByRole("alert")).toContainText("Temporary service failure");
  await expect.poll(() => page.evaluate(() => location.search)).toBe("?run=run-transient");
});

test("playlist generation waits for the complete track list", async ({ page }) => {
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  let releaseTracks!: () => void;
  const tracksGate = new Promise<void>((resolve) => { releaseTracks = resolve; });
  await page.route(/.*\/api\/v1\/runs\/run-1\/tracks.*/, async (route) => {
    await tracksGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{
          position: 0,
          candidateId: "candidate-ready",
          artist: "Artist",
          title: "Ready track",
          status: "accepted",
          catalogId: "apple-ready",
          song: { id: "apple-ready", name: "Ready track", artistName: "Artist" },
          alternatives: [],
          evidenceEligible: true,
          selected: true,
          selectable: true,
        }],
        page: 1,
        pageSize: 200,
        total: 1,
        totalPages: 1,
        selectableCount: 1,
        unmatchedCount: 0,
        retryableCount: 0,
        matchingComplete: true,
      }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  await expect(page.getByText("LOADING TRACKS")).toBeVisible();
  const generateButton = continueWithTracksButton(page);
  await expect(generateButton).toBeDisabled();
  releaseTracks();
  await expect(page.getByText("Ready track", { exact: true })).toBeVisible();
  await expect(generateButton).toBeEnabled();
});

test("duplicate or missing track pages cannot produce a playlist", async ({ page }) => {
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-1\/tracks.*/, async (route) => {
    const pageNumber = Number(new URL(route.request().url()).searchParams.get("page") ?? "1");
    const item = {
      position: pageNumber - 1,
      candidateId: "candidate-duplicate",
      artist: "Artist",
      title: `Track page ${pageNumber}`,
      status: "accepted",
      catalogId: `apple-${pageNumber}`,
      song: { id: `apple-${pageNumber}`, name: `Track page ${pageNumber}`, artistName: "Artist" },
      alternatives: [],
      evidenceEligible: true,
      selected: true,
      selectable: true,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [item],
        page: pageNumber,
        pageSize: 1,
        total: 2,
        totalPages: 2,
        selectableCount: 2,
        unmatchedCount: 0,
        retryableCount: 0,
        matchingComplete: true,
      }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  await expect(page.getByRole("alert")).toContainText("track list is incomplete");
  await expect(continueWithTracksButton(page)).toBeDisabled();
  await expect(page.getByRole("list", { name: "Playlist tracks" })).toHaveCount(0);
});

test("interactive controls meet the minimum touch target", async ({ page }) => {
  await openPrompt(page);
  const undersized = await page.locator("button:not([disabled]), a[href], textarea, input, select, summary").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return [];
      return rect.width < 44 || rect.height < 44
        ? [{ label: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName, width: rect.width, height: rect.height }]
        : [];
    }),
  );
  expect(undersized).toEqual([]);
});

test("desktop keyboard focus remains visible and primary text meets WCAG AA contrast", async ({ page }, testInfo) => {
  // Wait for the one-time intro to finish before editing the controlled field.
  // Otherwise the intro can replace the composer after `fill`, discarding the
  // value and leaving the CTA disabled on slower mobile projects.
  await openPrompt(page);
  const request = requestField(page);
  await request.fill("Every released song Paulinho da Costa performed on");
  const primary = page.getByRole("button", { name: /create playlist/i });
  // The enabled state is derived from React state. Under parallel responsive
  // coverage, the input event can commit one frame after Playwright's fill.
  await expect(primary).toBeEnabled();
  await primary.focus();
  await expect(primary).toBeFocused();

  for (const locator of [
    page.locator("body"),
    page.locator(".command-hero > p:last-child"),
    page.locator(".header-actions"),
    page.locator(".wordmark"),
  ]) {
    const colors = await locator.evaluate((element) => {
      const foreground = getComputedStyle(element).color;
      let current: Element | null = element;
      let background = "rgba(0, 0, 0, 0)";
      while (current && /rgba\([^)]*,\s*0\)$/u.test(background)) {
        background = getComputedStyle(current).backgroundColor;
        current = current.parentElement;
      }
      return { foreground, background };
    });
    expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);
  }

  if (testInfo.project.name === "desktop") {
    await primary.focus();
    await expect(primary).toBeFocused();
    const focusIndicator = await primary.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        color: style.outlineColor,
        style: style.outlineStyle,
        width: Number.parseFloat(style.outlineWidth),
      };
    });
    expect(focusIndicator).toMatchObject({ style: "solid", width: 2 });
    expect(focusIndicator.color).not.toBe("rgba(0, 0, 0, 0)");
  }
});
