import { expect, test } from "@playwright/test";

const brief = {
  title: "Baile Funk and Drill",
  description: "A source-backed cross-scene playlist.",
  mode: "curated",
  subjectEntities: ["baile funk", "drill"],
  relationship: "connects the production language of",
  include: ["released recordings"],
  exclude: ["weak metadata-only matches"],
  versionPolicy: "one canonical studio recording",
  evidencePolicy: "track-level scoped evidence",
  orderingPolicy: "interleave artists and scenes",
  targetSize: { min: 50, max: 50 },
  ambiguities: [],
};

function partialRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-partial-ready",
    prompt: "Baile funk and drill crossover",
    brief,
    status: "partial_ready",
    phase: "awaiting_partial_confirmation",
    pipelineVersion: "pipeline_v3",
    error: "A legacy shortfall error that the V3 UI must not show.",
    candidateCount: 96,
    sourceCount: 14,
    unresolvedCount: 2,
    autoPublish: true,
    pipelineOutcome: {
      status: "partial_evidence_shortfall",
      targetTrackCount: 50,
      qualifiedTrackCount: 37,
      selectedTrackCount: 37,
      reasonCodes: ["partial_evidence_shortfall"],
    },
    partialAction: {
      kind: "partial_confirmation",
      targetTrackCount: 50,
      qualifiedTrackCount: 37,
      remainingStrategyCount: 2,
      canContinueResearch: true,
      reasonCode: "partial_evidence_shortfall",
      outcomeVersion: 3,
      outcomeHash: "outcome-37",
      manifestId: "manifest-37",
      manifestHash: "manifest-hash-37",
    },
    ...overrides,
  };
}

test("a subject-specific scout asks one grounded question at a time", async ({ page }) => {
  await page.route("**/api/v1/brief", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        requestId: "brief-subject-specific",
        status: "awaiting_answers",
        brief,
        questions: [
          {
            id: "baile-lineage",
            header: "SCENE LINEAGE",
            question: "Which branch of baile funk should anchor the crossover?",
            whyMaterial: "The answer changes the artists, eras, and production vocabulary in the candidate pool.",
            grounding: {
              summary: "The scout found distinct Miami bass, tamborzão, and mandelão lineages rather than one interchangeable sound.",
              sourceUrls: ["https://example.com/baile-funk-history"],
            },
            options: [
              { id: "tamborzao", label: "Tamborzão foundations", description: "Start with the foundational Rio rhythm.", recommended: true },
              { id: "mandelao", label: "Mandelão pressure", description: "Center contemporary São Paulo low-end." },
              { id: "full-lineage", label: "Across the lineage", description: "Connect multiple eras and cities." },
            ],
          },
          {
            id: "drill-bridge",
            header: "CROSSOVER",
            question: "What should connect baile funk to drill?",
            whyMaterial: "The bridge determines which tracks qualify as genuine stylistic neighbors.",
            options: [
              { id: "rhythm", label: "Rhythmic kinship", description: "Prioritize drum and swing connections.", recommended: true },
              { id: "scene", label: "Scene exchange", description: "Prioritize documented artist and producer exchange." },
              { id: "atmosphere", label: "Dark atmosphere", description: "Prioritize tonal and vocal resemblance." },
            ],
          },
        ],
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("textbox", { name: "PLAYLIST REQUEST" }).fill("Baile funk and drill crossover");
  await page.getByRole("button", { name: /create playlist · 50 tracks/i }).click();

  await expect(page.getByText("QUESTION 1 OF 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /which branch of baile funk/i })).toBeVisible();
  await expect(page.getByText(/distinct Miami bass, tamborzão, and mandelão lineages/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "example.com" })).toHaveAttribute("href", "https://example.com/baile-funk-history");
  await expect(page.getByRole("heading", { name: /what should connect/i })).toHaveCount(0);

  await page.getByRole("radio", { name: /Tamborzão foundations/i }).locator("..").click();
  await page.getByRole("button", { name: "NEXT →" }).click();
  await expect(page.getByText("QUESTION 2 OF 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /what should connect baile funk to drill/i })).toBeVisible();
});

test("route drift fails closed while truthful evidence units remain distinct", async ({ page }) => {
  const run = partialRun({
    id: "run-route-drift",
    status: "researching",
    phase: "source_discovery",
    pipelineVersion: "catalog_first_v2",
    partialAction: null,
    actionRequired: null,
    pipelineOutcome: null,
    sourceCount: 1_005,
    candidateCount: 1_005,
    unresolvedCount: 77,
    executionRouteReceipt: {
      version: "execution_route_receipt_v1",
      trafficClass: "public",
      contractVersion: 3,
      guidanceVersion: "adaptive_guidance_v5",
      executionRoute: "corpus_first_v3",
      queryPlanSchema: 6,
      queryPlanHash: "1".repeat(64),
      capabilitySnapshotHash: "2".repeat(64),
      releaseRevision: "3".repeat(40),
      executorConfigurationHash: "4".repeat(64),
      assignmentKind: "signed_public_direct_exposure",
      intentGroup: "editorial_influence",
      receiptHash: "5".repeat(64),
    },
    evidenceCoverage: {
      observationCount: 1_005,
      qualificationObservationCount: 77,
      legacyUnboundQualificationCount: 0,
      uniqueLeadCount: 189,
      materializedCandidateCount: 77,
      candidates: 77,
      identityBound: 77,
      appleResolvedCount: 73,
      versionCompatible: 73,
      storefrontPlayable: 73,
      obligationCounts: {
        historical_influence: { pass: 0, fail: 0, unknown: 77 },
      },
      evidencePassed: 0,
      evidenceUnknown: 77,
      evidenceFailed: 0,
      selected: 0,
      manifested: 0,
      appendedCount: 0,
      reconciledPublished: null,
    },
    resolution: {
      generation: 2,
      state: "executing",
      workMotion: "running",
      nextAction: "none",
      terminal: false,
      contractRevisionId: "contract-revision",
      contractRevision: 1,
      contractHash: "6".repeat(64),
      blocker: null,
    },
  });
  await page.route("**/api/v1/runs/run-route-drift", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(run),
    });
  });

  await page.goto("/?run=run-route-drift");

  await expect(page.getByRole("heading", {
    name: "Your playlist needs technical repair",
  })).toBeVisible();
  const indicator = page.getByTestId("working-indicator");
  await expect(indicator).toHaveAttribute("data-motion", "action-required");
  await expect(indicator.locator(".working-live-state"))
    .toContainText("ROUTE UNVERIFIED");
  await expect(indicator.locator(".working-live-state"))
    .not.toContainText("LIVE");
  await expect(indicator.locator(".working-facts"))
    .toContainText("SOURCES189");
  await expect(indicator.locator(".working-facts"))
    .toContainText("DISCOVERED77");
  await expect(indicator.locator(".working-facts"))
    .toContainText("OBSERVATIONS1,005");
  await expect(page.getByTestId("route-authority-error")).toContainText(
    "The execution route presented by this screen could not be verified",
  );
  await expect(page.getByTestId("technical-evidence-coverage")).toHaveCount(0);
  await expect(page.getByRole("link", {
    name: "REPORT TECHNICAL ISSUE →",
  })).toBeVisible();
});

test("a shortfall pauses durably and continues only after the visitor chooses it", async ({ page }) => {
  let currentRun: Record<string, unknown> = partialRun();
  let continueBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/runs/run-partial-ready", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentRun) });
  });
  await page.route("**/api/v1/runs/run-partial-ready/research/continue", async (route) => {
    continueBody = route.request().postDataJSON() as Record<string, unknown>;
    currentRun = {
      ...currentRun,
      status: "researching",
      phase: "source_discovery",
      error: null,
      partialAction: null,
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentRun) });
  });

  await page.goto("/?run=run-partial-ready");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("partial-decision-screen")).toBeVisible();
  await expect(page.getByRole("heading", { name: "37 verified tracks are ready" })).toBeVisible();
  await expect(page.getByText(/No playlist has been published yet/i)).toBeVisible();
  await expect(page.getByText("37", { exact: true })).toBeVisible();
  await expect(page.getByText("50", { exact: true })).toBeVisible();
  await expect(page.getByText("13", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "RUN ONE MORE BOUNDED PASS →" }).click();
  await expect.poll(() => continueBody).toEqual({ outcomeVersion: 3 });
  await expect(page.getByRole("heading", { name: "Researching your playlist" })).toBeVisible();
  await expect(page.getByTestId("working-indicator")).toHaveAttribute("data-stage", "discover");
  await expect(page.getByRole("progressbar", { name: /catalog-ready tracks/i })).toBeVisible();
});

test("partial publication is explicit and uses the immutable confirmation identifiers", async ({ page }) => {
  let currentRun: Record<string, unknown> = partialRun();
  let confirmationBody: Record<string, unknown> | null = null;
  let legacyPublishCalls = 0;
  await page.route("**/api/v1/runs/run-partial-ready", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentRun) });
  });
  await page.route("**/api/v1/runs/run-partial-ready/partial/confirm", async (route) => {
    confirmationBody = route.request().postDataJSON() as Record<string, unknown>;
    currentRun = {
      ...currentRun,
      status: "publishing",
      phase: "publication",
      partialAction: null,
      error: null,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ run: currentRun }),
    });
  });
  await page.route("**/api/v1/runs/run-partial-ready/publish", async (route) => {
    legacyPublishCalls += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "must not be called" }) });
  });

  await page.goto("/?run=run-partial-ready");
  await expect.poll(() => confirmationBody).toBeNull();
  await page.getByRole("button", { name: "PUBLISH 37 VERIFIED TRACKS" }).click();
  await expect.poll(() => confirmationBody).toEqual({
    outcomeHash: "outcome-37",
    manifestId: "manifest-37",
    manifestHash: "manifest-hash-37",
  });
  await expect.poll(() => legacyPublishCalls).toBe(0);
  await expect(page.getByRole("heading", { name: "Creating your playlist" })).toBeVisible();
});

test("zero compatible tracks stays neutral and can retry the immutable request under the updated policy", async ({ page }) => {
  const run = partialRun({
    id: "run-zero-compatible",
    status: "no_compatible_tracks",
    phase: "awaiting_partial_confirmation",
    pipelineOutcome: {
      status: "no_compatible_tracks",
      targetTrackCount: 25,
      qualifiedTrackCount: 0,
      selectedTrackCount: 0,
    },
    partialAction: {
      kind: "partial_confirmation",
      targetTrackCount: 25,
      qualifiedTrackCount: 0,
      remainingStrategyCount: 0,
      canContinueResearch: false,
      reasonCode: "no_compatible_tracks",
      outcomeHash: "outcome-zero",
    },
  });
  let cancelCalls = 0;
  await page.route("**/api/v1/runs/run-zero-compatible", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.route("**/api/v1/runs/run-zero-compatible/cancel", async (route) => {
    cancelCalls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/?run=run-zero-compatible");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No verified tracks are ready yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "NO VERIFIED TRACKS TO PUBLISH" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /continue research/i })).toHaveCount(0);
  await page.getByRole("button", { name: "RETRY WITH UPDATED INTERPRETATION" }).click();
  await expect(page.getByRole("heading", { name: "Create a playlist" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "PLAYLIST REQUEST" })).toHaveValue("Baile funk and drill crossover");
  await expect(page.getByRole("button", { name: /create playlist · 25 tracks/i })).toBeVisible();
  await expect.poll(() => cancelCalls).toBe(0);
});

test("Explore listing is opt-in and independent from the Apple share link", async ({ page }) => {
  const run = {
    ...partialRun(),
    id: "run-complete",
    status: "complete",
    phase: "complete",
    error: null,
    partialAction: null,
    brief: { ...brief, targetSize: { min: 25, max: 25 } },
  };
  let exploreBody: Record<string, unknown> | null = null;
  await page.route("**/api/v1/runs/run-complete", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.route("**/api/v1/runs/run-complete/result", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runId: run.id,
        status: "complete",
        title: "Baile Funk and Drill",
        requestedTrackCount: 25,
        sourceCount: 12,
        unresolvedGapCount: 0,
        volumes: [{ index: 1, name: "Baile Funk and Drill", url: "https://music.apple.com/us/playlist/test/pl.123", trackCount: 25 }],
        outcomeCounts: { accepted: 25 },
        explore: { eligible: true, listed: false, canChange: true },
      }),
    });
  });
  await page.route("**/api/v1/runs/run-complete/explore", async (route) => {
    exploreBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ explore: { eligible: true, listed: true, canChange: true } }),
    });
  });

  await page.goto("/?run=run-complete");
  await expect(page.getByRole("heading", { name: "Private from Explore" })).toBeVisible();
  await expect(page.getByText(/Apple Music link still works/i)).toBeVisible();
  await page.getByRole("button", { name: "LIST IN EXPLORE" }).click();
  await expect.poll(() => exploreBody).toEqual({ listed: true });
  await expect(page.getByRole("heading", { name: "Visible in Explore" })).toBeVisible();
  await expect(page.getByRole("button", { name: "REMOVE FROM EXPLORE" })).toBeVisible();
});
