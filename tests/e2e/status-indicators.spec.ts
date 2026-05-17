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

test("status indicator transitions through yellow (running) to gray (idle)", async () => {
  ctx.mockApi.setScript(simpleTextScript);

  const { page } = await ctx.openSession("new", "/tmp");

  // Initial state: idle (gray dot)
  const idleDot = page.locator('[data-testid="status-idle"]');
  await expect(idleDot).toBeVisible({ timeout: 10_000 });

  // Type a message and send
  await page.locator('[data-testid="message-input"]').fill("Hello");
  await page.locator('[data-testid="btn-send"]').click();

  // Wait for the running status (yellow dot)
  const runningDot = page.locator('[data-testid="status-running"]');
  await expect(runningDot).toBeVisible({ timeout: 30_000 });

  // Wait for the response to complete — idle (gray) dot returns
  await expect(idleDot).toBeVisible({ timeout: 30_000 });
});
