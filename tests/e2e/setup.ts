// Shared test harness: start mock API server + Cockpit + Playwright browser

import { type ChildProcess, spawn } from "node:child_process";
import { type Browser, chromium, type Page } from "@playwright/test";
import { createMockApiServer, type MockApiServer } from "../mock-api/server";
import { E2E_COCKPIT_TOKEN, restoreProviders, setupTestProvider } from "./fixtures";

const COCKPIT_PORT = 3099;

export interface E2EContext {
  mockApi: MockApiServer;
  page: Page;
  browser: Browser;
  cockpitProcess: ChildProcess;
}

export async function setupE2E(): Promise<E2EContext> {
  const mockApi = await createMockApiServer();

  setupTestProvider(mockApi.port);

  const cockpitProcess = spawn("npx", ["next", "dev", "-p", String(COCKPIT_PORT)], {
    env: {
      ...process.env,
      COCKPIT_TOKEN: E2E_COCKPIT_TOKEN,
      PORT: String(COCKPIT_PORT),
    },
    stdio: "pipe",
    shell: true,
  });

  // Wait for Cockpit to be ready
  await waitForServer(`http://localhost:${COCKPIT_PORT}/api/health`, 60_000);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  return { mockApi, browser, page, cockpitProcess };
}

export async function teardownE2E(ctx: E2EContext): Promise<void> {
  await ctx.page.context().close();
  await ctx.browser.close();
  ctx.cockpitProcess.kill("SIGTERM");
  await ctx.mockApi.stop();
  restoreProviders();
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}
