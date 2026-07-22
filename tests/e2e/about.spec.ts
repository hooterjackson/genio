import { expect, test } from "@playwright/test";
import { currentRelease, formatReleaseDate } from "../../shared/release-metadata";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("9enio:brand-intro:v2", "seen"));
  await page.route("**/health/live", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        build: {
          identifier: `${currentRelease.version}+123456789abc`,
          revision: "123456789abcdef0123456789abcdef012345678",
          version: currentRelease.version,
        },
        runtime: {
          pipelineVersion: "corpus_first_v3",
          assignmentEnabled: true,
          ownerCanaryEnabled: false,
          productionEvidenceApproved: true,
          factualFeasibilityApproved: false,
          schemaVersion: "15",
          workerProtocol: "playlist-pipeline-v8",
          selectionPlanVersion: "selection_plan_v3",
          queryPlanSchemaVersion: "2",
          queryPlanPolicyVersion: "corpus_first_v3_policy_v1",
          semanticScopePolicyVersion: "scope_gate_v2_1_2",
          musicConceptPolicyVersion: "music_concepts_v3_2_0",
          pipelinePolicyVersion: "pipeline_v3",
          promptVersion: "grounded_recovery_v3_1_prompt_v1",
          baselineProviderModelId: "gpt-5.6-luna",
          escalationProviderModelId: "gpt-5.6-terra",
          modelResolutionMode: "provider_managed_alias",
          modelCatalogValidatedAt: "2026-07-20T00:00:00.000Z",
          graphSnapshot: null,
        },
      }),
    });
  });
});

test("the hamburger menu opens the current version and patch notes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open menu" }).click();
  const aboutLink = page.getByRole("link", { name: "ABOUT", exact: true });
  await expect(aboutLink).toBeVisible();
  await aboutLink.click();

  await expect(page).toHaveURL(/\/about$/u);
  await expect(page.getByRole("heading", { name: `gênio v${currentRelease.version}` })).toBeVisible();
  await expect(page.locator(".about-hero time")).toHaveText(formatReleaseDate(currentRelease.releasedAt));
  await expect(page.locator(".release-list article").first().locator("time"))
    .toHaveText(formatReleaseDate(currentRelease.releasedAt));
  await expect(page.getByText("CURRENT RELEASE", { exact: true })).toBeVisible();
  await expect(page.getByText(`${currentRelease.version}+123456789abc`, { exact: true })).toBeVisible();
  await expect(page.getByText("123456789abc", { exact: true })).toBeVisible();
  await expect(page.getByText("playlist-pipeline-v8", { exact: true })).toBeVisible();
  await expect(page.getByText("2", { exact: true })).toBeVisible();
  await expect(page.getByText("scope gate v2 1 2", { exact: true })).toBeVisible();
  await expect(page.getByText("music concepts v3 2 0", { exact: true })).toBeVisible();
  await expect(page.getByText("IN SYNC", { exact: true })).toBeVisible();
  for (const note of currentRelease.notes) await expect(page.getByText(note, { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-build-version", currentRelease.version);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("About remains honest when live API build information is unavailable", async ({ page }) => {
  await page.unroute("**/health/live");
  await page.route("**/health/live", async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "offline" }) });
  });
  await page.goto("/about");
  await expect(page.getByText("UNAVAILABLE", { exact: true })).toBeVisible();
  await expect(page.getByText("STATUS UNKNOWN", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Running now" }).getByText(`v${currentRelease.version}`, { exact: true })).toBeVisible();
});

test("About navigation and controls remain touch-friendly", async ({ page }) => {
  await page.goto("/about");
  const undersized = await page.locator("a[href], button").evaluateAll((controls) => controls.flatMap((control) => {
    const rect = control.getBoundingClientRect();
    return rect.width < 44 || rect.height < 44
      ? [{ label: control.textContent?.trim() ?? "control", width: rect.width, height: rect.height }]
      : [];
  }));
  expect(undersized).toEqual([]);
});
