// Regression: settings content columns must be horizontally centered on
// desktop, fill available width on mobile, and hold centering in dark theme.
//
// Each settings page wraps its content in a max-w-* div that was missing
// mx-auto, pinning the column to the left. This test asserts the column is
// centered (left and right gutters equal within 2px) on the five in-scope
// pages, fills width on mobile, and remains centered in dark theme.

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function stubVersionEndpoints(page: Page) {
  await page.route("**/api/version", async (route) => {
    await route.fulfill({
      json: { installed: "2.0.0", latest: "2.0.0", updateCommand: "npm i -g @anthropic-ai/claude-code" },
    });
  });
  await page.route("**/api/version/cockpit", async (route) => {
    await route.fulfill({
      json: { installed: "0.4.0", latest: "0.4.0", installMethod: "dev", updateCommand: null },
    });
  });
  await page.route("**/api/version/changelog", async (route) => {
    await route.fulfill({ json: { releases: [{ version: "1.9.9", items: ["x"] }] } });
  });
  await page.route("**/api/version/cockpit/changelog", async (route) => {
    await route.fulfill({
      json: {
        releases: [{ version: "0.4.0", date: "2026-06-01", sections: [{ heading: "Fixes", items: ["y"] }] }],
        repo: "alexjbarnes/cockpit",
      },
    });
  });
}

async function assertCentered(col: Locator) {
  const container = col.locator("xpath=..");
  const b = await col.boundingBox();
  const c = await container.boundingBox();
  expect(b && c).toBeTruthy();
  const leftGutter = b!.x - c!.x;
  const rightGutter = c!.x + c!.width - (b!.x + b!.width);
  expect(Math.abs(leftGutter - rightGutter)).toBeLessThanOrEqual(2);
  // real gutter exists -> assertion is meaningful
  expect(c!.width - b!.width).toBeGreaterThan(100);
}

test.describe("settings page width", () => {
  const PAGES = ["/settings", "/settings/session", "/settings/appearance", "/settings/providers", "/settings/providers/new"];

  test("desktop centering on all in-scope settings pages", async ({ page, harness }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await stubVersionEndpoints(page);

    for (const path of PAGES) {
      await page.goto(`${harness.cockpitUrl}${path}`);
      const col = page.getByTestId("settings-content");
      await expect(col).toBeVisible();
      await assertCentered(col);
    }
  });

  test("dark theme centering on /settings", async ({ page, harness }) => {
    await page.addInitScript(() => localStorage.setItem("cockpit-theme", "dark"));
    await page.setViewportSize({ width: 1280, height: 800 });
    await stubVersionEndpoints(page);

    await page.goto(`${harness.cockpitUrl}/settings`);
    const col = page.getByTestId("settings-content");
    await expect(col).toBeVisible();
    await assertCentered(col);
  });

  test("mobile no-regression: column fills available width", async ({ page, harness }) => {
    await page.setViewportSize({ width: 393, height: 800 });
    await stubVersionEndpoints(page);

    await page.goto(`${harness.cockpitUrl}/settings`);
    const col = page.getByTestId("settings-content");
    await expect(col).toBeVisible();
    const container = col.locator("xpath=..");
    const b = await col.boundingBox();
    const c = await container.boundingBox();
    expect(b && c).toBeTruthy();
    // at mobile the column fills the content width; only the container's p-4 padding differs
    expect(c!.width - b!.width).toBeLessThanOrEqual(40);
    expect(b!.x).toBeGreaterThanOrEqual(0);
  });
});
