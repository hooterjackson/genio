import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const questionSetHash = "9".repeat(64);
const artistIdentityQuestionSetHash = "8".repeat(64);
const artistQuestion = {
  id: "guidance:artist-exclusion",
  header: "Artist exclusion",
  question: "Which exact artist should be excluded?",
  criticality: "required",
  selectionMode: "single",
  allowCustom: true,
  options: [{
    id: "keep_current_interpretation",
    label: "Keep the current interpretation",
    description: "Do not add an artist exclusion.",
    recommended: false,
  }],
};
const artistBrief = {
  title: "Nuanced dance set",
  description: "A polished dance playlist.",
  mode: "curated",
  subjectEntities: ["dance music"],
  relationship: "qualifies for the requested dance set",
  include: ["polished dance tracks"],
  exclude: [],
  versionPolicy: "canonical studio recordings",
  evidencePolicy: "documented track-level scope",
  orderingPolicy: "smooth editorial flow",
  targetSize: { min: 50, max: 50 },
  ambiguities: [],
};
const persistedArtistIdentityQuestion = {
  id: "guidance:artist-identity:persisted",
  header: "Choose exact artist",
  question: "Which Apple Music artist named “Bad Bunny” should be excluded?",
  axis: "exact_artist_identity",
  trigger: "correctness",
  criticality: "required",
  selectionMode: "single",
  allowCustom: false,
  whyMaterial: "The same artist name maps to multiple Apple Music identities. Choose one stable profile, or keep the current interpretation unchanged.",
  interpretationSummary: {
    mustHave: ["polished dance tracks"],
    prefer: [],
    avoid: ["No recordings by Bad Bunny"],
    flow: ["smooth editorial flow"],
    count: 50,
  },
  options: [
    {
      id: "keep_current_interpretation",
      label: "Keep current interpretation",
      description: "Do not add this artist exclusion.",
      recommended: true,
    },
    {
      id: "exclude_artist_0123456789abcdef",
      label: "Bad Bunny · 1126808565",
      description: "Exclude Apple Music artist 1126808565. Genres: Latin.",
      recommended: false,
    },
    {
      id: "exclude_artist_fedcba9876543210",
      label: "Bad Bunny · 998877",
      description: "Exclude Apple Music artist 998877.",
      recommended: false,
    },
  ],
};

type GuidanceAttempt = {
  idempotencyHeader: string | null;
  idempotencyBody: string | null;
  customText: string | null;
};

async function mockArtistGuidance(
  context: BrowserContext,
  input: {
    requestId: string;
    answerFailure: (attempt: number) => {
      status: number;
      body: Record<string, unknown>;
      headers?: Record<string, string>;
    };
  },
): Promise<GuidanceAttempt[]> {
  const attempts: GuidanceAttempt[] = [];
  await context.route("**/api/v1/brief**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/v1/brief" && request.method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requestId: input.requestId,
          status: "awaiting_answers",
          brief: artistBrief,
          requestedTrackCount: 50,
          originalRequestedTrackCount: 50,
          questionSetHash,
          questions: [artistQuestion],
        }),
      });
      return;
    }
    if (
      pathname === `/api/v1/brief/${input.requestId}/answers`
      && request.method() === "POST"
    ) {
      const body = request.postDataJSON() as {
        idempotencyKey?: unknown;
        answers?: Array<{ customText?: unknown }>;
      };
      attempts.push({
        idempotencyHeader: request.headers()["idempotency-key"] ?? null,
        idempotencyBody: typeof body.idempotencyKey === "string"
          ? body.idempotencyKey
          : null,
        customText: typeof body.answers?.[0]?.customText === "string"
          ? body.answers[0].customText
          : null,
      });
      const failure = input.answerFailure(attempts.length);
      await route.fulfill({
        status: failure.status,
        contentType: "application/json",
        headers: failure.headers,
        body: JSON.stringify({
          requestId: input.requestId,
          questionSetHash,
          questions: [artistQuestion],
          ...failure.body,
        }),
      });
      return;
    }
    await route.fallback();
  });
  return attempts;
}

async function openArtistGuidance(page: Page, customText: string): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create a playlist" })).toBeVisible();
  await page.getByRole("textbox", { name: /playlist request/i })
    .fill("A nuanced dance playlist with one exact artist excluded");
  await page.getByRole("button", { name: /create playlist/i }).click();
  await expect(page.getByRole("heading", { name: artistQuestion.question })).toBeVisible();
  await page.getByRole("radio", { name: /something else/i }).locator("..").click();
  await page.getByRole("textbox", { name: "Something else" }).fill(customText);
  await page.getByRole("button", { name: /create playlist/i }).click();
}

for (const clarification of [
  {
    status: 409,
    code: "exact_artist_identity_clarification_required",
    reason: "artist_identity_ambiguous",
    label: "ambiguous artist",
    error: "More than one Apple Music artist exactly matches “Phoenix”. Choose the exact artist.",
  },
  {
    status: 409,
    code: "exact_artist_identity_clarification_required",
    reason: "artist_not_found",
    label: "zero-result artist",
    error: "Apple Music could not verify an exact artist named “Phonix”. Check the artist name.",
  },
  {
    status: 503,
    code: "artist_identity_resolution_configuration",
    reason: "configuration",
    label: "artist verification quarantine",
    error: "Apple artist verification needs operator attention. Your current playlist interpretation is unchanged.",
  },
] as const) {
  test(`${clarification.label} recovery preserves text and unlocks a new-key edit`, async ({
    context,
    page,
  }) => {
    const attempts = await mockArtistGuidance(context, {
      requestId: `brief-${clarification.reason}`,
      answerFailure: () => ({
        status: clarification.status,
        body: {
          status: clarification.status === 409 ? "needs_input" : "quarantined",
          code: clarification.code,
          nextAction: clarification.status === 409
            ? "edit_interpretation"
            : "contact_support",
          reason: clarification.reason,
          error: clarification.error,
        },
      }),
    });

    await openArtistGuidance(page, "no Phoenix");

    const custom = page.getByRole("textbox", { name: "Something else" });
    await expect(page.getByText(clarification.error)).toBeVisible();
    await expect(custom).toBeEnabled();
    await expect(custom).toHaveValue("no Phoenix");
    if (clarification.code === "artist_identity_resolution_configuration") {
      await expect(
        page.getByRole("button", { name: /try a different artist/i }),
      ).toBeVisible();
    }
    const editArtist = page.getByRole("button", { name: /edit artist/i });
    await expect(editArtist).toBeVisible();
    await editArtist.click();
    await expect(custom).toBeFocused();
    await custom.fill("no Phoenix Band");
    await page.getByRole("button", { name: /verify artist/i }).click();
    await expect.poll(() => attempts.length).toBe(2);

    expect(attempts[0]).toMatchObject({
      idempotencyHeader: expect.any(String),
      idempotencyBody: expect.any(String),
      customText: "no Phoenix",
    });
    expect(attempts[0]?.idempotencyHeader).toBe(attempts[0]?.idempotencyBody);
    expect(attempts[1]).toMatchObject({
      idempotencyHeader: expect.any(String),
      idempotencyBody: expect.any(String),
      customText: "no Phoenix Band",
    });
    expect(attempts[1]?.idempotencyHeader).toBe(attempts[1]?.idempotencyBody);
    expect(attempts[1]?.idempotencyHeader).not.toBe(attempts[0]?.idempotencyHeader);
  });
}

test("a persisted exact-artist question selects a server-owned profile through the normal guidance flow", async ({
  context,
  page,
}) => {
  const requestId = "brief-persisted-artist-identity";
  const selectedOptionId = persistedArtistIdentityQuestion.options[1]!.id;
  const answerBodies: Array<{
    questionSetHash?: unknown;
    answers?: Array<{ optionId?: unknown; customText?: unknown }>;
  }> = [];
  const persistedRun = {
    id: "run-persisted-artist-identity",
    prompt: "A nuanced dance playlist with Bad Bunny excluded",
    brief: artistBrief,
    status: "researching",
    phase: "v3_retrieval",
    autoPublish: true,
    error: null,
    candidateCount: 0,
    sourceCount: 0,
    unresolvedCount: 0,
    frontier: [],
  };

  await context.route("**/api/v1/brief**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/v1/brief" && request.method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requestId,
          status: "awaiting_answers",
          brief: artistBrief,
          requestedTrackCount: 50,
          originalRequestedTrackCount: 50,
          questionSetHash,
          questions: [artistQuestion],
        }),
      });
      return;
    }
    if (
      pathname === `/api/v1/brief/${requestId}/answers`
      && request.method() === "POST"
    ) {
      answerBodies.push(request.postDataJSON() as typeof answerBodies[number]);
      const firstAnswer = answerBodies.length === 1;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify(firstAnswer
          ? {
              requestId,
              status: "awaiting_answers",
              questionSetHash: artistIdentityQuestionSetHash,
              questions: [persistedArtistIdentityQuestion],
            }
          : {
              requestId,
              status: "finalizing",
              pollAfterMs: 1,
            }),
      });
      return;
    }
    if (pathname === `/api/v1/brief/${requestId}`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requestId,
          status: "complete",
          brief: artistBrief,
          requestedTrackCount: 50,
          questionSetHash: artistIdentityQuestionSetHash,
        }),
      });
      return;
    }
    await route.fallback();
  });
  await context.route("**/api/v1/runs", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        run: persistedRun,
        capability: "persisted-artist-capability",
      }),
    });
  });
  await context.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runId: persistedRun.id }),
    });
  });
  await context.route(`**/api/v1/runs/${persistedRun.id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(persistedRun),
    });
  });

  await openArtistGuidance(page, "no Bad Bunny");
  await expect(
    page.getByRole("heading", {
      name: persistedArtistIdentityQuestion.question,
    }),
  ).toBeVisible();
  const summary = page.getByTestId("guided-interpretation-summary");
  await expect(summary).toContainText("No recordings by Bad Bunny");
  await page.getByRole("radio", {
    name: /Bad Bunny · 1126808565/i,
  }).locator("..").click();
  await page.getByRole("button", { name: /create playlist/i }).click();
  await expect(
    page.getByRole("heading", { name: "Researching your playlist" }),
  ).toBeVisible();

  expect(answerBodies).toEqual([
    expect.objectContaining({
      questionSetHash,
      answers: [{
        questionId: artistQuestion.id,
        customText: "no Bad Bunny",
      }],
    }),
    expect.objectContaining({
      questionSetHash: artistIdentityQuestionSetHash,
      answers: [{
        questionId: persistedArtistIdentityQuestion.id,
        optionId: selectedOptionId,
      }],
    }),
  ]);
});

test("retryable artist lookup exposes retry and reuses the exact submission identity", async ({
  context,
  page,
}) => {
  const attempts = await mockArtistGuidance(context, {
    requestId: "brief-artist-provider-retry",
    answerFailure: () => ({
      status: 503,
      headers: { "retry-after": "5" },
      body: {
        status: "blocked_dependency",
        code: "artist_identity_resolution_retryable",
        nextAction: "retry",
        retryAfterMs: 5_000,
        error: "Apple artist verification is temporarily unavailable. Your current playlist interpretation is unchanged.",
      },
    }),
  });

  await openArtistGuidance(page, "no Phoenix");

  const custom = page.getByRole("textbox", { name: "Something else" });
  await expect(page.getByText(/artist verification is temporarily unavailable/i)).toBeVisible();
  await expect(custom).toBeDisabled();
  await expect(custom).toHaveValue("no Phoenix");
  await expect(page.getByRole("button", { name: /edit artist/i })).toBeVisible();
  const retry = page.getByRole("button", { name: /retry lookup/i });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[1]).toEqual(attempts[0]);

  await page.getByRole("button", { name: /edit artist/i }).click();
  await expect(custom).toBeEnabled();
  await expect(custom).toBeFocused();
  await expect(custom).toHaveValue("no Phoenix");
  await custom.fill("no Phoenix Band");
  await page.getByRole("button", { name: /verify artist/i }).click();
  await expect.poll(() => attempts.length).toBe(3);
  expect(attempts[2]?.customText).toBe("no Phoenix Band");
  expect(attempts[2]?.idempotencyHeader).toBe(attempts[2]?.idempotencyBody);
  expect(attempts[2]?.idempotencyHeader).not.toBe(attempts[0]?.idempotencyHeader);
});
