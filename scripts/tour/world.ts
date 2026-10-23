// The tour's work in progress: projects and issues across the board, a set of
// scheduled jobs with a few weeks of run history, and the inbox those runs
// filled. All of it made up, timed relative to the moment the tour starts.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ScheduledJob } from "../../src/types";
import type { TourDirs } from "./cockpit";
import { DEEPSEEK_PRO, REPOS, repoPath } from "./seed";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function json(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A small deterministic generator, so every recording has the same data. */
export function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Issues ──────────────────────────────────────────────────────────────────

type Actor = { kind: "user" } | { kind: "assistant" } | { kind: "job"; jobId: string; jobName: string; runId: string };

interface IssueSpec {
  title: string;
  status: string;
  priority?: 0 | 1 | 2 | 3 | 4;
  labels?: string[];
  description: string;
  ageDays: number;
  comments?: Array<{ by: Actor; body: string; agoHours: number }>;
}

export const PROJECTS = [
  { id: "acme-storefront", name: "Acme Storefront", prefix: "SHOP", repo: REPOS.storefront, description: "Catalogue, cart and checkout." },
  { id: "acme-api", name: "Acme API", prefix: "API", repo: REPOS.api, description: "Orders, payments and webhooks." },
];

export const JOB_IDS = {
  triage: "job-pr-triage",
  audit: "job-dependency-audit",
  refiner: "job-issue-refiner",
  changelog: "job-weekly-changelog",
  metrics: "job-usage-metrics",
  digest: "job-morning-digest",
};

const refiner = (runId: string): Actor => ({ kind: "job", jobId: JOB_IDS.refiner, jobName: "Issue refiner", runId });

const SHOP: IssueSpec[] = [
  {
    title: "Discount codes: percentage and fixed amount",
    status: "Done",
    priority: 2,
    labels: ["checkout"],
    ageDays: 19,
    description: "Customers can enter a code at checkout for a percentage or a fixed amount off.",
  },
  {
    title: "Accessibility pass on the checkout form",
    status: "Done",
    priority: 2,
    labels: ["a11y", "checkout"],
    ageDays: 16,
    description: "Labels, focus order and error announcements on every checkout field.",
  },
  {
    title: "Order history pagination",
    status: "Code Review",
    priority: 3,
    labels: ["account"],
    ageDays: 9,
    description: "Account → Orders loads every order at once. Page it, 20 at a time, newest first.",
  },
  {
    title: "Move product search to the edge cache",
    status: "Plan Review",
    priority: 2,
    labels: ["performance"],
    ageDays: 7,
    description:
      "Search results take 600 ms at p95. Cache them at the edge, keyed by query and locale.\n\n## Plan\n\n1. Normalise the query (case, whitespace, locale) into a cache key.\n2. Serve from the edge cache for 60 s, revalidating in the background.\n3. Purge on catalogue publish.\n\n## Acceptance criteria\n\n- p95 under 150 ms for cached queries\n- A catalogue publish is visible within a minute",
    comments: [
      {
        by: refiner("run-refine-3"),
        agoHours: 30,
        body: "Refined: added a plan and acceptance criteria. The purge on publish needs the catalogue service to emit an event, which it already does for the sitemap.",
      },
    ],
  },
  {
    title: "Rate-limit the checkout endpoint",
    status: "Implementation",
    priority: 1,
    labels: ["security", "checkout"],
    ageDays: 2,
    description:
      "Card-testing bots are hitting `POST /checkout` hundreds of times a minute.\n\n## Acceptance criteria\n\n- At most 10 checkout attempts a minute per customer\n- The 11th answers **429** with a `Retry-After` header\n- One customer being limited never affects another\n- Covered by a test",
    comments: [
      {
        by: refiner("run-refine-7"),
        agoHours: 40,
        body: "Refined from the incident notes. Limiting per customer rather than per IP, since the bots rotate addresses but reuse accounts.",
      },
      { by: { kind: "user" }, agoHours: 26, body: "Agreed. Let's keep it in memory for now; Redis can come later." },
    ],
  },
  {
    title: "Upgrade to React 20",
    status: "Implementation Ready",
    priority: 3,
    labels: ["dependencies"],
    ageDays: 5,
    description: "React 20 is out. Upgrade, fix the two deprecated lifecycle warnings in the cart, run the e2e suite.",
  },
  {
    title: "Apple Pay on the payment step",
    status: "Refine Ready",
    priority: 2,
    labels: ["payments"],
    ageDays: 3,
    description: "Offer Apple Pay where the browser supports it, alongside cards.",
  },
  {
    title: "Show delivery estimates on the product page",
    status: "Needs Detail",
    priority: 3,
    labels: ["catalogue"],
    ageDays: 4,
    description: 'Something like "Arrives Thursday". Which carrier data do we trust?',
  },
  {
    title: "Cart badge doesn't update after removing the last item",
    status: "Backlog",
    priority: 2,
    labels: ["bug", "cart"],
    ageDays: 1,
    description: "Remove the only item in the cart: the header badge still says 1 until a reload.",
  },
  {
    title: "Wishlist sync across devices",
    status: "Backlog",
    priority: 4,
    labels: ["account"],
    ageDays: 6,
    description: "Wishlists live in local storage. Store them on the account.",
  },
];

const API: IssueSpec[] = [
  {
    title: "Paginate GET /orders",
    status: "Done",
    priority: 2,
    labels: ["api"],
    ageDays: 14,
    description: "Cursor pagination, 50 per page.",
  },
  {
    title: "Stripe webhook marks some orders paid twice",
    status: "Implementation",
    priority: 1,
    labels: ["bug", "payments"],
    ageDays: 1,
    description: "Stripe retries deliveries. Make the handler idempotent on the event id.",
  },
  {
    title: "Idempotency keys for refunds",
    status: "Refine Ready",
    priority: 2,
    labels: ["payments"],
    ageDays: 3,
    description: "A retried refund request must not refund twice.",
  },
  {
    title: "Rotate webhook signing secrets",
    status: "Backlog",
    priority: 3,
    labels: ["security"],
    ageDays: 8,
    description: "Support two secrets during a rotation window.",
  },
];

function buildIssues(projectId: string, prefix: string, specs: IssueSpec[], now: number) {
  return specs.map((spec, i) => {
    const created = now - spec.ageDays * DAY - i * 37 * MIN;
    const comments = (spec.comments ?? []).map((c) => ({
      id: randomUUID(),
      body: c.body,
      author: c.by,
      createdAt: now - c.agoHours * HOUR,
    }));
    return {
      id: randomUUID(),
      key: `${prefix}-${8 + i}`,
      projectId,
      title: spec.title,
      description: spec.description,
      status: spec.status,
      priority: spec.priority,
      labels: spec.labels ?? [],
      createdAt: created,
      updatedAt: Math.max(created, ...comments.map((c) => c.createdAt)),
      comments,
      attachments: [],
      activity: [
        { id: randomUUID(), createdAt: created, actor: { kind: "user" }, kind: "created" },
        ...comments.map((c) => ({ id: randomUUID(), createdAt: c.createdAt, actor: c.author, kind: "commented" })),
      ],
    };
  });
}

export function seedIssues(dirs: TourDirs, now: number): void {
  json(path.join(dirs.config, "projects.json"), {
    projects: PROJECTS.map((p, i) => ({
      id: p.id,
      name: p.name,
      prefix: p.prefix,
      description: p.description,
      repoPath: repoPath(dirs, p.repo),
      createdAt: now - (30 - i) * DAY,
      updatedAt: now - (30 - i) * DAY,
      nextNumber: 8 + (i === 0 ? SHOP.length : API.length),
    })),
  });
  json(path.join(dirs.config, "issues", "acme-storefront.json"), { issues: buildIssues("acme-storefront", "SHOP", SHOP, now) });
  json(path.join(dirs.config, "issues", "acme-api.json"), { issues: buildIssues("acme-api", "API", API, now) });
}

// ── Jobs, runs and the inbox ────────────────────────────────────────────────

export function jobs(dirs: TourDirs, now: number): ScheduledJob[] {
  const storefront = repoPath(dirs, REPOS.storefront);
  const api = repoPath(dirs, REPOS.api);
  const base = (
    id: string,
    name: string,
    cwd: string,
    extra: Pick<ScheduledJob, "schedules" | "prompt"> & Partial<ScheduledJob>,
  ): ScheduledJob => ({
    id,
    name,
    cwd,
    enabled: true,
    createdAt: now - 25 * DAY,
    updatedAt: now - 25 * DAY,
    bypassPermissions: false,
    maxDurationMinutes: 30,
    retentionDays: 90,
    inboxOutput: true,
    runtime: "pty",
    skipIfMissed: true,
    ...extra,
  });
  return [
    base(JOB_IDS.triage, "Morning PR triage", storefront, {
      schedules: [{ type: "cron", expression: "30 8 * * 1-5" }],
      model: "claude-sonnet-5-5",
      prompt:
        "Review the open pull requests in acme-storefront and acme-api. For each, summarise the change, flag risky diffs, and list what needs a human.",
      allowedTools: ["Read", "Grep", "Bash gh pr", "Bash git log"],
    }),
    base(JOB_IDS.audit, "Nightly dependency audit", api, {
      schedules: [{ type: "simple", frequency: "daily", time: "02:00" }],
      model: `deepseek:${DEEPSEEK_PRO}`,
      prompt: "Run npm audit and npm outdated in each repo. Open an issue for anything high severity.",
      allowedTools: ["Bash npm audit", "Bash npm outdated", "mcp__cockpit-config__create_issue"],
    }),
    base(JOB_IDS.refiner, "Issue refiner", storefront, {
      schedules: [{ type: "onIssueStatus", status: "Refine Ready", project: "acme-storefront" }],
      model: "claude-opus-5-5",
      thinkingLevel: "high",
      prompt: "Refine the issue: write acceptance criteria and a plan, then move it to Plan Review.",
      inboxOutput: false,
    }),
    base(JOB_IDS.metrics, "Collect usage metrics", api, {
      schedules: [{ type: "simple", frequency: "daily", time: "06:00" }],
      model: "zen-go:glm-5.3",
      prompt: "Pull yesterday's checkout and API metrics into metrics/daily.md.",
      inboxOutput: false,
    }),
    base(JOB_IDS.digest, "Morning digest", storefront, {
      schedules: [{ type: "afterJobs", jobIds: [JOB_IDS.triage, JOB_IDS.metrics] }],
      model: "claude-sonnet-5-5",
      prompt: "Fold the PR triage and yesterday's metrics into a short morning digest.",
    }),
    base(JOB_IDS.changelog, "Weekly changelog", storefront, {
      schedules: [{ type: "simple", frequency: "weekly", dayOfWeek: 5, time: "16:00" }],
      model: "claude-sonnet-5-5",
      prompt: "Draft release notes from the pull requests merged this week.",
    }),
  ];
}

interface RunSpec {
  jobId: string;
  name: string;
  at: number;
  ms: number;
  status: "success" | "failure" | "timeout";
  error?: string;
}

/** When each job ran over the last few weeks. */
function runSchedule(now: number): RunSpec[] {
  const rand = random(7);
  const runs: RunSpec[] = [];
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  for (let d = 21; d >= 0; d--) {
    const day = today.getTime() - d * DAY;
    const weekday = new Date(day).getDay();
    const at = (h: number, m: number) => day + h * HOUR + m * MIN;
    if (at(2, 0) < now) {
      const failed = d === 4;
      runs.push({
        jobId: JOB_IDS.audit,
        name: "Nightly dependency audit",
        at: at(2, 0),
        ms: (2 + rand() * 3) * MIN,
        status: failed ? "failure" : "success",
        ...(failed ? { error: "npm audit could not reach the registry (ETIMEDOUT)" } : {}),
      });
    }
    if (at(6, 0) < now)
      runs.push({ jobId: JOB_IDS.metrics, name: "Collect usage metrics", at: at(6, 0), ms: (1 + rand()) * MIN, status: "success" });
    if (weekday >= 1 && weekday <= 5 && at(8, 30) < now) {
      const ms = (3 + rand() * 4) * MIN;
      runs.push({ jobId: JOB_IDS.triage, name: "Morning PR triage", at: at(8, 30), ms, status: "success" });
      runs.push({ jobId: JOB_IDS.digest, name: "Morning digest", at: at(8, 30) + ms + 20_000, ms: (1 + rand()) * MIN, status: "success" });
    }
    if (weekday === 5 && at(16, 0) < now) {
      const timedOut = d > 6 && d < 13;
      runs.push({
        jobId: JOB_IDS.changelog,
        name: "Weekly changelog",
        at: at(16, 0),
        ms: timedOut ? 30 * MIN : (6 + rand() * 4) * MIN,
        status: timedOut ? "timeout" : "success",
        ...(timedOut ? { error: "Stopped after 30 minutes" } : {}),
      });
    }
    if (d % 3 === 1)
      runs.push({ jobId: JOB_IDS.refiner, name: "Issue refiner", at: at(14, 10), ms: (4 + rand() * 3) * MIN, status: "success" });
  }
  return runs;
}

/** Which audit run found something: the most recent full night's. */
let AUDIT_WARNING_RUN = -1;

const INBOX_BODIES: Record<string, (i: number) => { title: string; body: string; priority?: "info" | "warning" | "error" }> = {
  [JOB_IDS.triage]: (i) => ({
    title: "Morning PR triage",
    body: [
      `**${3 - (i % 2)} pull requests need you**`,
      "",
      "- **#482 Rate-limit checkout** · small, tests added. Ready to merge.",
      "- **#479 Apple Pay** · touches the payment step. Needs a human review.",
      "- **#477 Bump next to 16.4.2** · security release, CI green. Merge first.",
      "",
      "Two more are drafts and were skipped.",
    ].join("\n"),
  }),
  [JOB_IDS.digest]: () => ({
    title: "Morning digest",
    body: [
      "**Yesterday**",
      "",
      "- 1,284 orders, conversion 3.1% (+0.2)",
      "- Checkout p95 412 ms, API error rate 0.04%",
      "- 4 PRs merged, 3 waiting on review",
      "",
      "Nothing needs you before 10.",
    ].join("\n"),
  }),
  [JOB_IDS.audit]: (i) =>
    i === AUDIT_WARNING_RUN
      ? {
          title: "Nightly dependency audit",
          priority: "warning",
          body: "**1 high-severity advisory** in acme-api: `ip-address` 10.7.3 (GHSA-rxp7-6hxx-x8q5).\n\nOpened **API-12** with the fix: bump to 10.7.4, lockfile only.",
        }
      : { title: "Nightly dependency audit", body: "No new advisories. 3 packages a minor version behind; nothing urgent." },
  [JOB_IDS.changelog]: () => ({
    title: "Weekly changelog",
    body: "Drafted release notes for **v2.4.0**: discount codes, an accessible checkout form and faster order history. Saved to `CHANGELOG.md` on a branch.",
  }),
};

export interface SeededRun {
  jobId: string;
  sessionId: string;
  startedAt: number;
  durationMs: number;
  model: string;
  prompt: string;
}

export function seedJobs(dirs: TourDirs, now: number): SeededRun[] {
  const seeded: SeededRun[] = [];
  const list = jobs(dirs, now);
  json(path.join(dirs.config, "scheduled-jobs.json"), { jobs: list });
  const byJob = new Map<string, unknown[]>();
  const inbox: unknown[] = [];
  const counts = new Map<string, number>();
  const schedule = runSchedule(now);
  AUDIT_WARNING_RUN = schedule.filter((r) => r.jobId === JOB_IDS.audit).length - 1;
  for (const run of schedule) {
    const job = list.find((j) => j.id === run.jobId);
    if (!job) continue;
    const id = randomUUID();
    const sessionId = randomUUID();
    const n = (counts.get(run.jobId) ?? 0) + 1;
    counts.set(run.jobId, n);
    seeded.push({ jobId: run.jobId, sessionId, startedAt: run.at, durationMs: run.ms, model: String(job.model), prompt: job.prompt });
    byJob.set(run.jobId, [
      ...(byJob.get(run.jobId) ?? []),
      {
        id,
        jobId: run.jobId,
        sessionId,
        status: run.status,
        startedAt: run.at,
        completedAt: run.at + run.ms,
        durationMs: Math.round(run.ms),
        ...(run.error ? { error: run.error } : {}),
        toolsUsed: [],
        messageCount: 4 + (n % 5),
        prompt: job.prompt,
        cwd: job.cwd,
      },
    ]);
    const make = INBOX_BODIES[run.jobId];
    if (now - run.at > 7 * DAY) continue;
    if (run.status !== "success") {
      inbox.push({
        id: randomUUID(),
        jobId: run.jobId,
        jobName: run.name,
        runId: id,
        title: `Job failed: ${run.name}`,
        body: `**Status:** ${run.status}\n\n${run.error ?? ""}`,
        priority: "error",
        createdAt: run.at + run.ms,
        read: now - run.at > 2 * DAY,
      });
    } else if (make && job.inboxOutput) {
      const m = make(n);
      inbox.push({
        id: randomUUID(),
        jobId: run.jobId,
        jobName: run.name,
        runId: id,
        title: m.title,
        body: m.body,
        priority: m.priority ?? "info",
        createdAt: run.at + run.ms,
        read: now - run.at > 20 * HOUR,
      });
    }
  }
  for (const [jobId, runs] of byJob) json(path.join(dirs.config, "job-runs", `${jobId}.json`), { runs });
  inbox.sort((a, b) => (a as { createdAt: number }).createdAt - (b as { createdAt: number }).createdAt);
  mkdirSync(dirs.config, { recursive: true });
  writeFileSync(path.join(dirs.config, "inbox.jsonl"), `${inbox.map((m) => JSON.stringify(m)).join("\n")}\n`);
  return seeded;
}
