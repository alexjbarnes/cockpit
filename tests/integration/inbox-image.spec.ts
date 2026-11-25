// A picture attached to an inbox message is served by cockpit, not loaded from
// the site that produced it. The message list needs no CLI: seed inbox.jsonl
// and the attachment directory directly.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");

test("an attached picture renders from the authenticated attachment route", async ({ page, harness }) => {
  const id = "message-with-image";
  const imageId = "image-1";
  writeFileSync(
    path.join(harness.configDir, "inbox.jsonl"),
    `${JSON.stringify({
      id,
      title: "Stargazing forecast",
      body: "Tonight is clear.",
      priority: "info",
      images: [{ id: imageId, mime: "image/png" }],
      createdAt: Date.now(),
      read: true,
    })}\n`,
  );
  const dir = path.join(harness.configDir, "inbox-attachments", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${imageId}.png`), PNG);

  await page.goto(`${harness.cockpitUrl}/inbox/${id}`);
  const image = page.getByTestId("inbox-images").getByTestId("markdown-image").locator("img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);

  const res = await page.request.get(`${harness.cockpitUrl}/api/inbox/${id}/attachments/${imageId}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/png");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
});

test("an image id cannot walk out of the message's attachment directory", async ({ page, harness }) => {
  const id = "message-with-bad-image";
  writeFileSync(
    path.join(harness.configDir, "inbox.jsonl"),
    `${JSON.stringify({
      id,
      title: "Bad image",
      body: "b",
      priority: "info",
      images: [{ id: "../../etc/passwd", mime: "image/png" }],
      createdAt: Date.now(),
      read: true,
    })}\n`,
  );

  const res = await page.request.get(`${harness.cockpitUrl}/api/inbox/${id}/attachments/${encodeURIComponent("../../etc/passwd")}`);
  expect(res.status()).toBe(404);
});
