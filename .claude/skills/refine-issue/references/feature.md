# Feature template

The Feature template is the most detailed because features are the ones most likely to be handed to a coding agent cold. The bar: an agent should read this plan end-to-end and start writing code without asking a single follow-up question. Quote real snippets from the Explore findings. Do not paraphrase. Drop sections marked `(optional)` only when they genuinely do not apply, not as a shortcut.

## Explore guidance

Pass to the Explore subagent. Replace `<user's description>` with the actual feature description from the issue.

> Investigate the codebase to inform a feature plan that will be handed to a coding agent with no prior context. The agent should not need to ask follow-up questions, so be thorough and quote real code.
>
> Feature description: `<user's description>`
>
> Find and report:
> 1. **Location and parallel implementations**: which files/modules this feature most naturally belongs in. If new files are needed, where they should sit (path + reason). Is this behaviour implemented in more than one place: a parallel backend, a desktop vs web variant, a v1 vs v2 codepath, a legacy fallback? Duplicated implementations are a common cold-start trap; surface all of them so the plan can decide whether the change applies to one or all.
> 2. **End-to-end round-trip trace of the nearest analogous feature**: pick the closest existing feature with the same shape. Trace it end-to-end in both directions, naming every link with a file path and a quoted snippet:
>     - **Outbound:** user action / event -> hook or handler -> request body assembly -> request validation -> server route / handler -> state mutation.
>     - **Inbound:** server response / event -> client handler -> store setter -> UI render -> persistence.
>     Every link must be quoted from the real file, not paraphrased. Most cross-cutting pattern bugs come from one direction being traced thoroughly and the other being assumed. If 1-2 additional features are worth a brief mention for a specific aspect, list them with a one-line snippet, but the round-trip trace above is the priority.
> 3. **Existing types / models**: TypeScript interfaces, DB schemas, GraphQL types the new feature will produce, consume, or extend. Quote actual definitions with file paths.
> 4. **API patterns**: how endpoints are defined today (router file, request validation, response shape, error handling). Quote a representative example.
> 5. **UI patterns** (if applicable): how components are structured (state management, styling system, form patterns). Quote a representative example.
> 6. **Tests**: test file location convention, framework, a representative test for a similar feature. Quote it.
> 7. **Telemetry / logging**: how the codebase emits events/metrics/logs today. Event name conventions, payload shape, file where events are defined. Quote an example.
> 8. **Configuration / feature flags**: how feature flags or runtime config are wired. File path + example.
> 9. **Dependencies and call sites**: other code that calls into modules this feature will touch and may need to update.
> 10. **Constraints / gotchas**: non-obvious rules (auth requirements, perf budgets, persistence rules) the implementer must respect.
>
> For every item, include the file path and a short real snippet, not paraphrased. If something does not apply (e.g. no UI for a backend-only feature), say so explicitly rather than skipping silently.

## Template sections

After the standard Request section, feature plans include these sections. Fill placeholders with Explore findings and file reads. Do not leave placeholders in the output. Sections marked `(optional)` should be omitted if no content exists rather than left empty.

### Context
What we are building and why. One short paragraph. Include the user-visible goal and any constraint shaping the design (deadline, dependency, compliance, prior decision, related ticket).

### Goal
One-line statement of done. "After this ships, the user can do X that they could not do before." If it is a backend-only change with no user-visible effect, state the system-level outcome instead.

### User-Facing Behaviour
Step-by-step description of what the user (or calling system) experiences:
- The trigger (what the user does, or what event fires)
- Intermediate states (loading, optimistic updates, validation)
- End state (what the user sees or what the system has done)
- Empty / no-data state
- Error states (what is shown when things fail, and what is retried vs surfaced)

### Current State
The parts of the codebase the implementer must read first to orient. For each: file path + one-sentence summary + a short snippet if the agent will need to read or modify it.

```
`path/to/file.ext`
<short real snippet>
```

### Relevant Types / Models
Existing types/models the new code will consume or extend, quoted from actual files with file paths. Skip only if the feature truly introduces no new data or interacts with no existing data structures.

### Data Model Changes (optional)
New types, schema changes, migrations. Concrete definitions, not prose. Specify field types, nullability, defaults, indices. Note backwards-compatibility requirements.

### API Surface (optional)
New endpoints or public functions. For endpoints: method + path + request schema + response schema + error responses. For functions: full signature + behaviour contract + thrown errors.

### UI Changes (optional)
Which screens/components change and how. For new components: where they live, which existing component to model on (with path), what props they take. For modified components: which props/state change. Include an ASCII layout or reference an existing screen if the visual structure is non-obvious.

### Implementation Plan
Numbered list, each pinned to a file path with symbol names. Precise enough that an agent can write the diff without further investigation.

1. `path/to/file.ext` -> `symbolName`: exact change description
2. `path/to/new-file.ext` (new): intended shape, reference `path/to/reference.ext` as the pattern to model on
3. ...

### Implementation Order
Which change unblocks which, where to start, where the risk lives. Natural commit boundaries. Work that can be done in parallel.

### Reference Patterns
Existing code the implementer should model on, with paths and short snippets. Cover the patterns relevant to the feature: component shape, handler shape, test shape. This is critical for agent handoff: the agent must see what good looks like in this codebase, not generic best practice.

### Edge Cases & Error Handling
Bullet list of cases the implementation must handle:
- Empty / null / missing input
- Concurrent or out-of-order events
- Network or upstream failure: what is retried vs surfaced vs swallowed
- Backwards compatibility with existing data or callers
- Permissions / auth failures
- Feature-specific failure modes

### Testing
Specific tests the agent should write. For each: test file path + scenario + assertion.

- `path/to/file.test.ts` -- given <input>, when <action>, expect <result>
- `path/to/file.test.ts` -- error path: when <failure>, expect <observable behaviour>

### Telemetry / Observability (optional)
Analytics events, log lines, metrics the new feature should emit. Include the event/metric name, payload shape, and where it should be emitted from. Reference the codebase's existing telemetry helper.

### Rollout (optional)
Feature flag (name + default value + where it is read), gradual rollout plan, backfill steps, data migration order. Skip if the change is safe to land directly.

### Risks / Dependencies (optional)
Things that could break, prerequisite work that must land first, cross-team coordination needed.

### Out of Scope
Things people might assume are included but are not. Stops scope creep at implementation time.

### Acceptance Criteria
Testable statements, checkboxes. Keep each item free of inline code (no backticks). Use the bare identifier name instead if you need to mention one.

- [ ] Each user-facing behaviour from above is implemented and verifiable in the running app
- [ ] Each edge case above has corresponding handling and a test
- [ ] Each test scenario above is implemented and passes
- [ ] Telemetry events fire as specified, verified in dev tools or log output
- [ ] Any non-functional requirement: performance budget, accessibility, bundle size limit
- [ ] If behind a feature flag: flag exists, default is correct

### Open Questions / Assumptions
Anything unverified. Unresolved adversarial findings go here.
