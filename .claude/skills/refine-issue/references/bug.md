# Bug template

## Explore guidance

Pass to the Explore subagent. Replace `<user's description>` with the actual bug description from the issue.

> Investigate this reported bug so we can write a plan detailed enough to hand to another agent.
>
> Bug description: `<user's description>`
>
> Find:
> 1. The buggy code itself: file paths, line numbers, function/symbol names.
> 2. All call sites that exercise the buggy path (blast radius).
> 3. Related code that might share the same root cause. Check for parallel implementations: a v1/v2 codepath, a legacy fallback, a desktop vs web variant. The fix may need to land in more than one place.
> 4. Recent commits that touched the buggy code (`git log` on affected files, last 5-10 commits per file).
> 5. Tests that cover this area and whether they currently pass.
>
> Report file paths, line numbers, short snippets, and commit SHAs. Do not propose a fix.

## Template sections

After the standard Request section, bug plans include these sections. Fill placeholders with Explore findings and file reads. Do not leave placeholders in the output. Sections marked `(optional)` should be omitted if no content exists rather than left empty.

### Summary
Structured fields:
- **Context**: what the user/system was doing when the bug occurs, and the conditions that trigger it
- **Bug**: one-line statement of what is wrong
- **Actual vs. expected**: **Actual**: what happens. **Expected**: what should happen.
- **Impact**: who is affected and how badly (frequency, data loss, blocked workflows)

### Code with Bug
One or more code blocks from the real files, each preceded by `path/to/file.ext:line` so the reader can jump straight to it. Annotate the buggy line(s) with `// <-- BUG` (or the language equivalent) and a short note. Include enough surrounding context that the snippet is readable in isolation.

### Explanation
Step-by-step walkthrough of why the bug happens. Reference the snippets above. Cover the call path from user action to the buggy line. If the bug only manifests under specific conditions (rehydration, concurrency, specific input), spell those out.

### Codebase Inconsistency (optional)
Related code that shows the same root cause or a contradictory assumption. Use only when there is something concrete to point at.

### Reproduction
Commands to trigger the bug. Observed output (verbatim). Expected output. Re-runnable recipe, not dependent on a scratch dir surviving.

### Root cause
Confirmed (with evidence) or hypothesis (with reasoning). If regression, include the introducing commit SHA and what it changed.

### Recommended Fix
The smallest change that fixes the root cause. Show a code snippet of the proposed fix per file. Note follow-up call sites that need updating to stay consistent.

### History (optional)
Commit SHAs and short messages for commits that introduced or last touched the buggy code, with a one-line note on what each did.

### Edge Cases
Bullet list of other ways the same root cause could manifest that the fix must also cover.

### Testing
Specific tests the agent should write or update. For each: test file path + scenario + assertion.

- `path/to/file.test.ts` -- given <input>, when <action>, expect <result>
- `path/to/file.test.ts` -- error path: when <failure>, expect <observable behaviour>

### Out of Scope
Things people might assume are included but are not.

### Acceptance Criteria
Testable statements, checkboxes. Keep each item free of inline code (no backticks). Use the bare identifier name instead if you need to mention one.

- [ ] Observable behaviour that proves the bug is fixed
- [ ] Regression test added or updated, with the test file path
- [ ] Any related call sites updated for consistency, with paths

### Open Questions / Assumptions
Anything unverified. Unresolved adversarial findings go here.
