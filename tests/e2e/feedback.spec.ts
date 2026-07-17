import { expect, test } from "@playwright/test";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

test("visitors can open the mobile-safe menu and submit private feedback", async ({ page }) => {
  await page.goto("/");

  const menu = page.getByRole("button", { name: /open menu/i });
  await expect(menu).toBeVisible();
  await expect(menu).toBeEnabled();
  const menuBox = await menu.boundingBox();
  expect(menuBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(menuBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  await menu.click();
  const feedbackLink = page.getByRole("link", { name: /submit bug or improvement/i });
  await expect(feedbackLink).toBeVisible();
  await feedbackLink.click();
  await expect(page).toHaveURL(/\/feedback$/u);

  let submitted: Record<string, unknown> | undefined;
  let idempotencyKey = "";
  await page.route("**/api/v1/feedback", async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    idempotencyKey = route.request().headers()["idempotency-key"] ?? "";
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ received: true, id: "feedback-1" }),
    });
  });

  await page.getByText("IMPROVEMENT", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "IMPROVEMENT" })).toBeChecked();
  await page.getByRole("textbox", { name: /description/i }).fill("Show clearer progress while Apple Music matching runs.");
  await page.locator('input[type="file"]').setInputFiles({
    name: "screenshot.png",
    mimeType: "image/png",
    buffer: ONE_PIXEL_PNG,
  });
  await expect(page.getByRole("img", { name: /screenshot ready/i })).toBeVisible();
  await page.getByRole("button", { name: /submit feedback/i }).click();

  await expect(page.getByRole("heading", { name: "THANK YOU." })).toBeVisible();
  expect(idempotencyKey.length).toBeGreaterThan(8);
  expect(submitted).toMatchObject({
    kind: "improvement",
    message: "Show clearer progress while Apple Music matching runs.",
    pagePath: "/",
    image: { mimeType: "image/png", width: 1, height: 1 },
  });
  expect(submitted).not.toHaveProperty("url");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("the site menu is keyboard-operable and Escape restores focus", async ({ page }) => {
  await page.goto("/");

  const menu = page.getByRole("button", { name: /open menu/i });
  await expect(menu).toBeEnabled();
  await menu.focus();
  await expect(menu).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: /submit bug or improvement/i })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: /submit bug or improvement/i })).toBeHidden();
  await expect(menu).toBeFocused();
});

test("feedback rejects unsupported attachments without losing the report", async ({ page }) => {
  await page.goto("/feedback");
  await page.getByText("IMPROVEMENT", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "IMPROVEMENT" })).toBeChecked();
  const description = page.getByRole("textbox", { name: /description/i });
  await description.fill("The progress screen needs more specific status copy.");

  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });

  await expect(page.getByRole("alert")).toContainText("Choose a PNG or JPEG image.");
  await expect(description).toHaveValue("The progress screen needs more specific status copy.");
  await expect(page.getByRole("button", { name: /submit feedback/i })).toBeEnabled();
});

test("a temporary feedback failure can be retried with the same idempotency key", async ({ page }) => {
  const attempts: string[] = [];
  await page.route("**/api/v1/feedback", async (route) => {
    attempts.push(route.request().headers()["idempotency-key"] ?? "");
    if (attempts.length === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Feedback is temporarily unavailable." }),
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ received: true, id: "feedback-retry" }),
    });
  });

  await page.goto("/feedback");
  await page.getByText("IMPROVEMENT", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "IMPROVEMENT" })).toBeChecked();
  await page.getByRole("textbox", { name: /description/i }).fill("Apple matching should explain which titles need attention.");
  const submit = page.getByRole("button", { name: /submit feedback/i });
  await submit.click();
  await expect(page.getByRole("alert")).toContainText("Feedback is temporarily unavailable.");
  await submit.click();

  await expect(page.getByRole("heading", { name: "THANK YOU." })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).not.toBe("");
  expect(attempts[1]).toBe(attempts[0]);
});
