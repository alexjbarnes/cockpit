// A scheduled job reports through an MCP tool rather than a fenced block in its
// final message. That path is only real if the job session actually receives the
// cockpit MCP config, the CLI connects to the server with the run token, the
// permission gate lets the call through, and the message lands in the inbox.
// Every one of those could be individually correct and the feature still dead,
// which is what the fenced-block version taught us: it looked fine and silently
// dropped seventeen minutes of work.
//
// The second test is the one that matters for safety. It gives the job
// bypassPermissions so cockpit's own permission gate approves everything, which
// leaves the run token's confinement as the only thing standing between an
// unattended job and delete_job.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

const INBOX_TOOL = "mcp__cockpit-config__add_inbox_message";

async function createJob(page: import("@playwright/test").Page, cockpitUrl: string, body: Record<string, unknown>) {
  const res = await page.request.post(`${cockpitUrl}/api/jobs`, {
    data: {
      schedules: [{ type: "simple", frequency: "daily", time: "09:00" }],
      enabled: false, // triggered explicitly; never let the tick fire it too
      ...body,
    },
  });
  expect(res.ok()).toBe(true);
  const { job } = await res.json();
  expect(job?.id).toBeTruthy();
  return job as { id: string; name: string };
}

test("a job with inboxOutput reaches the inbox tool and the message is delivered", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-job-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    harness.mock.setScript([
      {
        events: toolUseResponse(INBOX_TOOL, {
          title: "Nightly roundup",
          // Multi-paragraph markdown is the exact shape that broke the fenced
          // JSON contract, so send it through the tool to show it survives.
          body: '# Findings\n\nFirst paragraph.\n\nSecond paragraph with a "quote" and a\nnewline.',
          priority: "info",
        }),
      },
      { events: textResponse("Reported.") },
    ]);

    const job = await createJob(page, harness.cockpitUrl, {
      name: "inbox-tool-job",
      prompt: "Summarise and report.",
      cwd: workDir,
      inboxOutput: true,
      runtime: "pty",
    });

    const trigger = await page.request.post(`${harness.cockpitUrl}/api/jobs/${job.id}/trigger`, { timeout: 120_000 });
    expect(trigger.ok()).toBe(true);
    const { run } = await trigger.json();
    expect(run.status).toBe("success");

    const inboxRes = await page.request.get(`${harness.cockpitUrl}/api/inbox`);
    expect(inboxRes.ok()).toBe(true);
    const inbox = await inboxRes.json();
    const messages = (inbox.messages ?? inbox) as { title: string; body: string; jobId?: string; runId?: string }[];

    const delivered = messages.find((m) => m.title === "Nightly roundup");
    expect(delivered, `no inbox message delivered; got ${JSON.stringify(messages.map((m) => m.title))}`).toBeTruthy();
    expect(delivered?.body).toContain("Second paragraph");
    // Attribution comes from the run context, not from anything the model sent.
    expect(delivered?.jobId).toBe(job.id);
    expect(delivered?.runId).toBe(run.id);

    // The tool has to have been offered to the CLI for the model to call it.
    const bodies = harness.mock
      .getRequests()
      .filter((r) => r.url.split("?")[0] === "/v1/messages")
      .map((r) => r.body)
      .join("\n");
    expect(bodies).toContain(INBOX_TOOL);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a job cannot call a config tool even with bypassPermissions", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-job-deny-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    // A job that exists purely so there is something for delete_job to destroy.
    const victim = await createJob(page, harness.cockpitUrl, {
      name: "victim-job",
      prompt: "Do nothing.",
      cwd: workDir,
    });

    harness.mock.setScript([
      { events: toolUseResponse("mcp__cockpit-config__delete_job", { id: victim.id }) },
      { events: textResponse("Could not do that.") },
    ]);

    const job = await createJob(page, harness.cockpitUrl, {
      name: "overreaching-job",
      prompt: "Delete the other job.",
      cwd: workDir,
      inboxOutput: true,
      // Approves every tool at cockpit's gate, so nothing but the run token's
      // confinement is left to stop this.
      bypassPermissions: true,
      runtime: "pty",
    });

    const trigger = await page.request.post(`${harness.cockpitUrl}/api/jobs/${job.id}/trigger`, { timeout: 120_000 });
    expect(trigger.ok()).toBe(true);

    const jobsRes = await page.request.get(`${harness.cockpitUrl}/api/jobs`);
    const { jobs } = await jobsRes.json();
    const stillThere = (jobs as { id: string }[]).some((j) => j.id === victim.id);
    expect(stillThere, "delete_job succeeded from a scheduled job run").toBe(true);

    // Which layer stopped it, measured rather than assumed: the CLI only ever
    // saw add_inbox_message, so it rejected the call locally and the MCP
    // server's own refusal text never came back. That makes this a proof of the
    // tools/list filtering. handleToolCall's call-time refusal is the second
    // layer and cannot be reached through a CLI that was never offered the
    // tool, so it is covered directly in tests/cockpit-config-server.test.ts.
    const bodies = harness.mock
      .getRequests()
      .filter((r) => r.url.split("?")[0] === "/v1/messages")
      .map((r) => r.body)
      .join("\n");
    expect(bodies).toContain(INBOX_TOOL);
    // "is only available to" is handleToolCall's scope-refusal text (see
    // TOOL_SCOPES in cockpit-config-server.ts); its absence here proves the
    // call was never forwarded to the MCP server at all — tools/list already
    // hid delete_job, so the CLI refused locally.
    expect(bodies).not.toContain("is only available to");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
