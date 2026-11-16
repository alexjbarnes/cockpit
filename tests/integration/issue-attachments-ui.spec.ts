// A person attaching a picture to an issue from the page: the paperclip in
// the Attachments card, and pasting a screenshot into a comment. The agent
// path (a file named by the MCP tool) is covered by issue-images.spec.ts;
// this is the one with no CLI and no path on disk, where the bytes arrive in
// the request.

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** A real 1x1 PNG. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_BASE64, "base64");

interface StoredIssue {
  comments: { body: string }[];
  attachments: { title: string; url: string; inline?: boolean }[];
}

async function createIssue(page: Page, cockpitUrl: string, prefix: string): Promise<string> {
  const patched = await page.request.patch(`${cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });
  expect(patched.ok()).toBe(true);
  const projectRes = await page.request.post(`${cockpitUrl}/api/projects`, { data: { name: `Attach ${prefix}`, prefix } });
  expect(projectRes.ok()).toBe(true);
  const { project } = (await projectRes.json()) as { project: { id: string } };
  const issueRes = await page.request.post(`${cockpitUrl}/api/issues`, { data: { projectId: project.id, title: "Needs a picture" } });
  expect(issueRes.ok()).toBe(true);
  return ((await issueRes.json()) as { issue: { key: string } }).issue.key;
}

async function storedIssue(page: Page, cockpitUrl: string, key: string): Promise<StoredIssue> {
  const res = await page.request.get(`${cockpitUrl}/api/issues/${key}`);
  return ((await res.json()) as { issue: StoredIssue }).issue;
}

test("a picture can be attached from the Attachments card", async ({ page, harness }) => {
  const key = await createIssue(page, harness.cockpitUrl, "ATT");
  await page.goto(`${harness.cockpitUrl}/issues/${key}`);

  // The card is there before there is anything in it, so the control that
  // adds the first attachment has somewhere to live.
  await expect(page.getByTestId("issue-attachments")).toBeVisible();
  await expect(page.getByTestId("issue-attachments")).toContainText("(0)");

  await page.getByTestId("issue-attachment-input").setInputFiles({ name: "mock.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByTestId("issue-attachments")).toContainText("(1)");

  await page.getByTestId("issue-attachments-toggle").click();
  const img = page.getByTestId("issue-attachment-images").locator("img");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0))).toBe(1);

  const stored = await storedIssue(page, harness.cockpitUrl, key);
  expect(stored.attachments).toHaveLength(1);
  expect(stored.attachments[0].title).toBe("mock.png");
  expect(stored.attachments[0].inline).toBeUndefined();

  // The bytes were copied into the issue's own folder, so the picture is still
  // there after a reload rather than pointing at the upload.
  await page.reload();
  await page.getByTestId("issue-attachments-toggle").click();
  await expect(page.getByTestId("issue-attachment-images").locator("img")).toBeVisible();
});

test("a pasted screenshot lands in the comment where it was pasted", async ({ page, harness }) => {
  const key = await createIssue(page, harness.cockpitUrl, "ATP");
  await page.goto(`${harness.cockpitUrl}/issues/${key}`);

  const input = page.getByTestId("comment-input");
  await input.evaluate((el, png) => {
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG_BASE64);

  await expect(input).toHaveValue(new RegExp(`!\\[pasted\\.png\\]\\(/api/issues/${key}/attachments/`));
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator("img[src^='/api/issues/']")).toBeVisible();

  const stored = await storedIssue(page, harness.cockpitUrl, key);
  expect(stored.comments).toHaveLength(1);
  expect(stored.comments[0].body).toContain("![pasted.png](/api/issues/");
  // Inline: shown in the comment, not listed again under Attachments.
  expect(stored.attachments).toHaveLength(1);
  expect(stored.attachments[0].inline).toBe(true);
  await expect(page.getByTestId("issue-attachments")).toContainText("(0)");
});
