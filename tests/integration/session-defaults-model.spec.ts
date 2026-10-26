// Session Defaults offers every model a session can run, not just Anthropic's,
// and a new session starts on whichever one is picked there.
//
// Before this, the page offered the four Anthropic aliases only, while the
// server already applied any `provider:model` from defaults.json (the harness
// itself seeds one). The picker was reachable only inside a session, so a
// provider could not be the default for new sessions without hand-editing the
// file.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";
import { GROQ_TEST_MODEL } from "./harness";

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

test.use({ harnessOptions: { groqViaMock: true } });

test("Session Defaults picks a provider's model, and the next session starts on it", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-defaults-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    await page.goto(`${harness.cockpitUrl}/settings/session`);
    const row = page.getByTestId("default-model-open");
    // The harness's own default is a provider model, and the row names it.
    await expect(row).toContainText("Mock API");

    await row.click();
    await expect(page.getByTestId("model-list")).toBeVisible();
    // Narrow to the connected provider, then pick its model.
    await page.getByTestId("model-provider").click();
    await page.getByTestId("model-provider-groq").click();
    await page.getByText(GROQ_TEST_MODEL, { exact: true }).click();
    await expect(page.getByTestId("model-list")).toHaveCount(0);

    // The page says what is set, and the server stored the qualified id.
    await expect(row).toContainText("Groq");
    await expect(row).toContainText("Mock OSS 120B");
    const defaults = (await (await page.request.get(`${harness.cockpitUrl}/api/defaults`)).json()) as {
      modelSlots: { main: string };
    };
    expect(defaults.modelSlots.main).toBe(`groq:${GROQ_TEST_MODEL}`);

    // A session created with no model takes the default, and the wire proves it
    // ran there: the mock's OpenAI door receives the translated turn.
    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("model-pill")).toContainText("Groq · Mock OSS 120B");
    await page.waitForTimeout(5000);
    await page.getByTestId("message-input").fill("started on the default model");
    await page.getByTestId("btn-send").click();

    await expect
      .poll(
        () =>
          harness.mock
            .getRequests()
            .filter((r) => r.url.split("?")[0] === "/v1/chat/completions")
            .some((r) => String(r.body).includes("started on the default model")),
        { timeout: 30_000 },
      )
      .toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("the picker works on a phone without the page scrolling sideways", async ({ page, harness }) => {
  await page.setViewportSize({ width: 393, height: 760 });
  await page.goto(`${harness.cockpitUrl}/settings/session`);

  await page.getByTestId("default-model-open").click();
  await expect(page.getByTestId("model-list")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await page.getByTestId("model-search").fill("mock-oss");
  await page.getByText(GROQ_TEST_MODEL, { exact: true }).click();
  await expect(page.getByTestId("model-list")).toHaveCount(0);
});
