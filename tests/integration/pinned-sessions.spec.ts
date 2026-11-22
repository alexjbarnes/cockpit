// Pinned sessions survive anything but being unpinned.
//
// The sidebar used to PUT the surviving pins after every load, dropping any id
// the by-ids response did not carry. That response can come back partial — a
// transcript mid-write, a scan racing a server start, a session whose id moved
// on /clear — and one of those deleted the user's list. A pin is now only
// removed where it is removed deliberately.
//
// The same lookup also had to learn the prefs chain: a session that ran /clear
// keeps its cockpit id while the conversation lives under a new CLI id, so its
// pin never matched a transcript filename.

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const MISSING = "11111111-1111-4111-8111-111111111111";

test("a pin the lookup cannot find is kept, not deleted", async ({ page, harness }) => {
  const added = await page.request.patch(`${harness.cockpitUrl}/api/sessions/pinned`, { data: { add: MISSING } });
  expect(added.ok()).toBe(true);

  // Loading the sidebar asks by-ids, which has nothing to say about this id.
  const byIds = page.waitForResponse((r) => r.url().includes("/api/sessions/by-ids"));
  await page.goto(`${harness.cockpitUrl}/`);
  await byIds;
  await page.waitForTimeout(500);

  const pinned = (await (await page.request.get(`${harness.cockpitUrl}/api/sessions/pinned`)).json()) as { pinned: string[] };
  expect(pinned.pinned).toContain(MISSING);
});

test("dragging a pinned session reorders it on the server", async ({ page, harness }) => {
  test.setTimeout(120_000);
  // The pinned list is the phone's Sessions place; check the layout it is used in.
  await page.setViewportSize({ width: 393, height: 760 });
  const dir = mkdtempSync(path.join(tmpdir(), "cockpit-it-pinned-order-"));
  harness.trustWorkDir(dir);
  try {
    const ids: string[] = [];
    for (const name of ["First", "Second"]) {
      const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: dir, runtime: "pty", name } });
      expect(res.ok()).toBe(true);
      const { sessionId } = (await res.json()) as { sessionId: string };
      ids.push(sessionId);
      const pinned = await page.request.patch(`${harness.cockpitUrl}/api/sessions/pinned`, { data: { add: sessionId } });
      expect(pinned.ok()).toBe(true);
    }

    await page.goto(`${harness.cockpitUrl}/sessions`);
    const rows = page.locator('[data-testid^="pinned-session-"]');
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
    await expect(rows.nth(0)).toHaveAttribute("data-testid", `pinned-session-${ids[0]}`);

    // The second row's handle up to the first row: down, hold past the
    // activation delay, then a stream of moves, then release.
    const from = await page.getByTestId(`pinned-drag-${ids[1]}`).boundingBox();
    const first = await page.getByTestId(`pinned-drag-${ids[0]}`).boundingBox();
    if (!from || !first) throw new Error("rows not measurable");
    const x = from.x + from.width / 2;
    const y = from.y + from.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(250);
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(x, y + ((first.y - y) * i) / 10);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();

    // The row moved, and dragging did not open the session.
    await expect(rows.nth(0)).toHaveAttribute("data-testid", `pinned-session-${ids[1]}`, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/sessions$/);

    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${harness.cockpitUrl}/api/sessions/pinned`);
          return ((await res.json()) as { pinned: string[] }).pinned.slice(0, 2);
        },
        { timeout: 10_000 },
      )
      .toEqual([ids[1], ids[0]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pin is answered under its own id when the session moved on /clear", async ({ page, harness }) => {
  const created = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
    data: { cwd: harness.configDir, runtime: "pty", name: "Cleared session" },
  });
  expect(created.ok()).toBe(true);
  const { sessionId } = (await created.json()) as { sessionId: string };

  // What /clear leaves behind: the cockpit id names a session whose CLI id is
  // another. Written straight to the store, which reloads on the file's mtime.
  const prefsFile = path.join(harness.configDir, "session-prefs.json");
  const prefs = JSON.parse(readFileSync(prefsFile, "utf-8")) as Record<string, { cliSessionId?: string }>;
  const cockpitId = "22222222-2222-4222-8222-222222222222";
  prefs[cockpitId] = { cliSessionId: sessionId };
  writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));

  const res = await page.request.get(`${harness.cockpitUrl}/api/sessions/by-ids?ids=${cockpitId}`);
  expect(res.ok()).toBe(true);
  const data = (await res.json()) as { sessions: { id: string; name: string }[]; foundIds: string[] };
  expect(data.foundIds).toContain(cockpitId);
  expect(data.sessions.map((s) => s.id)).toContain(cockpitId);
});
