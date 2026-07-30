import { expect, test } from "@playwright/test";

const initialHash = "a".repeat(64);
const confirmationHash = "b".repeat(64);
const requestId = "brief-adaptive-guidance-v3";

const brief = {
  title: "Smooth Reggaeton Heat",
  description: "A polished reggaeton playlist.",
  mode: "curated",
  subjectEntities: ["reggaeton"],
  relationship: "qualifies as reggaeton",
  include: ["polished reggaeton"],
  exclude: [],
  versionPolicy: "canonical studio recordings",
  evidencePolicy: "documented track-level scope",
  orderingPolicy: "smooth editorial flow",
  targetSize: { min: 50, max: 50 },
  ambiguities: [],
};

const initialQuestion = {
  id: "guidance:reggaeton:adjacent-latin-urban-scope",
  header: "Genre reach",
  question: "How far should “adjacent Latin urban” extend?",
  criticality: "required",
  selectionMode: "single",
  allowCustom: true,
  options: [
    {
      id: "core_reggaeton_only",
      label: "Core reggaeton only",
      description: "Every track must qualify as reggaeton.",
      recommended: false,
    },
    {
      id: "reggaeton_dembow_latin_urban",
      label: "Reggaeton + Latin urban",
      description: "Keep at least 70% core reggaeton.",
      recommended: true,
    },
    {
      id: "broader_latin_crossover",
      label: "Broader crossover",
      description: "Keep at least 50% core reggaeton.",
      recommended: false,
    },
  ],
};

const confirmationQuestion = {
  id: "guidance:custom:confirm:test",
  header: "Confirm interpretation",
  question: "Apply this revised playlist contract?",
  criticality: "required",
  selectionMode: "single",
  allowCustom: false,
  whyMaterial: "Your custom answer changes one or more hard rules. Review every section before confirming.",
  interpretationSummary: {
    mustHave: [
      "Clean versions only",
      "At least 51% Tracks by women artists",
      "reggaeton",
    ],
    prefer: [],
    avoid: ["No recordings by Bad Bunny"],
    flow: ["smooth editorial flow"],
    count: 50,
  },
  options: [
    {
      id: "apply_revised_interpretation",
      label: "Apply revised interpretation",
      description: "Create a successor contract with exactly the rules shown above.",
      recommended: true,
    },
    {
      id: "keep_current_interpretation",
      label: "Keep current interpretation",
      description: "Discard the custom changes.",
      recommended: false,
    },
  ],
};

const run = {
  id: "run-adaptive-guidance-v3",
  prompt: "Smooth reggaeton and adjacent Latin urban",
  brief,
  status: "researching",
  phase: "v3_retrieval",
  autoPublish: true,
  error: null,
  candidateCount: 0,
  sourceCount: 0,
  unresolvedCount: 0,
  frontier: [],
};

test("a precise request shows and explicitly receipts the zero-question V4 checkpoint", async ({
  page,
  context,
}) => {
  const confirmationRequestId = "brief-v4-interpretation-confirmation";
  const questionSetHash = "9".repeat(64);
  const summary = {
    mustHave: ["Recordings by Radiohead", "Studio recordings"],
    prefer: [],
    avoid: ["Live recordings", "Remixes"],
    flow: ["Chronological"],
    count: 25,
  };
  let submitted: Record<string, unknown> | null = null;
  await context.route("**/api/v1/brief/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === `/api/v1/brief/${confirmationRequestId}` && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requestId: confirmationRequestId,
          prompt: "Exactly 25 studio recordings by Radiohead",
          requestedTrackCount: 25,
          status: "awaiting_answers",
          briefContractVersion: 3,
          questionSetHash,
          checkpointMode: "interpretation_confirmation",
          interpretationSummary: summary,
          brief: {
            ...brief,
            title: "Radiohead studio chronology",
            targetSize: { min: 25, max: 25 },
          },
          questions: [],
        }),
      });
      return;
    }
    if (pathname === `/api/v1/brief/${confirmationRequestId}/answers` && request.method() === "POST") {
      submitted = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requestId: confirmationRequestId,
          status: "failed",
          error: "test stopped after confirmation receipt",
        }),
      });
      return;
    }
    await route.fallback();
  });

  await page.goto(`/?brief=${confirmationRequestId}`);
  await expect(page.getByRole("heading", { name: /here’s how gênio will build it/i })).toBeVisible();
  const checkpoint = page.getByTestId("guidance-confirmation-summary");
  await expect(checkpoint).toContainText("Recordings by Radiohead");
  await expect(checkpoint).toContainText("Live recordings");
  await expect(checkpoint).toContainText("Chronological");
  await expect(checkpoint).toContainText("25 TRACKS · EXACT");
  await expect(page.getByText("QUESTION 1 OF", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: /create this playlist/i }).click();
  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted).toMatchObject({
    answers: [],
    questionSetHash,
  });
});

test("custom hard rules require a visible summary and a stale second tab must review the successor", async ({
  context,
}) => {
  let active: "initial" | "confirmation" | "complete" = "initial";
  const answerBodies: Record<string, unknown>[] = [];

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
          brief,
          questionSetHash: initialHash,
          questions: [initialQuestion],
        }),
      });
      return;
    }
    if (pathname === `/api/v1/brief/${requestId}/answers`) {
      const body = request.postDataJSON() as Record<string, unknown>;
      answerBodies.push(body);
      const submittedHash = body.questionSetHash;
      if (active === "confirmation" && submittedHash === initialHash) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Playlist guidance changed; review the current questions before answering",
            code: "stale_guidance_question_set",
            requestId,
            questionSetHash: confirmationHash,
            questions: [confirmationQuestion],
          }),
        });
        return;
      }
      if (active === "initial") {
        active = "confirmation";
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            requestId,
            status: "awaiting_answers",
            questionSetHash: confirmationHash,
            questions: [confirmationQuestion],
          }),
        });
        return;
      }
      active = "complete";
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
        body: JSON.stringify(active === "complete"
          ? { requestId, status: "complete", brief, questionSetHash: confirmationHash }
          : active === "confirmation"
            ? {
                requestId,
                status: "awaiting_answers",
                brief,
                questionSetHash: confirmationHash,
                questions: [confirmationQuestion],
              }
            : {
                requestId,
                status: "awaiting_answers",
                brief,
                questionSetHash: initialHash,
                questions: [initialQuestion],
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
      body: JSON.stringify({ run, capability: "adaptive-guidance-capability" }),
    });
  });
  await context.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runId: run.id }),
    });
  });
  await context.route(`**/api/v1/runs/${run.id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(run),
    });
  });

  const first = await context.newPage();
  const second = await context.newPage();
  for (const page of [first, second]) {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Create a playlist" })).toBeVisible();
    await page.getByRole("textbox", { name: /playlist request/i })
      .fill("Smooth reggaeton and adjacent Latin urban");
    await page.getByRole("button", { name: /create playlist/i }).click();
    await expect(page.getByRole("heading", { name: initialQuestion.question })).toBeVisible();
  }

  await first.getByRole("radio", { name: /something else/i }).locator("..").click();
  await first.getByRole("textbox", { name: "Something else" })
    .fill("mostly women, clean, no Bad Bunny");
  await first.getByRole("button", { name: /create playlist/i }).click();
  await expect(first.getByRole("heading", { name: confirmationQuestion.question })).toBeVisible();
  const summary = first.getByTestId("guided-interpretation-summary");
  await expect(summary).toContainText("MUST HAVE");
  await expect(summary).toContainText("Clean versions only");
  await expect(summary).toContainText("At least 51% Tracks by women artists");
  await expect(summary).toContainText("AVOID");
  await expect(summary).toContainText("No recordings by Bad Bunny");
  await expect(summary).toContainText("COUNT");
  await expect(summary).toContainText("50 TRACKS · EXACT");

  await second.getByRole("radio", { name: /core reggaeton only/i }).locator("..").click();
  await second.getByRole("button", { name: /create playlist/i }).click();
  await expect(second.getByText(/guidance changed while you were answering/i)).toBeVisible();
  await expect(second.getByRole("heading", { name: confirmationQuestion.question })).toBeVisible();

  await first.getByRole("radio", { name: /apply revised interpretation/i }).locator("..").click();
  await first.getByRole("button", { name: /create playlist/i }).click();
  await expect(first.getByRole("heading", { name: "Researching your playlist" })).toBeVisible();

  expect(answerBodies).toEqual(expect.arrayContaining([
    expect.objectContaining({
      questionSetHash: initialHash,
      answers: [{
        questionId: initialQuestion.id,
        customText: "mostly women, clean, no Bad Bunny",
      }],
    }),
    expect.objectContaining({
      questionSetHash: confirmationHash,
      answers: [{
        questionId: confirmationQuestion.id,
        optionId: "apply_revised_interpretation",
      }],
    }),
  ]));
});

test("a confirmed count successor becomes the browser and run-request authority across stale tabs", async ({
  context,
}) => {
  const countRequestId = "brief-adaptive-count-successor";
  const countInitialHash = "c".repeat(64);
  const countConfirmationHash = "d".repeat(64);
  const initialBrief = {
    ...brief,
    title: "20-track Disco Survey",
    subjectEntities: ["disco"],
    relationship: "qualifies as disco",
    include: ["documented disco"],
    targetSize: { min: 20, max: 20 },
  };
  const revisedBrief = {
    ...initialBrief,
    title: "25-track Disco Survey",
    targetSize: { min: 25, max: 25 },
  };
  const countQuestion = {
    id: "guidance:count:revision",
    header: "Playlist count",
    question: "Would you like to revise the exact count?",
    criticality: "optional",
    selectionMode: "single",
    allowCustom: true,
    options: [{
      id: "keep_20",
      label: "Keep 20 tracks",
      description: "Keep the original exact count.",
      recommended: true,
    }],
  };
  const countConfirmationQuestion = {
    ...confirmationQuestion,
    id: "guidance:count:confirm",
    interpretationSummary: {
      mustHave: ["documented disco"],
      prefer: [],
      avoid: [],
      flow: ["smooth editorial flow"],
      count: 25,
    },
  };
  const countRun = {
    ...run,
    id: "run-adaptive-count-successor",
    prompt: "A documented disco survey",
    brief: revisedBrief,
    selectionPlan: {
      requestedTrackCount: 25,
      reserveTrackCount: 5,
    },
  };
  let active: "initial" | "confirmation" | "complete" = "initial";
  const briefBodies: Record<string, unknown>[] = [];
  const runBodies: Record<string, unknown>[] = [];

  await context.route("**/api/v1/brief**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/v1/brief" && request.method() === "POST") {
      briefBodies.push(request.postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requestId: countRequestId,
          status: "awaiting_answers",
          brief: initialBrief,
          requestedTrackCount: 20,
          originalRequestedTrackCount: 20,
          questionSetHash: countInitialHash,
          questions: [countQuestion],
        }),
      });
      return;
    }
    if (pathname === `/api/v1/brief/${countRequestId}/answers`) {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (active === "initial") {
        active = "confirmation";
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            requestId: countRequestId,
            status: "awaiting_answers",
            questionSetHash: countConfirmationHash,
            questions: [countConfirmationQuestion],
          }),
        });
        return;
      }
      if (active === "confirmation"
        && body.questionSetHash === countConfirmationHash) {
        active = "complete";
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            requestId: countRequestId,
            status: "finalizing",
            pollAfterMs: 1,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Playlist guidance changed; review the current questions before answering",
          code: "stale_guidance_question_set",
          requestId: countRequestId,
          questionSetHash: countConfirmationHash,
          questions: [],
        }),
      });
      return;
    }
    if (pathname === `/api/v1/brief/${countRequestId}`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(active === "complete"
          ? {
              requestId: countRequestId,
              status: "complete",
              brief: revisedBrief,
              requestedTrackCount: 25,
              originalRequestedTrackCount: 20,
              questionSetHash: countConfirmationHash,
              questions: [],
            }
          : {
              requestId: countRequestId,
              status: "awaiting_answers",
              brief: initialBrief,
              requestedTrackCount: 20,
              originalRequestedTrackCount: 20,
              questionSetHash: countConfirmationHash,
              questions: [countConfirmationQuestion],
            }),
      });
      return;
    }
    await route.fallback();
  });
  await context.route("**/api/v1/runs", async (route) => {
    runBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        run: countRun,
        capability: "adaptive-count-successor-capability",
      }),
    });
  });
  await context.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runId: countRun.id }),
    });
  });
  await context.route(`**/api/v1/runs/${countRun.id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(countRun),
    });
  });

  const first = await context.newPage();
  const second = await context.newPage();
  for (const page of [first, second]) {
    await page.goto("/");
    await page.getByRole("textbox", { name: /playlist request/i })
      .fill("A documented disco survey");
    await page.getByRole("button", { name: /^custom size$/i }).click();
    await page.getByRole("textbox", { name: /^exact track count$/i })
      .fill("20");
    await page.getByRole("button", { name: /create playlist/i }).click();
    await expect(page.getByRole("heading", {
      name: countQuestion.question,
    })).toBeVisible();
  }

  await second.getByRole("radio", { name: /keep 20 tracks/i })
    .locator("..").click();
  await first.getByRole("radio", { name: /something else/i })
    .locator("..").click();
  await first.getByRole("textbox", { name: "Something else" })
    .fill("25 tracks");
  await first.getByRole("button", { name: /create playlist/i }).click();
  await expect(first.getByTestId("guided-interpretation-summary"))
    .toContainText("25 TRACKS · EXACT");
  await first.getByRole("radio", {
    name: /apply revised interpretation/i,
  }).locator("..").click();
  await first.getByRole("button", { name: /create playlist/i }).click();
  await expect(first.getByRole("heading", {
    name: "Researching your playlist",
  })).toBeVisible();
  await expect(first.getByTestId("working-indicator")).toContainText("TARGET25");

  await second.getByRole("button", { name: /create playlist/i }).click();
  await expect(second.getByText(
    /guidance changed while you were answering/i,
  )).toBeVisible();
  await expect(second.getByRole("heading", {
    name: "Create a playlist",
  })).toBeVisible();
  await expect(second.getByRole("button", {
    name: "25 tracks",
    exact: true,
  }))
    .toHaveAttribute("aria-pressed", "true");
  await second.getByRole("button", { name: /create playlist/i }).click();
  await expect(second.getByRole("heading", {
    name: "Researching your playlist",
  })).toBeVisible();

  expect(briefBodies).toHaveLength(2);
  expect(briefBodies).toEqual(expect.arrayContaining([
    expect.objectContaining({ targetTrackCount: 20 }),
  ]));
  expect(runBodies).toHaveLength(2);
  expect(runBodies).toEqual([
    expect.objectContaining({
      briefRequestId: countRequestId,
      targetTrackCount: 25,
      brief: expect.objectContaining({
        targetSize: { min: 25, max: 25 },
      }),
    }),
    expect.objectContaining({
      briefRequestId: countRequestId,
      targetTrackCount: 25,
      brief: expect.objectContaining({
        targetSize: { min: 25, max: 25 },
      }),
    }),
  ]);
});

test("earlier-answer history supports multi-select replacement, fresh dependent guidance, and stale-tab fencing", async ({
  context,
}) => {
  const sourceRun = {
    ...run,
    id: "11111111-1111-4111-8111-111111111119",
    status: "needs_decision",
    phase: "research_boundary",
    decisionAction: {
      kind: "research_boundary",
      decisionHash: "1".repeat(64),
      contractRevisionId: "pcr1:history-source",
      contractSemanticHash: "2".repeat(64),
      reason: "active_compute_limit",
      targetTrackCount: 50,
      verifiedTrackCount: 31,
      remainingStrategyCount: 1,
      consumedActiveComputeMs: 900_000,
      activeComputeLimitMs: 900_000,
      activeComputeExtensionsUsed: 0,
      namedPredicates: [],
      interpretationSummary: {
        mustHave: ["Reggaeton"],
        prefer: ["Warm", "Peak-time lift"],
        avoid: [],
        flow: ["Smooth"],
        count: 50,
      },
      actions: {
        anotherBoundedPass: false,
        reviseNamedPredicate: false,
        reduceCount: false,
        publishVerifiedPartial: false,
        pause: true,
        resumeLater: true,
        cancel: true,
      },
      reachedAt: "2026-07-24T12:00:00.000Z",
    },
    resolution: {
      state: "needs_decision",
      nextAction: "review_contract",
      terminal: false,
      contractRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      contractRevision: 3,
      contractHash: "2".repeat(64),
      blocker: null,
    },
  };
  const dependentQuestion = {
    ...initialQuestion,
    id: "guidance:dependent:familiarity",
    question: "How familiar should the revised playlist feel?",
    allowCustom: false,
    interpretationSummary: {
      mustHave: ["Reggaeton"],
      prefer: ["Chill openings", "Peak-time lift"],
      avoid: [],
      flow: ["Smooth"],
      count: 50,
    },
  };
  const successorRun = {
    ...sourceRun,
    id: "22222222-2222-4222-8222-222222222229",
    phase: "dependent_guidance_required",
    decisionAction: null,
    guidanceAction: {
      kind: "rescue_guidance",
      questionSetHash: "9".repeat(64),
      baseContractRevisionId: "pcr1:history-successor",
      baseContractSemanticHash: "8".repeat(64),
      questions: [dependentQuestion],
      attemptsUsed: 1,
      maximumAttempts: 2,
      showEditableInterpretationSummary: false,
    },
    resolution: {
      ...sourceRun.resolution,
      contractRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      contractRevision: 4,
      contractHash: "8".repeat(64),
      nextAction: "answer_rescue_guidance",
    },
  };
  const history = {
    activeContractRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    activeContractSemanticHash: "2".repeat(64),
    historyVersion: "3".repeat(64),
    items: [{
      answerSetId: "44444444-4444-4444-8444-444444444444",
      questionSetHash: "4".repeat(64),
      question: {
        id: "guidance:history:energy",
        header: "Energy blend",
        question: "Which energy qualities should shape the playlist?",
        criticality: "optional",
        selectionMode: "multiple",
        allowCustom: true,
        options: [
          { id: "warm", label: "Warm", description: "Warm low-key energy." },
          { id: "chill", label: "Chill", description: "Relaxed pacing." },
          { id: "peak", label: "Peak-time lift", description: "Late lift." },
        ],
      },
      selectedOptionIds: ["warm", "peak"],
      selectedOptionLabels: ["Warm", "Peak-time lift"],
      hadCustomAnswer: false,
      skipped: false,
      axis: "energy",
      trigger: "nuance",
      acceptedAt: "2026-07-24T11:00:00.000Z",
    }],
  };
  let revisionCalls = 0;
  const revisionBodies: Record<string, unknown>[] = [];
  await context.route("**/api/v1/brief**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/v1/brief") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requestId: "history-brief",
          status: "complete",
          brief,
          questions: [],
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
      body: JSON.stringify({ run: sourceRun, capability: "history-capability" }),
    });
  });
  await context.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runId: sourceRun.id }),
    });
  });
  await context.route(`**/api/v1/runs/${sourceRun.id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sourceRun),
    });
  });
  await context.route(
    `**/api/v1/runs/${sourceRun.id}/guidance/history`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(history),
      });
    },
  );
  await context.route(
    `**/api/v1/runs/${sourceRun.id}/guidance/revisions`,
    async (route) => {
      revisionBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      revisionCalls += 1;
      await route.fulfill(revisionCalls === 1 ? {
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ status: "revised", run: successorRun }),
      } : {
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "The playlist interpretation changed in another tab",
          code: "stale_guidance_history",
        }),
      });
    },
  );

  const first = await context.newPage();
  const second = await context.newPage();
  for (const page of [first, second]) {
    await page.goto("/");
    await page.getByRole("textbox", { name: /playlist request/i })
      .fill("Smooth reggaeton and adjacent Latin urban");
    await page.getByRole("button", { name: /create playlist/i }).click();
    await expect(page.getByTestId("run-boundary-interpretation")).toBeVisible();
    await page.getByRole("button", { name: /change an earlier answer/i }).click();
    await expect(page.getByTestId("guidance-history-screen")).toBeVisible();
    await expect(page.getByText("CURRENT · Warm, Peak-time lift")).toBeVisible();
    await expect(page.getByText(sourceRun.prompt)).toHaveCount(0);
  }

  await first.getByRole("checkbox", { name: /chill/i }).check();
  await first.getByRole("checkbox", { name: /peak-time lift/i }).check();
  await first.getByRole("button", { name: /apply change/i }).click();
  await expect(first.getByRole("heading", {
    name: dependentQuestion.question,
  })).toBeVisible();
  await expect(first.getByTestId("guided-interpretation-summary"))
    .toContainText("50 TRACKS · EXACT");
  expect(new URL(first.url()).searchParams.get("run")).toBe(successorRun.id);

  await second.getByRole("button", {
    name: /skip this optional decision/i,
  }).click();
  await second.getByRole("button", { name: /apply change/i }).click();
  await expect(second.getByText(/changed in another tab/i)).toBeVisible();
  expect(revisionBodies[0]).toMatchObject({
    answerSetId: history.items[0]!.answerSetId,
    questionId: history.items[0]!.question.id,
    answer: {
      questionId: history.items[0]!.question.id,
      optionIds: ["chill", "peak"],
    },
    expectedContractRevisionId: history.activeContractRevisionId,
    expectedContractSemanticHash: history.activeContractSemanticHash,
    historyVersion: history.historyVersion,
  });
  expect(revisionBodies[1]).toMatchObject({
    answer: {
      questionId: history.items[0]!.question.id,
      skipped: true,
    },
  });
});

test("an earlier custom hard change must be confirmed from an exact interpretation summary", async ({
  context,
  page,
}) => {
  const sourceRun = {
    ...run,
    id: "55555555-5555-4555-8555-555555555559",
    status: "needs_decision",
    phase: "research_boundary",
    decisionAction: {
      kind: "research_boundary",
      decisionHash: "5".repeat(64),
      contractRevisionId: "pcr1:custom-history",
      contractSemanticHash: "6".repeat(64),
      reason: "active_compute_limit",
      targetTrackCount: 50,
      verifiedTrackCount: 20,
      remainingStrategyCount: 0,
      consumedActiveComputeMs: 900_000,
      activeComputeLimitMs: 900_000,
      activeComputeExtensionsUsed: 0,
      namedPredicates: [],
      interpretationSummary: {
        mustHave: ["Reggaeton"],
        prefer: ["Smooth"],
        avoid: [],
        flow: ["Editorial"],
        count: 50,
      },
      actions: {
        anotherBoundedPass: false,
        reviseNamedPredicate: false,
        reduceCount: false,
        publishVerifiedPartial: false,
        pause: true,
        resumeLater: true,
        cancel: true,
      },
      reachedAt: "2026-07-24T12:00:00.000Z",
    },
    resolution: {
      state: "needs_decision",
      nextAction: "review_contract",
      terminal: false,
      contractRevisionId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3",
      contractRevision: 2,
      contractHash: "6".repeat(64),
      blocker: null,
    },
  };
  const successor = {
    ...sourceRun,
    id: "66666666-6666-4666-8666-666666666669",
    status: "researching",
    phase: "v3_retrieval",
    decisionAction: null,
    resolution: {
      ...sourceRun.resolution,
      state: "executing",
      nextAction: "none",
      contractRevisionId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd4",
      contractRevision: 3,
      blocker: null,
    },
  };
  const history = {
    activeContractRevisionId: sourceRun.resolution.contractRevisionId,
    activeContractSemanticHash: sourceRun.resolution.contractHash,
    historyVersion: "7".repeat(64),
    items: [{
      answerSetId: "77777777-7777-4777-8777-777777777777",
      questionSetHash: "8".repeat(64),
      question: {
        id: "guidance:history:scope",
        header: "Genre reach",
        question: "How far should the genre reach extend?",
        criticality: "required",
        selectionMode: "single",
        allowCustom: true,
        options: initialQuestion.options,
      },
      selectedOptionIds: ["reggaeton_dembow_latin_urban"],
      selectedOptionLabels: ["Reggaeton + Latin urban"],
      hadCustomAnswer: false,
      skipped: false,
      axis: "genre_scope",
      trigger: "correctness",
      acceptedAt: "2026-07-24T11:00:00.000Z",
    }],
  };
  const submitted: Record<string, unknown>[] = [];
  await context.route(`**/api/v1/runs/${sourceRun.id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sourceRun),
    });
  });
  await context.route(
    `**/api/v1/runs/${sourceRun.id}/guidance/history`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(history),
      });
    },
  );
  await context.route(
    `**/api/v1/runs/${sourceRun.id}/guidance/revisions`,
    async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      submitted.push(body);
      await route.fulfill(submitted.length === 1 ? {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "needs_confirmation",
          confirmationHash: "9".repeat(64),
          hardChangeReasons: [
            "content_policy_changed",
            "exclusion_changed",
          ],
          interpretationSummary: {
            mustHave: ["Clean versions only", "Reggaeton"],
            prefer: ["Smooth"],
            avoid: ["No recordings by Bad Bunny"],
            flow: ["Editorial"],
            count: 50,
          },
        }),
      } : {
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ status: "revised", run: successor }),
      });
    },
  );

  await page.goto(`/?run=${sourceRun.id}`);
  await expect(page.getByTestId("run-boundary-interpretation")).toBeVisible();
  await page.getByRole("button", { name: /change an earlier answer/i }).click();
  await page.getByRole("textbox", { name: "Custom replacement answer" })
    .fill("clean versions only, no Bad Bunny");
  await page.getByRole("button", { name: /apply change/i }).click();
  const confirmation = page.getByTestId("guidance-history-confirmation");
  await expect(confirmation).toContainText("Clean versions only");
  await expect(confirmation).toContainText("No recordings by Bad Bunny");
  await expect(confirmation).toContainText("50 TRACKS · EXACT");
  await page.getByRole("button", {
    name: /confirm and create successor/i,
  }).click();
  await expect(page.getByRole("heading", {
    name: "Researching your playlist",
  })).toBeVisible();
  expect(submitted[1]).toMatchObject({
    confirmationHash: "9".repeat(64),
    confirmed: true,
    answer: {
      questionId: history.items[0]!.question.id,
      customText: "clean versions only, no Bad Bunny",
    },
  });
});

test("the 15-minute boundary exposes one real bounded pass and keeps partial publication explicit", async ({
  context,
  page,
}) => {
  const boundaryRun = {
    ...run,
    id: "run-active-compute-boundary",
    prompt: "100 rare French jazz recordings from the 1970s",
    brief: {
      ...brief,
      title: "Rare French Jazz",
      targetSize: { min: 100, max: 100 },
    },
    status: "needs_decision",
    phase: "active_compute_limit_reached",
    candidateCount: 73,
    partialAction: {
      kind: "partial_publication",
      targetTrackCount: 100,
      qualifiedTrackCount: 73,
      remainingStrategyCount: 2,
      canContinueResearch: true,
      reasonCode: "pipeline_v3_deadline_reached",
      outcomeVersion: 1,
      outcomeHash: "e".repeat(64),
      manifestId: "11111111-1111-4111-8111-111111111111",
      manifestHash: "f".repeat(64),
    },
    decisionAction: {
      kind: "research_boundary",
      decisionHash: "c".repeat(64),
      contractRevisionId: "pcr1:boundary",
      contractSemanticHash: "d".repeat(64),
      reason: "active_compute_limit",
      targetTrackCount: 100,
      verifiedTrackCount: 73,
      remainingStrategyCount: 2,
      consumedActiveComputeMs: 900_000,
      activeComputeLimitMs: 900_000,
      activeComputeExtensionsUsed: 0,
      namedPredicates: [{
        clauseId: "prompt:era:1970s",
        label: "Recorded in the 1970s",
      }],
      interpretationSummary: {
        mustHave: ["French jazz", "Recorded in the 1970s"],
        prefer: ["Documented rarity"],
        avoid: [],
        flow: ["Editorial flow"],
        count: 100,
      },
      actions: {
        anotherBoundedPass: true,
        reviseNamedPredicate: true,
        reduceCount: true,
        publishVerifiedPartial: true,
        pause: true,
        resumeLater: false,
        cancel: true,
      },
      reachedAt: "2026-07-23T12:00:00.000Z",
    },
    resolution: {
      state: "needs_decision",
      nextAction: "review_contract",
      terminal: false,
      contractRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      contractRevision: 1,
      contractHash: "d".repeat(64),
      blocker: {
        kind: "scope_decision",
        nextRetryAt: null,
        automaticRetryUntil: null,
        retryCount: 0,
      },
    },
  };
  const continuingRun = {
    ...boundaryRun,
    status: "continuing_research",
    phase: "continuing_research",
    partialAction: null,
    decisionAction: null,
    resolution: {
      ...boundaryRun.resolution,
      state: "executing",
      nextAction: "none",
      blocker: null,
    },
  };
  let continuationBody: Record<string, unknown> | null = null;
  let currentBoundaryRun: Record<string, unknown> = boundaryRun;
  await context.route("**/api/v1/brief**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/v1/brief" && request.method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requestId: "brief-active-compute-boundary",
          status: "complete",
          brief: boundaryRun.brief,
          questions: [],
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
        run: boundaryRun,
        capability: "active-compute-boundary-capability",
      }),
    });
  });
  await context.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runId: boundaryRun.id }),
    });
  });
  await context.route(`**/api/v1/runs/${boundaryRun.id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(currentBoundaryRun),
    });
  });
  await context.route(`**/api/v1/runs/${boundaryRun.id}/research/continue`, async (route) => {
    continuationBody = route.request().postDataJSON() as Record<string, unknown>;
    currentBoundaryRun = continuingRun;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify(continuingRun),
    });
  });

  await page.goto("/");
  await page.getByRole("textbox", { name: /playlist request/i })
    .fill(boundaryRun.prompt);
  await page.getByRole("button", { name: "100 tracks" }).click();
  await page.getByRole("button", { name: /create playlist/i }).click();
  await expect(page.getByTestId("partial-decision-screen")).toBeVisible();
  await expect(page.getByText(/active 15-minute research pass completed/i)).toBeVisible();
  await expect(page.getByTestId("run-decision-interpretation")).toContainText(
    "100 TRACKS · EXACT",
  );
  await expect(page.getByRole("button", { name: /run one more bounded pass/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /publish 73 verified tracks/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /revise.*recorded in the 1970s/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /separate count revision/i })).toBeVisible();

  await page.getByRole("button", { name: /run one more bounded pass/i }).click();
  await expect(page.getByRole("heading", { name: "Researching your playlist" })).toBeVisible();
  expect(continuationBody).toEqual({
    outcomeVersion: 1,
    decisionHash: "c".repeat(64),
  });
});

test("a mid-run rescue question revises only the named predicate and hands off to its successor", async ({
  context,
  page,
}) => {
  const rescueQuestion = {
    id: "guidance:rescue:predicate:1970s",
    header: "Yield bottleneck",
    question: "Would you like to revise “Recorded in the 1970s” for this playlist?",
    criticality: "optional",
    selectionMode: "single",
    allowCustom: false,
    whyMaterial: "This was the named rule most often limiting otherwise qualified tracks. Skipping keeps it exact.",
    interpretationSummary: {
      mustHave: ["French jazz", "Recorded in the 1970s"],
      prefer: ["Documented rarity"],
      avoid: [],
      flow: ["Editorial flow"],
      count: 100,
    },
    options: [
      {
        id: "keep_as_preference",
        label: "Keep as a preference",
        description: "Preserve this intent in ranking, but stop using it as an eligibility gate.",
        recommended: true,
      },
      {
        id: "remove_named_rule",
        label: "Remove this rule",
        description: "Delete only this named rule; every other rule remains.",
        recommended: false,
      },
    ],
  };
  const rescueRun = {
    ...run,
    id: "run-rescue-guidance",
    prompt: "100 rare French jazz recordings from the 1970s",
    brief: {
      ...brief,
      title: "Rare French Jazz",
      targetSize: { min: 100, max: 100 },
    },
    status: "needs_decision",
    phase: "rescue_guidance_required",
    guidanceAction: {
      kind: "rescue_guidance",
      questionSetHash: "8".repeat(64),
      baseContractRevisionId: "pcr1:rescue-base",
      baseContractSemanticHash: "9".repeat(64),
      questions: [rescueQuestion],
      attemptsUsed: 1,
      maximumAttempts: 2,
      showEditableInterpretationSummary: false,
    },
    resolution: {
      state: "needs_input",
      nextAction: "answer_rescue_guidance",
      terminal: false,
      contractRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      contractRevision: 1,
      contractHash: "9".repeat(64),
      blocker: {
        kind: "guidance",
        nextRetryAt: null,
        automaticRetryUntil: null,
        retryCount: 0,
      },
    },
  };
  const successorRun = {
    ...rescueRun,
    id: "run-rescue-successor",
    status: "researching",
    phase: "v3_retrieval",
    guidanceAction: null,
    resolution: {
      ...rescueRun.resolution,
      state: "executing",
      nextAction: "none",
      contractRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      contractRevision: 2,
      blocker: null,
    },
  };
  let answerBody: Record<string, unknown> | null = null;
  await context.route("**/api/v1/brief**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/v1/brief"
      && route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requestId: "brief-run-rescue",
          status: "complete",
          brief: rescueRun.brief,
          questions: [],
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
        run: rescueRun,
        capability: "run-rescue-capability",
      }),
    });
  });
  await context.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runId: rescueRun.id }),
    });
  });
  await context.route(`**/api/v1/runs/${rescueRun.id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(rescueRun),
    });
  });
  await context.route(
    `**/api/v1/runs/${rescueRun.id}/guidance/answers`,
    async (route) => {
      answerBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ run: successorRun, revised: true }),
      });
    },
  );

  await page.goto("/");
  await page.getByRole("textbox", { name: /playlist request/i })
    .fill(rescueRun.prompt);
  await page.getByRole("button", { name: "100 tracks" }).click();
  await page.getByRole("button", { name: /create playlist/i }).click();
  await expect(page.getByRole("heading", { name: rescueQuestion.question })).toBeVisible();
  await expect(page.getByText("FOCUSED RESEARCH DECISION")).toBeVisible();
  await expect(page.getByTestId("guided-interpretation-summary"))
    .toContainText("100 TRACKS · EXACT");
  await expect(page.getByText(/skipping keeps it exact/i)).toBeVisible();

  await page.getByRole("radio", { name: /keep as a preference/i })
    .locator("..").click();
  await page.getByRole("button", { name: /apply and continue/i }).click();
  await expect(page.getByRole("heading", { name: "Researching your playlist" }))
    .toBeVisible();
  expect(answerBody).toEqual({
    questionSetHash: "8".repeat(64),
    answers: [{
      questionId: rescueQuestion.id,
      optionId: "keep_as_preference",
    }],
  });
  expect(new URL(page.url()).searchParams.get("run")).toBe(successorRun.id);
});

test("the 24-hour provider boundary is labeled as retryable service state with visible exits", async ({
  context,
  page,
}) => {
  const dependencyRun = {
    ...run,
    id: "run-dependency-window",
    status: "needs_decision",
    phase: "dependency_retry_window_expired",
    decisionAction: {
      kind: "research_boundary",
      decisionHash: "6".repeat(64),
      contractRevisionId: "pcr1:dependency",
      contractSemanticHash: "7".repeat(64),
      reason: "dependency_retry_window_expired",
      targetTrackCount: 50,
      verifiedTrackCount: 0,
      remainingStrategyCount: 0,
      consumedActiveComputeMs: 0,
      activeComputeLimitMs: 900_000,
      activeComputeExtensionsUsed: 0,
      namedPredicates: [],
      interpretationSummary: {
        mustHave: ["Reggaeton"],
        prefer: ["Smooth and polished"],
        avoid: [],
        flow: ["Smooth editorial flow"],
        count: 50,
      },
      actions: {
        anotherBoundedPass: false,
        reviseNamedPredicate: false,
        reduceCount: false,
        publishVerifiedPartial: false,
        pause: true,
        resumeLater: true,
        cancel: true,
      },
      reachedAt: "2026-07-23T12:00:00.000Z",
    },
    resolution: {
      state: "needs_decision",
      nextAction: "resume_research",
      terminal: false,
      contractRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      contractRevision: 1,
      contractHash: "7".repeat(64),
      blocker: {
        kind: "provider",
        nextRetryAt: null,
        automaticRetryUntil: "2026-07-23T12:00:00.000Z",
        retryCount: 8,
        versionHash: "8".repeat(64),
      },
    },
  };
  const queuedRun = {
    ...dependencyRun,
    status: "queued",
    phase: "dependency_resume_scheduled",
    decisionAction: null,
    resolution: {
      state: "accepted",
      nextAction: "none",
      terminal: false,
      contractRevisionId:
        dependencyRun.resolution.contractRevisionId,
      contractRevision: dependencyRun.resolution.contractRevision,
      contractHash: dependencyRun.resolution.contractHash,
      blocker: null,
    },
  };
  let currentRun: typeof dependencyRun | typeof queuedRun = dependencyRun;
  let resumeCalls = 0;
  const resumeBodies: Array<Record<string, unknown>> = [];
  await context.route("**/api/v1/brief**", async (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname === "/api/v1/brief"
      && request.method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requestId: "brief-dependency-window",
          status: "complete",
          brief,
          questions: [],
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
        run: dependencyRun,
        capability: "dependency-window-capability",
      }),
    });
  });
  await context.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runId: dependencyRun.id }),
    });
  });
  await context.route(`**/api/v1/runs/${dependencyRun.id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(currentRun),
    });
  });
  await context.route(
    `**/api/v1/runs/${dependencyRun.id}/dependency/resume`,
    async (route) => {
      const request = route.request();
      expect(request.method()).toBe("POST");
      const body = request.postDataJSON() as Record<string, unknown>;
      resumeBodies.push(body);
      resumeCalls += 1;
      expect(request.headers()["idempotency-key"])
        .toBe(body.idempotencyKey);
      expect(body).toMatchObject({
        expectedContractRevisionId:
          dependencyRun.resolution.contractRevisionId,
        expectedContractSemanticHash:
          dependencyRun.resolution.contractHash,
        decisionHash: dependencyRun.decisionAction.decisionHash,
        blockerVersion:
          dependencyRun.resolution.blocker.versionHash,
      });
      expect(JSON.stringify(body)).not.toContain(dependencyRun.prompt);
      if (resumeCalls === 1) {
        currentRun = queuedRun;
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            run: queuedRun,
            dependencyResume: {
              queued: true,
              authorizationHash: "9".repeat(64),
              resumeAt: "2026-07-23T12:15:00.000Z",
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "The dependency decision changed; review the latest run",
          code: "dependency_resume_stale",
        }),
      });
    },
  );

  await page.goto("/");
  await page.getByRole("textbox", { name: /playlist request/i })
    .fill(dependencyRun.prompt);
  await page.getByRole("button", { name: /create playlist/i }).click();
  const panel = page.getByTestId("run-decision-panel");
  await expect(panel).toContainText("24-hour automatic retry window ended");
  await expect(panel).toContainText("service dependency state");
  await expect(panel).toContainText("not a claim that the music does not exist");
  await expect(panel).toContainText("PROGRESS IS SAVED");
  await expect(page.getByRole("button", { name: /resume later/i }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: /refine request/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /cancel job/i })).toBeVisible();
  await expect(page.getByText(/no verified tracks are ready yet/i)).toHaveCount(0);

  const stalePage = await context.newPage();
  await stalePage.goto(`/?run=${dependencyRun.id}`);
  await expect(stalePage.getByRole("button", { name: /resume later/i }))
    .toBeVisible();

  await page.getByRole("button", { name: /resume later/i }).click();
  await expect(page.getByText(
    /you authorized another exact-contract attempt/i,
  )).toBeVisible();
  await expect(page.getByRole("button", { name: /resume later/i }))
    .toHaveCount(0);

  await stalePage.getByRole("button", { name: /resume later/i }).click();
  await expect(stalePage.getByRole("alert")).toContainText(
    "The dependency decision changed",
  );
  await expect(stalePage.getByRole("alert")).toContainText(
    "Refresh the job to review its current state",
  );
  expect(resumeCalls).toBe(2);
  expect(resumeBodies[0]?.idempotencyKey)
    .not.toBe(resumeBodies[1]?.idempotencyKey);
});

test("a rollout capability change is a durable decision and never offers an automatic downgrade", async ({
  context,
  page,
}) => {
  const rolloutDecisionRun = {
    ...run,
    id: "run-rollout-cohort-decision",
    prompt: "50 clean reggaeton tracks, mostly women, no Bad Bunny",
    status: "needs_decision",
    phase: "public_rollout_successor_required",
    resolution: {
      state: "needs_decision",
      nextAction: "review_contract",
      terminal: false,
      contractRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      contractRevision: 2,
      contractHash: "7".repeat(64),
      blocker: {
        kind: "scope_decision",
        nextRetryAt: null,
        automaticRetryUntil: null,
        retryCount: 0,
      },
    },
  };
  await context.route(
    `**/api/v1/runs/${rolloutDecisionRun.id}`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rolloutDecisionRun),
      });
    },
  );

  await page.goto(`/?run=${rolloutDecisionRun.id}`);
  const panel = page.getByTestId("public-rollout-successor-decision");
  await expect(panel).toContainText("accepted request is unchanged");
  await expect(panel).toContainText("will not be silently downgraded");
  await expect(panel).toContainText(
    "SAVED DURABLY · REFINE OR CANCEL",
  );
  await expect(
    page.getByRole("button", { name: /create control successor/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /refine request/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /cancel job/i }),
  ).toBeVisible();

  await page.getByRole("button", { name: /refine request/i }).click();
  await expect(
    page.getByRole("textbox", { name: /playlist request/i }),
  ).toHaveValue(rolloutDecisionRun.prompt);
  await expect(
    page.getByRole("button", { name: "50 tracks", exact: true }),
  ).toBeVisible();
});

test("two same-axis clarification attempts render a zero-question editable summary", async ({
  context,
  page,
}) => {
  const summaryRun = {
    ...run,
    id: "run-clarification-limit-summary",
    status: "needs_decision",
    phase: "interpretation_summary_required",
    guidanceAction: {
      kind: "interpretation_summary",
      questionSetHash: "c".repeat(64),
      baseContractRevisionId: "pcr1:clarification-limit-summary",
      baseContractSemanticHash: "d".repeat(64),
      questions: [],
      attemptsUsed: 2,
      maximumAttempts: 2,
      showEditableInterpretationSummary: true,
      reason: "clarification_attempt_limit",
      axis: "french_jazz_scope",
      interpretationSummary: {
        mustHave: ["Jazz", "Artists from France"],
        prefer: ["Editorial balance"],
        avoid: ["Duplicate recordings"],
        flow: ["Smooth"],
        count: 50,
      },
      actions: {
        changeEarlierAnswer: true,
        reviewContract: true,
        resumeLater: true,
        cancel: true,
      },
    },
    resolution: {
      state: "needs_decision",
      nextAction: "review_contract",
      terminal: false,
      contractRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
      contractRevision: 4,
      contractHash: "d".repeat(64),
      blocker: {
        kind: "scope_decision",
        nextRetryAt: null,
        automaticRetryUntil: null,
        retryCount: 0,
      },
    },
  };
  await context.route(`**/api/v1/runs/${summaryRun.id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(summaryRun),
    });
  });

  await page.goto(`/?run=${summaryRun.id}`);
  const summary = page.getByTestId("clarification-limit-summary");
  await expect(summary).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /clarification limit reached/i }),
  ).toBeVisible();
  const contract = page.getByTestId("clarification-limit-contract");
  await expect(contract).toContainText("MUST HAVE");
  await expect(contract).toContainText("Artists from France");
  await expect(contract).toContainText("PREFER");
  await expect(contract).toContainText("Editorial balance");
  await expect(contract).toContainText("AVOID");
  await expect(contract).toContainText("Duplicate recordings");
  await expect(contract).toContainText("FLOW");
  await expect(contract).toContainText("Smooth");
  await expect(contract).toContainText("50 TRACKS · EXACT");
  await expect(
    page.getByRole("button", { name: /change an earlier answer/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /return to jobs/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /cancel job/i }),
  ).toBeVisible();
  await expect(page.getByText("QUESTION 1 OF")).toHaveCount(0);
});
