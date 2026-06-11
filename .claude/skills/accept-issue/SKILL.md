---
description: Merge an accepted Linear issue and clean up its review surface. Picks up an issue in Accepted, confirms the PR is mergeable and its CI is green (bringing the branch up to date with next, and resolving conflicts, only when needed), merges it, kills the test server, removes the worktree, and moves the issue to Done. Also reaps the test servers and worktrees of issues that left Human Review without being accepted. Run as a scheduled job ("Run the accept-issue skill") or directly, e.g. "accept ALE-123".
---

# Accept and merge a Linear issue

The final pipeline stage. A human has verified the feature at its live test URL and moved the issue to `Accepted`. The code already passed CI when the PR was opened and was reviewed inline during implementation. This skill's job is small and should be fast: confirm the PR still merges cleanly with `next` and that CI is green on the current head, merge it, tear down the ephemeral review surface (test server + worktree), and close the issue out. It also reaps orphaned review surfaces left by rejected issues.

**Trust CI; do not re-run the suite locally.** GitHub runs typecheck, lint, test, secrets, and socket on the PR in a clean environment. Re-running `tsc`/`build`/`lint`/`vitest` here only duplicates that, runs against a possibly-stale review worktree, and trips over problems that are pre-existing on `next` rather than introduced by this issue. The only reason to touch the worktree is to bring the branch up to date with `next` or to resolve a conflict. After any such push, let CI re-validate the new head; do not verify it yourself.

## Input
Either an explicit issue ID, or none (the skill selects one).

- **An issue ID was given** (e.g. ALE-123): use it (still run the reaper first).
- **No ID, pipeline mode** (a scheduled job): run the reaper, then `list_issues` (server `Linear`) with `state: "Accepted"`. If none, stop after reaping. Otherwise pick exactly ONE, oldest by `updatedAt`, and process only that. A later run takes the next.
- **No ID, interactive mode** (a human ran the skill): run the reaper, then list `Accepted` and ask which to merge.

## Linear access
Linear is a downstream server behind conduit. Call tools with `mcp__conduit__call_tool`, server `Linear`. Run `describe_server` for `Linear` first if needed. Pass markdown with literal newlines.

## Step 0: Reap orphaned review surfaces
Run this every invocation, before anything else. It cleans up test servers and worktrees for issues that are no longer under review.

1. `git worktree prune` (drop pointers to worktrees whose directory is already gone), then `git worktree list`. For each worktree whose path matches `cockpit-<ISSUE-ID>` (a review worktree):
2. Fetch that issue's status from Linear (`get_issue`).
3. If the status is **neither `Human Review` nor `Accepted`** (e.g. it was rejected back to Implementation Ready, or is already Done), reap it:
   - Read `<worktree>/.review-server.json` for the `port`. Kill the server by port only: `lsof -ti:<port> | xargs -r kill`. **Never** kill by process name (`pkill -f "tsx server.ts"` would also kill the live :3001 instance).
   - Remove the throwaway config dir (`configDir` from the json) and the log file.
   - `git worktree remove --force <path>`.

The reaper is what cleans up rejected issues: when a human moves an issue from Human Review back to Implementation Ready, its server and worktree are no longer needed, and this removes them.

## Step 1: Select and load the issue
Per the Input rules, get one `Accepted` issue. `get_issue` for its PR link and `gitBranchName`. The worktree is at `../cockpit-<ISSUE-ID>`; read `<worktree>/.review-server.json` for its server `port` (needed at teardown). Note the PR number from the issue's links.

## Step 2: Check the PR state
The PR is the source of truth for what to do next. Query it once:

```
gh pr view <pr-number> --json state,mergeStateStatus,mergeable,statusCheckRollup,headRefName
```

- **`state` is `MERGED`**: a prior run, or a manual merge, already landed it. Do not merge again. Skip straight to teardown (Step 5), then close out (Step 6). This is the common cause of a slow run reprocessing already-done work, catch it here.
- **`state` is `CLOSED`** (not merged): anomalous for an Accepted issue. Do not merge. Move the issue to `Human Review` with a comment explaining the PR is closed, leave the review surface, and stop.
- **`state` is `OPEN`**: continue to Step 3.

## Step 3: Bring the branch up to date with next, only if needed
Read `mergeStateStatus` from Step 2 and act on it. Do NOT run any local build or test here.

- **`CLEAN`** (mergeable, up to date with the base): nothing to do. Go to Step 4.
- **`BEHIND`** (`next` advanced, no conflicts): update the branch so CI validates the real merge result. In the worktree (assert it is sound first, see below): `git -C <wt> fetch origin`, `git -C <wt> merge origin/next`, `git -C <wt> push`.
- **`DIRTY`** (conflicts): resolve them in the worktree (assert sound first): `git -C <wt> merge origin/next`, resolve honoring the intent of both sides (the feature's change and whatever landed on next), `git -C <wt> push`. If the conflicts cannot be resolved sensibly, stop: move the issue to `Human Review` (Started-type id, resolved by name+type), comment what conflicts and what is needed, leave the worktree and server. Do not force a merge.
- **`UNKNOWN`/`BLOCKED`**: GitHub may still be computing mergeability, or a required check/review is missing. Re-query once after a short `curl`-poll; if still not actionable, move to `Human Review` with a comment and stop.

**Assert the worktree is sound before any `git -C <wt>` command.** A review worktree can go stale or prunable, losing its `.git` pointer or its source files (only `.next`/`node_modules` left). If you then run tooling in it, npm and Next walk **up** to the main repo and you silently operate on the wrong tree. Guard against it: `git -C <wt> rev-parse --show-toplevel` must print the worktree path, and a known source file (e.g. `<wt>/package.json`, `<wt>/server.ts`) must exist. If not, `git worktree prune` and recreate it: `git worktree add <wt> <branch>` from `origin`. If it still cannot be made sound, bail: move to `Human Review` with a comment, leave the surface, stop.

## Step 4: Wait for CI to pass, then merge
CI is the gate. If Step 3 pushed an update, CI re-runs on the new head; make sure you watch the run for *that* commit, not a stale green result. Get the head SHA (`git -C <wt> rev-parse HEAD`, or `gh pr view <pr> --json headRefOid`) and, if you just pushed, confirm a check run exists for it (`gh run list --branch <branch> --limit 1 --json headSha,status` shows that SHA) before trusting the watch. Then:

```
gh pr checks <pr-number> --watch --fail-fast --interval 30
```

- **Green** (exit 0): merge. `gh pr merge <pr-number> --squash --delete-branch`. Base is `next`; squash keeps history clean and matches the repo's conventional-commit style.
- **Red** (non-zero exit) **or CI never completes**: do not merge. Move the issue to `Human Review` (Started-type id by name+type), comment the failing check name(s) with the run URL, and leave the worktree and server for the human. Stop. Do not re-run the suite locally to second-guess CI; CI is authoritative.

If the branch was already `CLEAN` with all checks `SUCCESS`, the watch returns immediately and you merge straight away. That is the fast happy path, and it never touches the worktree.

## Step 5: Tear down the review surface
- Kill the test server by port: `lsof -ti:<port> | xargs -r kill`. By port only, never by process name.
- Remove the throwaway config dir and log file.
- `git worktree remove --force ../cockpit-<ISSUE-ID>`, then `git worktree prune` (the remote branch is already deleted by the squash-merge; the work is on `next`).

## Step 6: Close out
Move the issue to `Done` via `save_issue` (id + state; `Done` is unique, set by name). Post a brief comment: merged to `next`, PR link, review surface cleaned up.

## Rules
- Reap every run, before selecting work. This is how rejected issues get cleaned up. `git worktree prune` first so stale pointers do not confuse the listing.
- Trust CI. Never run `tsc`/`build`/`lint`/`vitest` locally here, and never build or test `next` to "compare". The PR's GitHub checks are the merge gate; watch them with `gh pr checks --watch`.
- Touch the worktree only to bring the branch up to date with `next` or to resolve a conflict. After any push, let CI re-validate; do not verify locally.
- Always use `git -C <worktree>` and absolute paths. Never `cd` into the worktree: the shell cwd does not persist between Bash calls and silently resets to the repo root, so a `cd`-then-run sequence ends up running against the main repo, not the worktree.
- Before any worktree work, assert the worktree is sound (`rev-parse --show-toplevel` equals its path, a known source file present). If prunable or broken, prune and recreate from `origin/<branch>`, or bail to Human Review. Never let npm or Next walk up to the main repo.
- If the PR is already `MERGED`, go straight to teardown. If it is `CLOSED`-unmerged, or CI is red, or a conflict is unresolvable, or the worktree cannot be made sound: route to `Human Review` with a comment and leave the surface. Do not force.
- Kill servers by **port**, never by process name. The live instance on 3001 must never be touched.
- One issue merged per invocation. No loop. The schedule drives throughput.
- Reject path is not this skill's job: a human moves a rejected issue back to Implementation Ready; the reaper here cleans up its leftover server/worktree on the next run.
