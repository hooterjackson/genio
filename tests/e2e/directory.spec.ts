import { expect, test } from "@playwright/test";

const pageOne = {
  items: [
    {
      id: "playlist-1",
      title: "Paulinho da Costa Essentials",
      trackCount: 100,
      volumeCount: 1,
      publishedAt: "2026-07-16T22:00:00.000Z",
      volumes: [
        {
          volumeNumber: 1,
          name: "Paulinho da Costa Essentials",
          trackCount: 100,
          shareUrl: "https://music.apple.com/us/playlist/paulinho-da-costa-essentials/pl.u-test",
        },
      ],
    },
    {
      id: "playlist-2",
      title: "Brazilian Boogie: 1978–1986",
      trackCount: 150,
      volumeCount: 2,
      publishedAt: "2026-07-15T18:30:00.000Z",
      volumes: [
        {
          volumeNumber: 2,
          name: "Brazilian Boogie [2/2]",
          trackCount: 50,
          shareUrl: "https://music.apple.com/us/playlist/brazilian-boogie-2/pl.u-two",
        },
        {
          volumeNumber: 1,
          name: "Brazilian Boogie [1/2]",
          trackCount: 100,
          shareUrl: "https://music.apple.com/us/playlist/brazilian-boogie-1/pl.u-one",
        },
      ],
    },
    {
      id: "playlist-3",
      title: "Link pending",
      trackCount: 25,
      volumeCount: 1,
      publishedAt: "2026-07-14T12:00:00.000Z",
      volumes: [
        {
          volumeNumber: 1,
          name: "Unsafe link",
          trackCount: 25,
          shareUrl: "https://example.com/not-apple",
        },
      ],
    },
  ],
  page: 1,
  pageSize: 12,
  total: 3,
  totalPages: 1,
};

test("the public playlist library is responsive, ordered, and opens only Apple Music links", async ({ page }) => {
  await page.route("**/api/v1/playlists?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pageOne) });
  });

  await page.goto("/playlists");

  await expect(page.getByRole("heading", { name: "Explore playlists" })).toBeVisible();
  await expect(page.getByText("Explore playlists researched and published by gênio.")).toBeVisible();
  await expect(page.getByText("3 PUBLIC PLAYLISTS")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Paulinho da Costa Essentials" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Brazilian Boogie: 1978–1986" })).toBeVisible();
  await expect(page.getByText("100 TRACKS · 1 VOLUME")).toBeVisible();
  await expect(page.getByText("150 TRACKS · 2 VOLUMES")).toBeVisible();

  const appleLinks = page.getByRole("link", { name: /open .* in apple music/i });
  await expect(appleLinks).toHaveCount(3);
  await expect(appleLinks.nth(0)).toHaveAttribute("href", /music\.apple\.com\/us\/playlist/u);
  await expect(appleLinks.nth(0)).toHaveAttribute("target", "_blank");
  await expect(page.getByText("APPLE LINK UNAVAILABLE")).toBeVisible();
  await expect(page.locator('a[href*="example.com"]')).toHaveCount(0);

  const multiVolumeLabels = page.locator(".directory-playlist").nth(1).locator(".directory-volume-links > a > span");
  await expect(multiVolumeLabels).toHaveText(["VOLUME 1", "VOLUME 2"]);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  const undersized = await page.locator("a[href], button").evaluateAll((controls) => controls.flatMap((control) => {
    const rect = control.getBoundingClientRect();
    return rect.width < 44 || rect.height < 44
      ? [{ label: control.textContent?.trim() ?? "control", width: rect.width, height: rect.height }]
      : [];
  }));
  expect(undersized).toEqual([]);
});

test("the primary Create, Explore, and Jobs navigation remains clear across public screens", async ({ page }) => {
  await page.route("**/api/v1/playlists?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pageOne) });
  });

  await page.goto("/");
  await expect(page.getByRole("link", { name: "CREATE", exact: true })).toHaveAttribute("aria-current", "page");
  const exploreLink = page.getByRole("link", { name: "EXPLORE", exact: true });
  await expect(exploreLink).toHaveAttribute("href", "/playlists");
  await expect(page.getByRole("button", { name: "JOBS", exact: true })).toBeVisible();
  await exploreLink.click();
  await expect(page).toHaveURL(/\/playlists$/u);
  await expect(page.getByRole("heading", { name: "Explore playlists" })).toBeVisible();
  await expect(page.getByRole("link", { name: "EXPLORE", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "CREATE", exact: true })).toHaveAttribute("href", "/");
  await expect(page.getByRole("link", { name: "JOBS", exact: true })).toHaveAttribute("href", "/?view=jobs");
});

test("directory pagination updates the public URL and loads the selected page", async ({ page }) => {
  await page.route("**/api/v1/playlists?*", async (route) => {
    const requestedPage = Number.parseInt(new URL(route.request().url()).searchParams.get("page") ?? "1", 10);
    const payload = requestedPage === 2
      ? {
          items: [{
            ...pageOne.items[0],
            id: "playlist-page-2",
            title: "Page Two Selection",
          }],
          page: 2,
          pageSize: 12,
          total: 13,
          totalPages: 2,
        }
      : { ...pageOne, total: 13, totalPages: 2 };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });

  await page.goto("/playlists");
  await expect(page.getByText("PAGE 1 / 2")).toBeVisible();
  await expect(page.getByRole("button", { name: "← PREVIOUS" })).toBeDisabled();
  await page.getByRole("button", { name: "NEXT →" }).click();
  await expect(page).toHaveURL(/\/playlists\?page=2$/u);
  await expect(page.getByText("PAGE 2 / 2")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Page Two Selection" })).toBeVisible();
  await expect(page.getByRole("button", { name: "NEXT →" })).toBeDisabled();
  await page.getByRole("button", { name: "← PREVIOUS" }).click();
  await expect(page).toHaveURL(/\/playlists$/u);
});

test("directory loading, empty, and retry states remain explicit", async ({ page }) => {
  let requestCount = 0;
  await page.route("**/api/v1/playlists?*", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], page: 1, pageSize: 12, total: 0, totalPages: 1 }),
    });
  });

  await page.goto("/playlists");
  await expect(page.getByRole("status", { name: /loading public playlists/i })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("PLAYLISTS COULD NOT BE LOADED.");
  await page.getByRole("button", { name: "RETRY →" }).click();
  await expect(page.getByText("NO PLAYLISTS YET.")).toBeVisible();
  await expect(page.getByRole("link", { name: "CREATE THE FIRST ONE →" })).toHaveAttribute("href", "/");
});
