// Shared test harness: start mock API server + Cockpit + Playwright browser

import { spawn } from "node:child_process";
import { type Browser, chromium, type Page } from "@playwright/test";
import { createMockApiServer, type MockApiServer } from "../mock-api/server";
import { E2E_COCKPIT_TOKEN, E2E_MODEL_STRING, restoreProviders, setupTestProvider } from "./fixtures";

const COCKPIT_PORT = 3099;

export interface E2EContext {
  mockApi: MockApiServer;
  page: Page;
  browser: Browser;
  cockpitProcess: { kill(signal: string): void };
  /** Kill and restart Cockpit, return new page after reconnect */
  restartCockpit: () => Promise<void>;
  /** Navigate to a session or create one via API. Returns page + sessionId. */
  openSession: (idOrNew: string, cwd: string) => Promise<{ page: Page; sessionId: string }>;
}

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "NODE_ENV" && v != null) env[k] = v;
  }
  env.COCKPIT_TOKEN = E2E_COCKPIT_TOKEN;
  env.PORT = String(COCKPIT_PORT);
  return env;
}

function startCockpit(): { process: { kill(signal: string): void }; stop: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc: any = spawn("npx", ["tsx", "server.ts"], {
    env: buildEnv() as typeof process.env,
    stdio: "pipe",
    shell: true,
  });

  proc.stdout.on("data", (d: Buffer) => process.stdout.write(`[cockpit] ${d}`));
  proc.stderr.on("data", (d: Buffer) => process.stderr.write(`[cockpit:err] ${d}`));

  return {
    process: proc,
    stop: () => {
      try {
        proc.kill("SIGTERM");
      } catch {}
    },
  };
}

export async function setupE2E(): Promise<E2EContext> {
  const mockApi = await createMockApiServer();
  setupTestProvider(mockApi.port);

  let cockpit = startCockpit();
  await waitForServer(`http://localhost:${COCKPIT_PORT}/api/health`, 120_000);

  const browser = await chromium.launch({ headless: true });

  async function restartCockpit(): Promise<void> {
    cockpit.stop();
    // Wait for port to be released
    await new Promise((r) => setTimeout(r, 1000));
    cockpit = startCockpit();
    await waitForServer(`http://localhost:${COCKPIT_PORT}/api/health`, 120_000);
  }

  async function openSession(idOrNew: string, cwd: string): Promise<{ page: Page; sessionId: string }> {
    let sessionId: string;

    if (idOrNew === "new") {
      // Create session via API to get a proper UUID
      const res = await fetch(`http://localhost:${COCKPIT_PORT}/api/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${E2E_COCKPIT_TOKEN}`,
        },
        body: JSON.stringify({ cwd, name: "e2e-test", runtime: "pty", model: E2E_MODEL_STRING, bypassPermissions: true }),
      });
      const data = await res.json();
      sessionId = data.sessionId;
      if (!sessionId) throw new Error(`Failed to create session: ${JSON.stringify(data)}`);
    } else {
      sessionId = idOrNew;
    }

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.context().addCookies([{ name: "cockpit_session", value: E2E_COCKPIT_TOKEN, domain: "localhost", path: "/" }]);
    await page.goto(`/sessions/${sessionId}?cwd=${encodeURIComponent(cwd)}`);
    await page.locator('[data-testid="message-input"]').waitFor({ timeout: 15_000 });
    return { page, sessionId };
  }

  return {
    mockApi,
    browser,
    page: await browser.newPage(),
    cockpitProcess: cockpit.process,
    restartCockpit,
    openSession,
  };
}

export async function teardownE2E(ctx?: E2EContext): Promise<void> {
  if (!ctx) return;
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
