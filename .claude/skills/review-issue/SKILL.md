---
description: Run an on-demand adversarial review of a refined Linear issue plan. Dispatches the plan-reviewer agent against the plan in the issue description and posts the findings as a comment. Use when a human wants a fresh review of an existing plan outside the autonomous refinement flow, e.g. "review ALE-123". Not part of the autonomous pipeline; the refine-issue skill already self-reviews inline.
---

# Review a Linear issue plan (on-demand)

A manual tool for getting a fresh adversarial pass on a plan that already sits in an issue's description. The autonomous pipeline does not use this: the `refine-issue` skill self-reviews inline during refinement and posts those findings itself. Reach for this skill when a human wants an extra review of an existing plan, for example after editing it by hand or before approving it at the Human Review gate.

## Input
The issue ID (e.g. ALE-123) from the invocation. If none was given, ask which issue.

## Linear access
Linear is a downstream server behind conduit. Call tools with `mcp__conduit__call_tool`, server `Linear`. If this is the first Linear call in the session, run `describe_server` for `Linear` first. Pass markdown with literal newlines, never escaped.

## Steps

### 1. Read the issue
- `get_issue` for the ID. Capture the title, full description (the plan), state.
- `list_comments` for the issue. Read prior review comments and any human feedback.
- Extract the original brief from the plan's `## Request` block at the top of the description. The reviewer needs it to check scope drift.

### 2. Determine the repo
The reviewer verifies file paths and code snippets against the actual codebase. Use the current working directory as the repo. If the cwd is not a code repo, the reviewer will note that code accuracy was not verified.

### 3. Dispatch the reviewer
Dispatch the `plan-reviewer` agent (`subagent_type: "plan-reviewer"`) with three labelled blocks:

```
**Plan draft:**
<full issue description>

**Original brief:** <verbatim Request block from the description>

**Repo:** <absolute cwd path>
```

The agent returns Critical/High/Medium/Low findings and a PASS/FAIL verdict. It does not touch Linear.

### 4. Post the findings as a comment
Post the agent's full review (the four buckets and verdict) as a comment on the issue via `save_comment`. Post it regardless of verdict.

### 5. Report and offer to transition
Report the verdict to the user. Do not change the issue status automatically. If the user wants to act on it, offer the obvious transition:
- FAIL (Critical/High): offer to set `Issue Refinement Ready` to send it back for another refinement pass.
- PASS: offer to set `Implementation Ready` if they are approving at the Human Review gate.

Wait for the user to confirm before changing status.

## Rules
- One review pass per invocation. No looping.
- Always post the findings comment.
- The agent reviews; this skill posts to Linear. Do not duplicate the agent's reasoning here.
- Do not change issue status without the user's say-so. This is a manual tool, not an autonomous stage.
