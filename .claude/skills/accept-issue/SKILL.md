---
description: Merge an accepted cockpit issue and clean up its review surface. Picks up an issue in Accepted, confirms the PR is mergeable and its CI is green (bringing the branch up to date with next, and resolving conflicts, only when needed), merges it, kills the test server, removes the worktree, and moves the issue to Done. Also reaps the test servers and worktrees of issues that left Code Review without being accepted. Run as a scheduled job ("Run the accept-issue skill") or directly, e.g. "accept CK-12".
---

# Accept and merge a cockpit issue

The final pipeline stage. A human has verified the feature at its live test URL and moved the issue to `Accepted`. The code already passed CI when the PR was opened and was reviewed inline during implementation. This skill's job is small and should be fast: confirm the PR still merges cleanly with `next` and that CI is green on the current head, merge it, tear down the ephemeral review surface (test server + worktree), and close the issue out. It also reaps orphaned review surfaces left by rejected issues.

**Trust CI; do not re-run the suite locally.** GitHub runs typecheck, lint, test, secrets, and socket on the PR in a clean environment. Re-running `tsc`/`build`/`lint`/`vitest` here only duplicates that, runs against a possibly-stale review worktree, and trips over problems that are pre-existing on `next` rather than introduced by this issue. The only reason to touch the worktree is to bring the branch up to date with `next` or to resolve a conflict. After any such push, let CI re-validate the new head; do not verify it yourself.

## Input
Either an explicit issue key, or none (the skill selects one).

- **An issue key was given** (e.g. CK-12): use it (still run the reaper first).
- **No key, pipeline mode** (a scheduled job): run the reaper, then `mcp__cockpit-config__list_issues` with `status: "Accepted"`. If none, stop after reaping. Otherwise pick exactly ONE, oldest by `updatedAt`, and process only that. A later run takes the next.
- **No key, interactive mode** (a human ran the skill): run the reaper, then list `Accepted` and ask which to merge.

## Run by a workflow
When the prompt opens with "You are the agent for the ... status of a workflow on issue <KEY>" (or says the issue "has come back to" a status), a Cockpit workflow started this session for that one issue and told it to run this skill. This is pipeline mode, with these differences, and where they conflict with a step below they win:

- **The issue is the one the prompt names.** Do not list issues, pick one, or look at any other.
- **Cockpit has already moved it to the status you work in.** Skip any step that sets a status to say work has started.
- **Your work ends when you move the issue** with `update_issue` to one of the statuses the prompt lists, and those are the only statuses you can move it to. The prompt lists the statuses and nothing more: which one fits which outcome is said below. Make it your last action.
- **If you cannot do the work**, comment why on the issue, leave its status alone, and end with the `cockpit-error` block the prompt describes. Cockpit holds the issue for a person.
- **The working directory may be the issue's own worktree.** When the prompt says so, Cockpit has already made the worktree and its `issue/<KEY>` branch, and every agent that works on the issue works in it. Use the working directory as the worktree: do not create, replace or remove a worktree or branch for the issue, and do not `cd` out of it to the main checkout. Cockpit removes it when the issue is finished.
- **A port is kept for the run** in `$COCKPIT_RUN_PORT`, and named in the prompt. If you start a server, start it on that port and do not scan for another.

For this skill that means: skip Step 0 (Cockpit removes the worktrees of finished issues itself), and in Step 5 kill the review server but leave the worktree where it is when it is the working directory. Merge the issue the prompt names and move it to `Done` in Step 6. A pull request that could not be merged goes back to `Code Review`, as the steps below say, with a comment saying why. If the prompt lists other names, choose by what they mean.

## Step 0: Reap orphaned review surfaces
Run this every invocation, before anything else. It cleans up test servers and worktrees for issues whose work is finished or abandoned.

Do this once per repo in scope: `list_projects`, and for each project's `repoPath` (falling back to the session's current working directory for a project without one — today's behaviour, and the only case while cockpit is the sole project), call that resolved path `<REPO>`:

1. `git -C <REPO> worktree prune` (drop pointers to worktrees whose directory is already gone), then `git -C <REPO> worktree list`. For each worktree whose path matches `<name>-<ISSUE-ID>` (a review worktree — `<name>` is `<REPO>`'s basename, `<ISSUE-ID>` looks like a project prefix and number, e.g. `CK-12`):
2. Fetch that issue's status (`get_issue`).
3. Reap it **only if the issue is finished or abandoned: its status is `Done`, `Cancelled` or `Backlog`, or the issue no longer exists.** Leave every other status alone. An issue that is `Implementation Ready`, `Implementation`, `Validation`, `Code Review` or `Accepted` still has work in its worktree or is about to: with several issues in flight at once, another session may be building in that worktree right now, and removing it destroys that work. To reap:
   - Read `<worktree>/.review-server.json` for the `port`. Kill the server by port only: `lsof -ti:<port> | xargs -r kill`. **Never** kill by process name (`pkill -f "tsx server.ts"` would also kill the live :3001 instance).
   - Remove the throwaway config dir (`configDir` from the json) and the log file.
   - `git -C <REPO> worktree remove --force <path>`.

An issue sent back from review keeps its worktree and server: the rework pass restores the same branch and replaces the worktree itself (implement-issue step 4). The reaper only removes what nothing will come back to.

## Step 1: Select and load the issue
Per the Input rules, get one `Accepted` issue (`get_issue`). Resolve its repo the same way as Step 0 (`list_projects` + `repoPath`, else cwd) — call it `<REPO>` — and the branch: `issue/<ISSUE-ID>`. The worktree is at `<REPO>/../<name>-<ISSUE-ID>`; read `<worktree>/.review-server.json` for its server `port` (needed at teardown). Find the PR: `gh pr list --head issue/<ISSUE-ID> --json number,url`.

## Step 2: Check the PR state
The PR is the source of truth for what to do next. Query it once:

```
gh pr view <pr-number> --json state,mergeStateStatus,mergeable,statusCheckRollup,headRefName
```

- **`state` is `MERGED`**: a prior run, or a manual merge, already landed it. Do not merge again. Skip straight to teardown (Step 5), then close out (Step 6). This is the common cause of a slow run reprocessing already-done work, catch it here.
- **`state` is `CLOSED`** (not merged): anomalous for an Accepted issue. Do not merge. Move the issue to `Code Review` with a comment explaining the PR is closed, leave the review surface, and stop.
- **`state` is `OPEN`**: continue to Step 3.

## Step 3: Bring the branch up to date with next, only if needed
Read `mergeStateStatus` from Step 2 and act on it. Do NOT run any local build or test here.

- **`CLEAN`** (mergeable, up to date with the base): nothing to do. Go to Step 4.
- **`BEHIND`** (`next` advanced, no conflicts): update the branch so CI validates the real merge result. In the worktree (assert it is sound first, see below): `git -C <wt> fetch origin`, `git -C <wt> merge origin/next`, `git -C <wt> push`.
- **`DIRTY`** (conflicts): resolve them in the worktree (assert sound first): `git -C <wt> merge origin/next`, resolve honoring the intent of both sides (the feature's change and whatever landed on next), `git -C <wt> push`. If the conflicts cannot be resolved sensibly, stop: move the issue to `Code Review`, comment what conflicts and what is needed, leave the worktree and server. Do not force a merge.
- **`UNKNOWN`/`BLOCKED`**: GitHub may still be computing mergeability, or a required check/review is missing. Re-query once after a short `curl`-poll; if still not actionable, move to `Code Review` with a comment and stop.

**Assert the worktree is sound before any `git -C <wt>` command.** A review worktree can go stale or prunable, losing its `.git` pointer or its source files (only `.next`/`node_modules` left). If you then run tooling in it, npm and Next walk **up** to `<REPO>` and you silently operate on the wrong tree. Guard against it: `git -C <wt> rev-parse --show-toplevel` must print the worktree path, and a known source file (e.g. `<wt>/package.json`, `<wt>/server.ts`) must exist. If not, `git worktree prune` and recreate it: `git -C <REPO> worktree add <wt> issue/<ISSUE-ID> origin/issue/<ISSUE-ID>`. If it still cannot be made sound, bail: move to `Code Review` with a comment, leave the surface, stop.

## Step 4: Wait for CI to pass, then merge
CI is the gate. If Step 3 pushed an update, CI re-runs on the new head; make sure you watch the run for *that* commit, not a stale green result. Get the head SHA (`git -C <wt> rev-parse HEAD`, or `gh pr view <pr> --json headRefOid`) and, if you just pushed, confirm a check run exists for it (`gh run list --branch <branch> --limit 1 --json headSha,status` shows that SHA) before trusting the watch. Then:

```
gh pr checks <pr-number> --watch --fail-fast --interval 30
```

- **Green** (exit 0): merge. `gh pr merge <pr-number> --squash --delete-branch`. Base is `next`; squash keeps history clean and matches the repo's conventional-commit style.
- **Red** (non-zero exit) **or CI never completes**: do not merge. Move the issue to `Code Review`, comment the failing check name(s) with the run URL, and leave the worktree and server for the human. Stop. Do not re-run the suite locally to second-guess CI; CI is authoritative.

If the branch was already `CLEAN` with all checks `SUCCESS`, the watch returns immediately and you merge straight away. That is the fast happy path, and it never touches the worktree.

## Step 5: Tear down the review surface
- Kill the test server by port: `lsof -ti:<port> | xargs -r kill`. By port only, never by process name.
- Remove the throwaway config dir and log file.
- `git -C <REPO> worktree remove --force ../<name>-<ISSUE-ID>`, then `git -C <REPO> worktree prune` (the remote branch is already deleted by the squash-merge; the work is on `next`).

## Step 6: Close out
Move the issue to `Done` via `update_issue` (key + status; `Done` is unique, set by name). Post a brief comment: merged to `next`, PR link, review surface cleaned up.

## Rules
- Reap every run, before selecting work. This is how rejected issues get cleaned up. `git worktree prune` first so stale pointers do not confuse the listing.
- Trust CI. Never run `tsc`/`build`/`lint`/`vitest` locally here, and never build or test `next` to "compare". The PR's GitHub checks are the merge gate; watch them with `gh pr checks --watch`.
- Touch the worktree only to bring the branch up to date with `next` or to resolve a conflict. After any push, let CI re-validate; do not verify locally.
- Always use `git -C <worktree>` and absolute paths. Never `cd` into the worktree: the shell cwd does not persist between Bash calls and silently resets between calls, so a `cd`-then-run sequence ends up running somewhere other than the worktree.
- Before any worktree work, assert the worktree is sound (`rev-parse --show-toplevel` equals its path, a known source file present). If prunable or broken, prune and recreate from `origin/issue/<ISSUE-ID>`, or bail to Code Review. Never let npm or Next walk up to `<REPO>`.
- If the PR is already `MERGED`, go straight to teardown. If it is `CLOSED`-unmerged, or CI is red, or a conflict is unresolvable, or the worktree cannot be made sound: route to `Code Review` with a comment and leave the surface. Do not force.
- Kill servers by **port**, never by process name. The live instance on 3001 must never be touched.
- One issue merged per invocation. No loop. The schedule drives throughput.
- Reject path is not this skill's job: a human moves a rejected issue back to Implementation Ready; the reaper here cleans up its leftover server/worktree on the next run.
