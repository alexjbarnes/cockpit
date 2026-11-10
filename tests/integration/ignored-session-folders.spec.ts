// A folder in Settings → Session Defaults hides every Claude session in it,
// and in any folder below it, from the homepage groups, "load all", the
// sidebar's pinned lookup and global search. Opening one by its direct URL
// still works.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

const IGNORED_ROOT = "/tmp/cockpit-it-ignored/ai-reviews";
const IGNORED_NESTED = `${IGNORED_ROOT}/nested/deep`;
const SIBLING = "/tmp/cockpit-it-ignored/ai-reviews-2";
const KEPT = "/tmp/cockpit-it-kept";

const IGNORED_ID = "11111111-1111-4111-8111-111111111111";
const IGNORED_NESTED_ID = "22222222-2222-4222-8222-222222222222";
const SIBLING_ID = "33333333-3333-4333-8333-333333333333";
const KEPT_ID = "44444444-4444-4444-8444-444444444444";

function writeTranscript(claudeDir: string, id: string, cwd: string, reply: string): void {
  const dir = path.join(claudeDir, "projects", cwd.replace(/[/.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const lines = [
    {
      parentUuid: null,
      type: "user",
      cwd,
      message: { content: "prompt" },
      uuid: `${id}-u`,
      timestamp: "2026-01-01T00:00:00Z",
      sessionId: id,
    },
    {
      parentUuid: `${id}-u`,
      type: "assistant",
      message: { content: [{ type: "text", text: reply }] },
      uuid: `${id}-a`,
      timestamp: "2026-01-01T00:01:00Z",
      sessionId: id,
    },
  ];
  writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n"));
}

test.use({
  harnessOptions: {
    prepare: ({ configDir, claudeDir }) => {
      writeTranscript(claudeDir, IGNORED_ID, IGNORED_ROOT, "ignoredmarker");
      writeTranscript(claudeDir, IGNORED_NESTED_ID, IGNORED_NESTED, "ignoredmarker nested");
      writeTranscript(claudeDir, SIBLING_ID, SIBLING, "keptmarker sibling");
      writeTranscript(claudeDir, KEPT_ID, KEPT, "keptmarker");

      const defaultsFile = path.join(configDir, "defaults.json");
      const defaults = JSON.parse(readFileSync(defaultsFile, "utf-8")) as Record<string, unknown>;
      defaults.ignoredSessionFolders = [IGNORED_ROOT];
      writeFileSync(defaultsFile, JSON.stringify(defaults, null, 2));
    },
  },
});

test("ignored folders are hidden from every session list but direct URLs still open", async ({ page, harness }) => {
  const url = harness.cockpitUrl;

  const list = (await (await page.request.get(`${url}/api/sessions`)).json()) as {
    groups: { cwd: string; sessions: { id: string }[] }[];
  };
  const cwds = list.groups.map((group) => group.cwd);
  expect(cwds).not.toContain(IGNORED_ROOT);
  expect(cwds).not.toContain(IGNORED_NESTED);
  expect(cwds).toContain(SIBLING);
  expect(cwds).toContain(KEPT);

  for (const cwd of [IGNORED_ROOT, IGNORED_NESTED]) {
    const group = (await (await page.request.get(`${url}/api/sessions/group?cwd=${encodeURIComponent(cwd)}`)).json()) as {
      sessions: { id: string }[];
    };
    expect(group.sessions).toEqual([]);
  }
  const siblingGroup = (await (await page.request.get(`${url}/api/sessions/group?cwd=${encodeURIComponent(SIBLING)}`)).json()) as {
    sessions: { id: string }[];
  };
  expect(siblingGroup.sessions.map((s) => s.id)).toContain(SIBLING_ID);

  const byIds = (await (await page.request.get(`${url}/api/sessions/by-ids?ids=${IGNORED_ID},${KEPT_ID}`)).json()) as {
    sessions: { id: string }[];
    foundIds: string[];
  };
  expect(byIds.sessions.map((s) => s.id)).toEqual([KEPT_ID]);
  expect(byIds.foundIds).toEqual([KEPT_ID]);

  const ignoredSearch = (await (await page.request.get(`${url}/api/sessions/search?q=ignoredmarker`)).json()) as {
    results: unknown[];
  };
  expect(ignoredSearch.results).toEqual([]);
  const keptSearch = (await (await page.request.get(`${url}/api/sessions/search?q=keptmarker`)).json()) as {
    results: unknown[];
  };
  expect(keptSearch.results.length).toBeGreaterThan(0);

  // The direct route never consults the ignored list.
  const direct = await page.request.get(`${url}/api/sessions/${IGNORED_ID}?cwd=${encodeURIComponent(IGNORED_ROOT)}`);
  expect(direct.ok()).toBe(true);
  const directBody = (await direct.json()) as { messages: { content: string }[] };
  expect(directBody.messages.some((m) => m.content.includes("prompt"))).toBe(true);
});

test("the settings list adds, rejects and removes folders", async ({ page, harness }) => {
  await page.setViewportSize({ width: 393, height: 760 });
  await page.goto(`${harness.cockpitUrl}/settings/session`);
  const section = page.getByTestId("ignored-folders");
  await expect(section).toBeVisible({ timeout: 20_000 });
  await expect(section.getByTestId("ignored-folder-row")).toHaveCount(1);

  const input = section.getByTestId("ignored-folder-input");

  // Add the sibling, which the list now hides.
  await input.fill(SIBLING);
  await section.getByTestId("ignored-folder-add").click();
  await expect(section.getByTestId("ignored-folder-row")).toHaveCount(2);
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflows).toBe(false);
  await expect
    .poll(async () => {
      const defaults = (await (await page.request.get(`${harness.cockpitUrl}/api/defaults`)).json()) as {
        ignoredSessionFolders?: string[];
      };
      return defaults.ignoredSessionFolders;
    })
    .toEqual([IGNORED_ROOT, SIBLING]);

  // A folder already in the list is refused.
  await input.fill(`${IGNORED_ROOT}/`);
  await section.getByTestId("ignored-folder-add").click();
  await expect(section.getByTestId("ignored-folder-error")).toContainText("already ignored");
  await expect(section.getByTestId("ignored-folder-row")).toHaveCount(2);

  // A relative path is refused.
  await input.fill("not/absolute");
  await section.getByTestId("ignored-folder-add").click();
  await expect(section.getByTestId("ignored-folder-error")).toContainText("absolute");

  // Remove the sibling again.
  const siblingRow = section.getByTestId("ignored-folder-row").filter({ hasText: SIBLING });
  await siblingRow.getByTestId("ignored-folder-remove").click();
  await expect(section.getByTestId("ignored-folder-row")).toHaveCount(1);
  await expect
    .poll(async () => {
      const defaults = (await (await page.request.get(`${harness.cockpitUrl}/api/defaults`)).json()) as {
        ignoredSessionFolders?: string[];
      };
      return defaults.ignoredSessionFolders;
    })
    .toEqual([IGNORED_ROOT]);

  // Browse opens the existing picker.
  await section.getByTestId("ignored-folder-browse").click();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden();
});
