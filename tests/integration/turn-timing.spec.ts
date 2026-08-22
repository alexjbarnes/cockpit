// The two timing readouts on the chat view, against the real CLI:
//   1. a live elapsed counter beside the processing spinner, so a long turn
//      says how long it has been going rather than just spinning;
//   2. a clock time under an assistant message, so you can tell WHEN a reply
//      landed and not only how long it took.
//
// Both are wall-clock UI that only exists while/after a real turn runs, which
// is why this is an integration test rather than a unit one: the counter needs
// a turn genuinely held open, and the footer needs a turn that genuinely ended.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { textResponse } from "../mock-api/builder";
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

// The reported failure, reproduced: the counter sat on "1s" for a long time and
// only then began counting. The user is on a phone talking to a Mac, and the
// bubble the counter anchors to gets REPLACED mid-turn — the copy rendered on
// click is client-clocked, the transcript copy that lands moments later is
// clocked by the CLI at submit. When the viewing device's clock trails the
// server's, that replacement puts the anchor in the future, elapsed goes
// negative, and formatDuration floors it at 1s until real time catches up.
//
// One machine runs both halves here, so the skew has to be injected: the page's
// Date.now is moved back 30s, leaving the server's timestamps 30s ahead exactly
// as they are for a phone with a lagging clock.
test("the counter keeps counting when the viewing device's clock trails the server's", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-skew-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  const SKEW_MS = 30_000;

  try {
    harness.mock.setScript([{ events: textResponse("done thinking"), delayMs: 12_000 }]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();

    // Only Date.now, which is what the counter reads — a wholesale Date swap
    // would drag every unrelated timer in the page along with it.
    await page.addInitScript((skew) => {
      const real = Date.now.bind(Date);
      Date.now = () => real() - skew;
    }, SKEW_MS);

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    const input = page.getByTestId("message-input");
    await expect(input).toBeVisible();
    await page.waitForTimeout(5000);

    await input.fill("take your time");
    await page.getByTestId("btn-send").click();

    const elapsed = page.getByTestId("turn-elapsed");
    await expect(elapsed).toBeVisible({ timeout: 20_000 });

    // Without the latch this reads "1s" for the whole 30s of skew.
    await page.waitForTimeout(5000);
    const seconds = Number((await elapsed.textContent())?.match(/^(\d+)s/)?.[1] ?? 0);
    expect(seconds, "a skewed clock must not park the counter").toBeGreaterThanOrEqual(3);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a running turn shows a ticking elapsed time, and the finished reply shows when it landed", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-timing-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });

  try {
    // Held open long enough to watch the ticker advance several times.
    harness.mock.setScript([{ events: textResponse("done thinking"), delayMs: 12_000 }]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    const input = page.getByTestId("message-input");
    await expect(input).toBeVisible();
    await page.waitForTimeout(5000);

    await input.fill("take your time");
    await page.getByTestId("btn-send").click();

    const elapsed = page.getByTestId("turn-elapsed");
    await expect(elapsed).toBeVisible({ timeout: 20_000 });

    // It must actually count, not render a frozen value.
    const first = await elapsed.textContent();
    expect(first, "a blank or zeroed reading means the turn-start anchor was lost").toMatch(/^\d+[smh]/);
    await expect.poll(async () => (await elapsed.textContent()) !== first, { timeout: 15_000 }).toBe(true);

    // ...and count from the click, not from some later anchor. The bubble
    // rendered on click is client-clocked; the transcript copy that replaces it
    // mid-turn is clocked by the CLI at submit, so re-reading the anchor parked
    // the counter on "1s" (a negative elapsed floors there) until real time
    // caught up with the skew — which on a phone talking to a desktop is the
    // whole visible delay. Four seconds after send it must read at least 3s.
    await page.waitForTimeout(4000);
    const seconds = Number((await elapsed.textContent())?.match(/^(\d+)s/)?.[1] ?? 0);
    expect(seconds, "counts from send, not from a later anchor").toBeGreaterThanOrEqual(3);

    await expect(page.getByText("done thinking")).toBeVisible({ timeout: 30_000 });
    await expect(elapsed, "the counter belongs to a running turn only").toBeHidden({ timeout: 20_000 });

    // "Worked for 6s · 14:32" — duration and clock time under the reply.
    await expect(page.getByText(/Worked for .+ · \d{2}:\d{2}/)).toBeVisible({ timeout: 20_000 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
