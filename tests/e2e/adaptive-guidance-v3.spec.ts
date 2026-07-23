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
    phase: "v3_waiting_for_retrieval_provider",
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
      nextAction: "review_contract",
      terminal: false,
      contractRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      contractRevision: 1,
      contractHash: "7".repeat(64),
      blocker: {
        kind: "scope_decision",
        nextRetryAt: null,
        automaticRetryUntil: "2026-07-23T12:00:00.000Z",
        retryCount: 8,
      },
    },
  };
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
      body: JSON.stringify(dependencyRun),
    });
  });

  await page.goto("/");
  await page.getByRole("textbox", { name: /playlist request/i })
    .fill(dependencyRun.prompt);
  await page.getByRole("button", { name: /create playlist/i }).click();
  const panel = page.getByTestId("run-decision-panel");
  await expect(panel).toContainText("24-hour automatic retry window ended");
  await expect(panel).toContainText("service dependency state");
  await expect(panel).toContainText("not a claim that the music does not exist");
  await expect(panel).toContainText("PROGRESS IS SAVED");
  await expect(page.getByRole("button", { name: /refine request/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /cancel job/i })).toBeVisible();
  await expect(page.getByText(/no verified tracks are ready yet/i)).toHaveCount(0);
});
