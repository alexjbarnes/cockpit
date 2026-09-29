// Requests that would widen the Bash sandbox, driven through the real CLI with
// the sandbox actually running.
//
// Network access: a sandboxed command reaching a host outside the allowed
// domains makes the CLI draw its "Network request outside of sandbox" dialog in
// the terminal, with no PermissionRequest behind it. Cockpit has to raise that
// as a card of its own and answer it with the dialog's keys, or the command
// waits on a question nobody can see.
//
// Escapes: a Bash call with dangerouslyDisableSandbox is an ordinary
// PermissionRequest, which bypass answers for every other tool. It must reach
// the user as a card instead.
//
// Both need a host that can run the sandbox (bubblewrap and socat on Linux).
// Skipped otherwise, and a skip here proves nothing.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const onPath = (bin: string) => {
  try {
    execSync(`which ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const SANDBOX_AVAILABLE = process.platform === "darwin" || (process.platform === "linux" && onPath("bwrap") && onPath("socat"));

test.skip(!CLAUDE_AVAILABLE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);
test.skip(!SANDBOX_AVAILABLE, "this host cannot run the Bash sandbox (needs bubblewrap and socat on Linux)");

async function openSandboxedSession(page: Page, harness: Harness, extra: Record<string, unknown> = {}) {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-sandbox-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  // New sessions take the default, so switching it on sandboxes the session.
  const defaults = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { sandbox: { enabled: true }, ...extra } });
  expect(defaults.ok()).toBe(true);

  const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
  expect(createRes.ok()).toBe(true);
  const { sessionId } = await createRes.json();
  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
  await expect(page.getByTestId("message-input")).toBeVisible();
  // The eager spawn from session:connect has to finish, or the first send
  // races a second one.
  await page.waitForTimeout(5000);
  return workDir;
}

test("a blocked host raises a network access card, and Deny answers the CLI's dialog", async ({ page, harness }) => {
  harness.mock.setScript([
    {
      events: toolUseResponse("Bash", {
        command: "curl -s -m 25 -o /dev/null -w '%{http_code}' https://blocked.example.com/",
        description: "Fetch a page",
      }),
    },
    { events: textResponse("The request was refused.") },
  ]);
  const workDir = await openSandboxedSession(page, harness);
  try {
    await page.getByTestId("message-input").fill("fetch the page");
    await page.getByTestId("btn-send").click();

    const card = page.getByTestId("network-access-prompt");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("blocked.example.com");

    await page.getByTestId("btn-network-deny").click();
    await expect(card).toBeHidden({ timeout: 10_000 });
    // Esc refused the connection, so curl failed fast instead of sitting out
    // its timeout, and the turn carried on.
    await expect(page.getByText("The request was refused.")).toBeVisible({ timeout: 20_000 });

    const toolResults = harness.mock
      .getRequests()
      .filter((r) => r.url.split("?")[0] === "/v1/messages")
      .map((r) => r.body)
      .join("\n");
    expect(toolResults).toContain("000");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a Bash call leaving the sandbox reaches the user as a card, even in bypass", async ({ page, harness }) => {
  harness.mock.setScript([
    { events: toolUseResponse("Bash", { command: "echo outside", description: "Echo", dangerouslyDisableSandbox: true }) },
    { events: textResponse("Declined, as asked.") },
  ]);
  const workDir = await openSandboxedSession(page, harness, { permissionMode: "bypass" });
  try {
    await page.getByTestId("message-input").fill("run it outside the sandbox");
    await page.getByTestId("btn-send").click();

    const card = page.getByTestId("permission-prompt");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("sandbox-escape-warning")).toBeVisible();

    await card.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByText("Declined, as asked.")).toBeVisible({ timeout: 20_000 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
