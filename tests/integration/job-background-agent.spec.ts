// A scheduled job must survive the turn that launches an async Agent.
//
// The CLI's Agent tool returns immediately with "Async agent launched", ends
// the turn, and wakes the model with a <task-notification> when the agent
// finishes. A scheduler that treats the first idle as the end of the run tears
// the PTY down and kills the agent with it. This spec drives that exact
// sequence against the real CLI: the job launches the agent, its turn ends
// while the agent is still working, and the run only succeeds after the
// notification starts a second turn.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { textResponse, toolUseResponse } from "../mock-api/builder";
import { expect, test } from "./fixtures";
import type { Harness } from "./harness";

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

// The general-purpose agent's system prompt; the parent's requests never carry
// it, so the agent's turns can be answered apart.
const AGENT_SYSTEM = "You are an agent for Claude Code";
// Only the notification turn's user message carries these.
const NOTIFICATION_MARKER = "<task-id>";

function diag(harness: Harness, sessionId: string): Array<Record<string, unknown>> {
  const file = path.join(harness.configDir, "debug.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes('"dir":"diag"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.sessionId === sessionId);
}

test("a job waits for an async Agent and finishes after its task notification", async ({ page, harness }) => {
  test.setTimeout(180_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-job-agent-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    // Every response is built before setScript, which resets the builder's ids.
    const title = textResponse('{"title":"Probe"}');
    const launch = toolUseResponse("Agent", {
      description: "Run the probe",
      prompt: "Report back.",
      subagent_type: "general-purpose",
      run_in_background: true,
    });
    const waiting = textResponse("Waiting for the agent.");
    const agentDone = textResponse("Agent finished.");
    const report = textResponse("Report sent.");

    harness.mock.setScript([
      // The CLI's title side request, sent beside the first message.
      { match: '"json_schema"', events: title },
      // The agent's own request. The delay keeps it running after the parent
      // has ended its turn, which is the window that used to be fatal.
      { match: AGENT_SYSTEM, events: agentDone, delayMs: 8000 },
      { events: launch },
      { events: waiting },
      { events: report },
    ]);

    const created = await page.request.post(`${harness.cockpitUrl}/api/jobs`, {
      data: {
        name: "background-agent-job",
        prompt: "Run the probe agent and report.",
        cwd: workDir,
        schedules: [{ type: "simple", frequency: "daily", time: "09:00" }],
        // Triggered explicitly; the tick must never fire it too.
        enabled: false,
        runtime: "pty",
        allowedTools: ["Agent"],
        maxDurationMinutes: 5,
      },
    });
    expect(created.ok()).toBe(true);
    const { job } = (await created.json()) as { job: { id: string } };

    const startedAt = Date.now();
    const trigger = await page.request.post(`${harness.cockpitUrl}/api/jobs/${job.id}/trigger`, { timeout: 170_000 });
    const elapsedMs = Date.now() - startedAt;
    expect(trigger.ok()).toBe(true);
    const { run } = (await trigger.json()) as { run: { id: string; sessionId: string; status: string; error?: string } };

    expect(run.error).toBeUndefined();
    expect(run.status, `run failed: ${run.error ?? ""}`).toBe("success");
    // The agent ran for 8s after the parent's turn ended, so a run that
    // returned sooner never waited for it.
    expect(elapsedMs).toBeGreaterThan(7000);

    // The wait branch is the fix; without it the first idle is a teardown.
    expect(diag(harness, run.sessionId).some((e) => e.label === "job:waiting-on-background")).toBe(true);

    // The run could only finish after the agent's work if the notification
    // woke the model, so a later request must carry the agent's result.
    const bodies = harness.mock
      .getRequests()
      .filter((r) => r.url.split("?")[0] === "/v1/messages")
      .map((r) => r.body);
    expect(bodies.some((body) => body.includes(NOTIFICATION_MARKER))).toBe(true);
    expect(bodies.some((body) => body.includes("Agent finished."))).toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
