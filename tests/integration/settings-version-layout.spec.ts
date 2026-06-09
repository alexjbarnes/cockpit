// Regression: opening the Settings page must not shift content downward when
// the Claude Code and Cockpit version cards finish loading.
//
// The version cards are reserved from first paint with a min-height wrapper.
// Before the fix, the cards appeared late and pushed the nav rows down
// (cumulative layout shift). This test intercepts the version endpoints
// behind manual gates so the before/after layout state is deterministic.

import { expect, test } from "./fixtures";

test("settings version cards do not shift the nav row on load", async ({ page, harness }) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  // Gate the two version endpoints so we control when they resolve
  let releaseVersion!: () => void;
  let releaseCockpit!: () => void;
  const versionGate = new Promise<void>((r) => {
    releaseVersion = r;
  });
  const cockpitGate = new Promise<void>((r) => {
    releaseCockpit = r;
  });

  await page.route("**/api/version", async (route) => {
    await versionGate;
    await route.fulfill({
      json: { installed: "2.0.0", latest: "2.0.0", updateCommand: "npm i -g @anthropic-ai/claude-code" },
    });
  });

  await page.route("**/api/version/cockpit", async (route) => {
    await cockpitGate;
    await route.fulfill({
      json: { installed: "0.4.0", latest: "0.4.0", installMethod: "dev", updateCommand: null },
    });
  });

  // Fulfill changelog endpoints immediately so the "What's New" header is
  // part of the loaded steady state
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

  // Capture any uncaught client error
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto(`${harness.cockpitUrl}/settings`);

  // Self-validate that interception is holding: the nav row should be visible
  // but the version cards should NOT yet be present
  const anchor = page.getByRole("button", { name: "Session Defaults" });
  await expect(anchor).toBeVisible();
  await expect(page.getByText("Claude Code")).toHaveCount(0);
  await expect(page.getByText("Cockpit", { exact: true })).toHaveCount(0);
  const before = await anchor.boundingBox();
  expect(before).not.toBeNull();

  // Release both version gates and wait for the cards to appear
  releaseVersion();
  releaseCockpit();
  await expect(page.getByText("Claude Code")).toBeVisible();
  await expect(page.getByText("Cockpit", { exact: true })).toBeVisible();

  const after = await anchor.boundingBox();
  expect(after).not.toBeNull();

  // The nav row must not have shifted by more than 1px
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);

  expect(pageErrors, `unexpected page errors: ${pageErrors.join(" | ")}`).toHaveLength(0);
});
