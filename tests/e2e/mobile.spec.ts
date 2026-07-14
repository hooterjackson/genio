import { expect, test, type Page } from "@playwright/test";

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

const brief = {
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

const estimate = {
  minimumUsd: 4.25,
  maximumUsd: 9.5,
  approvalUsd: 9.5,
  factors: [
    { label: "open-ended exhaustive research", minimumUsd: 2.5, maximumUsd: 4 },
    { label: "unbounded source frontier", minimumUsd: 1.5, maximumUsd: 3 },
    { label: "track-level relationship verification", minimumUsd: 0.25, maximumUsd: 2.5 },
  ],
};

const curatedBrief = {
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

const fastEstimate = {
  minimumUsd: 0.1,
  maximumUsd: 0.5,
  approvalUsd: 0.5,
  factors: [{ label: "time-boxed curated research", minimumUsd: 0.1, maximumUsd: 0.5 }],
};

async function openPrompt(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /go past the first 25/i })).toBeVisible();
  await page.getByRole("button", { name: /research a playlist/i }).click();
  await expect(page.getByRole("heading", { name: /what should needle build/i })).toBeVisible();
}

test("the request and scope flow remains usable at mobile widths", async ({ page }) => {
  await page.route("**/api/v1/brief", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brief, estimateUsd: estimate.approvalUsd, estimate, cached: false }),
    });
  });

  await openPrompt(page);
  const example = page.getByRole("button", { name: "Paulinho da Costa’s 100 most influential songs" });
  await example.click();
  await expect(example).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel(/playlist request/i)).toHaveValue("Paulinho da Costa’s 100 most influential songs");
  await page.getByRole("button", { name: /back/i }).click();
  await expect(page.getByRole("heading", { name: /go past the first 25/i })).toBeVisible();
  await page.getByRole("button", { name: /research a playlist/i }).click();
  await page.getByLabel(/playlist request/i).fill("Every released song Paulinho da Costa performed on");
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page.getByRole("heading", { name: brief.title })).toBeVisible();
  await expect(page.getByText("[DEEP · SOURCE FRONTIER]", { exact: true })).toBeVisible();
  await expect(page.getByText("Source-bounded completeness attempt; unresolved evidence stays visible.")).toBeVisible();
  await expect(page.getByRole("button", { name: /start deep research/i })).toBeVisible();
  await expect(page.getByText("$4.25–$9.50")).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("curated requests are clearly labeled as the time-boxed fast path", async ({ page }) => {
  await page.route("**/api/v1/brief", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brief: curatedBrief, estimateUsd: fastEstimate.approvalUsd, estimate: fastEstimate, cached: false }),
    });
  });

  await openPrompt(page);
  await page.getByLabel(/playlist request/i).fill("Influential Berlin techno");
  await page.getByRole("button", { name: /continue/i }).click();

  await expect(page.getByText("[FAST · <2 MIN TARGET]", { exact: true })).toBeVisible();
  await expect(page.getByText("Cited editorial selection; partial results stay visible if the time box closes.")).toBeVisible();
  await expect(page.getByRole("button", { name: /start fast research/i })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("an active fast run keeps its profile and concise phase message visible", async ({ page }) => {
  const fastRun = {
    ...run,
    id: "run-fast",
    brief: curatedBrief,
    status: "researching",
    phase: "fast_research",
    candidateCount: 24,
    sourceCount: 4,
    unresolvedCount: 0,
  };
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: fastRun.id }) });
  });
  await page.route("**/api/v1/runs/run-fast", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fastRun) });
  });

  await page.goto("/#cap=one-time-secret&run=run-fast");
  await expect(page.getByText("[FAST · RESEARCHING]", { exact: true })).toBeVisible();
  await expect(page.getByText("Fast mode is building a cited editorial selection inside a fixed research window.")).toBeVisible();
});

test("material scope assumptions must be accepted and are preserved in the confirmed brief", async ({ page }) => {
  const ambiguities = ["Include credited guest appearances", "Use the first released studio version"];
  const ambiguousBrief = { ...brief, ambiguities };
  await page.route("**/api/v1/brief", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brief: ambiguousBrief, estimateUsd: estimate.approvalUsd, estimate, cached: false }),
    });
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
  await page.getByLabel(/playlist request/i).fill("Every released song Paulinho da Costa performed on");
  await page.getByRole("button", { name: /continue/i }).click();

  const confirm = page.getByRole("button", { name: /start deep research/i });
  await expect(confirm).toBeDisabled();
  const acceptance = page.getByRole("checkbox", { name: /i accept this scope/i });
  await acceptance.check();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  const body = await runRequest;
  const confirmed = body.brief as typeof ambiguousBrief & { ambiguityAcceptance?: string[] };
  expect(confirmed.ambiguities).toEqual(ambiguities);
  expect(confirmed.ambiguityAcceptance).toEqual(ambiguities);
});

test("capabilities are exchanged and removed from the URL fragment", async ({ page }) => {
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-1\/exceptions.*/, async (route) => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      candidateId: `candidate-${index}`,
      artist: "Artist",
      title: `Uncertain track ${index + 1}`,
      album: "Album",
      basis: "version conflict",
      status: "review",
      alternatives: [],
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items, page: 1, pageSize: 20, total: 21, totalPages: 2 }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  await expect(page.getByRole("heading", { name: "Uncertain track 1" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await expect(page.getByText("[1 OF 21]", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Uncertain track 2" })).toHaveCount(0);
  await expect(page.locator(".exception-choices")).toHaveCount(1);
});

test("the primary Apple match is selectable once even when alternatives repeat it", async ({ page }) => {
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-1\/exceptions.*/, async (route) => {
    const primary = { id: "apple-primary", name: "Primary recording", artistName: "Artist", albumName: "Album" };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{
          candidateId: "candidate-primary",
          artist: "Artist",
          title: "Uncertain track",
          album: "Album",
          basis: "version conflict",
          status: "review",
          song: primary,
          alternatives: [
            primary,
            { id: "apple-alternative", name: "Alternate recording", artistName: "Artist", albumName: "Album" },
          ],
        }],
        page: 1,
        pageSize: 20,
        total: 1,
        totalPages: 1,
        unresolvedCount: 1,
      }),
    });
  });

  let captureReview!: (body: Record<string, unknown>) => void;
  const reviewRequest = new Promise<Record<string, unknown>>((resolve) => { captureReview = resolve; });
  await page.route("**/api/v1/runs/run-1/review", async (route) => {
    captureReview(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reviewed: true, decision: "accepted" }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  const primaryChoice = page.getByRole("button", { name: /use this match primary recording/i });
  await expect(primaryChoice).toHaveCount(1);
  await expect(page.getByRole("button", { name: /use this match alternate recording/i })).toBeVisible();
  expect(await page.locator(".exception-actions button").evaluateAll((buttons) => buttons.every((button) => {
    const rect = button.getBoundingClientRect();
    return rect.width >= 44 && rect.height >= 44;
  }))).toBe(true);
  await primaryChoice.click();
  const reviewBody = await reviewRequest;
  expect(reviewBody.catalogId).toBe("apple-primary");
  expect((reviewBody.song as { id?: string } | undefined)?.id).toBe("apple-primary");
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
  await expect(page.getByRole("heading", { name: "PUBLISHED." })).toBeVisible();
  await expect(page.getByText("Published from 18 documented sources with 3 visible gaps.")).toBeVisible();
  await expect(page.getByText("2 tracks")).toBeVisible();
  await expect(page.getByRole("link", { name: /view evidence/i })).toHaveAttribute(
    "href",
    "/api/v1/runs/run-result/evidence",
  );
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

test("manifest locking waits for the first exception page", async ({ page }) => {
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: run.id }) });
  });
  await page.route("**/api/v1/runs/run-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  let releaseExceptions!: () => void;
  const exceptionGate = new Promise<void>((resolve) => { releaseExceptions = resolve; });
  await page.route(/.*\/api\/v1\/runs\/run-1\/exceptions.*/, async (route) => {
    await exceptionGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 0, unresolvedCount: 0 }),
    });
  });

  await page.goto("/#cap=one-time-secret&run=run-1");
  await expect(page.getByText("LOADING EXCEPTIONS")).toBeVisible();
  const lockButton = page.getByRole("button", { name: /lock playlist/i });
  await expect(lockButton).toBeDisabled();
  releaseExceptions();
  await expect(page.getByText("[NO EXCEPTIONS]")).toBeVisible();
  await expect(lockButton).toBeEnabled();
});

test("interactive controls meet the minimum touch target", async ({ page }) => {
  await openPrompt(page);
  const undersized = await page.locator("button:not([disabled]), a[href], textarea, input, summary").evaluateAll((elements) =>
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
  await page.goto("/");
  const primary = page.getByRole("button", { name: /research a playlist/i });
  await primary.focus();
  await expect(primary).toBeFocused();

  for (const locator of [
    page.locator("body"),
    page.locator(".intro-copy p"),
    page.locator(".screen-index"),
    page.locator(".intro-mark"),
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
    await primary.click();
    const request = page.getByLabel(/playlist request/i);
    await expect(request).toBeFocused();
    await request.fill("Every released song Paulinho da Costa performed on");
    expect(await request.evaluate((element) => getComputedStyle(element).outlineColor)).toBe("rgb(224, 96, 41)");
  }
});
