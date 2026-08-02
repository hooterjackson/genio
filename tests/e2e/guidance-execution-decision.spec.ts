import {
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import type { PlaylistBrief } from "../../shared/types";

const requestId = "brief-guidance-execution-decision";
const questionSetHash = "1".repeat(64);
const decisionHash = "2".repeat(64);
const actionHashes = {
  execute_confirmed_contract: "3".repeat(64),
  review_interpretation: "4".repeat(64),
  cancel_request: "5".repeat(64),
} as const;
const prompt = "Influential Irish music";

const brief: PlaylistBrief = {
  title: "Influential Irish Music",
  description: "Irish artists and recordings with lasting musical influence.",
  mode: "curated",
  subjectEntities: ["Irish music"],
  relationship: "documented musical influence",
  include: ["Irish artists and recordings"],
  exclude: [],
  versionPolicy: "canonical studio recordings",
  evidencePolicy: "documented influence and exact artist identity",
  orderingPolicy: "coherent editorial flow",
  targetSize: { min: 25, max: 25 },
  ambiguities: [],
};

const question = {
  schemaVersion: 5,
  id: "guidance:execution-decision:confirmed-contract",
  questionHash: decisionHash,
  header: "Before research",
  question: "What should gênio do with this confirmed interpretation?",
  criticality: "required",
  selectionMode: "single",
  allowCustom: false,
  guidanceMode: "execution_decision",
  options: [
    {
      id: "execute_confirmed_contract",
      label: "Research this interpretation",
      description: "Start research using the exact confirmed contract.",
      recommended: true,
      executionAction: {
        kind: "execute_confirmed_contract",
        startsResearch: true,
      },
    },
    {
      id: "review_interpretation",
      label: "Review before research",
      description: "Return the saved wording and count to the request editor.",
      recommended: false,
      executionAction: {
        kind: "review_interpretation",
        startsResearch: false,
      },
    },
    {
      id: "cancel_request",
      label: "Cancel this request",
      description: "Save a cancelled outcome without researching or publishing.",
      recommended: false,
      executionAction: {
        kind: "cancel_request",
        startsResearch: false,
      },
    },
  ],
};

type ExecutionKind = keyof typeof actionHashes;

function executionAction(kind: ExecutionKind) {
  return {
    decisionHash,
    optionId: kind,
    kind,
    startsResearch: kind === "execute_confirmed_contract",
    actionHash: actionHashes[kind],
  };
}

const researchingRun = {
  id: "run-guidance-execution-decision",
  prompt,
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

async function installExecutionDecisionRoutes(
  context: BrowserContext,
  kind: ExecutionKind,
): Promise<{
  answerBodies: Array<Record<string, unknown>>;
  briefGetCount: () => number;
  runPostCount: () => number;
  briefDeleteCount: () => number;
}> {
  const answerBodies: Array<Record<string, unknown>> = [];
  let briefGetCount = 0;
  let runPostCount = 0;
  let briefDeleteCount = 0;
  let answered = false;

  await context.route("**/api/v1/brief/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === `/api/v1/brief/${requestId}/answers`
      && request.method() === "POST") {
      answerBodies.push(request.postDataJSON() as Record<string, unknown>);
      answered = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          requestId,
          prompt,
          requestedTrackCount: 25,
          brief,
          status: kind === "execute_confirmed_contract"
            ? "finalizing"
            : kind === "review_interpretation"
              ? "review_required"
              : "cancelled",
          executionAction: executionAction(kind),
        }),
      });
      return;
    }
    if (pathname === `/api/v1/brief/${requestId}`
      && request.method() === "DELETE") {
      briefDeleteCount += 1;
      await route.fulfill({ status: 204 });
      return;
    }
    if (pathname === `/api/v1/brief/${requestId}`
      && request.method() === "GET") {
      briefGetCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(answered
          && kind === "execute_confirmed_contract"
          ? {
              requestId,
              prompt,
              requestedTrackCount: 25,
              status: "complete",
              brief,
              executionAction: executionAction(kind),
            }
          : {
              requestId,
              prompt,
              requestedTrackCount: 25,
              status: "awaiting_answers",
              briefContractVersion: 3,
              checkpointMode: "execution_decision",
              questionSetHash,
              brief,
              questions: [question],
            }),
      });
      return;
    }
    await route.fallback();
  });

  await context.route("**/api/v1/runs", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [] }),
      });
      return;
    }
    runPostCount += 1;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        run: researchingRun,
        capability: "execution-decision-capability",
      }),
    });
  });
  await context.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runId: researchingRun.id }),
    });
  });
  await context.route(
    `**/api/v1/runs/${researchingRun.id}`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(researchingRun),
      });
    },
  );

  return {
    answerBodies,
    briefGetCount: () => briefGetCount,
    runPostCount: () => runPostCount,
    briefDeleteCount: () => briefDeleteCount,
  };
}

async function openExecutionDecision(page: Page): Promise<void> {
  await page.goto(`/?brief=${requestId}`);
  await expect(
    page.getByRole("heading", { name: question.question }),
  ).toBeVisible();
}

test("execute starts research only after the hash-bound browser choice", async ({
  context,
  page,
}) => {
  const observed = await installExecutionDecisionRoutes(
    context,
    "execute_confirmed_contract",
  );
  await openExecutionDecision(page);

  const executeChoice = page.getByRole(
    "radio",
    { name: /research this interpretation/i },
  );
  await executeChoice.locator("..").click();
  await expect(executeChoice).toBeChecked();
  await page.getByRole("button", { name: /create playlist/i }).click();

  await expect(
    page.getByRole("heading", { name: "Researching your playlist" }),
  ).toBeVisible();
  expect(observed.answerBodies).toHaveLength(1);
  expect(observed.answerBodies[0]).toMatchObject({
    questionSetHash,
    answers: [{
      questionId: question.id,
      optionId: "execute_confirmed_contract",
    }],
  });
  expect(observed.briefGetCount()).toBeGreaterThanOrEqual(2);
  expect(observed.runPostCount()).toBe(1);
  expect(observed.briefDeleteCount()).toBe(0);
});

test("review returns the preserved request to the editor without polling or research", async ({
  context,
  page,
}) => {
  const observed = await installExecutionDecisionRoutes(
    context,
    "review_interpretation",
  );
  await openExecutionDecision(page);
  const initialGetCount = observed.briefGetCount();

  const reviewChoice = page.getByRole(
    "radio",
    { name: /review before research/i },
  );
  await reviewChoice.locator("..").click();
  await expect(reviewChoice).toBeChecked();
  await page.getByRole("button", { name: /return to request/i }).click();

  await expect(
    page.getByRole("heading", { name: "Create a playlist" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: /playlist request/i }),
  ).toHaveValue(prompt);
  await expect(
    page.getByRole("button", { name: "25 tracks", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(750);
  expect(observed.answerBodies).toHaveLength(1);
  expect(observed.briefGetCount()).toBe(initialGetCount);
  expect(observed.runPostCount()).toBe(0);
  expect(observed.briefDeleteCount()).toBe(0);
  expect(new URL(page.url()).searchParams.has("brief")).toBe(false);
});

test("cancel renders a durable terminal receipt and never polls, starts, or deletes it", async ({
  context,
  page,
}) => {
  const observed = await installExecutionDecisionRoutes(
    context,
    "cancel_request",
  );
  await openExecutionDecision(page);
  const initialGetCount = observed.briefGetCount();

  const cancelChoice = page.getByRole(
    "radio",
    { name: /cancel this request/i },
  );
  await cancelChoice.locator("..").click();
  await expect(cancelChoice).toBeChecked();
  await page.getByRole("button", { name: /cancel request/i }).click();

  await expect(
    page.getByRole("heading", {
      name: "Nothing was researched or published",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("This playlist request was cancelled at the guidance checkpoint."),
  ).toBeVisible();
  await page.waitForTimeout(750);
  expect(observed.answerBodies).toHaveLength(1);
  expect(observed.briefGetCount()).toBe(initialGetCount);
  expect(observed.runPostCount()).toBe(0);
  expect(observed.briefDeleteCount()).toBe(0);

  await page.getByRole("link", { name: "Jobs" }).click();
  await expect(page.getByText("NO JOBS IN THIS VIEW")).toBeVisible();
  expect(observed.briefDeleteCount()).toBe(0);
});
