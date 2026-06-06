---
description: Refine a Linear issue into an exact implementation plan an agent can execute. Reads the target issue, investigates the real code, reproduces bugs, then overwrites the issue description with a precise build spec (files, symbols, exact changes, acceptance criteria). Use when asked to refine, plan, or work up a Linear issue, e.g. "refine ALE-123".
---

# Refine a Linear issue

Turn a rough Linear issue into a precise plan another agent will execute without interpretation. The plan replaces the issue description. The bar: an implementation agent should read the plan end-to-end and start writing code without asking a single follow-up question.

## Input
The issue ID (e.g. ALE-123) from the invocation. If none was given, ask which issue, or use `list_issues` to show open candidates and confirm one.

## Linear access
Linear is a downstream server behind conduit. Call tools with `mcp__conduit__call_tool`, server `Linear`. If this is the first Linear call in the session, run `describe_server` for `Linear` first. Pass markdown with literal newlines, never escaped.

## Invocation modes
This skill runs in two modes. Determine which from how it was invoked.

- **Pipeline (autonomous)**: a ticket enters `Issue Refinement Ready` and an agent runs the skill end to end with no human in the loop. Perform the detail check gate, the self-review loop, all status transitions, and **skip** the preview/confirm step. The agent never waits for a human.
- **Interactive**: a human runs the skill directly (e.g. "refine ALE-123"). Same flow, but do the preview/confirm step before writing.

The default is pipeline mode. Treat it as interactive only when a human invoked it directly in this session.

Refinement and the adversarial review are one stage. The skill investigates once (warm context), then self-reviews and fixes in the same run, posting each review round's findings as a comment. There is no separate review stage in the autonomous pipeline. The issue moves Issue Refinement -> Human Review directly.

## Steps

### 1. Read the issue
- `get_issue` for the ID. Capture the title, full description verbatim, type/labels, state.
- `list_comments` for the issue. Read any context the reporter added.
- If the description or comments contain images, pull them with `extract_images`.

Do not ask follow-up clarifying questions yet. The Explore step often answers them.

### 2. Detail check gate

Before doing any investigation, verify the issue has enough basic information to produce a useful plan. Required details depend on type:

- **Bug**: what is broken, how to trigger it, expected vs actual behaviour.
- **Feature**: what the user should be able to do that they cannot do today.
- **Chore / task**: what needs to change and why.

**If details are missing:**
1. Set the issue status to `Needs Detail` via `save_issue` (id + state).
2. Add a comment via `save_comment` listing exactly what is missing and what the reporter should add.
3. Stop. Do not proceed with refinement.

In interactive mode, surface the gaps to the human and ask whether to proceed anyway before moving to `Needs Detail`.

**If details are sufficient:**
1. Set the issue status to `Issue Refinement` via `save_issue` (id + state).
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

Spawn the **Explore** subagent (`subagent_type: "Explore"`) with the explore prompt from the loaded reference file. Do the exploration in the subagent, not inline. This keeps the main context lean and lets the search run without bloating the conversation.

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
Build the full description using the template sections from the loaded reference file. Do not write it to Linear yet.

Every plan starts with:

```
## Request
> <original ask, verbatim>
```

Then include every section specified in the reference file. Fill placeholders with Explore findings and your own file reads. Do not leave placeholders in the output. Sections marked `(optional)` should be omitted if no content exists for them rather than left empty.

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
<full description draft>

**Original brief:** <verbatim user request from the issue>

**Repo:** <absolute cwd path>
```

The agent returns Critical/High/Medium/Low findings and a PASS/FAIL verdict.

**Post every round's findings as a comment.** After each review round, post the agent's full findings (all four buckets and the verdict) to the issue via `save_comment` before fixing anything. This is the observability trail: it shows what refinement's draft got wrong each pass, which is the signal for improving this skill over time. Do not skip a round's comment, even on PASS.

**On FAIL or any Critical/High findings:** fix the named issues in the draft, then re-dispatch. Productive iteration is allowed. Keep going as long as each round surfaces new issues, because that means the fixes are working and the reviewer is finding genuinely fresh problems.

**When to stop iterating** (in order, first matching condition wins):

1. **PASS or only Medium/Low remain.** Apply Medium fixes. Move on.
2. **Findings recur.** Same sections, same gaps, same dimensions as the prior round. Stop thrashing. Surface as `**Unresolved findings:**` in the Open questions section.
3. **Hard cap: 4 total reviews.** Most plans converge in 1-2. Needing 3-4 is a signal the original brief was thin or the codebase is unfamiliar.

**Calibration:** the adversarial framing is deliberate. It compensates for "I just wrote this so it must be fine" bias. If the review comes back clean, accept it and move on. Do not push the subagent to invent findings, and do not re-run a passing review hoping for issues.

**If something genuinely cannot be fixed from available material** (e.g. the template asks for a Telemetry section but Explore returned no telemetry patterns), do not invent content. Note it as `**Unresolved:** <what's missing and why>` in the Open questions section of the plan.

**If the loop hits the hard cap with blocking findings still open**, put them in the plan's Open questions section, post a final comment flagging them, and still route to Human Review. The human decides whether to send it back to Issue Refinement Ready or add detail.

### 10. Preview and confirm (interactive mode only)

Skip this step in pipeline mode. The autonomous agent writes the plan and transitions status without waiting for a human.

In interactive mode, show the user the full plan as it will appear in the issue description. Accept inline edits:
- "drop the out of scope section" -> remove, re-show.
- "change the approach for step 3" -> update, re-show.
- "this is a feature not a bug" -> reclassify, regenerate.

Wait for explicit confirmation before writing. Do not proceed on ambiguous responses.

### 11. Write to Linear and transition status
Resolve the correct Human Review state first. There are two states named "Human Review" (one in the Unstarted group, one in the Started group). Setting by name is ambiguous. This is the issue-level gate, the **Unstarted** one. Call `list_issue_statuses` for the issue's team, find the status whose name is "Human Review" and whose type is `unstarted`, and use its **ID**.

Then write the final converged plan in one `save_issue` call with `id`, `description`, and `state: <that status ID>`. The description opens with the user's verbatim ask, so nothing is lost when it overwrites the field. The self-review already ran inline (step 9), so the plan moves straight to the human gate. The round-by-round findings are already on the issue as comments.

## Rules
- Build the whole plan before writing. One `save_issue`, not incremental edits.
- Preserve the original ask verbatim at the top. The overwrite is why this matters.
- Quote real code from real files. Do not paraphrase snippets. If you would cite a file you have not read, read it first.
- Include reference patterns with quoted snippets so the implementation agent knows what good looks like in this codebase.
- Exact over vague. If you cannot name the symbol and the change, you have not finished investigating.
- Separate fact from hypothesis. The review stage attacks the assumptions, so make them visible.
- Name specific test cases with file paths, scenarios, and assertions. "Add tests" is not a test plan.
- For any runtime/behavioural acceptance criterion, name an EXERCISING test, an integration test against the mock CLI (see the integration-test skill) or a spawn-arg unit test, not just a helper unit test. A criterion that can only be proven by running the feature needs a test that runs it.
- A load-bearing assumption (one the feature's behaviour depends on, e.g. "the CLI reports the injected server under this name, which the permission filter keys on") must become a specific test or a runtime check in the plan, not sit in Open Questions as prose. An unverified assumption on a critical path is how a feature ships dead.
