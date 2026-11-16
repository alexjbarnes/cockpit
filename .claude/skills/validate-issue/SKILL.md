---
description: Validate the implementation of a cockpit issue as someone who did not write it. Runs the completeness-reviewer, code-reviewer and (when UI changed) ui-reviewer agents against the issue's worktree and pull request, posts every finding to the issue, and either passes the work on to the human review or sends it back to be fixed. Does not change code. Run by the Validate stage of a workflow, or directly, e.g. "validate CK-12".
---

# Validate a cockpit issue

The Validation step of the pipeline. Another agent built the issue and opened a pull request. This skill checks that work without touching it: does it deliver what was asked, is the code correct, does the UI render and behave. It then says so on the issue and moves the issue one of two ways: on to the human review, or back to be fixed.

The author does not mark its own work. That is the whole reason this is a separate agent, usually on a different model: a reviewer that just wrote the code believes it. **Do not fix anything you find.** A fix made here is unreviewed code. Report it and send the issue back.

## Run by a workflow
When the prompt opens with "You are the agent for the ... status of a workflow on issue <KEY>" (or says the issue "has come back to" a status), a Cockpit workflow started this session for that one issue and told it to run this skill.

- **The issue is the one the prompt names.** Do not list issues or pick one.
- **Your work ends when you move the issue** with `update_issue` to one of the statuses the prompt lists, and those are the only statuses you can move it to: `Code Review` for work that passed, `Implementation Ready` for work sent back. If the prompt lists other names, choose by what they mean: the one where a person reviews the work, and the one that queues it to be built again. Make it your last action.
- **The working directory may be the issue's own worktree.** When the prompt says so, that is the worktree to validate: the agent that built the issue worked in it. Do not make or remove one. `$COCKPIT_RUN_PORT` is a port kept for this run, for anything you need to start.
- **If you cannot do the validation at all** (no pull request, no worktree, the checks cannot be run), comment why on the issue, leave its status alone, and end with the `cockpit-error` block the prompt describes.

Run directly by a person ("validate CK-12"), do the same, and ask before moving the issue.

## Steps

### 1. Read the issue and find the work
- `mcp__cockpit-config__get_issue` for the key. It returns the description (the requirement), `plan` (the approved plan, in `plan.content`; an older issue has `plan: null` and its plan in the description), every comment and every attachment.
- Resolve the repo: `list_projects`, match the issue's `projectId`, use that project's `repoPath`. Call it `<REPO>`.
- The branch is `issue/<ISSUE-ID>` and the worktree is `<REPO>/../<name>-<ISSUE-ID>`, where `<name>` is `<REPO>`'s basename. Find the pull request: `gh pr list --head issue/<ISSUE-ID> --json number,url,state`.
- If there is no open pull request or no worktree, there is nothing to validate: stop as described above.
- Read the comments for earlier validation rounds and for anything a person asked for at review. A change a person asked for is a requirement, and overrides the plan where they conflict.

Work read-only in the worktree. Use `git -C <worktree> ...` and absolute paths. Do not commit, push, or edit a file.

### 2. Run the checks yourself
In the worktree, run what the project's own gate runs. For this repo:

```
NODE_ENV=development npm install --include=dev
npx tsc --noEmit -p tsconfig.json
npm run build
npm run lint
npx vitest run
```

Run `npm run test:integration` when the plan names an integration test or the change touches a runtime path (session spawn, agent tools, permission flow, scheduled jobs, workflows). Check `gh pr checks <n>` too: red CI is a blocking finding by itself.

A check that fails on the base branch as well is not this issue's failure. Say so, and do not count it.

### 3. Completeness
Dispatch the `completeness-reviewer` agent (`subagent_type: "completeness-reviewer"`):

```
**Issue:** <CK-12>
**Worktree:** <absolute worktree path>
**Mode:** coverage
```

It maps the request and every acceptance criterion against the diff and the tests and returns COMPLETE or INCOMPLETE with a coverage table. A criterion with no implementing code or test blocks.

### 4. Code review
Dispatch the `code-reviewer` agent (`subagent_type: "code-reviewer"`) against the diff. Tell it the base branch is `next`, so it reviews `git diff next` in the worktree, and ask for a standard single-pass sweep. It returns Critical, High, Medium and Low findings and a PASS or FAIL verdict.

### 5. UI review (only if the change touches UI)
If the diff touches `src/components/**`, `src/app/**/*.tsx` or any `*.css`, dispatch the `ui-reviewer` agent (`subagent_type: "ui-reviewer"`):

```
**Issue:** <CK-12>
**Worktree:** <absolute worktree path>
**Changed UI files:** <the UI files from the diff>
**Plan UI sections:** <the plan's User-Facing Behaviour and UI Changes sections, verbatim>
```

It drives the running app in a browser and posts its own findings comment with its screenshots shown in it.

Steps 3, 4 and 5 are independent: dispatch them together and wait for all of them.

### 6. Report
Post one comment on the issue with `add_issue_comment`, headed `Validation: passed` or `Validation: changes needed`, holding:

- what you ran in step 2 and how each came out;
- the completeness coverage table;
- the code review in full: every finding with its file and line, its breaking example and suggested fix. Not a summary;
- the UI verdict (its detail is in the ui-reviewer's own comment);
- for `changes needed`, a short numbered list at the top of exactly what must be fixed. This list is what the implementing agent works from, so each item names the file and what is wrong.

### 7. Move the issue
- **Pass** when the checks are green, completeness is COMPLETE, and no Critical or High finding is open from the code or UI review. Medium and Low findings do not block: they are in your comment for the human to weigh. Move the issue to the status for work that passed.
- **Send back** otherwise. Move the issue to the status for work sent back. The implementing agent picks it up as rework and fixes what your list names.

When the same blocking finding has come back in a third validation round, say so plainly at the top of the comment: the two agents are not converging and a person should look. Still send it back. Cockpit stops the loop after a set number of rounds and holds the issue.

## Rules
- Never change code, commit or push. Findings go in the comment.
- Do not pass work to be kind. A person will spend their attention on whatever you pass.
- Do not invent findings to look thorough. A clean result is a result.
- Judge against the requirement and the plan, not against how you would have built it.
- Every blocking finding names a file and says what is wrong, so the fix needs no further question.
