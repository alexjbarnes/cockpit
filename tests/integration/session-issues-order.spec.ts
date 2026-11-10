// The session's issue list must paint once, in the project's stored status
// order, not in the canonical order and then jump to the stored one.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";

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

test("the session issue list never paints the default order first", async ({ page, harness }) => {
  test.setTimeout(120_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-session-order-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  try {
    await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });
    const projectRes = await page.request.post(`${harness.cockpitUrl}/api/projects`, {
      data: { name: "Order probe", prefix: "OPR", repoPath: workDir },
    });
    const { project } = (await projectRes.json()) as { project: { id: string } };
    for (const [title, status] of [
      ["Backlog row", "Backlog"],
      ["Accepted row", "Accepted"],
    ]) {
      const res = await page.request.post(`${harness.cockpitUrl}/api/issues`, { data: { projectId: project.id, title } });
      const { issue } = (await res.json()) as { issue: { key: string } };
      if (status !== "Backlog") await page.request.put(`${harness.cockpitUrl}/api/issues/${issue.key}`, { data: { status } });
    }
    await page.request.put(`${harness.cockpitUrl}/api/projects/${project.id}`, { data: { statusOrder: ["Accepted", "Backlog"] } });

    harness.trustWorkDir(workDir);
    const sessionRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    const button = page.getByTestId("session-issues");
    await expect(button).toBeVisible({ timeout: 20_000 });
    await button.click();
    await expect(page.getByTestId("session-issues-modal")).toBeVisible();

    const orders: string[] = [];
    for (let i = 0; i < 30; i++) {
      const order = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="session-issues-list"]');
        if (!list) return "";
        return [...list.querySelectorAll('[data-testid^="issue-group-"]')].map((el) => el.getAttribute("data-testid")).join(",");
      });
      if (order && orders[orders.length - 1] !== order) orders.push(order);
      await page.waitForTimeout(50);
    }

    expect(orders[0]).toBe("issue-group-Accepted,issue-group-Backlog");
    expect(new Set(orders).size, `orders seen: ${JSON.stringify(orders)}`).toBe(1);

    // Reopening keeps the modal's full shell and a loading body, rather than
    // painting the previous open's rows for a frame and then swapping them.
    const modal = page.getByTestId("session-issues-modal");
    const settledBox = await modal.boundingBox();
    await modal.getByRole("button", { name: "Close" }).click();
    await expect(modal).toBeHidden();

    await page.route("**/api/issues", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });
    await page.getByTestId("session-issues").click();
    await expect(page.getByTestId("session-issues-loading")).toBeVisible();
    const loadingBox = await page.getByTestId("session-issues-modal").boundingBox();
    await expect(page.getByTestId("issue-group-Accepted")).toBeHidden();
    expect(Math.abs((loadingBox?.height ?? 0) - (settledBox?.height ?? 0))).toBeLessThanOrEqual(1);

    await expect(page.getByTestId("issue-group-Accepted")).toBeVisible({ timeout: 10_000 });
    const loadedBox = await page.getByTestId("session-issues-modal").boundingBox();
    expect(Math.abs((loadedBox?.height ?? 0) - (settledBox?.height ?? 0))).toBeLessThanOrEqual(1);

    // A section folds, and the choice survives closing and reopening the list,
    // and a reload.
    await page.unroute("**/api/issues");
    await page.getByTestId("issue-status-toggle-Accepted").click();
    await expect(page.getByText("Accepted row")).toHaveCount(0);
    await page.getByTestId("session-issues-modal").getByRole("button", { name: "Close" }).click();
    await page.getByTestId("session-issues").click();
    await expect(page.getByTestId("session-issues-modal")).toBeVisible();
    await expect(page.getByText("Accepted row")).toHaveCount(0);

    await page.reload();
    // The URL still says ?issues=1, so the list reopens itself.
    await expect(page.getByTestId("session-issues-modal")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Accepted row")).toHaveCount(0);
    await page.getByTestId("issue-status-toggle-Accepted").click();
    await expect(page.getByText("Accepted row")).toHaveCount(1);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
