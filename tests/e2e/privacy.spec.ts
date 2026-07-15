import { expect, test } from "@playwright/test";

test("the public footer opens the complete minimal privacy notice", async ({ page }) => {
  await page.goto("/");
  const privacyLink = page.getByRole("link", { name: /privacy/i });
  await expect(privacyLink).toBeVisible();
  await privacyLink.click();

  await expect(page).toHaveURL(/\/privacy$/u);
  await expect(page.getByRole("heading", { name: "PRIVACY_" })).toBeVisible();
  await expect(page.getByText(/browser cookie keeps your jobs available on this device/i)).toBeVisible();
  await expect(page.getByText(/visitors do not provide emails or create accounts/i)).toBeVisible();
  await expect(page.getByText(/daily HMAC-derived network buckets/i)).toBeVisible();
  await expect(page.getByText(/never raw IP addresses/i)).toBeVisible();
  await expect(page.getByText(/deleted after 48 hours/i)).toBeVisible();
  await expect(page.getByText(/OpenAI processes prompts and web research with AI/i)).toBeVisible();
  await expect(page.getByText(/OpenAI Sites serves the interface/i)).toBeVisible();
  await expect(page.getByText(/Railway runs and stores the service/i)).toBeVisible();
  await expect(page.getByText(/Resend alerts only the owner/i)).toBeVisible();
  await expect(page.getByText(/Detailed run data is kept for 90 days/i)).toBeVisible();
  await expect(page.getByText(/cannot remove a playlist already published/i)).toBeVisible();
  await expect(page.getByText(/not directed to children/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "mrcloblima@gmail.com" })).toHaveAttribute(
    "href",
    "mailto:mrcloblima@gmail.com",
  );

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("privacy navigation remains touch-friendly", async ({ page }) => {
  await page.goto("/privacy");
  const undersized = await page.locator("a[href]").evaluateAll((links) => links.flatMap((link) => {
    const rect = link.getBoundingClientRect();
    return rect.width < 44 || rect.height < 44
      ? [{ label: link.textContent?.trim() ?? "link", width: rect.width, height: rect.height }]
      : [];
  }));
  expect(undersized).toEqual([]);
});
