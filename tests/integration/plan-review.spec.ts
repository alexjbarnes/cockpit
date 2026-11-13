// Plan review rests on three things the CLI does, none of which cockpit can
// see without running it:
//
//  1. the ExitPlanMode permission request carries the plan text and the path
//     of the file it came from, so the plan shown is this session's own;
//  2. a no with a message reaches the model as the answer to its plan, in the
//     same turn, with the session still planning, so it can revise;
//  3. a yes that carries a different plan text makes that text the plan.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { textResponse, toolUseResponse } from "../mock-api/builder";
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

const PLAN_V1 = "# Add a greeting\n\n1. Create hello.txt\n2. Write the word hello into it\n";
const PLAN_V2 = "# Add a greeting\n\n1. Create hello.txt\n2. Write the word hello into it\n3. Add a test for it\n";
const FEEDBACK = "PLAN-FEEDBACK-MARKER: add a test for the greeting.";
const EDITED = `${PLAN_V2}\n## Notes from the user\n\nPLAN-EDIT-MARKER: keep the file name lower case.\n`;

interface PlanRequest {
  requestId: string;
  input: string;
}

/** Every ExitPlanMode request the page's own socket is sent, as it arrives. */
function watchPlanRequests(page: Page): PlanRequest[] {
  const seen: PlanRequest[] = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => {
      if (typeof frame.payload !== "string" || !frame.payload.includes("permission:request")) return;
      try {
        const msg = JSON.parse(frame.payload) as { type?: string; toolName?: string; requestId?: string; input?: string };
        if (msg.type !== "permission:request" || msg.toolName !== "ExitPlanMode" || !msg.requestId) return;
        if (seen.some((r) => r.requestId === msg.requestId)) return;
        seen.push({ requestId: msg.requestId, input: msg.input ?? "" });
      } catch {
        // not a JSON frame
      }
    });
  });
  return seen;
}

/** Answer a permission request as a client would, on a socket of its own. */
async function answer(page: Page, harness: Harness, message: Record<string, unknown>): Promise<void> {
  const tokenRes = await page.request.get(`${harness.cockpitUrl}/api/auth/ws-token`);
  const { token } = (await tokenRes.json()) as { token: string };
  const wsUrl = `${harness.cockpitUrl.replace(/^http/, "ws")}/ws?token=${token}`;
  await page.evaluate(
    ({ wsUrl, message }) =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.onerror = () => reject(new Error("websocket failed"));
        ws.onopen = () => {
          ws.send(JSON.stringify(message));
          setTimeout(() => {
            ws.close();
            resolve();
          }, 500);
        };
      }),
    { wsUrl, message },
  );
}

/** The plan file the CLI told the model to write, read off what it sent. */
function planPathFrom(harness: Harness): string | undefined {
  for (const request of harness.mock.getRequests()) {
    const found = /(\/[^\s"\\]+\/plans\/[a-z0-9-]+\.md)/.exec(request.body);
    if (found) return found[1];
  }
  return undefined;
}

function messageBodies(harness: Harness): string[] {
  return harness.mock
    .getRequests()
    .filter((r) => r.url.split("?")[0] === "/v1/messages")
    .map((r) => r.body);
}

test("a plan is sent with its text, takes feedback in the same turn, and is approved as edited", async ({ page, harness }) => {
  test.setTimeout(180_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-planreview-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  const planRequests = watchPlanRequests(page);

  try {
    harness.mock.setScript([{ events: textResponse("Looking at the request.") }]);
    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000);

    await page.getByTitle("Switch to Plan mode (Tab)").click();
    await expect(page.getByTitle("Switch to Build mode (Tab)")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(5000);

    // The first turn only exists to learn where the CLI wants the plan kept.
    await page.getByTestId("message-input").fill("plan a greeting file");
    await page.getByTestId("btn-send").click();
    await expect(page.getByText("Looking at the request.")).toBeVisible({ timeout: 30_000 });
    const planPath = planPathFrom(harness);
    expect(planPath, "the plan-mode reminder names the plan file").toBeTruthy();

    harness.mock.setScript([
      { events: toolUseResponse("Write", { file_path: planPath, content: PLAN_V1 }) },
      { events: toolUseResponse("ExitPlanMode", {}) },
      { events: toolUseResponse("Write", { file_path: planPath, content: PLAN_V2 }) },
      { events: toolUseResponse("ExitPlanMode", {}) },
      { events: textResponse("Starting on the greeting.") },
    ]);
    await page.getByTestId("message-input").fill("write the plan");
    await page.getByTestId("btn-send").click();

    // 1. The request carries this session's plan.
    await expect.poll(() => planRequests.length, { timeout: 45_000 }).toBe(1);
    const first = JSON.parse(planRequests[0].input) as { plan?: string; planFilePath?: string };
    expect(first.plan).toBe(PLAN_V1);
    expect(first.planFilePath).toBe(planPath);

    // 2. Feedback goes back as the answer, and the model revises in the same turn.
    await answer(page, harness, {
      type: "permission:response",
      sessionId,
      requestId: planRequests[0].requestId,
      allowed: false,
      permissionMode: "deny",
      denyMessage: FEEDBACK,
    });
    await expect.poll(() => planRequests.length, { timeout: 45_000 }).toBe(2);
    expect(messageBodies(harness).some((body) => body.includes(FEEDBACK))).toBe(true);
    const second = JSON.parse(planRequests[1].input) as { plan?: string };
    expect(second.plan).toBe(PLAN_V2);
    await expect(page.getByTitle("Switch to Build mode (Tab)")).toBeVisible();

    // 3. Approving an edited plan makes the edit the plan.
    await answer(page, harness, {
      type: "permission:response",
      sessionId,
      requestId: planRequests[1].requestId,
      allowed: true,
      permissionMode: "allow",
      planText: EDITED,
    });
    await expect(page.getByText("Starting on the greeting.")).toBeVisible({ timeout: 45_000 });
    expect(messageBodies(harness).some((body) => body.includes("PLAN-EDIT-MARKER"))).toBe(true);
    expect(existsSync(planPath as string)).toBe(true);
    expect(readFileSync(planPath as string, "utf-8")).toContain("PLAN-EDIT-MARKER");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

const SHOTS = process.env.PLAN_REVIEW_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** A session in plan mode whose model has proposed PLAN_V1 and is waiting. */
async function proposePlan(
  page: Page,
  harness: Harness,
  workDir: string,
  afterFirst: Parameters<Harness["mock"]["setScript"]>[0],
): Promise<string> {
  harness.mock.setScript([{ events: textResponse("Looking at the request.") }]);
  const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
  expect(createRes.ok()).toBe(true);
  const { sessionId } = (await createRes.json()) as { sessionId: string };
  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
  await expect(page.getByTestId("message-input")).toBeVisible();
  await page.waitForTimeout(5000);

  await page.getByTitle("Switch to Plan mode (Tab)").click();
  await expect(page.getByTitle("Switch to Build mode (Tab)")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(5000);

  await page.getByTestId("message-input").fill("plan a greeting file");
  await page.getByTestId("btn-send").click();
  await expect(page.getByText("Looking at the request.")).toBeVisible({ timeout: 30_000 });
  const planPath = planPathFrom(harness);
  expect(planPath, "the plan-mode reminder names the plan file").toBeTruthy();

  harness.mock.setScript([
    { events: toolUseResponse("Write", { file_path: planPath, content: PLAN_V1 }) },
    { events: toolUseResponse("ExitPlanMode", {}) },
    ...afterFirst.map((turn) => ({
      ...turn,
      events: JSON.parse(JSON.stringify(turn.events).replaceAll("__PLAN_PATH__", planPath as string)) as typeof turn.events,
    })),
  ]);
  await page.getByTestId("message-input").fill("write the plan");
  await page.getByTestId("btn-send").click();
  await expect(page.getByTestId("plan-approval-prompt")).toBeVisible({ timeout: 45_000 });
  return sessionId;
}

test("a plan is marked up beside the chat, sent back, and its revision compared and approved", async ({ page, harness }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-planui-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    await proposePlan(page, harness, workDir, [
      { events: toolUseResponse("Write", { file_path: "__PLAN_PATH__", content: PLAN_V2 }) },
      { events: toolUseResponse("ExitPlanMode", {}) },
      { events: textResponse("Starting on the greeting.") },
    ]);

    // The plan opens beside the conversation without being asked for, and the
    // chat stays where it was.
    const review = page.getByTestId("plan-review");
    await expect(review).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("plan-approval-prompt")).toBeVisible();
    const doc = page.getByTestId("plan-document");
    await expect(doc).toContainText("Write the word hello into it");
    await expect(page.getByTestId("plan-tab-waiting")).toBeVisible();

    // A real selection with the mouse: three clicks take the whole line.
    await doc.getByText("Write the word hello into it").click({ clickCount: 3 });
    await expect(page.getByTestId("plan-toolbar")).toBeVisible();
    await shot(page, "desktop-1-toolbar");
    // The labels stay open once opened: releasing the mouse on the button
    // re-reports the same selection, which used to close them again at once.
    await page.getByTestId("plan-act-label").click();
    await page.waitForTimeout(400);
    await expect(page.getByTestId("plan-quick-labels")).toBeVisible();
    await page.getByTestId("plan-act-label").click();
    await expect(page.getByTestId("plan-quick-labels")).toBeHidden();
    await page.getByTestId("plan-act-comment").click();
    await page.getByTestId("plan-composer-input").fill("Say which folder the file goes in.");
    await shot(page, "desktop-2-composer");
    await page.getByTestId("plan-composer-save").click();
    await expect(page.getByTestId("plan-notes-count")).toHaveText("1");

    // A removal needs no words: select and press D.
    await doc.getByText("Create hello.txt").click({ clickCount: 3 });
    await expect(page.getByTestId("plan-toolbar")).toBeVisible();
    await page.keyboard.press("d");
    await expect(page.getByTestId("plan-notes-count")).toHaveText("2");
    await expect(page.locator("[data-testid^='plan-marker-']")).toHaveCount(2);

    // The markup survives a reload: it is stored, not held in the page.
    await page.waitForTimeout(800);
    await page.reload();
    await expect(page.getByTestId("plan-notes-count")).toHaveText("2", { timeout: 20_000 });
    // Beside the chat there is no room for the notes to sit next to the plan,
    // so they open over it.
    await page.getByTestId("plan-notes-open").click();
    await expect(page.getByTestId("plan-notes-sheet")).toContainText("Say which folder the file goes in.");
    await shot(page, "desktop-3-notes");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("plan-notes-sheet")).toBeHidden();
    // Escape closed the notes and nothing else: the plan is still waiting.
    await expect(page.getByTestId("plan-approval-prompt")).toBeVisible();

    await page.getByTestId("plan-send-feedback").click();

    // The model was told, as the answer to its plan, and proposed again.
    await expect(page.getByTestId("plan-version-select")).toHaveValue("2", { timeout: 45_000 });
    const sent = messageBodies(harness).find((body) => body.includes("Say which folder the file goes in."));
    expect(sent, "the feedback reached the model").toBeTruthy();
    expect(sent).toContain("asked for changes");
    expect(sent).toContain("Remove this");

    // What changed since last time is on the screen without asking.
    await expect(page.getByTestId("plan-change-summary")).toContainText("since version 1");
    await expect(page.getByTestId("plan-changed-rail").first()).toBeVisible();
    await shot(page, "desktop-4-revised");
    await page.getByTestId("plan-view-changes").click();
    await expect(page.getByTestId("plan-diff")).toBeVisible();
    await shot(page, "desktop-5-diff");

    // The round before is still there, with its notes and what was sent.
    await page.getByTestId("plan-version-select").selectOption("1");
    await page
      .getByTestId("plan-view-plan")
      .click()
      .catch(() => {});
    await expect(page.getByTestId("plan-outcome")).toContainText("Changes requested");
    await page.getByTestId("plan-notes-open").click();
    await expect(page.getByTestId("plan-notes-sheet")).toContainText("Say which folder the file goes in.");
    await page.keyboard.press("Escape");
    await page.getByTestId("plan-sent-toggle").click();
    await expect(page.getByTestId("plan-sent")).toContainText("Review notes (2)");
    await shot(page, "desktop-6-history");

    await page.getByTestId("plan-version-select").selectOption("2");
    await page.getByTestId("plan-approve").click();
    // The harness runs sessions in bypass, so the choice is only about context.
    await page.getByTestId("plan-approve-keep-auto").click();
    await expect(page.getByText("Starting on the greeting.")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("plan-outcome")).toContainText("Approved", { timeout: 15_000 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a plan is opened from its card, marked up by tapping, and sent back", async ({ page, harness }) => {
    test.setTimeout(240_000);
    const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-planphone-"));
    mkdirSync(path.join(workDir, ".git"), { recursive: true });
    harness.trustWorkDir(workDir);

    try {
      await proposePlan(page, harness, workDir, [
        { events: toolUseResponse("Write", { file_path: "__PLAN_PATH__", content: PLAN_V2 }) },
        { events: toolUseResponse("ExitPlanMode", {}) },
        { events: textResponse("Starting on the greeting.") },
      ]);

      // A phone is never switched to the plan: the card says it is there.
      await expect(page.getByTestId("plan-review")).toBeHidden();
      await shot(page, "phone-1-card");
      await page.getByTestId("btn-review-plan").tap();
      const review = page.getByTestId("plan-review");
      await expect(review).toBeVisible();
      await shot(page, "phone-2-plan");

      // One tap takes a whole step, with no handles to drag.
      await page.getByTestId("plan-tap-toggle").tap();
      await page.getByTestId("plan-document").getByText("Write the word hello into it").tap();
      const bar = page.getByTestId("plan-toolbar");
      await expect(bar).toBeVisible();
      await shot(page, "phone-3-actions");
      await page.getByTestId("plan-act-comment").tap();
      await expect(page.getByTestId("plan-composer-sheet")).toBeVisible();
      await page.getByTestId("plan-label-tests").tap();
      await shot(page, "phone-4-composer");
      await page.getByTestId("plan-composer-save").tap();
      await expect(page.getByTestId("plan-notes-count")).toHaveText("1");

      await page.getByTestId("plan-notes-open").tap();
      await expect(page.getByTestId("plan-notes-sheet")).toContainText("Needs tests");
      await shot(page, "phone-5-notes");
      await page.keyboard.press("Escape");

      // Nothing on the page is wider than the phone.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);

      await page.getByTestId("plan-send-feedback").tap();
      await expect(page.getByTestId("plan-version-select")).toHaveValue("2", { timeout: 45_000 });
      expect(messageBodies(harness).some((body) => body.includes("Needs tests. Say how this will be tested"))).toBe(true);
      await shot(page, "phone-6-revised");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

test("a plan edited by hand is approved with notes, and the model is given both", async ({ page, harness }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-planedit-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    await proposePlan(page, harness, workDir, [{ events: textResponse("Starting on the greeting.") }]);
    await expect(page.getByTestId("plan-review")).toBeVisible({ timeout: 15_000 });

    // Change the plan's own text.
    await page.getByTestId("plan-edit-toggle").click();
    const editor = page.getByTestId("plan-review").locator(".cm-content");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("3. EDITED-BY-HAND: name the file greeting.txt");
    await page.getByTestId("plan-edit-toggle").click();
    await expect(page.getByTestId("plan-edited-banner")).toBeVisible();
    await expect(page.getByTestId("plan-document")).toContainText("EDITED-BY-HAND");

    // And say something about the plan as a whole.
    await page.getByTestId("plan-notes-open").click();
    await page.getByTestId("plan-add-note").click();
    await page.getByTestId("plan-composer-input").fill("NOTE-FOR-LATER: keep the commit small.");
    await page.getByTestId("plan-composer-save").click();
    await expect(page.getByTestId("plan-notes-count")).toHaveText("1");
    await shot(page, "desktop-7-edited");

    await page.getByTestId("plan-approve-with-notes").click();
    await shot(page, "desktop-8-approve");
    await page.getByTestId("plan-approve-keep-auto").click();
    await expect(page.getByText("Starting on the greeting.")).toBeVisible({ timeout: 45_000 });

    // Both went to the model as the approved plan, and the plan file holds them.
    const approved = messageBodies(harness).find((body) => body.includes("EDITED-BY-HAND"));
    expect(approved, "the edited plan reached the model").toBeTruthy();
    expect(approved).toContain("NOTE-FOR-LATER");
    expect(approved).toContain("Notes from the user");
    const planPath = planPathFrom(harness) as string;
    const onDisk = readFileSync(planPath, "utf-8");
    expect(onDisk).toContain("EDITED-BY-HAND");
    expect(onDisk).toContain("NOTE-FOR-LATER");

    // The approved text is kept as a version of its own, marked as the user's.
    await expect(page.getByTestId("plan-version-select")).toHaveValue("2", { timeout: 15_000 });
    await expect(page.getByTestId("plan-outcome")).toContainText("Approved");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
