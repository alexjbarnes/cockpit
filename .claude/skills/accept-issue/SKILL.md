---
description: Merge an accepted Linear issue and clean up its review surface. Picks up an issue in Accepted, brings its PR up to date with next (resolving conflicts), merges it, kills the test server, removes the worktree, and moves the issue to Done. Also reaps the test servers and worktrees of issues that left Human Review without being accepted. Run as a scheduled job ("Run the accept-issue skill") or directly, e.g. "accept ALE-123".
---

# Accept and merge a Linear issue

The final pipeline stage. A human has verified the feature at its live test URL and moved the issue to `Accepted`. This skill merges the PR into `next`, tears down the ephemeral review surface (test server + worktree), and closes the issue out. It also reaps orphaned review surfaces left by rejected issues.

## Input
Either an explicit issue ID, or none (the skill selects one).

- **An issue ID was given** (e.g. ALE-123): use it (still run the reaper first).
- **No ID, pipeline mode** (a scheduled job): run the reaper, then `list_issues` (server `Linear`) with `state: "Accepted"`. If none, stop after reaping. Otherwise pick exactly ONE, oldest by `updatedAt`, and process only that. A later run takes the next.
- **No ID, interactive mode** (a human ran the skill): run the reaper, then list `Accepted` and ask which to merge.

## Linear access
Linear is a downstream server behind conduit. Call tools with `mcp__conduit__call_tool`, server `Linear`. Run `describe_server` for `Linear` first if needed. Pass markdown with literal newlines.

## Step 0: Reap orphaned review surfaces
Run this every invocation, before anything else. It cleans up test servers and worktrees for issues that are no longer under review.

1. `git worktree list`. For each worktree whose path matches `cockpit-<ISSUE-ID>` (a review worktree):
2. Fetch that issue's status from Linear (`get_issue`).
3. If the status is **neither `Human Review` nor `Accepted`** (e.g. it was rejected back to Implementation Ready, or is already Done), reap it:
   - Read `<worktree>/.review-server.json` for the `port`. Kill the server by port only: `lsof -ti:<port> | xargs -r kill`. **Never** kill by process name (`pkill -f "tsx server.ts"` would also kill the live :3001 instance).
   - Remove the throwaway config dir (`configDir` from the json) and the log file.
   - `git worktree remove --force <path>`.

The reaper is what cleans up rejected issues: when a human moves an issue from Human Review back to Implementation Ready, its server and worktree are no longer needed, and this removes them.

## Step 1: Select and load the issue
Per the Input rules, get one `Accepted` issue. `get_issue` for its PR link and `gitBranchName`; the worktree is at `../cockpit-<ISSUE-ID>`. Read `<worktree>/.review-server.json` for its server port.

## Step 2: Bring the branch up to date with next, resolving conflicts
`next` has likely advanced since the branch was cut. Work in the issue's existing worktree:

1. `git fetch origin`.
2. `git merge origin/next` in the worktree.
3. **On conflicts**: resolve them. Honor the intent of both sides, the feature's change and whatever landed on next. Then re-verify (step 3).
4. **If the conflicts cannot be resolved sensibly** (genuinely incompatible changes, or the resolution is unclear), stop: move the issue back to `Human Review` (resolve the Started-type id by name+type), post a comment explaining the conflict and what is needed, and leave the worktree and server in place. Do not force a merge.

## Step 3: Re-verify after the merge
After merging next in, the combined code must still pass:
- `npx tsc --noEmit -p tsconfig.json`
- `npm run build`
- `npm run lint`
- `npx vitest run`

Fix straightforward breakage from the merge. If it cannot be made green, stop: move to `Human Review` with a comment describing the failure, leave the worktree/server. Do not merge a red branch.

## Step 4: Merge the PR
Push the updated branch (`git push`), then merge:

```
gh pr merge <pr-number> --squash --delete-branch
```

Base is `next`. Squash keeps history clean and matches the repo's conventional-commit style.

## Step 5: Tear down the review surface
- Kill the test server by port: `lsof -ti:<port> | xargs -r kill`.
- Remove the throwaway config dir and log.
- `git worktree remove --force ../cockpit-<ISSUE-ID>` (the remote branch is already deleted by the merge; the work is on `next`).

## Step 6: Close out
Move the issue to `Done` via `save_issue` (id + state; `Done` is unique, set by name). Post a brief comment: merged to `next`, PR link, review surface cleaned up.

## Rules
- Reap every run, before selecting work. This is how rejected issues get cleaned up.
- Kill servers by **port**, never by process name. The live instance on 3001 must never be touched.
- One issue merged per invocation. No loop. The schedule drives throughput.
- Never merge a branch that does not pass tsc/build/lint/vitest after merging next in.
- Unresolvable conflict or unfixable breakage → back to Human Review with a comment, leave the review surface for the human. Do not force.
- Reject path is not this skill's job: a human moves a rejected issue back to Implementation Ready; the reaper here cleans up its leftover server/worktree on the next run.
