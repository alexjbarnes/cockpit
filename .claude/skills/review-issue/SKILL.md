---
description: Run an on-demand adversarial review of a refined cockpit issue plan. Dispatches the plan-reviewer agent against the plan in the issue description and posts the findings as a comment. Use when a human wants a fresh review of an existing plan outside the autonomous refinement flow, e.g. "review CK-12". Not part of the autonomous pipeline; the refine-issue skill already self-reviews inline.
---

# Review a cockpit issue plan (on-demand)

A manual tool for getting a fresh adversarial pass on a plan that already sits in an issue's description. The autonomous pipeline does not use this: the `refine-issue` skill self-reviews inline during refinement and posts those findings itself. Reach for this skill when a human wants an extra review of an existing plan, for example after editing it by hand or before approving it at the Plan Review gate.

## Input
The issue key (e.g. CK-12) from the invocation. If none was given, ask which issue.

## Steps

### 1. Read the issue
- `mcp__cockpit-config__get_issue` for the key. One call returns the title, full description (the plan), status, and every comment — read prior review comments and any human feedback.
- Extract the original brief from the plan's `## Request` block at the top of the description. The reviewer needs it to check scope drift.

### 2. Determine the repo
The reviewer verifies file paths and code snippets against the actual codebase. `list_projects`, match the issue's `projectId`, and use that project's `repoPath` if set. Otherwise use the current working directory (today's behaviour). If neither is a code repo, the reviewer will note that code accuracy was not verified.

### 3. Dispatch the reviewer
Dispatch the `plan-reviewer` agent (`subagent_type: "plan-reviewer"`) with three labelled blocks:

```
**Plan draft:**
<full issue description>

**Original brief:** <verbatim Request block from the description>

**Repo:** <resolved repo path from step 2>
```

The agent returns Critical/High/Medium/Low findings and a PASS/FAIL verdict. It does not touch the issue.

### 4. Post the findings as a comment
Post the agent's full review (the four buckets and verdict) as a comment on the issue via `mcp__cockpit-config__add_issue_comment`. Post it regardless of verdict.

### 5. Report and offer to transition
Report the verdict to the user. Do not change the issue status automatically. If the user wants to act on it, offer the obvious transition:
- FAIL (Critical/High): offer to set `Refine Ready` to send it back for another refinement pass.
- PASS: offer to set `Implementation Ready` if they are approving at the Plan Review gate.

Wait for the user to confirm before changing status.

## Rules
- One review pass per invocation. No looping.
- Always post the findings comment.
- The agent reviews; this skill posts the comment. Do not duplicate the agent's reasoning here.
- Do not change issue status without the user's say-so. This is a manual tool, not an autonomous stage.
