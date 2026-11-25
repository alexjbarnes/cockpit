# Workflows

A workflow says what happens to a project's issues at each status on its board. At some statuses nothing happens. At others an issue queues for an agent, an agent works on it, or it waits for you. Moving an issue into a queue is what starts things: an agent picks it up, does the work, and moves the issue on to whatever comes next, which may be another agent or you.

Workflows are experimental. Turn the issue tracker on in Settings → Appearance, then open Settings → Workflows and turn on **Switch workflows on**.

## The shape of it

A project uses either its own workflow or a reusable one it selects. Either way the statuses are the project's own board, in board order, and a reusable workflow's statuses are added to every project using it. Every status is one of four things:

- **Nothing happens.** The issue stays until someone moves it. Backlog and Done are usually this.
- **A queue for an agent.** Issues wait here. When an agent is free, Cockpit moves the issue to the status the queue points at, where the work happens. The board then shows waiting and working apart.
- **An agent works on it.** While the issue is in this status an agent runs one of the project's skills on it. The status lists where the issue may go when the agent finishes. Moving it to one of those is how the agent's work ends, and the only status change it is allowed.
- **It waits for you.** Its choices are buttons on the issue. If it is where the plan is reviewed, approving the plan or sending it back makes the move.

A typical one:

| Status | What happens | Then the issue goes to |
|---|---|---|
| Refine Ready | Queue for an agent | Refining |
| Refining | An agent runs `plan-issue` | Plan Review, or Needs Detail |
| Plan Review | Waits for you | Implementation Ready, or back to Refine Ready |
| Implementation Ready | Queue for an agent | Implementation |
| Implementation | An agent runs `implement-issue` | Validation |
| Validation | An agent runs `validate-issue` | Code Review, or back to Implementation Ready |
| Code Review | Waits for you | Accepted, or back to Implementation Ready |
| Accepted | An agent runs `merge-issue`, one at a time | Done, or back to Code Review |

A status an agent works in does not need a queue in front of it. Without one, issues that arrive wait and are worked in the same status, as Validation and Accepted are above, and the issue's badge says whether it is queued or running.

An issue you put by hand straight into a status an agent works in, when that status has a queue, is not picked up by itself. Its page says nothing is working on it and offers to queue it.

## Reusable workflows

When several projects should work the same way, define the workflow once. **Settings → Workflows → New** creates a reusable workflow outside any project. Give it a name, then set what happens at each status exactly as for a project's own workflow.

A project selects one in **Settings → Projects**, under **Workflow**, or from the source card on its workflow page. Selecting one adds the workflow's statuses to the project's board and stops using its own workflow, which is kept and comes back if the project stops using the shared one.

A status added to a reusable workflow is added to every project using it. Nothing is ever removed from a project's board, so an issue in a status the workflow no longer names is not orphaned. A project whose custom status differs from the shared spelling only by case is refused when it selects the workflow, because the shared spelling cannot be changed for one project.

Both limits count in each project. **Issues worked at once** is per project using the workflow, and a status's **At once** is per project too. **Run this workflow** is the exception: switching it off pauses every project using it.

A reusable workflow that a project still uses cannot be removed. Switch those projects to their own workflow first.

## Skills

An agent does its work by running a skill from the project's own repo: a folder under `.claude/skills` with a `SKILL.md` in it. The skill is the project's own description of how that work is done, so it is versioned with the code and can name the repo's branches, commands and conventions. If the repo, or the issue's worktree, has no skill of that name, Cockpit falls back to your user skills at `~/.claude/skills/<name>/SKILL.md`, which Claude Code loads in every session. The repo's copy wins when both exist. If neither has it, nothing starts there, and the workflow page says which skill is missing and where to add it.

A skill a workflow runs has nobody watching it, so it must:

- take the issue it is told the key of, and no other;
- read the issue with `get_issue`: the description is the requirement, `plan` the plan with any review feedback, the comments what came before;
- work in the directory it is given, and make no worktree or branch of its own;
- write the plan with `set_issue_plan`, if planning is its job, and leave the description alone;
- ask no questions;
- finish by moving the issue with `update_issue` to one of the statuses it is told it may use, and say itself which of them fits which outcome.

If the agent works in the issue's own worktree (see below), a repo skill must be committed and on the project's base branch, since the worktree is cut from it. A user skill is available in the worktree without being committed.

## Setting one up

1. **Settings → Projects.** The project needs a repo path, which is where its skills are read from. Choose **Workflow**: its own, or a reusable one.
2. **Settings → Workflows.** Press **Set up** beside the project. Its page lists the project's statuses. Press a status and say what happens there. A reusable workflow is edited from its own card instead, once for every project using it.
3. Create an issue and move it to the first queue, or press the button on its page that does.

A project with nothing set yet can copy another project's workflow, or a reusable workflow can copy one. It arrives as unsaved changes, so you can read it before it runs. A status the workflow names that the project does not have is added to its board when you save.

### Or ask an agent to

Everything on those pages can be set through Cockpit's tools, so an agent working in a project's repo can write the skills and set the workflow up:

- `list_workflows`: every project, where its workflow comes from, and whether it has one.
- `get_workflow`: one project's effective workflow, its statuses in board order, the skills it can run, and what stands in the way of it running.
- `update_workflow`: create or change a project's own workflow, or select a reusable one with `reusable`. Statuses merge by name, and `null` clears one.
- `delete_workflow`: remove a project's own workflow.
- `list_reusable_workflows`: every reusable workflow and the projects using it.
- `get_reusable_workflow`: one reusable workflow, the projects using it, its skills and what each project is missing.
- `update_reusable_workflow`: create one, or change it. Its changes reach every project using it.
- `delete_reusable_workflow`: remove one that no project uses.

These are for the assistant and for sessions of yours. An agent a workflow started cannot change the workflow it is running in. Turning a workflow on, and widening what its agents may do, are your decisions. One reusable workflow can reach many projects at once, so check its permissions as carefully as you would a job's.

## The plan

An issue's plan is its own document, kept beside the description. The description stays the requirement as you wrote it.

An agent writes the plan and hands the issue to you. Open it from the issue's Plan section: select text to comment on it, mark it for removal or suggest a replacement, add notes on the whole plan, or edit it directly. Then approve it, with your notes carried into the plan, or send it back. Sent back, the agent revises it and you get the next version with what changed marked, and every earlier version with its notes is still there to open and compare.

## Pictures

A comment and a plan can carry pictures. An agent writes one as a markdown image whose target is the file's absolute path, with a caption: `![Settings at phone width](/tmp/shots/settings-phone.png)`. Cockpit copies the file into the issue, shows it where it was written, and opens it full size over the page when you press it. PNG, JPEG, GIF and WebP.

Two uses are worth writing into a project's skills. The agent that builds or checks a change puts its screenshots in the comment that hands the work over, so you can judge it from the issue without opening a running copy. The agent that plans can offer designs to choose between, one captioned picture each: select a caption in the plan review and comment on it to say which you want.

An agent that reads the issue later is given each picture as a file it can open.

## How many at once

Three limits apply together:

- **Agents working at once** in Settings → Workflows: across everything. Each is a full Claude session, about 350 MB.
- **Issues worked at once** on a workflow, counted in each project using it. A reusable workflow's number is per project, not shared between them.
- **At once** on a status an agent works in: for work that must not overlap, such as merging. In a reusable workflow it is also per project.

Issues waiting are taken most urgent first, then in board order, then oldest.

An agent set to work in **the issue's own worktree** gets a git worktree and branch for that issue, which every agent on the issue shares. That is what lets several issues be worked in one repository at once. Cockpit makes it on the first run, starting from the project's base branch, and removes it when the issue is Done or Cancelled. The branch is left. Each run also gets a port of its own in `$COCKPIT_RUN_PORT`, for a skill that starts a server.

An agent can also be set to **carry on in the same session** when an issue comes back to its status, so a plan sent back is revised by the session that wrote it.

## When a run does not end well

- A session that stops without moving its issue is asked once to finish.
- A run that fails is tried again, as many times as its status allows.
- After that, or when a run uses up its time, the issue is **held**: it goes back to the queue it came from, it shows the reason, it is in your inbox, and nothing more starts on it until you press **Run it again** or move it yourself.
- Two statuses that keep sending an issue back to each other are stopped after five runs, and the issue is held. Sending it back yourself starts the count over.
- You can **Stop** a run from the issue, which holds it too, or **Watch** it: a run's session is an ordinary session you can open.

**Pause**, on the issues page and in Settings, holds every workflow. Runs already going finish.

## Following an issue

The issue's page has a track with one bar for each status where something happens to it, in order. Bars it has passed are ticked, and the one it is at is coloured: blue while an agent has it, amber when it is yours, red when it is held. Press a bar to see what that status is. Under the track is what is happening now, with the buttons that go with it.

On the issues list and the board, each status's heading says what happens there (a queue, the skill an agent runs, or yours), and each issue carries a mark: queued, running, yours or held.

## Permissions

An agent works with nobody watching, so choose what its session may do:

- **Everything.** Nothing is asked.
- **Only what I list.** The tools and MCP servers you list, and nothing else. The session carries on without what it was refused.
- **Ask me.** Each permission prompt comes to you, on the session and by notification, and the run waits.

The session can always run its skill and reach the issue it is working on: read it, comment, attach, write its plan, and move it to one of the statuses its workflow lists. It cannot move any other issue, and it cannot change workflows, jobs or settings.

## Scheduled jobs and workflows

A job set to run "On issue status" still works for projects without a workflow. For a project whose workflow is on, the workflow does the work and such a job is not started for its issues.
