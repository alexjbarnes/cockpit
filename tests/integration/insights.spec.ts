// The Insights page over a seeded telemetry store (tests/fixtures/
// insights-seed.ts), at a desktop size and a phone's: every tab shows the
// seeded numbers priced by each session's provider, nothing on any tab
// scrolls sideways, a bar can be read by tapping it, and a session drills in
// down to one turn's timeline and back out again.
//
// No Claude CLI is needed: the store is written before cockpit starts, the
// way the telemetry worker would have written it.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { loadSqlite } from "../../src/server/telemetry/sqlite";
import { SEED, SEED_PREFS, SEED_PROVIDERS, seedInsightsDb } from "../fixtures/insights-seed";
import { expect, test } from "./fixtures";

const { sqlite } = loadSqlite();
test.skip(!sqlite, "this Node has no built-in SQLite (Node 22.13 or later)");

test.use({
  harnessOptions: {
    telemetry: true,
    prepare: ({ configDir }) => {
      seedInsightsDb(path.join(configDir, "telemetry.db"), sqlite as NonNullable<typeof sqlite>, Date.now());
      const providers = path.join(configDir, "providers.json");
      writeFileSync(providers, JSON.stringify([...JSON.parse(readFileSync(providers, "utf8")), ...SEED_PROVIDERS]));
      writeFileSync(path.join(configDir, "session-prefs.json"), JSON.stringify(SEED_PREFS));
    },
  },
});

const SIZES = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 393, height: 760 },
] as const;

/** The most any scroller on the page (the page included) can scroll
 *  sideways. The tab strip scrolls sideways on purpose and is left out. */
function sideways(page: Page): Promise<number> {
  return page.evaluate(() => {
    const scrollers = [document.documentElement, ...document.querySelectorAll<HTMLElement>("div")].filter(
      (el) => el === document.documentElement || (getComputedStyle(el).overflowY === "auto" && el.dataset.testid !== "insights-tabs"),
    );
    return Math.max(...scrollers.map((el) => el.scrollWidth - el.clientWidth));
  });
}

async function openTab(page: Page, tab: string, panel: string): Promise<void> {
  await page.getByTestId(`insights-tab-${tab}`).click();
  await expect(page.getByTestId(`insights-tab-${tab}`)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId(panel)).toBeVisible({ timeout: 30_000 });
}

for (const size of SIZES) {
  test(`every tab shows the seeded numbers, priced by provider, on a ${size.name}`, async ({ page, harness }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`${harness.cockpitUrl}/insights`);

    // Anthropic's $1.50 at API prices, the cheap catalogue's $0.144 (not the
    // $3.00 Claude Code reported for it), and one request with no price.
    await expect(page.getByTestId("tile-spend")).toContainText("$1.64+", { timeout: 30_000 });
    await expect(page.getByTestId("tile-spend")).toContainText("1 request unpriced");
    await expect(page.getByTestId("tile-tokens")).toContainText("527k");
    await expect(page.getByTestId("tile-turns")).toContainText("3");
    await expect(page.getByTestId("tile-tools")).toContainText("1 failed");
    await expect(page.getByTestId("tile-waiting")).toContainText("8 s");
    await expect(page.getByTestId("tile-errors")).toContainText("1 retry");
    await expect(page.getByTestId("tile-lines")).toContainText("+30 −5");
    await expect(page.getByTestId("list-top-sessions").getByRole("button").first()).toContainText(SEED.anthropic.name);
    await expect(page.getByTestId("list-top-sessions")).toContainText("$0.14");
    expect(await sideways(page), "overview").toBeLessThanOrEqual(1);

    await openTab(page, "spend", "panel-spend");
    await expect(page.getByTestId("chart-spend-readout")).toContainText("$1.64");
    await expect(page.getByTestId("panel-spend")).toContainText(SEED.unpriced.model);
    await expect(page.getByTestId("list-ranked-sessions")).toContainText(SEED.catalogue.name);
    await expect(page.getByTestId("list-purposes")).toContainText("Session titles");
    await expect(page.getByTestId("list-top-turns").getByRole("button").first()).toContainText("Fix the login bug");
    expect(await sideways(page), "spend").toBeLessThanOrEqual(1);
    // A tap on a bar reads that day out above the chart.
    const readout = page.getByTestId("chart-spend-readout");
    await expect(readout).toContainText("Last 7 days");
    const chart = page.getByTestId("chart-spend").locator("svg");
    await chart.scrollIntoViewIfNeeded();
    const box = await chart.boundingBox();
    if (!box) throw new Error("spend chart has no box");
    await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
    await expect(readout).not.toContainText("Last 7 days");
    await expect(readout).toContainText("$1.50");

    await openTab(page, "speed", "panel-models");
    await expect(page.getByTestId("list-models")).toContainText(SEED.anthropic.model);
    await expect(page.getByTestId("panel-turn-time")).toContainText("Waiting for approval");
    expect(await sideways(page), "speed").toBeLessThanOrEqual(1);

    await openTab(page, "tools", "panel-tools");
    await expect(page.getByTestId("list-tools")).toContainText("1 failed");
    await expect(page.getByTestId("list-slow-commands")).toContainText("npm test");
    await expect(page.getByTestId("list-files")).toContainText("/repo/src/app.ts");
    await expect(page.getByTestId("panel-waiting")).toContainText("8 s");
    await expect(page.getByTestId("panel-waiting")).toContainText("Bypass 1");
    expect(await sideways(page), "tools").toBeLessThanOrEqual(1);

    await openTab(page, "health", "panel-api-errors");
    await expect(page.getByTestId("list-api-errors")).toContainText("529");
    await expect(page.getByTestId("list-mcp-connections")).toContainText("1 of 1 failed");
    await expect(page.getByTestId("list-hooks")).toContainText("PreToolUse");
    expect(await sideways(page), "health").toBeLessThanOrEqual(1);

    await openTab(page, "activity", "panel-heatmap");
    await expect(page.getByTestId("tile-lines-added")).toContainText("+30");
    await expect(page.getByTestId("tile-commits")).toContainText("1");
    await expect(page.getByTestId("list-languages")).toContainText("TypeScript");
    expect(await sideways(page), "activity").toBeLessThanOrEqual(1);
  });
}

test("a session drills in to one turn's timeline, and Back and the scope's close lead out again", async ({ page, harness }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 393, height: 760 });
  await page.goto(`${harness.cockpitUrl}/insights`);
  await page
    .getByTestId("list-top-sessions")
    .getByRole("button", { name: new RegExp(SEED.anthropic.name) })
    .click();
  await expect(page).toHaveURL(new RegExp(`session=${SEED.anthropic.id}`));
  await expect(page.getByTestId("insights-session-header")).toContainText(SEED.anthropic.name);
  await expect(page.getByTestId("tile-spend")).toContainText("$1.50");
  await expect(page.getByTestId("tile-spend")).toContainText("at API prices");

  await openTab(page, "turns", "panel-turns");
  const turn = page.getByTestId("turn-row");
  await expect(turn).toHaveCount(1);
  await expect(turn).toContainText("Fix the login bug");
  await turn.click();
  await expect(page).toHaveURL(new RegExp(`turn=${SEED.anthropic.trace}`));
  const rows = page.getByTestId("timeline-rows");
  await expect(rows).toContainText("npm test");
  // Hooks are folded away until asked for.
  await expect(rows).not.toContainText("PreToolUse");
  await page.getByTestId("toggle-hooks").click();
  await expect(rows).toContainText("PreToolUse");
  expect(await sideways(page), "timeline").toBeLessThanOrEqual(1);

  await page.goBack();
  await expect(page.getByTestId("turn-row")).toBeVisible();
  await openTab(page, "context", "panel-context");
  await expect(page.getByTestId("chart-context-readout")).toContainText("13k");

  await page.getByTestId("insights-clear-scope").click();
  await expect(page).not.toHaveURL(/session=/);
  await expect(page.getByTestId("insights-tab-turns")).toHaveCount(0);
  await expect(page.getByTestId("insights-tab-overview")).toHaveAttribute("aria-selected", "true");
});

test("the sidebar opens Insights, in the page modal", async ({ page, harness }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${harness.cockpitUrl}/`);
  await page.getByTestId("sidebar-insights").click();
  const frame = page.frameLocator("iframe[name=cockpit-page-modal]");
  await expect(frame.getByTestId("tile-spend")).toContainText("$1.64+", { timeout: 30_000 });
});
