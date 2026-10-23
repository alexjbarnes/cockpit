// Bringing the tour's world to life: seed it, start the tour API and a cockpit
// against it, then play each session's history through the real CLI, fill
// Insights with a month of telemetry, and leave two sessions mid-flight (one
// working, one asking a question) so the sidebar looks like a working day.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import type { TourDirs } from "./cockpit";
import { type RunningCockpit, startCockpit } from "./cockpit";
import { type TelemetrySession, workdayStarts, writeTelemetry } from "./insights-data";
import { type MockApi, startMockApi } from "./mock-api";
import { director, PROMPTS, SESSION_NAMES } from "./script";
import { DEEPSEEK_PRO, REPOS, repoPath, seedWorld, tourDirs } from "./seed";
import { random, seedIssues, seedJobs } from "./world";

export const TOKEN = "tour-token";

export interface TourSession {
  id: string;
  cwd: string;
  name: string;
}

export interface Tour {
  dirs: TourDirs;
  mock: MockApi;
  cockpit: RunningCockpit;
  browser: Browser;
  sessions: { storefront: TourSession; api: TourSession; docs: TourSession; react: TourSession; readme: TourSession };
  stop(): Promise<void>;
}

export async function authed(
  browser: Browser,
  cockpit: RunningCockpit,
  opts: Parameters<Browser["newContext"]>[0] = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark", ...opts });
  await context.addCookies([{ name: "cockpit_session", value: cockpit.token, domain: "127.0.0.1", path: "/" }]);
  return context;
}

async function createSession(cockpit: RunningCockpit, cwd: string, name: string, model?: string): Promise<TourSession> {
  const res = await fetch(`${cockpit.url}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cockpit.token}` },
    body: JSON.stringify({ cwd, name, runtime: "pty", ...(model ? { model } : {}) }),
  });
  if (!res.ok) throw new Error(`creating ${name}: HTTP ${res.status} ${await res.text()}`);
  const { sessionId } = (await res.json()) as { sessionId: string };
  return { id: sessionId, cwd, name };
}

export function sessionUrl(cockpit: RunningCockpit, s: TourSession): string {
  return `${cockpit.url}/sessions/${s.id}?cwd=${encodeURIComponent(s.cwd)}`;
}

/** Opens a session and sends one message; waits for `until` when given. */
async function say(page: Page, cockpit: RunningCockpit, s: TourSession, text: string, until?: string): Promise<void> {
  await page.goto(sessionUrl(cockpit, s));
  await page.getByTestId("message-input").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(4_000);
  await page.getByTestId("message-input").fill(text);
  await page.getByTestId("btn-send").click();
  if (until) await page.getByText(until, { exact: false }).first().waitFor({ timeout: 90_000 });
}

export async function startTour(root: string, log: (line: string) => void = () => {}): Promise<Tour> {
  const now = Date.now();
  const dirs = tourDirs(root);
  seedWorld(dirs, now);
  seedIssues(dirs, now);
  const runs = seedJobs(dirs, now);
  const code = path.join(dirs.home, "code");

  const mock = await startMockApi(director(code), {
    "/user/balance": {
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "18.42", granted_balance: "0.00", topped_up_balance: "18.42" }],
    },
  });
  log(`tour API on ${mock.url}`);
  const cockpit = await startCockpit(dirs, mock.url, TOKEN);
  log(`cockpit on ${cockpit.url}`);
  const browser = await chromium.launch();

  const storefront = await createSession(cockpit, repoPath(dirs, REPOS.storefront), SESSION_NAMES.storefront);
  const api = await createSession(cockpit, repoPath(dirs, REPOS.api), SESSION_NAMES.api, "claude-sonnet-5-5");
  const docs = await createSession(cockpit, repoPath(dirs, REPOS.docs), SESSION_NAMES.docs, "claude-sonnet-5-5");
  const react = await createSession(cockpit, repoPath(dirs, REPOS.storefront), SESSION_NAMES.react, `deepseek:${DEEPSEEK_PRO}`);
  const readme = await createSession(cockpit, repoPath(dirs, REPOS.docs), "Tidy the README", "openrouter:z-ai/glm-5.3");

  const context = await authed(browser, cockpit);
  const page = await context.newPage();
  log("playing each session's history");
  await say(page, cockpit, storefront, PROMPTS.storefrontHistory, "Say the word");
  await say(page, cockpit, api, PROMPTS.apiHistory, "event ids it has already handled");
  await say(page, cockpit, docs, PROMPTS.docsHistory, "Drafted");
  await say(page, cockpit, react, PROMPTS.reactHistory, "Three steps");
  await say(page, cockpit, readme, PROMPTS.readmeHistory, "Fixed three broken links");

  log("writing a month of telemetry");
  const rand = random(11);
  const chat = (s: TourSession, provider: string, model: string, perDay: number, weight: number, prompts: string[]): TelemetrySession => ({
    id: s.id,
    provider,
    model,
    prompts,
    starts: workdayStarts(now - 30 * 60 * 1000, 30, perDay, rand),
    repo: s.cwd,
    weight,
  });
  const runModel = (model: string): [string, string] => {
    const colon = model.indexOf(":");
    return colon > 0 ? [model.slice(0, colon), model.slice(colon + 1)] : ["anthropic", model];
  };
  const telemetry: TelemetrySession[] = [
    chat(storefront, "anthropic", "claude-opus-5-5", 5, 1.4, [
      PROMPTS.storefrontHistory,
      "Why is the cart total off by a penny for bundles?",
      "Add discount codes: percentage and fixed amount",
      "Make the checkout form accessible: labels, focus order, errors",
      "Review this diff before I open the PR",
    ]),
    chat(api, "anthropic", "claude-sonnet-5-5", 4, 1.2, [
      PROMPTS.apiHistory,
      "Paginate GET /orders with a cursor",
      "Why did the refund test fail on CI?",
    ]),
    chat(docs, "anthropic", "claude-sonnet-5-5", 2, 0.8, [PROMPTS.docsHistory, "Proofread the getting started page"]),
    chat(react, "deepseek", DEEPSEEK_PRO, 3, 1.1, [PROMPTS.reactHistory, "Find every deprecated lifecycle method"]),
    chat(readme, "openrouter", "z-ai/glm-5.3", 1.5, 0.8, ["Tidy the README and fix the broken links"]),
    ...runs.map((r) => {
      const [provider, model] = runModel(r.model);
      return {
        id: r.sessionId,
        provider,
        model,
        prompts: [r.prompt],
        starts: [r.startedAt],
        repo: repoPath(dirs, REPOS.storefront),
        weight: 0.6,
      };
    }),
  ];
  const records = writeTelemetry(path.join(dirs.config, "telemetry.db"), telemetry, now);
  log(`${records} telemetry records`);

  log("leaving two sessions mid-flight");
  await say(page, cockpit, api, PROMPTS.apiWork);
  await page.waitForTimeout(3_000);
  await say(page, cockpit, docs, PROMPTS.docsWork, "Which SDK release");
  await context.close();
  void randomUUID;

  return {
    dirs,
    mock,
    cockpit,
    browser,
    sessions: { storefront, api, docs, react, readme },
    async stop() {
      await browser.close().catch(() => {});
      await cockpit.stop();
      await mock.stop();
    },
  };
}
