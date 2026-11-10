import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const NOTIFICATIONS = {
  providers: [
    {
      id: "test-ntfy",
      type: "ntfy",
      enabled: true,
      name: "Test ntfy",
      config: { serverUrl: "https://ntfy.sh", topic: "cockpit-test" },
    },
  ],
};

// The dialog fetches this when it opens; a real host here may not support the
// sandbox, and the row would then be disabled for a reason unrelated to the test.
const SANDBOX_SUPPORTED = { supported: true, networkIsolation: true, platform: "linux" };

test.use({
  harnessOptions: {
    prepare: ({ configDir }) => {
      writeFileSync(path.join(configDir, "notifications.json"), JSON.stringify(NOTIFICATIONS, null, 2));
    },
  },
});

function workDir(): string {
  return mkdtempSync(path.join(tmpdir(), "cockpit-new-session-"));
}

function readPrefs(configDir: string, sessionId: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path.join(configDir, "session-prefs.json"), "utf-8"))[sessionId] ?? null;
  } catch {
    return null;
  }
}

async function openDialog(page: import("@playwright/test").Page, harness: { cockpitUrl: string }) {
  // The session list and its New Session button live on the home page.
  await page.goto(`${harness.cockpitUrl}/`);
  await page.getByTestId("new-session-open").click();
  await expect(page.getByTestId("new-session-dialog")).toBeVisible();
}

test("step two creates the session with every setting chosen", async ({ page, harness }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const cwd = workDir();
  harness.trustWorkDir(cwd);

  await openDialog(page, harness);
  await page.getByTestId("new-session-cwd").fill(cwd);
  await page.getByTestId("new-session-name").fill("Configured");
  await page.getByTestId("new-session-configure").click();
  await expect(page.getByTestId("new-session-step-how")).toBeVisible();

  // The model row starts on the harness default and settles once providers load.
  await expect(page.getByTestId("new-session-row-model")).toContainText("Mock Sonnet");

  await page.getByTestId("new-session-row-model").click();
  await page.getByTestId("new-session-context-1m").click();
  await page.getByTestId("new-session-thinking-low").click();

  await page.getByTestId("new-session-row-permissions").click();
  await page.getByTestId("new-session-perm-manual").click();

  // This host has no bwrap/socat, so the server says the sandbox cannot be
  // enforced and the row must say so rather than offer a toggle that would not
  // take effect.
  await page.getByTestId("new-session-row-sandbox").click();
  await expect(page.getByTestId("new-session-row-sandbox")).toContainText("Not supported");
  await expect(page.getByTestId("new-session-sandbox-toggle")).toBeDisabled();

  await page.getByTestId("new-session-row-notifications").click();
  await page.getByTestId("new-session-notify-provider-test-ntfy").click();

  const posted = page.waitForRequest((r) => r.url().endsWith("/api/sessions") && r.method() === "POST");
  await page.getByTestId("new-session-create").click();
  const request = await posted;
  expect(request.postDataJSON()).toEqual({
    cwd,
    name: "Configured",
    runtime: "pty",
    model: "mock:claude-sonnet-4-6",
    contextSize: "1m",
    thinkingLevel: "low",
    permissionMode: "manual",
    sandbox: { enabled: false },
    notifications: { providerId: "test-ntfy", events: { finished: true, question: true, permission: true } },
  });

  const response = await request.response();
  const { sessionId } = (await response!.json()) as { sessionId: string };
  await expect
    .poll(() => readPrefs(harness.configDir, sessionId))
    .toMatchObject({
      name: "Configured",
      model: "mock:claude-sonnet-4-6",
      contextSize: "1m",
      thinkingLevel: "low",
      permissionMode: "manual",
      sandbox: { enabled: false },
      notifications: { providerId: "test-ntfy" },
      runtime: "pty",
    });
});

test("create with defaults skips step two and stores the defaults", async ({ page, harness }) => {
  const cwd = workDir();
  harness.trustWorkDir(cwd);

  await openDialog(page, harness);
  await page.getByTestId("new-session-cwd").fill(cwd);

  const posted = page.waitForRequest((r) => r.url().endsWith("/api/sessions") && r.method() === "POST");
  await page.getByTestId("new-session-create-defaults").click();
  const request = await posted;
  expect(request.postDataJSON()).toEqual({ cwd, runtime: "pty" });

  const { sessionId } = (await (await request.response())!.json()) as { sessionId: string };
  await expect
    .poll(() => readPrefs(harness.configDir, sessionId))
    .toMatchObject({
      model: "mock:claude-sonnet-4-6",
      contextSize: "200k",
      thinkingLevel: "high",
      permissionMode: "bypass",
      sandbox: { enabled: false },
      runtime: "pty",
    });
});

test("cloning continues to step two with the cloned path", async ({ page, harness }) => {
  const cwd = workDir();
  harness.trustWorkDir(cwd);
  let cloneBody: unknown;
  await page.route("**/api/git/clone", async (route) => {
    cloneBody = route.request().postDataJSON();
    await route.fulfill({ json: { path: cwd } });
  });

  await openDialog(page, harness);
  await page.getByTestId("new-session-tab-clone").click();
  await page.getByTestId("new-session-clone-url").fill("https://example.com/acme/widgets.git");
  await page.getByTestId("new-session-clone-dest").fill(path.dirname(cwd));
  await page.getByTestId("new-session-clone-configure").click();

  await expect(page.getByTestId("new-session-step-how")).toBeVisible();
  await expect(page.getByTestId("new-session-where-summary")).toHaveText(cwd);
  expect(cloneBody).toMatchObject({ url: "https://example.com/acme/widgets.git", parentPath: path.dirname(cwd) });

  const posted = page.waitForRequest((r) => r.url().endsWith("/api/sessions") && r.method() === "POST");
  await page.getByTestId("new-session-create").click();
  expect((await posted).postDataJSON()).toMatchObject({ cwd, runtime: "pty" });
});

test("the dialog and every expanded row fit a phone", async ({ page, harness }) => {
  await page.setViewportSize({ width: 393, height: 760 });
  await page.route("**/api/sandbox/support", (route) => route.fulfill({ json: SANDBOX_SUPPORTED }));
  const cwd = workDir();
  harness.trustWorkDir(cwd);

  await openDialog(page, harness);
  await page.getByTestId("new-session-cwd").fill(cwd);
  await page.getByTestId("new-session-name").fill("A deliberately long session name for a phone");
  await page.getByTestId("new-session-configure").click();
  await expect(page.getByTestId("new-session-step-how")).toBeVisible();

  for (const row of ["notifications", "model", "permissions", "sandbox"]) {
    await page.getByTestId(`new-session-row-${row}`).click();
    const overflow = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="new-session-dialog"]') as HTMLElement;
      const root = document.documentElement;
      return { dialog: dialog.scrollWidth - dialog.clientWidth, page: root.scrollWidth - root.clientWidth };
    });
    expect(overflow.dialog, `${row} row overflows the dialog`).toBeLessThanOrEqual(1);
    expect(overflow.page, `${row} row overflows the page`).toBeLessThanOrEqual(1);
    await page.getByTestId(`new-session-row-${row}`).click();
  }

  const create = await page.getByTestId("new-session-create").boundingBox();
  expect(create).not.toBeNull();
  expect(create!.y + create!.height).toBeLessThanOrEqual(760);
});

test("stream is hidden until its setting is turned on", async ({ page, harness }) => {
  await openDialog(page, harness);
  await expect(page.getByTestId("new-session-runtime-stream")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.goto(`${harness.cockpitUrl}/settings/session`);
  await page.getByTestId("toggle-stream-runtime").click();
  await expect
    .poll(async () => {
      const res = await page.request.get(`${harness.cockpitUrl}/api/defaults`);
      return ((await res.json()) as { streamRuntimeEnabled?: boolean }).streamRuntimeEnabled;
    })
    .toBe(true);
});

test.describe("with Stream enabled", () => {
  test.use({ harnessOptions: { defaults: { streamRuntimeEnabled: true } } });

  test("stream can be chosen and is stored on the session", async ({ page, harness }) => {
    const cwd = workDir();
    harness.trustWorkDir(cwd);

    await openDialog(page, harness);
    await page.getByTestId("new-session-cwd").fill(cwd);
    await page.getByTestId("new-session-runtime-stream").click();

    const posted = page.waitForRequest((r) => r.url().endsWith("/api/sessions") && r.method() === "POST");
    await page.getByTestId("new-session-create-defaults").click();
    const request = await posted;
    expect(request.postDataJSON()).toMatchObject({ cwd, runtime: "stream" });

    const { sessionId } = (await (await request.response())!.json()) as { sessionId: string };
    await expect.poll(() => readPrefs(harness.configDir, sessionId)).toMatchObject({ runtime: "stream" });
  });
});

test("a session already on Stream still shows it, with a way back to PTY", async ({ page, harness }) => {
  const cwd = workDir();
  harness.trustWorkDir(cwd);
  const created = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd, runtime: "stream" } });
  const { sessionId } = (await created.json()) as { sessionId: string };

  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(cwd)}`);
  await page.getByTestId("btn-session-settings").click();
  await page.getByTestId("settings-tab-runtime").click();

  await expect(page.getByTestId("runtime-current")).toHaveText("Stream (deprecated)");
  await expect(page.getByTestId("runtime-pty")).toHaveText("Switch to PTY");
  await expect(page.getByTestId("runtime-stream")).toHaveCount(0);

  await page.getByTestId("runtime-pty").click();
  await expect.poll(() => readPrefs(harness.configDir, sessionId)).toMatchObject({ runtime: "pty" });
});
