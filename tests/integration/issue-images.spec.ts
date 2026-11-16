// Pictures in an issue's comments and plan, end to end. An agent's hand-over
// comment carries the screenshots of what it built, and a plan can offer
// designs to choose between, so the work is judged from the issue without a
// review server.
//
// Unit tests cover the text rewriting and the copying. What only a real run
// shows is the whole path: a real CLI session calls the cockpit tools with a
// file's path, the file is copied into the issue, the page loads the picture
// through the attachments route and opens it over itself, and a reviewer can
// pick one of a plan's designs by its caption.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { textResponse, toolUseResponse } from "../mock-api/builder";
import type { TurnScript } from "../mock-api/types";
import { expect, test } from "./fixtures";
import type { Harness } from "./harness";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_AVAILABLE = (() => {
  try {
    execSync(`${CLAUDE_BIN} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test.skip(!CLAUDE_AVAILABLE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);

const COMMENT = "mcp__cockpit-config__add_issue_comment";
const ATTACH = "mcp__cockpit-config__add_issue_attachment";
const SET_PLAN = "mcp__cockpit-config__set_issue_plan";

/** Set ISSUE_IMAGES_SHOTS to a folder to keep a picture of each step. */
const SHOTS = process.env.ISSUE_IMAGES_SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

interface StoredIssue {
  key: string;
  status: string;
  comments: { body: string }[];
  attachments: { id: string; title: string; url: string; inline?: boolean }[];
}

const TITLE: TurnScript = { match: '"json_schema"', events: textResponse('{"title":"Run"}') };

function callId(events: ReturnType<typeof toolUseResponse>): string {
  for (const e of events) {
    const block = (e.data as { content_block?: { type?: string; id?: string } }).content_block;
    if (block?.type === "tool_use" && block.id) return block.id;
  }
  throw new Error("no tool call in these events");
}

async function readIssue(page: Page, harness: Harness, key: string): Promise<StoredIssue> {
  const res = await page.request.get(`${harness.cockpitUrl}/api/issues/${key}`);
  return (await res.json()).issue as StoredIssue;
}

/** A stand-in for a screenshot or a mock-up: a real PNG of the given size. */
async function draw(page: Page, file: string, width: number, height: number, label: string, colour: string): Promise<void> {
  const canvas = await page.context().newPage();
  await canvas.setViewportSize({ width, height });
  await canvas.setContent(
    `<body style="margin:0;height:100vh;display:grid;place-items:center;background:${colour};font:600 28px system-ui;color:#fff">${label}</body>`,
  );
  await canvas.screenshot({ path: file });
  await canvas.close();
}

/** The picture has really loaded, at the size of the file it came from. */
async function expectLoaded(img: Locator, width: number): Promise<void> {
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { timeout: 15_000 }).toBe(width);
}

test("a session's comment and plan carry pictures, which the issue shows and opens over itself", async ({ page, harness }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-issue-images-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });
    const projectRes = await page.request.post(`${harness.cockpitUrl}/api/projects`, { data: { name: "Greeter", prefix: "GR" } });
    const { project } = await projectRes.json();
    const created = await page.request.post(`${harness.cockpitUrl}/api/issues`, {
      data: { projectId: project.id, title: "Redesign the settings page" },
    });
    const key = ((await created.json()).issue as StoredIssue).key;

    const phone = path.join(workDir, "settings-phone.png");
    const optionA = path.join(workDir, "option-a.png");
    const optionB = path.join(workDir, "option-b.png");
    const extra = path.join(workDir, "before.png");
    await draw(page, phone, 390, 844, "Settings, phone", "#2563eb");
    await draw(page, optionA, 1200, 700, "Tabs along the top", "#0f766e");
    await draw(page, optionB, 1200, 700, "Tabs down the side", "#9333ea");
    await draw(page, extra, 800, 500, "Before", "#57534e");

    // One message, three tool calls in a row: the hand-over comment with its
    // screenshot, a plain attachment, and a plan offering two designs.
    const comment = toolUseResponse(COMMENT, {
      key,
      body: `Built it. This is the page on a phone:\n\n![Settings at phone width](${phone})\n\nNothing else changed.`,
    });
    const attach = toolUseResponse(ATTACH, { key, url: extra, title: "The page before" });
    const plan = toolUseResponse(SET_PLAN, {
      key,
      content: [
        "# Redesign the settings page",
        "",
        "Two ways to lay the sections out. Say which you want.",
        "",
        `![Option A: tabs along the top](${optionA})`,
        "",
        `![Option B: tabs down the side](${optionB})`,
        "",
        "Either way the sections themselves stay as they are.",
      ].join("\n"),
    });
    const ASK = "Hand the settings redesign over";
    harness.mock.setScript([
      TITLE,
      { match: callId(plan), events: textResponse("Handed over.") },
      { match: callId(attach), events: plan },
      { match: callId(comment), events: attach },
      { match: ASK, events: comment },
      { events: textResponse("Nothing to do.") },
    ]);

    const session = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty", name: "Hand over", bypassPermissions: true },
    });
    expect(session.ok()).toBe(true);
    const { sessionId } = await session.json();
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    // The PTY needs a moment before it takes input (see hello.spec.ts).
    await page.waitForTimeout(5000);
    await page.getByTestId("message-input").fill(`${ASK}.`);
    await page.getByTestId("btn-send").click();

    await expect
      .poll(async () => (await (await page.request.get(`${harness.cockpitUrl}/api/issues/${key}/plan`)).json()).versions?.length, {
        timeout: 90_000,
      })
      .toBe(1);

    // What was stored: each named file copied into the issue, and the text
    // pointing at where the page loads it. The files the session named can go.
    const stored = await readIssue(page, harness, key);
    expect(stored.attachments.map((a) => [a.title, !!a.inline])).toEqual([
      ["Settings at phone width", true],
      ["The page before", false],
      ["Option A: tabs along the top", true],
      ["Option B: tabs down the side", true],
    ]);
    expect(stored.comments[0].body).toContain(`![Settings at phone width](/api/issues/${key}/attachments/${stored.attachments[0].id})`);
    for (const file of [phone, optionA, optionB, extra]) rmSync(file);

    // The comment shows its picture, with its caption.
    await page.goto(`${harness.cockpitUrl}/issues/${key}`);
    // The Attachments card is folded away until opened.
    await page.getByTestId("issue-attachments-toggle").click();
    const inComment = page.locator(".border.rounded-md", { hasText: "Built it." }).getByTestId("markdown-image");
    await expect(inComment).toHaveCount(1);
    await expectLoaded(inComment.locator("img"), 390);
    await expect(page.getByText("Settings at phone width", { exact: true })).toBeVisible();
    await shot(page, "desktop-1-comment");

    // A picture written into the text is not listed again; a plain attachment
    // that is a picture is shown as one, not as a link to another tab.
    const listed = page.getByTestId("issue-attachment-images").getByTestId("markdown-image");
    await expect(listed).toHaveCount(1);
    await expectLoaded(listed.locator("img"), 800);
    await expect(page.locator('a[target="_blank"]', { hasText: "The page before" })).toHaveCount(0);

    // Pressing it opens it over the issue, fitted, then at its own size.
    await inComment.click();
    const lightbox = page.getByTestId("image-lightbox");
    await expect(lightbox).toBeVisible();
    await expect(lightbox).toContainText("Settings at phone width");
    const big = lightbox.locator("img");
    await expectLoaded(big, 390);
    expect((await big.boundingBox())?.height ?? 0).toBeLessThan(844);
    await shot(page, "desktop-2-lightbox");
    await page.getByTestId("image-lightbox-size").click();
    await expect.poll(async () => Math.round((await big.boundingBox())?.width ?? 0)).toBe(390);
    await expect.poll(async () => Math.round((await big.evaluate((el: HTMLImageElement) => el.height)) ?? 0)).toBe(844);
    await page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();
    expect(page.url()).toContain(`/issues/${key}`);

    // The plan shows both designs, and one is chosen by commenting on its caption.
    await page.getByTestId("issue-plan-open").click();
    const modal = page.getByTestId("issue-plan-modal");
    await expect(modal).toBeVisible();
    const doc = page.getByTestId("plan-document");
    const designs = doc.getByTestId("markdown-image");
    await expect(designs).toHaveCount(2);
    await expectLoaded(designs.nth(0).locator("img"), 1200);
    await expectLoaded(designs.nth(1).locator("img"), 1200);
    await shot(page, "desktop-3-plan");

    // A design opens over the plan, and closing it leaves the plan open.
    await designs.nth(1).click();
    await expect(lightbox).toContainText("Option B: tabs down the side");
    await expectLoaded(lightbox.locator("img"), 1200);
    await shot(page, "desktop-4-plan-lightbox");
    await page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();
    await expect(modal).toBeVisible();
    // Opening the picture did not select anything in the plan.
    await expect(page.getByTestId("plan-toolbar")).toHaveCount(0);

    await doc.getByText("Option B: tabs down the side").click({ clickCount: 3 });
    await expect(page.getByTestId("plan-toolbar")).toBeVisible();
    await page.getByTestId("plan-act-comment").click();
    await page.getByTestId("plan-composer-input").fill("This one.");
    await page.getByTestId("plan-composer-save").click();
    await expect(page.getByTestId("plan-notes")).toContainText("This one.");
    await page.getByTestId("plan-send-feedback").click();
    await expect(modal).toBeHidden({ timeout: 15_000 });

    const reviewed = await readIssue(page, harness, key);
    const feedback = reviewed.comments.at(-1)?.body ?? "";
    expect(feedback).toContain("Option B: tabs down the side");
    expect(feedback).toContain("This one.");

    // On a phone the pictures stay inside the page, and open over it.
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto(`${harness.cockpitUrl}/issues/${key}`);
    const onPhone = page.locator(".border.rounded-md", { hasText: "Built it." }).getByTestId("markdown-image");
    await expectLoaded(onPhone.locator("img"), 390);
    await onPhone.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, "phone-1-comment");
    await onPhone.click();
    await expectLoaded(lightbox.locator("img"), 390);
    const box = await lightbox.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 393).toBe(true);
    await shot(page, "phone-2-lightbox");
    await page.getByTestId("image-lightbox-close").click();
    await expect(lightbox).toBeHidden();

    await page.getByTestId("issue-plan-open").click();
    await expectLoaded(page.getByTestId("plan-document").getByTestId("markdown-image").nth(0).locator("img"), 1200);
    const wide = await page.getByTestId("plan-document").getByTestId("markdown-image").nth(0).boundingBox();
    expect(wide && wide.x + wide.width <= 393).toBe(true);
    await shot(page, "phone-3-plan");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
