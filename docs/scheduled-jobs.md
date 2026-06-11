# Scheduled jobs

Jobs run Claude Code on a schedule. Set a cron, write a prompt, and Cockpit fires the run unattended. Each run produces a transcript you can browse later.

## What jobs are for

Anything you want Claude to do on a recurring basis without starting a session manually:

- Daily PR triage
- Weekly dependency upgrades
- Hourly health checks against a service
- One-off tasks fired on demand

## Creating a job

The Jobs page lists your jobs. Add one with:

- Name. Used in the dashboard and run history.
- Working directory. Where Claude runs (defaults to your home).
- Schedule. Either **Simple** (hourly, daily, weekly, or monthly, at a chosen time and day) or a raw **Cron** expression. A single job can hold more than one schedule. Cockpit shows the next 3 fire times so you can sanity-check.
- Prompt. The instruction Claude runs on each fire.
- Model, context size, and thinking level. Same options as interactive sessions, including custom [providers](settings.md#providers).
- Runtime. Stream (headless, the default) or PTY, the same choice as interactive sessions.
- Run-time budget. The maximum minutes a run may take before it is stopped (default 30).
- Retention. How many days of run history and transcripts to keep (default 90).
- Skip if missed. If the server was down when a run was due, skip the late catch-up rather than firing on startup.
- Enabled. Toggle to pause the job without deleting it.

Save and the scheduler picks it up immediately.

## Scoping and permissions

Jobs run unattended, so each one is scoped tighter than an interactive session.

### Working directory

The cwd determines which project's `.claude/` config applies. Hooks, skills, agents, CLAUDE.md memory, and MCP servers are all picked up from the directory the job runs in. Two jobs in two directories see two different configurations, even on the same Claude account.

### Tool permissions

Each job has an explicit allowlist. Tools are listed by name, and Bash can be restricted to a leading command:

- `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Agent`, `WebFetch`, `WebSearch`. Whole-tool entries with no restriction.
- `Bash git`, `Bash npm`, `Bash ls`. Bash plus a leading-command restriction. Only invocations starting with the literal command (`git ...`, `npm ...`) match.

The Bash restriction rejects shell operators (`&&`, `||`, `|`, `;`, `>`, redirects). A `Bash git` rule cannot be bypassed with `git status && rm -rf /`.

Bypass all permissions disables the allowlist for the job. Use only for trusted internal automation.

### MCP server filters

Each job opts into specific MCP servers. Servers not enabled for a job are unavailable to that run.

For enabled servers you can also restrict which tools are callable:

- No filter. Every tool on the server is callable.
- Filter list. Only listed tools on that server are callable.
- `server:tool` syntax. For meta-tools that take server and tool arguments, scope by both.

## Running a job

Three ways:

1. Schedule. Fires automatically at the cron time.
2. Trigger. Run Now button on the job page. Same as a scheduled run, just immediate.
3. Duplicate. Copy an existing job to use as a template for a new one.

## Run history

Each run is recorded with start time, end time, duration, status (success, failure, in progress), cost, and a full transcript.

Click a run to open the transcript in the same chat view used for live sessions. Tool calls, diffs, plans, and todos render the same way.

## Failure handling

Failed runs (Claude errored, hit a permission denial, ran out of context) are flagged in the run list. Open the transcript to see what happened and adjust the prompt or schedule.

## Notifications

Job completions are sent to the inbox and, if configured, to external notification providers (Telegram, ntfy.sh). See [Settings](settings.md#notifications) for provider setup.

The inbox message includes the job name, run status, duration, and a link to the transcript.

## MCP discovery

The MCP discovery endpoint scans for MCP servers reachable from the job's working directory. Useful when you want a job to use project-specific MCP servers without hardcoding them in the job config.
