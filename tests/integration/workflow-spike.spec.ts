// Two facts the workflow engine rests on, proven before it is built.
//
// 1. An unattended run can reach the issue tools. A stage run works on an
//    issue through the cockpit MCP server, and a run's start turns off every
//    MCP server its job did not list, so the server has to survive that.
// 2. Several runs can work at once in separate worktrees of one repo. The
//    engine's whole point is more than one issue in flight.

import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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

type Page = import("@playwright/test").Page;

async function createJob(page: Page, cockpitUrl: string, body: Record<string, unknown>) {
  const res = await page.request.post(`${cockpitUrl}/api/jobs`, {
    data: { schedules: [{ type: "simple", frequency: "daily", time: "09:00" }], enabled: false, runtime: "pty", ...body },
  });
  expect(res.ok()).toBe(true);
  const { job } = await res.json();
  return job as { id: string; name: string };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Resident memory, in MB, of every process working inside `root`. */
function memoryUnder(root: string): { count: number; mb: number } {
  let count = 0;
  let kb = 0;
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      if (!readlinkSync(`/proc/${pid}/cwd`).startsWith(root)) continue;
      const rss = /^VmRSS:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/status`, "utf-8"));
      if (!rss) continue;
      count++;
      kb += Number(rss[1]);
    } catch {
      // Another user's process, or one that ended while being read.
    }
  }
  return { count, mb: Math.round(kb / 1024) };
}

test("an unattended run creates an issue through the cockpit tools", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-wf-tools-"));
  git(workDir, "init", "-q");
  harness.trustWorkDir(workDir);

  try {
    await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });
    const projectRes = await page.request.post(`${harness.cockpitUrl}/api/projects`, {
      data: { name: "Spike", prefix: "SPK", repoPath: workDir },
    });
    expect(projectRes.ok()).toBe(true);

    harness.mock.setScript([
      { events: toolUseResponse("mcp__cockpit-config__create_issue", { project: "SPK", title: "Made by a run" }) },
      { events: textResponse("Created.") },
    ]);

    const job = await createJob(page, harness.cockpitUrl, {
      name: "issue-tool-run",
      prompt: "Create the issue.",
      cwd: workDir,
      inboxOutput: true,
      bypassPermissions: true,
      // No servers of its own: everything the CLI reports at start is one the
      // run turns off, the cockpit server included if nothing spares it.
      mcpServers: [],
    });

    const trigger = await page.request.post(`${harness.cockpitUrl}/api/jobs/${job.id}/trigger`, { timeout: 120_000 });
    expect(trigger.ok()).toBe(true);
    const { run } = await trigger.json();
    expect(run.status, run.error).toBe("success");

    const issuesRes = await page.request.get(`${harness.cockpitUrl}/api/issues`);
    const body = await issuesRes.json();
    const issues = (body.issues ?? body) as { title: string; activity: { actor: { kind: string; jobId?: string } }[] }[];
    const made = issues.find((i) => i.title === "Made by a run");
    expect(made, `no issue created; got ${JSON.stringify(issues.map((i) => i.title))}`).toBeTruthy();
    // Attribution comes from the run's token, not from anything the model sent.
    expect(made?.activity[0].actor).toMatchObject({ kind: "job", jobId: job.id });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("three runs work at once in three worktrees of one repo", async ({ page, harness }) => {
  test.setTimeout(180_000);
  const root = mkdtempSync(path.join(tmpdir(), "cockpit-it-wf-parallel-"));
  const repo = path.join(root, "repo");
  const trees = ["A-1", "A-2", "A-3"].map((key) => path.join(root, `repo-${key}`));

  try {
    execFileSync("mkdir", ["-p", repo]);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "# spike\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.email=it@example.com", "-c", "user.name=it", "commit", "-q", "-m", "init");
    trees.forEach((tree, i) => {
      git(repo, "worktree", "add", "-q", tree, "-b", `issue/A-${i + 1}`);
      harness.trustWorkDir(tree);
    });

    // Every turn is held long enough that the three are in flight together.
    harness.mock.setScript([{ events: textResponse("Stage finished."), delayMs: 8000 }]);

    const jobs = await Promise.all(
      trees.map((tree, i) => createJob(page, harness.cockpitUrl, { name: `parallel-${i + 1}`, prompt: `Work in ${tree}.`, cwd: tree })),
    );

    const started = Date.now();
    const triggers = jobs.map((job) => page.request.post(`${harness.cockpitUrl}/api/jobs/${job.id}/trigger`, { timeout: 150_000 }));

    // Sample while they run: how many CLI processes, and what they cost.
    let peak = { count: 0, mb: 0 };
    const sampler = setInterval(() => {
      const now = memoryUnder(root);
      if (now.mb > peak.mb) peak = now;
    }, 500);
    const results = await Promise.all(triggers);
    clearInterval(sampler);

    const runs: { status: string; error?: string; startedAt: number; completedAt: number; cwd: string }[] = [];
    for (const res of results) {
      expect(res.ok()).toBe(true);
      runs.push((await res.json()).run);
    }
    for (const run of runs) expect(run.status, run.error).toBe("success");
    expect(new Set(runs.map((r) => r.cwd)).size).toBe(3);

    // All three were running at the same moment: the last to start began
    // before the first to finish ended.
    const lastStart = Math.max(...runs.map((r) => r.startedAt));
    const firstEnd = Math.min(...runs.map((r) => r.completedAt));
    expect(lastStart).toBeLessThan(firstEnd);

    // Each run's request named its own worktree, so no run was handed another's turn.
    const bodies = harness.mock
      .getRequests()
      .filter((r) => r.url.split("?")[0] === "/v1/messages")
      .map((r) => r.body);
    for (const tree of trees) expect(bodies.some((b) => b.includes(`Work in ${tree}.`))).toBe(true);

    console.log(
      `[workflow-spike] 3 parallel runs: ${Date.now() - started} ms wall, peak ${peak.mb} MB across ${peak.count} processes under the worktrees`,
    );
    expect(peak.count).toBeGreaterThanOrEqual(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
