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
  await expect(page.getByRole("heading", { name: /research a playlist/i })).toBeVisible();
  await page.getByRole("button", { name: /new playlist/i }).click();
  await expect(page.getByRole("heading", { name: /enter a request/i })).toBeVisible();
}

function requestField(page: Page) {
  return page.getByRole("textbox", { name: /request/i });
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
  await expect(requestField(page)).toHaveValue("Paulinho da Costa’s 100 most influential songs");
  await page.getByRole("button", { name: /back/i }).click();
  await expect(page.getByRole("heading", { name: /research a playlist/i })).toBeVisible();
  await page.getByRole("button", { name: /new playlist/i }).click();
  await requestField(page).fill("Every released song Paulinho da Costa performed on");
  await page.getByRole("button", { name: /review request/i }).click();
  await expect(page.getByRole("heading", { name: brief.title })).toBeVisible();
  await expect(page.getByText("[EXHAUSTIVE · LONGER RUN]", { exact: true })).toBeVisible();
  await expect(page.getByText("Searches the configured sources for all documented matches and reports unresolved gaps.")).toBeVisible();
  await expect(page.getByRole("button", { name: /start research/i })).toBeVisible();
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
  await requestField(page).fill("Influential Berlin techno");
  await page.getByRole("button", { name: /review request/i }).click();

  await expect(page.getByText("[CURATED · UNDER 2 MIN TARGET]", { exact: true })).toBeVisible();
  await expect(page.getByText("Returns a cited selection within a two-minute target. Partial results remain available if time expires.")).toBeVisible();
  await expect(page.getByRole("button", { name: /start research/i })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
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
  };
  const matchingRun = {
    ...fastRun,
    status: "matching",
    phase: "catalog_matching",
    candidateCount: 100,
    sourceCount: 10,
  };
  const reviewRun = {
    ...matchingRun,
    status: "visitor_review",
    phase: "exception_review",
  };
  const tracks = Array.from({ length: 100 }, (_, index) => ({
    position: index,
    candidateId: `candidate-100-${index}`,
    artist: `Artist ${index + 1}`,
    title: `Influential track ${index + 1}`,
    album: `Album ${index + 1}`,
    status: "accepted",
    catalogId: `apple-100-${index}`,
    song: {
      id: `apple-100-${index}`,
      name: `Influential track ${index + 1}`,
      artistName: `Artist ${index + 1}`,
      albumName: `Album ${index + 1}`,
    },
    alternatives: [],
    evidenceEligible: true,
    selected: true,
    selectable: true,
  }));

  let briefBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/brief", async (route) => {
    briefBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brief: exactBrief, estimateUsd: fastEstimate.approvalUsd, estimate: fastEstimate, cached: false }),
    });
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
  await page.route("**/api/v1/runs/run-100", async (route) => {
    const states = [fastRun, matchingRun, reviewRun];
    const next = states[Math.min(statusRead, states.length - 1)]!;
    statusRead += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(next) });
  });
  await page.route(/.*\/api\/v1\/runs\/run-100\/tracks.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: tracks,
        page: 1,
        pageSize: 500,
        total: 100,
        totalPages: 1,
        selectableCount: 100,
        unmatchedCount: 0,
        retryableCount: 0,
        matchingComplete: true,
      }),
    });
  });

  let selectionBody: Record<string, unknown> | null = null;
  const manifestTracks = tracks.map((track) => ({
    position: track.position,
    candidateId: track.candidateId,
    catalogId: track.catalogId,
    artist: track.artist,
    title: track.title,
  }));
  await page.route("**/api/v1/runs/run-100/selection", async (route) => {
    selectionBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "manifest-100",
        runId: fastRun.id,
        name: exactBrief.title,
        contentHash: "manifest-hash-100",
        trackCount: 100,
        tracks: manifestTracks,
      }),
    });
  });
  let publishBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/runs/run-100/publish", async (route) => {
    publishBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ ...reviewRun, status: "publishing", phase: "publication" }),
    });
  });

  await openPrompt(page);
  await requestField(page).fill(prompt);
  await page.getByRole("button", { name: /review request/i }).click();
  await expect(page.getByText("100–100 tracks", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /start research/i }).click();

  await expect(page.getByRole("heading", { name: "SELECT TRACKS." })).toBeVisible();
  await expect(page.getByText("100 OF 100 MATCHED TRACKS SELECTED", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(100);
  await expect(page.getByText("Influential track 100", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /generate playlist/i }).click();

  expect(briefBody).toMatchObject({ prompt });
  expect(runBody).toMatchObject({ brief: { targetSize: { min: 100, max: 100 } } });
  expect(selectionBody).toEqual({ useRecommended: true, excludedCandidateIds: [], overrides: [] });
  expect(manifestTracks).toHaveLength(100);
  await expect.poll(() => publishBody).toEqual({ manifestId: "manifest-100" });
  await expect(page.getByText("Creating the playlist in Apple Music.")).toBeVisible();
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
  await page.getByRole("button", { name: /generate playlist/i }).click();

  await expect.poll(() => selectionBody).toEqual({
    useRecommended: true,
    excludedCandidateIds: Array.from({ length: 6 }, (_, index) => `candidate-50-${index + 50}`),
    overrides: [],
  });
  await expect(page.getByRole("heading", { name: "50 TRACKS READY." })).toBeVisible();
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
  await page.getByRole("button", { name: /generate playlist/i }).click();

  await expect.poll(() => selectionBody).toEqual({
    useRecommended: true,
    excludedCandidateIds: Array.from({ length: 100 }, (_, index) => `candidate-200-${index + 200}`),
    overrides: [],
  });
  await expect(page.getByRole("heading", { name: "200 TRACKS READY." })).toBeVisible();
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
  await expect(page.getByText("[CURATED · RESEARCHING]", { exact: true })).toBeVisible();
  await expect(page.getByText("Finding and verifying cited tracks.")).toBeVisible();
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

  await page.goto("/");
  await page.getByRole("button", { name: "JOBS" }).click();
  await expect(page.getByRole("heading", { name: "JOBS" })).toBeVisible();
  await expect(page.getByText(brief.title)).toBeVisible();
  await page.getByRole("button", { name: /open/i }).click();
  await expect(page.getByRole("heading", { name: /research in progress/i })).toBeVisible();
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
  await page.getByRole("button", { name: "NEW JOB", exact: true }).click();
  await expect(page.getByRole("heading", { name: /enter a request/i })).toBeVisible();
  await expect(requestField(page)).toHaveValue("");
  expect(deletes).toEqual([]);
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
  await requestField(page).fill("Every released song Paulinho da Costa performed on");
  await page.getByRole("button", { name: /review request/i }).click();

  const confirm = page.getByRole("button", { name: /start research/i });
  await expect(confirm).toBeDisabled();
  const acceptance = page.getByRole("checkbox", { name: /i accept these assumptions/i });
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
  await expect(page.getByRole("heading", { name: "SELECT TRACKS." })).toBeVisible();
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
  const generate = page.getByRole("button", { name: /generate playlist/i });
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
  await expect(page.getByRole("button", { name: /generate playlist/i })).toBeDisabled();
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
  await expect(page.getByRole("heading", { name: /research in progress/i })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "SELECT TRACKS." })).toBeVisible();
  await expect(page.getByText("Apple Music matching is incomplete for 1 track. Retry matching before generating a playlist.", { exact: true })).toBeVisible();
  await expect(page.getByText("NEEDS MATCH", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "SELECT ALL", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: /generate playlist/i })).toBeDisabled();
  const retry = page.getByRole("button", { name: "Retry Apple Music matching for 1 track" });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.getByRole("heading", { name: /research in progress/i })).toBeVisible();
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
  await expect(page.getByRole("button", { name: /generate playlist/i })).toBeDisabled();

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
  await page.getByRole("button", { name: /generate playlist/i }).click();
  await expect.poll(() => selectionBody).toEqual({
    selected: [{ candidateId: "candidate-manual-choice", catalogId: "apple-title-only-alternative" }],
  });
});

test("one Generate playlist action saves the list and starts Apple publication", async ({ page }) => {
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
  await page.getByRole("button", { name: /generate playlist/i }).click();
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
  await page.getByRole("button", { name: /generate playlist/i }).click();
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
  await page.getByRole("button", { name: /generate playlist/i }).click();
  await started;
  await page.getByRole("button", { name: "NEW JOB", exact: true }).click();
  await expect(page.getByRole("heading", { name: /enter a request/i })).toBeVisible();
  releaseSelection();
  await page.waitForTimeout(50);
  await expect(page.getByRole("heading", { name: /enter a request/i })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "PLAYLIST PUBLISHED WITH GAPS." })).toBeVisible();
  await expect(page.getByText("Published from 18 documented sources with 3 visible gaps.")).toBeVisible();
  await expect(page.getByText("2 tracks")).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "PLAYLIST PUBLISHED." })).toBeVisible();
  await expect(page.getByRole("heading", { name: /with gaps/i })).toHaveCount(0);
  await expect(page.getByText("Published from 10 documented sources with 0 visible gaps.")).toBeVisible();
  await expect(page.getByText("50 tracks")).toBeVisible();
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
  const generateButton = page.getByRole("button", { name: /generate playlist/i });
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
  await expect(page.getByRole("button", { name: /generate playlist/i })).toBeDisabled();
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
  await page.goto("/");
  const primary = page.getByRole("button", { name: /new playlist/i });
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
    const request = requestField(page);
    await expect(request).toBeFocused();
    await request.fill("Every released song Paulinho da Costa performed on");
    expect(await request.evaluate((element) => getComputedStyle(element).outlineColor)).toBe("rgb(224, 96, 41)");
  }
});
