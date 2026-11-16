---
description: Refine a cockpit issue into an exact implementation plan an agent can execute. Reads the target issue, investigates the real code, reproduces bugs, then writes the issue's plan: a precise build spec (files, symbols, exact changes, acceptance criteria) kept as its own versioned document beside the description. Revises that plan when a reviewer sends it back. Use when asked to refine, plan, or work up a cockpit issue, e.g. "refine CK-12".
---

# Refine a cockpit issue

Turn a rough cockpit issue into a precise plan another agent will execute without interpretation. The plan is the issue's own versioned document, written with `mcp__cockpit-config__set_issue_plan`. The description is the requirement as the reporter wrote it: never edit it, and never put the plan in it. The bar: an implementation agent should read the plan end-to-end and start writing code without asking a single follow-up question.

## Input
The issue key (e.g. CK-12) from the invocation. If none was given, ask which issue, or use `mcp__cockpit-config__list_issues` to show open candidates and confirm one.

## Run by a workflow
When the prompt opens with "You are the agent for the ... status of a workflow on issue <KEY>" (or says the issue "has come back to" a status), a Cockpit workflow started this session for that one issue and told it to run this skill. This is pipeline mode, with these differences, and where they conflict with a step below they win:

- **The issue is the one the prompt names.** Do not list issues, pick one, or look at any other.
- **Cockpit has already moved it to the status you work in.** Skip any step that sets a status to say work has started.
- **Your work ends when you move the issue** with `update_issue` to one of the statuses the prompt lists, and those are the only statuses you can move it to. The prompt lists the statuses and nothing more: which one fits which outcome is said below. Make it your last action.
- **If you cannot do the work**, comment why on the issue, leave its status alone, and end with the `cockpit-error` block the prompt describes. Cockpit holds the issue for a person.
- **The working directory may be the issue's own worktree.** When the prompt says so, Cockpit has already made the worktree and its `issue/<KEY>` branch, and every agent that works on the issue works in it. Use the working directory as the worktree: do not create, replace or remove a worktree or branch for the issue, and do not `cd` out of it to the main checkout. Cockpit removes it when the issue is finished.
- **A port is kept for the run** in `$COCKPIT_RUN_PORT`, and named in the prompt. If you start a server, start it on that port and do not scan for another.

For this skill that means: skip the move to `Refining` in step 2 and step 1a. In step 11, with the plan written, move the issue to `Plan Review`. When details are missing (step 2), comment what is missing and move it to `Needs Detail`. If the prompt lists other names, choose by what they mean: the one where a person reviews the plan, and the one where the issue waits for more detail.

## Invocation modes
This skill runs in two modes. Determine which from how it was invoked.

- **Pipeline (autonomous)**: a ticket enters `Refine Ready` and an agent runs the skill end to end with no human in the loop. Perform the detail check gate, the self-review loop, all status transitions, and **skip** the preview/confirm step. The agent never waits for a human.
- **Interactive**: a human runs the skill directly (e.g. "refine CK-12"). Same flow, but do the preview/confirm step before writing.

The default is pipeline mode. Treat it as interactive only when a human invoked it directly in this session.

Refinement and the adversarial review are one stage. The skill investigates once (warm context), then self-reviews and fixes in the same run, posting each review round's findings as a comment. There is no separate review stage in the autonomous pipeline. The issue moves Refining -> Plan Review directly.

## Steps

### 1. Read the issue and resolve the repo
- `mcp__cockpit-config__get_issue` for the key. One call returns the full title, description verbatim, labels, status, every comment, and `plan`: the newest version of the issue's plan with the review of it, or null when it has never been planned. Capture all of it, including any context a reporter left in a comment.
- **If `plan.review.outcome` is `changes_requested`, this is a rework: a person read the plan and sent it back.** Go to step 1a. Otherwise this is a first refinement and step 1a does not apply.
- Resolve the repo to investigate: `list_projects`, match the issue's `projectId`, and use that project's `repoPath` if set. Otherwise use the session's current working directory (today's behaviour, and the only case while cockpit is the sole project). Investigation and file reads in the steps below happen in that repo.
- A picture in a comment or in the plan is a markdown image whose target is the file it is stored in: open it with Read. If the description links an image, view it directly from its URL; attachments returned by `get_issue` are also plain paths or URLs.

Do not ask follow-up clarifying questions yet. The Explore step often answers them.

### 1a. Rework: revise the plan that was sent back

`plan.content` is the plan as the reviewer read it, and `plan.review.feedback` is what they said: numbered notes anchored to quoted text (comments, removals, replacements, notes on the whole plan) and sometimes a diff of edits they made to the text themselves.

1. Set the issue status to `Refining` via `update_issue`.
2. Treat every point in the feedback as a requirement. Work through them in order. A comment is answered by changing the plan, a removal by taking the text out, a replacement by using the reviewer's wording, and a diff of their own edits is kept exactly.
3. Keep everything the reviewer did not comment on as it is. This is a revision of the same plan, not a new one: same title, same structure, changed only where the feedback requires it.
4. Where a point needs facts you do not have, investigate just that (step 5 and step 6, scoped to the point). Do not re-run the whole exploration.
5. Where you cannot do what a point asks, do not drop it silently: say why under Open questions in the plan.
6. Run the self-review loop (step 9) on the revised draft, capped at 2 rounds for a rework.
7. Write the revised plan as the next version (step 11), then add one comment with `add_issue_comment` headed `Plan version <n>: revised`, listing each feedback point and how it was handled in one line each.

Skip steps 2, 3, 4, 7 and 8 in a rework.

### 2. Detail check gate

Before doing any investigation, verify the issue has enough basic information to produce a useful plan. Required details depend on type:

- **Bug**: what is broken, how to trigger it, expected vs actual behaviour.
- **Feature**: what the user should be able to do that they cannot do today.
- **Chore / task**: what needs to change and why.

**If details are missing:**
1. Set the issue status to `Needs Detail` via `update_issue` (key + status).
2. Add a comment via `add_issue_comment` listing exactly what is missing and what the reporter should add.
3. Stop. Do not proceed with refinement.

In interactive mode, surface the gaps to the human and ask whether to proceed anyway before moving to `Needs Detail`.

**If details are sufficient:**
1. Set the issue status to `Refining` via `update_issue` (key + status).
2. Continue to step 3.

### 3. Classify
Decide the type from labels first, else infer from content:
- **bug / regression**: use the bug template from `references/bug.md`.
- **feature**: use the feature template from `references/feature.md`.
- **chore / refactor / task**: use the feature template but drop UI-specific and telemetry sections.

State the classification before planning.

### 4. Load the per-type template
Read the reference file for the classified type (relative to this SKILL.md):
- `references/bug.md` for bugs and regressions
- `references/feature.md` for features, chores, and tasks

The reference file contains two things:
- **Explore guidance**: what to investigate and what to quote from the codebase.
- **Template sections**: the sections the plan must include, with descriptions of what goes in each.

Use the explore guidance to direct your investigation in the next step. Use the template sections to structure the plan in step 6.

### 5. Investigate the code (the core of the job)
This is where the plan earns its precision. Do not guess.

Spawn the **Explore** subagent (`subagent_type: "Explore"`) with the explore prompt from the loaded reference file, scoped to the repo resolved in step 1. Do the exploration in the subagent, not inline. This keeps the main context lean and lets the search run without bloating the conversation.

- If the repo uses graphene, read the relevant nodes before exploring files, and record any boundary or gotcha you find.
- Wait for the Explore subagent to return before continuing.
- If it comes back with low-confidence or empty findings (e.g. user described something not in this repo), surface that to the user and confirm the right repo before continuing.

### 6. Read the files you intend to cite

**Before drafting, Read the 3-5 most-cited files from the Explore findings** using the `Read` tool. Quote snippets verbatim from those reads, not from Explore's prose. This is the single largest lever for avoiding accuracy-driven review rounds. Explore summaries are high-level by design, and small inaccuracies (wrong line number, paraphrased identifier, missing helper) compound into multiple HIGH findings when the reviewer cross-checks against the real files.

If you would cite a file you have not read in this skill invocation, read it now. Record `git rev-parse HEAD` as the base commit. The plan is anchored to it.

### 7. Reproduce (bugs only)
- Build the smallest reproduction that triggers the failure. Isolate it from unrelated state.
- Capture the exact commands, the observed output verbatim, and the expected output.
- Find the root cause. Mark it "confirmed" only if proven, else "hypothesis".
- Check for regression: `git log` / `git blame` on the affected lines for the introducing commit.
- The reproduction goes into the plan as a re-runnable recipe. Do not depend on a scratch dir surviving.

### 8. Write the plan
Build the full plan using the template sections from the loaded reference file. Do not write it to the issue yet.

Every plan starts with a top-level heading that names it, the issue's title:

```
# <issue title>
```

Do not restate the request: it is the issue's description, which stays where it is and travels with the plan. Then include every section specified in the reference file. Fill placeholders with Explore findings and your own file reads. Do not leave placeholders in the output. Sections marked `(optional)` should be omitted if no content exists for them rather than left empty.

All plans must have:

**Implementation plan**: numbered list, each pinned to a file path with symbol names. Each step names the file, the symbol (function, struct, method), and the precise change. Anchor to the symbol plus the base SHA. Line numbers are hints, symbols are the anchor. For new files, state the intended shape and reference an existing file as the pattern to follow.

**Reference patterns**: existing code the implementation agent should model on, with paths and short quoted snippets. This is what stops the agent from writing code that compiles but doesn't match the codebase's conventions.

**Edge cases & error handling**: explicit bullet list of cases the implementation must handle.

**Testing**: specific tests with file paths, scenarios, and assertions. Not "add tests" but the actual cases:
- `path/to/file.test.ts` -- given <input>, when <action>, expect <result>

**Acceptance criteria**: testable statements, checkboxes. Keep each item free of inline code (no backticks). Use the bare identifier name instead if you need to mention one.

**Out of scope**: what NOT to touch.

**Open questions / assumptions**: anything unverified, for the review stage.

### 9. Self-review loop

Refinement and review run in one warm stage. The investigation context is already loaded, so reviewing and fixing here is far cheaper than handing off to a separate stage that would have to re-investigate from scratch.

Dispatch the `plan-reviewer` agent (`subagent_type: "plan-reviewer"`) to attack the draft. A fresh subagent with adversarial framing catches issues the author misses. Pass three labelled blocks:

```
**Plan draft:**
<full plan draft>

**Original brief:** <verbatim user request from the issue>

**Repo:** <absolute cwd path>
```

The agent returns Critical/High/Medium/Low findings and a PASS/FAIL verdict.

**Post every round's findings as a comment.** After each review round, post the agent's full findings (all four buckets and the verdict) to the issue via `add_issue_comment` before fixing anything. This is the observability trail: it shows what refinement's draft got wrong each pass, which is the signal for improving this skill over time. Do not skip a round's comment, even on PASS.

**On FAIL or any Critical/High findings:** fix the named issues in the draft, then re-dispatch. Productive iteration is allowed. Keep going as long as each round surfaces new issues, because that means the fixes are working and the reviewer is finding genuinely fresh problems.

**When to stop iterating** (in order, first matching condition wins):

1. **PASS or only Medium/Low remain.** Apply Medium fixes. Move on.
2. **Findings recur.** Same sections, same gaps, same dimensions as the prior round. Stop thrashing. Surface as `**Unresolved findings:**` in the Open questions section.
3. **Hard cap: 4 total reviews.** Most plans converge in 1-2. Needing 3-4 is a signal the original brief was thin or the codebase is unfamiliar.

**Calibration:** the adversarial framing is deliberate. It compensates for "I just wrote this so it must be fine" bias. If the review comes back clean, accept it and move on. Do not push the subagent to invent findings, and do not re-run a passing review hoping for issues.

**If something genuinely cannot be fixed from available material** (e.g. the template asks for a Telemetry section but Explore returned no telemetry patterns), do not invent content. Note it as `**Unresolved:** <what's missing and why>` in the Open questions section of the plan.

**If the loop hits the hard cap with blocking findings still open**, put them in the plan's Open questions section, post a final comment flagging them, and still route to Plan Review. The human decides whether to send it back to Refine Ready or add detail.

### 10. Preview and confirm (interactive mode only)

Skip this step in pipeline mode. The autonomous agent writes the plan and transitions status without waiting for a human.

In interactive mode, show the user the full plan as it will be written to the issue. Accept inline edits:
- "drop the out of scope section" -> remove, re-show.
- "change the approach for step 3" -> update, re-show.
- "this is a feature not a bug" -> reclassify, regenerate.

Wait for explicit confirmation before writing. Do not proceed on ambiguous responses.

### 11. Write the plan and transition status
Write the final converged plan with one `set_issue_plan` call (`key`, `content`: the whole plan). It becomes the next numbered version; earlier versions and their reviews are kept, and the reviewer sees what changed since the last one. Then move the issue with `update_issue`: `key` and `status: "Plan Review"`. Do not pass `description`. `Plan Review` is its own named status, distinct from the implementation-side `Code Review` gate. The self-review already ran inline (step 9), so the plan moves straight to the human gate, where a person reads it on the issue, marks it up, and approves it or sends it back. The round-by-round findings are already on the issue as comments.

## Rules
- When the plan turns on how something should look and there is more than one reasonable answer, show the choices instead of describing them: draw each as a small static HTML page, screenshot it, and put it in the plan as a markdown image with the file's absolute path and a caption that names it (`![Option A: tabs along the top](/tmp/.../option-a.png)`). The reviewer picks one by commenting on its caption. Cockpit copies the files into the issue, so they need only exist when `set_issue_plan` is called.
- Build the whole plan before writing. One `set_issue_plan` call with the whole plan, not incremental edits: every call with new text is a version a person may be asked to review.
- Never write to the issue's description. It is the requirement, and the reporter's words.
- Quote real code from real files. Do not paraphrase snippets. If you would cite a file you have not read, read it first.
- Include reference patterns with quoted snippets so the implementation agent knows what good looks like in this codebase.
- Exact over vague. If you cannot name the symbol and the change, you have not finished investigating.
- Separate fact from hypothesis. The review stage attacks the assumptions, so make them visible.
- Name specific test cases with file paths, scenarios, and assertions. "Add tests" is not a test plan.
- For any runtime/behavioural acceptance criterion, name an EXERCISING test, an integration test against the mock CLI (see the integration-test skill) or a spawn-arg unit test, not just a helper unit test. A criterion that can only be proven by running the feature needs a test that runs it.
- A load-bearing assumption (one the feature's behaviour depends on, e.g. "the CLI reports the injected server under this name, which the permission filter keys on") must become a specific test or a runtime check in the plan, not sit in Open Questions as prose. An unverified assumption on a critical path is how a feature ships dead.
- A "render / display X readably" criterion must specify the CONCRETE expected output per field, not just "readable". Name what each value should look like (a schedule shows as `Cron: 0 2 * * *`, never JSON; a long prompt shows as a block) and state "no raw JSON in user-facing output" when that is the intent. "Readable display" alone makes the implementer and the reviewers guess, and they guess wrong (ALE-617: the code-reviewer's reasonable-looking `JSON.stringify` fix produced the exact JSON the user kept rejecting).
- Any UI rendering criterion must hold in BOTH light and dark themes — say so explicitly. Syntax-highlight / markdown / code components are a known dark-mode trap (they can hardcode a light theme and go invisible).
- When a change touches a surface meant to mirror another (an MCP tool that should expose the same fields as a UI form; two views of the same data), make that PARITY an explicit acceptance criterion and enumerate the fields. A "like-for-like with the UI" requirement that is only implied gets missed (ALE-617: the job MCP tools were missing runtime / allowedTools / mcpServers / mcpToolFilters / notifyProviders / schedules; the user found it only by testing).
- Ambiguous scope (which sessions / surfaces / users does this apply to?) becomes an Open Question for the human, and the plan defaults to the NARROWER interpretation — never silently pick the reading that touches more surface (ALE-617: "block bypass" was refined as all interactive sessions; the user had to bounce it back to cockpit-agent-only).
