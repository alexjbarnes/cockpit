import { expect, test } from "@playwright/test";
import { simpleTextScript } from "../mock-api/scripts/simple-text";
import { E2E_COCKPIT_TOKEN } from "./fixtures";
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

  await ctx.page.goto("/");

  // Authenticate via cookie
  await ctx.page.context().addCookies([{ name: "cockpit_session", value: E2E_COCKPIT_TOKEN, domain: "localhost", path: "/" }]);

  // Navigate to a directory — creates a new session
  await ctx.page.goto("/sessions/new?cwd=/tmp&name=e2e-status-test");

  // Verify we're on the session page
  await expect(ctx.page.locator('[data-testid="message-input"]')).toBeVisible({ timeout: 15_000 });

  // Initial state: idle (gray dot)
  const idleDot = ctx.page.locator('[data-testid="status-idle"]');
  await expect(idleDot).toBeVisible({ timeout: 10_000 });

  // Type a message and send
  await ctx.page.locator('[data-testid="message-input"]').fill("Hello");
  await ctx.page.locator('[data-testid="btn-send"]').click();

  // Wait for the running status (yellow dot)
  const runningDot = ctx.page.locator('[data-testid="status-running"]');
  await expect(runningDot).toBeVisible({ timeout: 30_000 });

  // Wait for the response to complete — idle (gray) dot returns
  await expect(idleDot).toBeVisible({ timeout: 30_000 });
});
