---
description: Implement a refined Linear issue. Branches off next in an isolated git worktree, writes the code following the approved plan, runs build/lint/tests, self-reviews with the code-reviewer agent (up to 4 rounds), runs the ui-reviewer agent for screenshots when UI changed, opens a PR, and moves the issue to Human Review. Use when asked to implement, build, or code up a Linear issue, e.g. "implement ALE-123".
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
Confirm the description is a real refined plan, not a rough ticket. It should have an Implementation Plan section with file-and-symbol steps, plus Acceptance Criteria. If it does not, stop, add a comment saying it needs refinement first, and do not implement.

### 3. Set status to Implementation
Set the issue status to `Implementation` via `save_issue` (id + state).

### 4. Create an isolated worktree off next
Work in a git worktree so the implementation is isolated from the main working tree.

```
git fetch origin
git worktree add ../cockpit-<ISSUE-ID> -b <gitBranchName> origin/next
```

Use the branch name from the issue's `gitBranchName`. Do all subsequent work with that worktree as the cwd. The branch is based on `next`, and the PR will target `next`.

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

### 7. Verify
Run the project's checks. All must pass:
- `npm run build` (Next build + `tsc -p tsconfig.server.json` + `tsc-alias`)
- `npm run lint` (biome; `npm run lint:fix` for mechanical issues)
- `npx vitest run` (unit tests; there is no `test` script alias)

Fix failures until green. Skip the Playwright integration suite unless the plan calls for it; note in the PR if integration coverage is warranted but not run.

### 8. Adversarial self-review loop
Dispatch the `code-reviewer` agent (`subagent_type: "code-reviewer"`) against the diff. Tell it the base branch is `next` so it reviews `git diff next` in the worktree. Request a standard single-pass sweep (the autonomous run has no human to confirm a fan-out).

The agent returns Critical/High/Medium/Low findings and a PASS/FAIL verdict.

**Post the full review of every round as a comment** on the issue via `save_comment`, before fixing anything. Post the agent's complete output verbatim, all four severity buckets with file:line, breaking example, and suggested fix for each finding, plus the verdict, not a summary. Head each comment with the round number (e.g. "Code review round 2/4"). Do this for every round, including a PASS. This is the observability trail for tuning the implement skill.

**On FAIL or any Critical/High findings:** fix the named issues, re-run the verify checks (step 7), then re-dispatch the reviewer.

**When to stop iterating** (first match wins):
1. **PASS or only Medium/Low remain.** Apply Medium fixes. Proceed to PR.
2. **Hard cap: 4 rounds.** If Critical/High findings still remain after the fourth review, stop iterating. Proceed to PR but carry the unresolved findings to step 10.

Re-verify after every fix. Never let a fix break the build, lint, or tests.

### 9. UI review (only if the change touches UI)
Check the diff for UI files: `src/components/**`, `src/app/**/*.tsx`, or any `*.css`. If none changed, skip this step.

If UI changed, dispatch the `ui-reviewer` agent (`subagent_type: "ui-reviewer"`) once, after the code-review loop has converged. Pass a labelled payload:

```
**Issue:** <ALE-123>
**Worktree:** <absolute worktree path>
**Changed UI files:** <the UI files from the diff>
**Plan UI sections:** <the plan's User-Facing Behaviour and UI Changes sections, verbatim>
```

The agent drives the running app in the worktree with Playwright, screenshots the affected screens at desktop and mobile, attaches the screenshots to the Linear issue, posts its own "UI review" findings comment, and returns a verdict. It writes its own Linear attachments and comment each round (it owns the screenshot artifacts), so you do not repost them.

Loop the same way as the code review:

**On FAIL or any Critical/High UI findings:** fix them, re-run the verify checks (step 7), then re-dispatch the ui-reviewer. Each round attaches fresh screenshots and posts a fresh findings comment.

**When to stop iterating** (first match wins):
1. **PASS or only Medium/Low remain.** Apply Medium fixes. Proceed.
2. **Hard cap: 4 rounds.** If Critical/High UI findings still remain after the fourth review, stop. Proceed to the PR and carry the unresolved findings to step 11; the screenshots are already attached for the human to judge.

Re-verify after every fix. Never let a UI fix break the build, lint, or tests.

### 10. Commit, push, open the PR
- Commit with a conventional message matching the repo style: `fix(scope): ...` for bugs, `feat(scope): ...` for features, `chore(scope): ...` for chores.
- In interactive mode, confirm with the human before pushing.
- Push the branch.
- Open the PR with `gh pr create`, base `next`. Title from the issue. Body: a short summary, the acceptance criteria as a ticked checklist, a `**Deviations from plan:**` section (or "none"), and a `**Review:**` line stating the verdict and round count. Reference the issue.

### 11. Link the PR and transition to Human Review
- Attach the PR to the issue: `save_issue` with `links: [{ url: <pr-url>, title: <pr-title> }]`.
- Resolve the correct Human Review state. There are two states named "Human Review" (one in the Unstarted group, one in the Started group). Setting by name is ambiguous. This is the code-level gate, the **Started** one. Call `list_issue_statuses` for the issue's team, find the status whose name is "Human Review" and whose type is `started`, and use its **ID**.
- Set the issue status via `save_issue` (id + state = that status ID). This is the code-level human gate: a human reviews the PR before merge.
- **If either review loop (code or UI) hit the 4-round cap with blocking findings still open**, post a final comment listing each unresolved Critical/High finding with the reason it could not be resolved, so the human knows exactly what to weigh before merging or sending it back. The UI screenshots are already attached for the visual ones.

### 12. Clean up the worktree
After the branch is pushed and the PR is open, remove the worktree (the pushed branch is the durable artifact):

```
git worktree remove ../cockpit-<ISSUE-ID>
```

## Rules
- The plan is the contract. Follow it. Record deviations in the PR body; do not improvise silently.
- Comments at the Human Review gate override the plan where they conflict.
- Work in the worktree off `next`. The PR targets `next`.
- Post the full review of every round as a comment (verbatim, all buckets, round number in the header), on both PASS and FAIL.
- Re-verify after every fix. Never open a PR with a failing build, lint, or test run.
- Four review rounds max. Still failing after four: open the PR, route to Human Review, and comment the unresolved findings with reasons.
- If the change touches UI, run the ui-reviewer agent (up to 4 rounds, same as code review) so screenshots of the change are attached to the issue before the human gate. Still failing after four: carry the findings to Human Review with the screenshots attached.
- Honor Out of Scope. Match the codebase's conventions from the plan's Reference Patterns.
