import { expect, test, type Page } from "@playwright/test";
import type { PlaylistBrief } from "../../shared/types";

const emptyDirectory = {
  items: [],
  page: 1,
  pageSize: 12,
  total: 0,
  totalPages: 1,
};

const navigationBrief: PlaylistBrief = {
  title: "Navigation regression playlist",
  description: "A playlist used to verify the shared public shell.",
  mode: "curated",
  subjectEntities: ["navigation"],
  relationship: "selected for",
  include: ["released recordings"],
  exclude: [],
  versionPolicy: "one canonical version per track",
  evidencePolicy: "editorial evidence",
  orderingPolicy: "editorial flow",
  targetSize: { min: 25, max: 25 },
  ambiguities: [],
};

const activeRun = {
  id: "run-navigation",
  prompt: "Movie icons",
  brief: navigationBrief,
  status: "researching",
  estimatedCostUsd: 0.2,
  actualCostUsd: 0.04,
  approvedBudgetUsd: 0.5,
  phase: "fast_research",
  error: null,
  candidateCount: 8,
  sourceCount: 3,
  unresolvedCount: 0,
  frontier: [],
  autoPublish: true,
};

type HeaderGeometry = {
  centers: number[];
  artCenterY: number;
  headerCenterY: number;
  menuCenterY: number;
  navCenterY: number;
};

async function expectStableHeader(page: Page): Promise<HeaderGeometry> {
  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(nav).toBeVisible();
  const items = nav.locator("[data-nav-item]");
  await expect(items).toHaveCount(3);
  await expect(page.getByRole("link", { name: "CREATE", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "EXPLORE", exact: true })).toBeVisible();
  await expect(nav.getByText("JOBS", { exact: true })).toBeVisible();

  const geometry = await page.locator(".site-header").evaluate((header) => {
    const headerBox = header.getBoundingClientRect();
    const navElement = header.querySelector<HTMLElement>(".primary-nav");
    const menu = header.querySelector<HTMLElement>(".site-menu-trigger");
    const wordmark = header.querySelector<HTMLElement>(".wordmark");
    const controls = [...header.querySelectorAll<HTMLElement>("[data-nav-item]")];
    if (!navElement || !menu || !wordmark || controls.length !== 3) throw new Error("Shared header controls are incomplete");
    const wordmarkBox = wordmark.getBoundingClientRect();
    const menuBox = menu.getBoundingClientRect();
    const art = header.querySelector<HTMLElement>(".brand-wordmark-art");
    if (!art) throw new Error("Shared header wordmark art is missing");
    const artBox = art.getBoundingClientRect();
    return {
      header: { top: headerBox.top, right: headerBox.right, bottom: headerBox.bottom, left: headerBox.left },
      wordmark: { left: wordmarkBox.left, right: wordmarkBox.right },
      art: {
        left: artBox.left,
        right: artBox.right,
        top: artBox.top,
        bottom: artBox.bottom,
        width: artBox.width,
        height: artBox.height,
      },
      menu: { left: menuBox.left, right: menuBox.right },
      controls: controls.map((control) => {
        const box = control.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      }),
      navCenterY: (() => {
        const box = navElement.getBoundingClientRect();
        return box.top + box.height / 2;
      })(),
      menuCenterY: (() => {
        const box = menu.getBoundingClientRect();
        return box.top + box.height / 2;
      })(),
    };
  });

  for (const control of geometry.controls) {
    expect(control.width).toBeGreaterThanOrEqual(44);
    expect(control.height).toBeGreaterThanOrEqual(44);
    expect(control.left).toBeGreaterThanOrEqual(geometry.header.left);
    expect(control.right).toBeLessThanOrEqual(geometry.header.right);
    expect(control.top).toBeGreaterThanOrEqual(geometry.header.top);
    expect(control.bottom).toBeLessThanOrEqual(geometry.header.bottom);
  }
  const sorted = [...geometry.controls].sort((left, right) => left.left - right.left);
  for (let index = 1; index < sorted.length; index += 1) {
    expect(sorted[index]!.left).toBeGreaterThanOrEqual(sorted[index - 1]!.right);
  }
  expect(sorted[0]!.left).toBeGreaterThanOrEqual(geometry.wordmark.right);
  expect(sorted[0]!.left).toBeGreaterThanOrEqual(geometry.art.right);
  expect(sorted.at(-1)!.right).toBeLessThanOrEqual(geometry.menu.left);
  const centers = geometry.controls.map((control) => control.left + control.width / 2);
  const headerCenterY = (geometry.header.top + geometry.header.bottom) / 2;
  const artCenterY = (geometry.art.top + geometry.art.bottom) / 2;
  expect(Math.max(...geometry.controls.map((control) => control.top + control.height / 2))
    - Math.min(...geometry.controls.map((control) => control.top + control.height / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.navCenterY - geometry.menuCenterY)).toBeLessThanOrEqual(1);
  expect(Math.abs(artCenterY - geometry.navCenterY)).toBeLessThanOrEqual(1);
  expect(Math.abs(artCenterY - headerCenterY)).toBeLessThanOrEqual(1);
  expect(geometry.art.height).toBeGreaterThanOrEqual(23);
  expect(geometry.art.left).toBeGreaterThanOrEqual(geometry.header.left);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  return {
    centers,
    artCenterY,
    headerCenterY,
    navCenterY: geometry.navCenterY,
    menuCenterY: geometry.menuCenterY,
  };
}

async function expectSameHorizontalNavigation(left: HeaderGeometry, right: HeaderGeometry): Promise<void> {
  expect(left.centers).toHaveLength(right.centers.length);
  for (let index = 0; index < left.centers.length; index += 1) {
    expect(Math.abs(left.centers[index]! - right.centers[index]!)).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(left.artCenterY - right.artCenterY)).toBeLessThanOrEqual(1);
  expect(Math.abs(left.headerCenterY - right.headerCenterY)).toBeLessThanOrEqual(1);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("9enio:brand-intro:v2", "seen"));
  await page.route("**/api/v1/playlists?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyDirectory) });
  });
  await page.route("**/api/v1/runs", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });
});

test("Create, Explore, and Jobs stay aligned and tappable across the public shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create a playlist" })).toBeVisible();
  const createGeometry = await expectStableHeader(page);

  await page.getByRole("link", { name: "EXPLORE", exact: true }).click();
  await expect(page).toHaveURL(/\/playlists$/u);
  await expect(page.getByRole("heading", { name: "Explore playlists" })).toBeVisible();
  const exploreGeometry = await expectStableHeader(page);
  await expectSameHorizontalNavigation(createGeometry, exploreGeometry);

  await page.getByRole("link", { name: "CREATE", exact: true }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByRole("heading", { name: "Create a playlist" })).toBeVisible();
  await expectSameHorizontalNavigation(createGeometry, await expectStableHeader(page));

  await page.getByRole("button", { name: "JOBS", exact: true }).click();
  await expect(page).toHaveURL(/\?view=jobs$/u);
  await expect(page.getByRole("heading", { name: "Your jobs" })).toBeVisible();
  await expectSameHorizontalNavigation(createGeometry, await expectStableHeader(page));
});

test("an active job keeps all primary destinations and exposes Share Job without displacing them", async ({ page }, testInfo) => {
  await page.route("**/api/v1/capabilities/exchange", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: activeRun.id }) });
  });
  await page.route("**/api/v1/runs/run-navigation", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(activeRun) });
  });

  await page.goto("/#cap=one-time-secret&run=run-navigation");
  await expect(page.getByRole("heading", { name: "Researching your playlist" })).toBeVisible();
  const runGeometry = await expectStableHeader(page);

  if (testInfo.project.name === "desktop") {
    await expect(page.getByRole("button", { name: "SHARE JOB", exact: true })).toBeVisible();
  } else {
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("button", { name: "SHARE JOB", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close menu" }).click();
  }

  await page.getByRole("link", { name: "EXPLORE", exact: true }).click();
  await expect(page).toHaveURL(/\/playlists$/u);
  await expect(page.getByRole("heading", { name: "Explore playlists" })).toBeVisible();
  await expectSameHorizontalNavigation(runGeometry, await expectStableHeader(page));

  await page.getByRole("link", { name: "CREATE", exact: true }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByRole("heading", { name: "Create a playlist" })).toBeVisible();
});
