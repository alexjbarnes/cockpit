---
description: Implement a refined Linear issue. Branches off next in an isolated git worktree, writes the code following the approved plan, runs build/lint/tests, runs the completeness-reviewer agent first to confirm every acceptance criterion has implementing code, self-reviews with the code-reviewer agent (up to 4 rounds), runs the ui-reviewer agent for screenshots when UI changed, opens a PR, waits for CI to pass, starts a live test server and posts its URL for the human to verify, then moves the issue to Human Review. Use when asked to implement, build, or code up a Linear issue, e.g. "implement ALE-123".
---

# Implement a Linear issue

The Implementation stage of the pipeline. The issue description already holds a precise, human-approved plan (produced by `refine-issue`, reviewed, and approved at the issue-level Human Review gate). This skill executes that plan, then adversarially reviews its own code inline, in one warm run.

The plan is the contract. Follow it. It names the files, symbols, and exact changes. Do not redesign it. If a step is wrong or blocked by reality, make the minimal correct change and record the deviation rather than improvising silently.

Implementation and code review are one stage. The skill codes the plan, then dispatches the `code-reviewer` agent against its own diff and fixes what it finds, looping in warm context. There is no separate code-review stage in the autonomous pipeline. The issue moves Implementation -> Human Review (the code-level gate) directly.

## Input
Either an explicit issue ID, or none (the skill selects one).

- **An issue ID was given** (e.g. ALE-123): use it.
- **No ID, pipeline mode** (a scheduled job ran the skill): select one. `list_issues` (server `Linear`) with `state: "Implementation Ready"`. If there are none, stop, there is no work this run, do nothing else. Otherwise pick exactly ONE, highest priority then oldest by `updatedAt`, and implement only that. Ignore the rest; a later run picks them up. Selecting one and immediately moving it to `Implementation` (step 3) is what stops two runs grabbing the same issue.
- **No ID, interactive mode** (a human ran the skill): `list_issues` with `state: "Implementation Ready"` and ask which one to implement. Do not auto-pick.

This is why a scheduled implementation job needs no selection logic in its prompt. "Run the implement-issue skill" is the whole job; the skill picks the issue.

## Linear access
Linear is a downstream server behind conduit. Call tools with `mcp__conduit__call_tool`, server `Linear`. If this is the first Linear call in the session, run `describe_server` for `Linear` first. Pass markdown with literal newlines, never escaped.

## Invocation modes
- **Pipeline (autonomous)**: an issue enters `Implementation Ready` and an agent runs the skill end to end. Perform all status transitions. Push and open the PR without waiting for a human.
- **Interactive**: a human runs the skill directly (e.g. "implement ALE-123"). Same flow, but confirm with the human before the outward-facing actions: pushing the branch and opening the PR.

The default is pipeline mode. Treat it as interactive only when a human invoked it directly in this session.

## Steps

### 1. Read the issue and plan
- `get_issue` for the ID. Capture the title, full description (the plan), type/labels, and `gitBranchName`.
- `list_comments`. The Human Review gate often leaves approval conditions or change requests in comments. Read them; they override the plan where they conflict.

### 2. Readiness check
Confirm the description is a real refined plan, not a rough ticket. It should have an Implementation Plan section with file-and-symbol steps, plus Acceptance Criteria. Hand the issue back early rather than improvising when:
- **It was never refined.** A hand-written ticket can carry the right section headings and still be ungrounded. If there is no sign it went through refine-issue (no refinement self-review comment, or the issue is still in Backlog and was never in Issue Refinement), stop, comment that it needs `refine-issue` first, and do not implement.
- **The plan's anchors do not exist on the base branch.** Spot-check that the files and symbols the plan names are actually present where it says. If the plan references code that is not there (e.g. it assumes an unmerged refactor has already landed, or names "the block which already does X" and that block does not exist), stop and comment exactly what is missing. Do not invent the missing surface.

If the plan is sound, continue. Context missing here costs minutes; the same gap found after a PR costs a full review cycle.

### 3. Set status to Implementation
Set the issue status to `Implementation` via `save_issue` (id + state).

### 4. Create an isolated worktree off next
Work in a git worktree so the implementation is isolated from the main working tree.

If this issue is being re-implemented after a rejection, a worktree and branch from the prior attempt may already exist. Clear the stale worktree first (the branch is reused so the existing PR updates rather than spawning a new one):

```
git worktree remove --force ../cockpit-<ISSUE-ID> 2>/dev/null || true
git fetch origin
git worktree add ../cockpit-<ISSUE-ID> -B <gitBranchName> origin/next
```

`-B` resets the branch to `origin/next` if it already exists, else creates it. Use the branch name from the issue's `gitBranchName`. Do all subsequent work in that worktree by **absolute path** or `git -C <worktree>`, never by relying on a `cd`. The job's cwd is the shared base checkout (the main repo, which also serves the live instance and is used interactively), and the shell cwd does not persist between Bash calls — it resets to that base checkout — so a `cd <worktree> && …` in one call does not carry to the next, and a later bare `git add` / edit / build then lands in the main repo and pollutes it. The branch is based on `next`, and the PR will target `next`.

Install deps in the worktree with dev dependencies: `NODE_ENV=development npm install --include=dev`. The shell exports `NODE_ENV=production`, under which npm omits devDependencies and biome/vitest go missing.

The plan is anchored to a base commit SHA. `next` has likely moved since, so line numbers in the plan are stale. Re-anchor by symbol name (function, struct, method), not line number.

### 5. Implement the plan
Work through the Implementation Plan in order. For each step:
- Make the change at the named file and symbol.
- Follow the Reference Patterns section. Match the conventions shown there, not generic best practice.
- Honor the Out of Scope section. Do not touch what it lists.
- Handle every case in the Edge Cases & Error Handling section.

Match the surrounding code's style, naming, and idioms. Read neighbouring code before adding to a file.

### 6. Write the tests
Write the tests named in the plan's Testing section, at the file paths and with the scenarios and assertions it specifies. Not "add tests" but exactly the cases listed.

For any acceptance criterion that is **behavioural** (the feature does something at runtime: an agent tool resolves, a session spawns with a flag, a job posts output, a permission is allowed or denied), write a test that EXERCISES that path, not a unit test of a helper in isolation. Use the integration-test skill (the real CLI driven by the mock Anthropic API) or a spawn-arg unit test. "The code is present and the build is green" has shipped entirely dead features here; a test that runs the path is what proves it works, and it is what the completeness reviewer now requires for behavioural criteria.

### 7. Verify
Run the project's checks. All must pass:
- `npx tsc --noEmit -p tsconfig.json` (typechecks the app **and `tests/`**)
- `npm run build` (Next build + `tsc -p tsconfig.server.json` + `tsc-alias`)
- `npm run lint` (biome; `npm run lint:fix` for mechanical issues)
- `npx vitest run` (unit tests; there is no `test` script alias)

Run the `tsc --noEmit` typecheck explicitly. Neither `npm run build` nor the server tsc covers `tests/`, and `vitest` strips types rather than checking them, so a type error in a test file passes all of build/lint/vitest and then the pre-commit hook (which does typecheck `tests/`) blocks the commit. Catch it here, not at commit time.

Fix failures until green. Run the Playwright integration suite (`npm run test:integration`) when the plan names an integration test or the change touches a runtime path (session spawn, agent tools, permission flow, jobs); note in the PR if it was warranted but not run.

Coverage gate: vitest enforces an 80% global threshold (lines, functions, branches; see `vitest.config`). A new source file with thin tests fails it. Check new files with `npx vitest run --coverage` and write branch tests up front, instead of discovering the shortfall after the review loops.

### 8. Feature-completeness coverage check
The first review gate. Before reviewing whether the code is correct or renders well, confirm it contains everything the issue asked for, so the deeper reviews run once, on a complete feature, not on half-built work. Dispatch the `completeness-reviewer` agent (`subagent_type: "completeness-reviewer"`) with:

```
**Issue:** <ALE-123>
**Worktree:** <absolute worktree path>
**Mode:** coverage (UI not yet reviewed)
```

It maps the issue's Request and every acceptance criterion against the diff and the tests, and returns COMPLETE/INCOMPLETE with a coverage table. A criterion with no implementing code or test is a real gap and blocks. A purely-visual criterion it cannot confirm from code or tests is marked "pending UI" and does NOT block here; the ui-reviewer (step 10) and the human gate confirm those. Post its output as a comment on the issue each round.

**On INCOMPLETE:** implement the missing pieces, re-run the verify checks (step 7), then re-dispatch the completeness-reviewer. Nothing earlier needs re-running, code and UI review have not run yet.

**When to stop iterating** (first match wins):
1. **COMPLETE** (every criterion has implementing code or a test, or is pending-UI). Proceed to code review.
2. **Hard cap: 4 rounds.** If criteria are still genuinely unmet after the fourth, stop. Proceed and carry the unmet criteria to the Human Review transition as a comment so the human knows exactly what is missing.

### 9. Adversarial self-review loop
The feature is complete; now confirm the code is correct. Dispatch the `code-reviewer` agent (`subagent_type: "code-reviewer"`) against the diff. Tell it the base branch is `next` so it reviews `git diff next` in the worktree. Request a standard single-pass sweep (the autonomous run has no human to confirm a fan-out).

The agent returns Critical/High/Medium/Low findings and a PASS/FAIL verdict.

**Post the full review of every round as a comment** on the issue via `save_comment`, before fixing anything. Post the agent's complete output verbatim, all four severity buckets with file:line, breaking example, and suggested fix for each finding, plus the verdict, not a summary. Head each comment with the round number (e.g. "Code review round 2/4"). Do this for every round, including a PASS. This is the observability trail for tuning the implement skill.

**On FAIL or any Critical/High findings:** fix the named issues, re-run the verify checks (step 7), then re-dispatch the reviewer.

**When to stop iterating** (first match wins):
1. **PASS or only Medium/Low remain.** Apply Medium fixes. Proceed.
2. **Hard cap: 4 rounds.** If Critical/High findings still remain after the fourth review, stop iterating. Proceed but carry the unresolved findings to the Human Review transition.

Re-verify after every fix. Never let a fix break the build, lint, or tests.

### 10. UI review (only if the change touches UI)
Check the diff for UI files: `src/components/**`, `src/app/**/*.tsx`, or any `*.css`. If none changed, skip this step.

If UI changed, dispatch the `ui-reviewer` agent (`subagent_type: "ui-reviewer"`) once, after the completeness and code-review loops have converged. Pass a labelled payload:

```
**Issue:** <ALE-123>
**Worktree:** <absolute worktree path>
**Changed UI files:** <the UI files from the diff>
**Plan UI sections:** <the plan's User-Facing Behaviour and UI Changes sections, verbatim>
```

The agent drives the running app in the worktree with Playwright, screenshots the affected screens at desktop and mobile, attaches the screenshots to the Linear issue, posts its own "UI review" findings comment, and returns a verdict. It writes its own Linear attachments and comment each round (it owns the screenshot artifacts), so you do not repost them.

Loop the same way as the code review:

**On FAIL or any Critical/High UI findings:** fix them, re-run the verify checks (step 7), then re-dispatch the ui-reviewer. Each round attaches fresh screenshots and posts a fresh findings comment.

**If a UI fix changes non-trivial logic** (not just markup or CSS), re-run the `code-reviewer` (step 9) on that delta before finishing, so a behavioural change introduced this late still gets a correctness pass. Skip this for purely presentational fixes.

**When to stop iterating** (first match wins):
1. **PASS or only Medium/Low remain.** Apply Medium fixes. Proceed.
2. **Hard cap: 4 rounds.** If Critical/High UI findings still remain after the fourth review, stop. Proceed and carry the unresolved findings to the Human Review transition; the screenshots are already attached for the human to judge.

Re-verify after every fix. Never let a UI fix break the build, lint, or tests.

### 11. Commit, push, open the PR
- Commit with a conventional message matching the repo style: `fix(scope): ...` for bugs, `feat(scope): ...` for features, `chore(scope): ...` for chores.
- In interactive mode, confirm with the human before pushing.
- Push the branch.
- Open the PR with `gh pr create`, base `next`. Title from the issue. Body: a short summary, the acceptance criteria as a ticked checklist, a `**Deviations from plan:**` section (or "none"), and a `**Review:**` line stating the verdict and round count. Reference the issue.

**Then confirm CI is green before going further.** The PR's GitHub Actions checks (typecheck, lint, test, secrets, socket) run in a clean environment and catch what the local verify in step 7 cannot (CI-only checks, environment differences). They, not the local run, are the gate for reaching the human. Watch them to completion:

```
gh pr checks <pr-number> --watch --fail-fast --interval 30
```

Checks take a few seconds to register after the PR is created; if `gh pr checks` reports none yet, poll briefly with `curl` (foreground `sleep` is blocked) and retry, then watch.
- **Green** (exit 0): continue to step 12.
- **Red**: a check failed that the local verify did not surface. Read the failing job (`gh run view <run-id> --log-failed`, or the check's details URL), fix the cause, re-run the local verify (step 7), push, and watch again. Bounded to 3 fix attempts.
- **Still red after 3 attempts, or CI never completes:** stop. Do NOT start the test server (step 12) or move to Human Review (step 13). Leave the issue in `Implementation` and post a comment naming the failing check(s) with the run URL. A red PR must never reach the human review gate.

### 12. Start a live test server for the human review
The human verifies the feature by clicking a link, not by checking out the branch. Start a persistent dev server from the worktree so the running feature is reachable. The cockpit cache gotchas in `.claude/skills/browser-test/SKILL.md` apply here (NODE_ENV, a stale `.next`, the service worker); clear them so the human sees current code, not a stale bundle.

1. Pick a free port (scan upward from 3010; skip 3001, the live instance).
2. Generate a fresh random password for this server: `openssl rand -hex 12`.
3. Use a throwaway, per-issue config dir so it does not collide with the live scheduler or other test servers: `/tmp/cockpit-review-<ISSUE-ID>`.
4. Start the server **detached into its own session with `setsid`** so it survives this job ending. A plain `nohup ... &` does NOT survive: the job kills its whole process group on completion (`destroySession` → `killProcessGroup`), and the server would be in that group. `setsid` puts it in a new group.

   **Strip inherited provider env vars** with `env -u`. If the agent launching this skill is itself running under a custom provider (e.g. a Deepseek-backed run), its `ANTHROPIC_BASE_URL` / `ANTHROPIC_DEFAULT_*_MODEL` / `ANTHROPIC_AUTH_TOKEN` vars are in the shell environment and the spawned cockpit server passes them straight through to every Claude CLI it spawns. The session then runs that provider's model while the UI still shows the built-in Anthropic selection (the picker says Sonnet, the CLI is really on `deepseek-v4-pro`). Unsetting them forces the review server onto real Anthropic so the human reviews against the model the UI claims.

   ```
   cd ../cockpit-<ISSUE-ID>
   rm -rf .next   # Next resolves the workspace root at the parent dir and can serve the MAIN repo's stale .next; clear it or the reviewer sees old code
   env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY \
       -u ANTHROPIC_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL \
       -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_SMALL_FAST_MODEL \
       -u CLAUDE_CODE_SUBAGENT_MODEL -u CLAUDE_CODE_EFFORT_LEVEL \
     NODE_ENV=development COCKPIT_CONFIG_DIR=/tmp/cockpit-review-<ISSUE-ID> PORT=<port> \
     setsid nohup npx tsx server.ts > /tmp/cockpit-review-<ISSUE-ID>.log 2>&1 &
   ```
5. Poll readiness with `curl --retry` (foreground `sleep` is blocked). Then set the password via the `/login` setup screen (see `.claude/skills/browser-test/SKILL.md` for the React-input setter), using the password from step 2.
6. Record the server details so `accept-issue` can find and kill it: write `<worktree>/.review-server.json` with `{ "port": <port>, "configDir": "/tmp/cockpit-review-<ISSUE-ID>", "password": "<pw>" }`.
7. Post a comment on the issue with the URL and credentials:
   - URL is `http://192.168.0.39:<port>`. The host is hardcoded here on purpose (this review-server flow is personal, not a general cockpit feature). When the host moves to `conduit.lan`, edit this line.
   - Include the password and which screens to check (from the plan's User-Facing Behaviour).
   - Add a one-line hint: if the UI looks stale or wrong, hard-reload (Ctrl+Shift+R) to clear the cached service worker.

### 13. Link the PR and transition to Human Review
Do this last, after the test server is up and its URL is posted, so the human never lands on Human Review before the link exists.
- Attach the PR to the issue: `save_issue` with `links: [{ url: <pr-url>, title: <pr-title> }]`.
- Resolve the correct Human Review state. There are two states named "Human Review" (one in the Unstarted group, one in the Started group). Setting by name is ambiguous. This is the post-implementation gate, the **Started** one. Call `list_issue_statuses` for the issue's team, find the status whose name is "Human Review" and whose type is `started`, and use its **ID**.
- Set the issue status via `save_issue` (id + state = that status ID). This is a requirements/feature gate: a human checks the change does what the issue asked and behaves correctly. The code, UI, and completeness reviews already ran inline; this is not a repeat of them.
- **If any review loop (code, UI, or completeness) hit the 4-round cap with blocking findings still open**, post a final comment listing each unresolved finding with the reason it could not be resolved, so the human knows exactly what to weigh. The UI screenshots are already attached for the visual ones.

### 14. Do not clean up
Leave the worktree and the test server running. They are the human's review surface, and the `accept-issue` skill reaps them (kills the server, removes the worktree) when the issue is accepted, or when it leaves Human Review without being accepted (e.g. rejected back to Implementation Ready). The pushed branch and PR are the durable artifacts; the worktree and server are ephemeral review aids.

## Rules
- The plan is the contract. Follow it. Record deviations in the PR body; do not improvise silently.
- Comments at the Human Review gate override the plan where they conflict.
- Work in the worktree off `next`, addressing it by absolute path or `git -C <worktree>`. Never write to, stage in, build in, or save artifacts into the job's cwd (the shared main checkout) — the cwd resets to it between Bash calls, which is how stray staged changes and files leak into the main repo. The PR targets `next`.
- Post the full review of every round as a comment (verbatim, all buckets, round number in the header), on both PASS and FAIL.
- Re-verify after every fix. Never open a PR with a failing build, lint, or test run.
- CI is the gate to the human, not the local run. After opening the PR, watch its GitHub checks (`gh pr checks --watch`) and only proceed to the test server and Human Review when they pass. If CI cannot be made green in 3 fix attempts, leave the issue in Implementation with a comment naming the failing checks. Never move a red PR to Human Review.
- Four review rounds max. Still failing after four: open the PR, route to Human Review, and comment the unresolved findings with reasons.
- If the change touches UI, run the ui-reviewer agent (up to 4 rounds, same as code review) so screenshots of the change are attached to the issue before the human gate. Still failing after four: carry the findings to Human Review with the screenshots attached.
- Run the completeness-reviewer agent first (before code and UI review, up to 4 rounds) as a coverage check that every acceptance criterion has implementing code or a test; purely-visual criteria are deferred to the ui-reviewer and the human. Genuinely unmet after four: carry the gaps to Human Review as a comment.
- If a late UI fix changes non-trivial logic (not just markup or CSS), re-run the code-reviewer on that delta so the behavioural change still gets a correctness pass.
- Start the test server with `setsid` (not bare `nohup`) so it survives the job, and strip inherited provider env vars with `env -u` (see step 12) so a Deepseek-backed agent run does not leak its `ANTHROPIC_*` model overrides into the review server. Bind a free port (never 3001), use a per-issue throwaway config dir, and a freshly generated password each time.
- Do NOT remove the worktree or kill the test server. The `accept-issue` skill owns that cleanup.
- Honor Out of Scope. Match the codebase's conventions from the plan's Reference Patterns.
