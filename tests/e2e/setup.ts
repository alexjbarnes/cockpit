// Shared test harness: start mock API server + Cockpit + Playwright browser

import { spawn } from "node:child_process";
import { type Browser, chromium, type Page } from "@playwright/test";
import { createMockApiServer, type MockApiServer } from "../mock-api/server";
import { E2E_COCKPIT_TOKEN, restoreProviders, setupTestProvider } from "./fixtures";

const COCKPIT_PORT = 3099;

export interface E2EContext {
  mockApi: MockApiServer;
  page: Page;
  browser: Browser;
  cockpitProcess: { kill(signal: string): void };
}

export async function setupE2E(): Promise<E2EContext> {
  const mockApi = await createMockApiServer();

  setupTestProvider(mockApi.port);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "NODE_ENV" && v != null) env[k] = v;
  }
  env.COCKPIT_TOKEN = E2E_COCKPIT_TOKEN;
  env.PORT = String(COCKPIT_PORT);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cockpitProcess: any = spawn("npx", ["tsx", "server.ts"], {
    env: env as typeof process.env,
    stdio: "pipe",
    shell: true,
  });

  cockpitProcess.stdout.on("data", (d: Buffer) => process.stdout.write(`[cockpit] ${d}`));
  cockpitProcess.stderr.on("data", (d: Buffer) => process.stderr.write(`[cockpit:err] ${d}`));

  // Wait for Cockpit to be ready
  await waitForServer(`http://localhost:${COCKPIT_PORT}/api/health`, 120_000);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  return { mockApi, browser, page, cockpitProcess };
}

export async function teardownE2E(ctx?: E2EContext): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.page.context().close();
  } catch {}
  try {
    await ctx.browser.close();
  } catch {}
  try {
    ctx.cockpitProcess.kill("SIGTERM");
  } catch {}
  try {
    await ctx.mockApi.stop();
  } catch {}
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
