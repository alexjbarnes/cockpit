import { expect, test } from "@playwright/test";
import { simpleTextScript } from "../mock-api/scripts/simple-text";
import { type E2EContext, setupE2E, teardownE2E } from "./setup";

let ctx: E2EContext;

test.beforeAll(async () => {
  ctx = await setupE2E();
});

test.afterAll(async () => {
  await teardownE2E(ctx);
});

test("status indicators work after server restart for PTY session", async () => {
  ctx.mockApi.setScript(simpleTextScript);

  // Create a PTY session via API
  const { page: page1, sessionId } = await ctx.openSession("new", "/tmp");

  // Send a message to spawn the CLI and create the transcript
  await page1.locator('[data-testid="message-input"]').fill("hello");
  await page1.locator('[data-testid="btn-send"]').click();
  await expect(page1.locator('[data-testid="status-running"]')).toBeVisible({ timeout: 30_000 });
  await expect(page1.locator('[data-testid="status-idle"]')).toBeVisible({ timeout: 30_000 });

  // Restart the server
  ctx.mockApi.setScript(simpleTextScript);
  await ctx.restartCockpit();

  // Open the SAME session after restart
  const { page: page2 } = await ctx.openSession(sessionId, "/tmp");

  // Send another message — tests both session:subscribe (sidebar pins) and
  // session:connect (page load) subscription paths
  await page2.locator('[data-testid="message-input"]').fill("hello again");
  await page2.locator('[data-testid="btn-send"]').click();

  await expect(page2.locator('[data-testid="status-running"]')).toBeVisible({ timeout: 30_000 });
  await expect(page2.locator('[data-testid="status-idle"]')).toBeVisible({ timeout: 30_000 });
});
