import { expect, test, type Page } from "@playwright/test";

const ownerHealth = {
  ok: true,
  paused: false,
  database: "ready",
  worker: "healthy",
  apple: {
    configured: true,
    authorized: true,
    status: "valid",
    storefront: "us",
    validatedAt: "2026-07-16T12:00:00.000Z",
    needsReauthorization: false,
    lastError: null,
  },
  queuedJobs: 0,
  activeJobs: 0,
  monthSpendUsd: 4.25,
  monthReservedUsd: 0,
  notificationBacklog: 0,
  orphanedPlaylists: 0,
};

const feedbackItems = Array.from({ length: 55 }, (_, index) => ({
  id: `feedback-${index + 1}`,
  kind: index % 2 === 0 ? "bug" : "improvement",
  status: index < 4 ? "new" : index < 8 ? "reviewed" : "resolved",
  message: `Private feedback report ${index + 1}`,
  pagePath: index % 2 === 0 ? "/" : "/feedback",
  appVersion: "qa-build",
  createdAt: new Date(Date.UTC(2026, 6, 16, 12, index)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 6, 16, 12, index)).toISOString(),
  hasImage: index === 0,
}));

const corpusSourceId = "00000000-0000-4000-8000-000000000101";
const corpusObservationId = "00000000-0000-4000-8000-000000000102";
const corpusRecordingId = "00000000-0000-4000-8000-000000000103";

function feedbackPage(offset: number, limit: number) {
  return {
    items: feedbackItems.slice(offset, offset + limit),
    total: feedbackItems.length,
    counts: { new: 4, reviewed: 4, resolved: 47 },
  };
}

async function mockOwnerApis(page: Page): Promise<void> {
  await page.route("**/api/v1/owner/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/v1/owner/status") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ownerHealth) });
      return;
    }
    if (path === "/api/v1/owner/budgets") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
      return;
    }
    if (path === "/api/v1/owner/publications/orphans") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
      return;
    }
    if (path === "/api/v1/owner/runs") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
      return;
    }
    if (path === "/api/v1/owner/feedback" && request.method() === "GET") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(feedbackPage(offset, limit)),
      });
      return;
    }
    if (path === "/api/v1/owner/corpus/sources" && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{
            id: corpusSourceId,
            title: "QA specialist archive",
            url: "https://archive.example/track",
            sourceClass: "specialist_archive",
            provenanceRoot: "archive.example",
            status: "active",
            metadataJson: { evidenceGraphPolicy: { approvalState: "approved", authority: "specialist_track_credit", licenseState: "permission_recorded" } },
          }],
          total: 1,
          limit: 25,
          offset: 0,
        }),
      });
      return;
    }
    if (path === "/api/v1/owner/corpus/review" && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{
            observation: {
              id: corpusObservationId,
              predicate: "performed_on",
              supportExcerpt: "The liner notes explicitly credit percussion on this exact track.",
              confidence: 0.98,
              status: "quarantined",
              recordingId: corpusRecordingId,
            },
            source: {
              id: corpusSourceId,
              title: "QA specialist archive",
              url: "https://archive.example/track",
              provenanceRoot: "archive.example",
              status: "active",
            },
          }],
          total: 1,
          limit: 25,
          offset: 0,
        }),
      });
      return;
    }
    if (path === "/api/v1/owner/corpus/assertions" && request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], total: 0, limit: 25, offset: 0 }) });
      return;
    }
    if (path === "/api/v1/owner/corpus/snapshots" && request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], total: 0, limit: 25, offset: 0 }) });
      return;
    }
    if (path === "/api/v1/owner/apple/developer-token") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "MusicKit is intentionally unavailable in this UI test." }),
      });
      return;
    }

    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unexpected owner route" }) });
  });
}

test("the feedback inbox is not exposed without the owner identity", async ({ page }) => {
  await page.goto("/owner");
  if (await page.getByText("Owner allowlist is not configured.").count()) {
    await expect(page.getByText("Private feedback report 1")).toHaveCount(0);
    return;
  }
  await expect(page).toHaveURL(/\/signin-with-chatgpt\?return_to=/u);
  await expect(page.getByText("Private feedback report 1")).toHaveCount(0);
});

test("the owner can page through the private feedback inbox and see attachments", async ({ page }) => {
  await page.setExtraHTTPHeaders({
    "oai-authenticated-user-email": "owner@example.com",
    "x-needle-owner-verified": "1",
  });
  await mockOwnerApis(page);
  await page.goto("/owner");
  await expect(page.getByText("Owner allowlist is not configured.")).toHaveCount(0);

  await expect(page.getByRole("heading", { name: "System control" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "BUGS + IMPROVEMENTS" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "V3 EVIDENCE CORPUS" })).toBeVisible();
  await expect(page.getByText("The liner notes explicitly credit percussion on this exact track.")).toBeVisible();
  const promote = page.getByRole("button", { name: "PROMOTE SELECTED [0]" });
  await expect(promote).toBeDisabled();
  await page.locator(`.operator-corpus-observation input[type="checkbox"]`).check();
  await expect(page.getByRole("button", { name: "PROMOTE SELECTED [1]" })).toBeEnabled();
  await expect(page.getByText("[50/55]", { exact: true })).toBeVisible();
  await expect(page.locator(".operator-feedback")).toHaveCount(50);
  await expect(page.getByText("Private feedback report 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /open image/i })).toHaveAttribute(
    "href",
    "/api/v1/owner/feedback/feedback-1/image",
  );

  await page.getByRole("button", { name: "LOAD OLDER" }).click();
  await expect(page.getByText("[55/55]", { exact: true })).toBeVisible();
  await expect(page.locator(".operator-feedback")).toHaveCount(55);
  await expect(page.getByText("Private feedback report 55", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "LOAD OLDER" })).toHaveCount(0);
});
