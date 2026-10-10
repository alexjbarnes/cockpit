// Select mode on the inbox: pick messages, then delete or mark them read in one go.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

function seedInbox(configDir: string, titles: string[]) {
  const now = Date.now();
  const lines = titles.map((title, i) =>
    JSON.stringify({ id: `msg-${i + 1}`, title, body: `Body of ${title}`, priority: "info", createdAt: now - i * 60_000, read: false }),
  );
  writeFileSync(path.join(configDir, "inbox.jsonl"), lines.join("\n") + "\n");
}

test("messages picked in select mode are deleted and marked read together", async ({ page, harness }) => {
  seedInbox(harness.configDir, ["First report", "Second report", "Third report", "Fourth report"]);
  await page.goto(`${harness.cockpitUrl}/inbox`);
  const rows = page.getByTestId("inbox-row");
  await expect(rows).toHaveCount(4);

  // In select mode a tap picks a row instead of opening it.
  await page.getByTestId("inbox-select").click();
  await rows.filter({ hasText: "First report" }).click();
  await rows.filter({ hasText: "Third report" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByTestId("inbox-select-all")).toHaveText("2 selected");

  await page.getByTestId("inbox-bulk-delete").click();
  await expect(page.getByText("Delete 2 messages? This cannot be undone.")).toBeVisible();
  await page.getByTestId("inbox-bulk-delete-confirm").click();
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "Second report" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Fourth report" })).toHaveCount(1);

  // Select all, then mark read.
  await page.getByTestId("inbox-select").click();
  await page.getByTestId("inbox-select-all").click();
  await expect(page.getByTestId("inbox-select-all")).toHaveText("2 selected");
  await page.getByRole("button", { name: "Mark read" }).click();
  await expect(page.getByTestId("inbox-selection-bar")).toHaveCount(0);

  const res = await page.request.get(`${harness.cockpitUrl}/api/inbox`);
  const { messages } = (await res.json()) as { messages: { id: string; read: boolean }[] };
  expect(messages.map((m) => [m.id, m.read])).toEqual([
    ["msg-2", true],
    ["msg-4", true],
  ]);
});
