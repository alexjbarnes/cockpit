// Claude Code's OpenTelemetry reaches cockpit's store, end to end: the real
// CLI, spawned by cockpit with telemetry switched on, runs a turn with a Bash
// call against the mock API, and every signal it reports (events, spans and
// metrics) is read back through /api/telemetry under that session.
//
// The settings file is the only place cockpit's telemetry keys beat the user's
// own settings, so this is also the proof that the CLI reads them from there,
// that the per-spawn token authenticates, and that the worker stores what the
// receiver hands it.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import type { InsightsOverview, InsightsTools, InsightsTurns, TelemetryPage, TelemetryRecord, TelemetryStats } from "../../src/types";
import { textResponse, toolUseResponse } from "../mock-api/builder";
import { expect, test } from "./fixtures";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_AVAILABLE = (() => {
  try {
    execSync(`${CLAUDE_BIN} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test.skip(!CLAUDE_AVAILABLE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);

async function allRecords(request: APIRequestContext, base: string, sessionId: string): Promise<TelemetryRecord[]> {
  const records: TelemetryRecord[] = [];
  let after = 0;
  for (;;) {
    const res = await request.get(`${base}/api/telemetry?session=${sessionId}&order=ingest&limit=1000&after=${after}`);
    expect(res.ok()).toBe(true);
    const page = (await res.json()) as TelemetryPage;
    records.push(...page.records);
    if (!page.nextCursor) return records;
    after = Number(page.nextCursor);
  }
}

async function runTurn(page: import("@playwright/test").Page, harness: import("./harness").Harness, workDir: string, text: string) {
  const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
  expect(res.ok()).toBe(true);
  const { sessionId } = (await res.json()) as { sessionId: string };
  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
  await expect(page.getByTestId("message-input")).toBeVisible();
  await page.waitForTimeout(5000);
  await page.getByTestId("message-input").fill(text);
  await page.getByTestId("btn-send").click();
  await expect(page.getByText("Done.", { exact: true })).toBeVisible({ timeout: 60_000 });
  return sessionId;
}

function script(harness: import("./harness").Harness) {
  harness.mock.setScript([
    { match: '"json_schema"', events: textResponse('{"title":"Telemetry"}') },
    // Output well over the 4 KB kept inline: 2000 numbered lines.
    { events: toolUseResponse("Bash", { command: "seq 1 2000 # telemetry-probe", description: "Probe" }) },
    // A command that writes, which the CLI asks permission for (seq is one it
    // allows by itself), so cockpit answers a prompt and records who did.
    { events: toolUseResponse("Bash", { command: "touch telemetry-probe.txt", description: "Write" }) },
    { events: textResponse("Done.") },
  ]);
}

test.describe("with telemetry switched on", () => {
  test.use({ harnessOptions: { telemetry: true } });

  test("a session's events, spans and metrics are stored under it", async ({ page, harness }) => {
    test.setTimeout(180_000);
    const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-telemetry-"));
    mkdirSync(path.join(workDir, ".git"), { recursive: true });
    harness.trustWorkDir(workDir);
    try {
      script(harness);
      const sessionId = await runTurn(page, harness, workDir, "record this turn please");

      // Logs and traces flush every 5 s, metrics every 10 s.
      const wanted = [
        "claude_code.user_prompt",
        "claude_code.api_request",
        "claude_code.tool_result",
        "claude_code.interaction",
        "claude_code.llm_request",
        "claude_code.tool",
        "claude_code.token.usage",
      ];
      let records: TelemetryRecord[] = [];
      await expect
        .poll(
          async () => {
            records = await allRecords(page.request, harness.cockpitUrl, sessionId);
            const names = new Set(records.map((r) => r.name));
            return wanted.filter((n) => !names.has(n));
          },
          { timeout: 60_000, intervals: [1000] },
        )
        .toEqual([]);

      const named = (name: string, signal?: string) => records.filter((r) => r.name === name && (!signal || r.signal === signal));
      // The prompt itself, captured because cockpit switches content on.
      expect(JSON.stringify(named("claude_code.user_prompt", "log").map((r) => r.attrs))).toContain("record this turn please");
      // Tool details: the command the turn ran.
      expect(JSON.stringify(named("claude_code.tool_result", "log").map((r) => r.attrs))).toContain("seq 1 2000 # telemetry-probe");
      expect(named("claude_code.interaction", "span").length).toBeGreaterThan(0);
      expect(named("claude_code.llm_request", "span")[0].value).toBeGreaterThanOrEqual(0);
      expect(records.some((r) => r.signal === "span_event")).toBe(true);
      expect(named("claude_code.token.usage", "metric").reduce((sum, r) => sum + (r.value ?? 0), 0)).toBeGreaterThan(0);

      // Every record is this session's, and carries the CLI's session id too,
      // which starts out equal to cockpit's.
      expect(new Set(records.map((r) => r.sessionId))).toEqual(new Set([sessionId]));
      expect(new Set(records.map((r) => r.cliSessionId).filter(Boolean))).toEqual(new Set([sessionId]));

      // The tool's output, over the size kept inline, is stored apart from its
      // record and comes back whole on request.
      const output = named("tool.output", "span_event")[0];
      expect(output, "OTEL_LOG_TOOL_CONTENT sends the tool's output").toBeTruthy();
      expect(Object.values(output.attrs).some((v) => typeof v === "object" && v !== null && "$content" in v)).toBe(true);
      const inline = (await (
        await page.request.get(`${harness.cockpitUrl}/api/telemetry?session=${sessionId}&name=tool.output&content=inline&limit=1`)
      ).json()) as TelemetryPage;
      expect(Object.values(inline.records[0].attrs).some((v) => typeof v === "string" && v.includes("1999\n2000"))).toBe(true);

      const stats = (await (
        await page.request.get(`${harness.cockpitUrl}/api/telemetry/stats?session=${sessionId}`)
      ).json()) as TelemetryStats;
      expect(stats).toMatchObject({ available: true, enabled: true });
      expect(stats.spawns.applied).toBeGreaterThanOrEqual(1);
      expect(stats.dropped.unknownToken).toBe(0);
      expect(stats.dropped.unsupportedType).toBe(0);
      expect(stats.store?.byName?.["claude_code.api_request"]).toBeGreaterThan(0);

      // The spawn named the provider serving its model on every record, which
      // is what Insights prices by: the harness runs its sessions on "mock".
      const first = (await (
        await page.request.get(`${harness.cockpitUrl}/api/telemetry?session=${sessionId}&limit=1`)
      ).json()) as TelemetryPage;
      expect(Object.values(first.sources).map((s) => s.resource["cockpit.provider"])).toEqual(["mock"]);

      // Insights reads the turn back, and knows the Bash call's prompt was
      // answered by bypass, which the harness runs sessions in, not by a person.
      const insights = async <T>(view: string) =>
        (await (
          await page.request.get(`${harness.cockpitUrl}/api/telemetry/insights?view=${view}&range=24h&session=${sessionId}`)
        ).json()) as T;
      const overview = await insights<InsightsOverview>("overview");
      expect(overview.totals).toMatchObject({ turns: 1, waits: 0, waitingMs: 0 });
      expect(overview.totals.requests).toBeGreaterThan(0);
      expect(overview.totals.toolCalls).toBeGreaterThan(0);
      expect(overview.sessions[sessionId].providers).toEqual(["mock"]);
      await expect
        .poll(async () => (await insights<InsightsTools>("tools")).waiting.answeredBy.bypass ?? 0, { timeout: 15_000 })
        .toBeGreaterThan(0);
      const turns = await insights<InsightsTurns>("turns");
      expect(turns.turns).toHaveLength(1);
      expect(turns.turns[0].prompt).toContain("record this turn please");
      expect(turns.turns[0].toolCalls).toBeGreaterThan(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

test("with telemetry off, a session's turn stores nothing", async ({ page, harness }) => {
  test.setTimeout(120_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-telemetry-off-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  try {
    script(harness);
    const sessionId = await runTurn(page, harness, workDir, "nothing to record");
    // Give an exporter that should not exist the time it would need.
    await page.waitForTimeout(12_000);
    const records = await allRecords(page.request, harness.cockpitUrl, sessionId);
    expect(records).toEqual([]);
    const stats = (await (await page.request.get(`${harness.cockpitUrl}/api/telemetry/stats`)).json()) as TelemetryStats;
    expect(stats.enabled).toBe(false);
    expect(stats.spawns.applied).toBe(0);
    expect(stats.spawns.off).toBeGreaterThanOrEqual(1);
    expect(stats.dropped.unknownToken).toBe(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
