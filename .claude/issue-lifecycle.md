# Issue Lifecycle

Cockpit's native issue tracker states for the agent pipeline. Issues flow top to bottom. Each transition is either manual or triggered by an agent completing its stage.

## Backlog

| State | Purpose |
|-------|---------|
| Backlog | Default landing state for new issues. Untriaged. |

## Not yet started

| State | Purpose |
|-------|---------|
| Needs Detail | Issue lacks enough information to refine. Agent or human has flagged missing details. A comment on the issue explains what is needed. |
| Refine Ready | Human has moved the issue here, signalling it has enough basic detail for the refine agent to pick up. |
| Refining | The `/refine-issue` skill is actively investigating the codebase, writing the plan, and self-reviewing it. Refinement and adversarial review happen in this one stage. |
| Plan Review | Refinement and self-review complete. A human reviews the refined plan before it moves to implementation. This is the issue-level human gate. |

## In progress

| State | Purpose |
|-------|---------|
| Implementation Ready | Human has approved the plan. The implement-issue skill can pick it up. |
| Implementation | The `implement-issue` skill is coding the plan and self-reviewing it (code-reviewer agent) in an isolated worktree off next. Implementation and code review happen in this one stage. |
| Code Review | PR open and code-reviewed inline; a live test server is running and its URL is in a comment. A human checks the feature against the requirement: does it do what was asked, does it behave right. Requirements/feature gate, not a code review. Accept it (-> Accepted) or reject it (-> Implementation Ready, with feedback). |
| Accepted | The human verified the feature. The `accept-issue` skill picks it up: brings the branch up to date with next, merges the PR, tears down the test server and worktree, and moves it to Done. |

## Terminal

| State | Purpose |
|-------|---------|
| Done | Merged and shipped. |
| Cancelled | Deliberately dropped, or a duplicate of another issue. There is no separate Duplicate status; tag it with a label if that distinction needs to be kept. |

Refinement and implementation each have their own human approval gate, and the two are easy to conflate because they play the same role at different stages. The tracker gives them distinct names rather than one name disambiguated by context: **Plan Review** (refinement-side, before implementation starts) and **Code Review** (implementation-side, before merge). Every transition below names the correct one explicitly — each is just a status, with no group or type qualifier to resolve first.

## Refinement phase (documented)

One autonomous agent stage. Human adds basic details to a ticket in Backlog, then moves it to Refine Ready when ready. The refine skill investigates, drafts, and self-reviews in one warm run, posting each review round's findings as a comment, then hands a reviewed plan to the human gate.

```
Backlog
  -> Refine Ready             (human: adds basic details, moves it here when ready)

Refine Ready
  -> Needs Detail             (refine skill: basic details missing, comment added explaining what is needed)
  -> Refining                 (refine skill: details sufficient, begins investigation)

Refining                      (refine skill: investigate -> draft -> self-review loop, every round's
                              findings posted as a comment -> fix -> repeat until clean)
  -> Plan Review              (plan converged; reviewed plan written to description)

Plan Review
  -> Refine Ready             (human: plan needs more work)
  -> Implementation Ready     (human: plan approved, ready to build)
```

Why one stage and not two: a separate review stage would be a cold start that re-runs the whole codebase investigation on every refine/review bounce. Keeping review inline means the investigation runs once and the review/fix loop reuses that warm context. The observability you would get from a separate stage (what review caught) is preserved by posting every round's findings as comments.

### Detail check gate

When the refine agent picks up a ticket from Refine Ready, it first checks whether the issue contains enough information to produce a useful plan. Required details depend on issue type:

**Bug**: what is broken, how to trigger it, expected vs actual behaviour.
**Feature**: what the user should be able to do that they cannot do today.
**Chore/task**: what needs to change and why.

If any of these are missing, the agent:
1. Sets the issue status to Needs Detail.
2. Adds a comment listing exactly what is missing.
3. Does not proceed with refinement.

If details are sufficient, the agent:
1. Sets the issue status to Refining.
2. Proceeds with the full refinement skill.

### Self-review loop

Inside Refining, the refine skill dispatches the `plan-reviewer` agent against its own draft. Every round's findings (Critical/High/Medium/Low + verdict) are posted as a comment on the issue, before the fix is applied. This is the observability trail for tuning the refine skill: it shows what each draft got wrong.

The skill iterates (fix, re-review) until the plan is clean or the stop conditions hit (recurring findings, or a hard cap of 4 rounds). Then it writes the final plan to the description and sets Plan Review.

If the loop hits the cap with blocking findings still open, they go into the plan's Open Questions, a final comment flags them, and the issue still routes to Plan Review. The human decides whether to send it back to Refine Ready.

### On-demand re-review

The `review-issue` skill exists as a manual tool for re-reviewing a plan outside the autonomous flow (e.g. a human wants a fresh adversarial pass on an existing plan). It dispatches the same `plan-reviewer` agent and posts findings as a comment. It is not part of the autonomous pipeline.

### Plan Review gate

A human reviews the refined and reviewed plan before implementation begins. This is a deliberate checkpoint. The human can:
- Approve and move to Implementation Ready.
- Request changes and move back to Refine Ready.
- Add comments with feedback for the next refinement pass.

## Implementation phase

One autonomous stage, like refinement. The implement-issue skill codes the plan, then adversarially reviews its own diff inline (the `code-reviewer` agent, up to 4 rounds), posting every round's findings as a comment, then opens a PR and hands to the human gate.

```
Implementation Ready
  -> Implementation           (implement-issue skill picks up)

Implementation               (implement-issue skill, in a worktree off next:
                              code the plan -> tsc/build/lint/vitest must pass ->
                              code-reviewer self-review loop, every round's findings
                              posted as a comment, up to 4 rounds ->
                              if UI changed: ui-reviewer loop (up to 4 rounds), screenshots
                              attached to the issue ->
                              completeness-reviewer loop (up to 4 rounds): every acceptance
                              criterion mapped to evidence, INCOMPLETE -> fix -> re-review ->
                              push -> open PR vs next ->
                              start a live test server (setsid, own port) and post its URL)
  -> Code Review              (review clean, OR 4-round cap hit with unresolved findings)

Code Review                   (human opens the posted URL and verifies the feature)
  -> Accepted                 (human: feature is correct)
  -> Implementation Ready     (human: feature is wrong, with feedback; the leftover
                              test server + worktree are reaped on the next accept-issue run)

Accepted                      (accept-issue skill picks up:
                              reap orphans -> merge next into the branch, resolve conflicts ->
                              re-verify -> squash-merge PR into next -> kill server +
                              remove worktree)
  -> Done                     (merged and cleaned up)
  -> Code Review              (unresolvable conflict or post-merge breakage, with a comment;
                              review surface left in place)
```

Branches off `next`, in an isolated git worktree, PR targets `next`. Verify is `npx tsc --noEmit -p tsconfig.json`, `npm run build`, `npm run lint`, `npx vitest run`. The plan is the contract; deviations are recorded in the PR body, not improvised silently.

The worktree and test server are kept alive through Code Review so the human verifies the feature by clicking a URL rather than checking out the branch. The `accept-issue` skill (a scheduled job) owns teardown: it merges accepted issues and reaps the review surface of any issue that left Code Review without being accepted.

Why implementation+code-review is one stage: same reasoning as refinement. Reviewing inline keeps the context warm for fixing, and the findings comments preserve observability. The automated code-reviewer agent loop runs inside the `Implementation` status itself; there is no separate tracker status for it before the issue reaches the human `Code Review` gate.
