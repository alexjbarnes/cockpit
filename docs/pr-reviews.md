# Pull request reviews

Cockpit is a code review surface for GitHub PRs. Browse your orgs, pick a repo, pick a PR, and start a review session backed by Claude.

## Browsing

The Reviews page is at `/reviews`. The flow:

1. Pick an organization. Cockpit caches the org list per device.
2. Pick a repository. Search by name or description. Results show language tag and last push time.
3. Pick a pull request. The PR list shows title, author, status checks, and last update.

Filter PRs by status (open, closed, merged, draft). Search across title and body.

## Review session

Opening a PR creates a Claude Code session at `~/.cockpit/reviews/`. The diff is fetched from GitHub via the `gh` CLI, not by cloning the repo. The first message Claude receives is `/review` with the PR context attached, so it starts a structured review immediately.

Review sessions are kept out of the main sessions list to avoid clutter. Resume them from the Reviews page or the sidebar on any device. Active reviews are pinned to the sidebar's Reviews section with status beacons showing whether Claude is working, waiting for input, or idle.

## Review UI

The review view splits into three regions:

- Sidebar with PR description, changed files, and reviews
- Diff for the active file
- Chat panel for talking with Claude about the change

The PR description is collapsible. Long descriptions truncate to 10 lines with a "Show more" toggle.

Changed files list below the description. Each file shows an icon for its change type (added, modified, deleted). Files you have viewed are dimmed with a checkmark. Click a file to load its diff.

Diffs load lazily as files come into view. Full file content is fetched from GitHub so the diff renders with complete context, not just the patch hunks. The diff uses the merge base SHA for accurate comparison, falling back to the base branch ref when the merge base is unavailable.

Diff rendering uses the same component as the chat view (split or inline per Settings).

## Check status

Cockpit polls PR check runs and surfaces failures inline. Use this to see if CI broke before reviewing further.

## Visibility

The Reviews section in the sidebar and the Reviews page can be hidden entirely with the "Reviews" toggle in Settings. Useful if you don't use GitHub PRs.

## Authentication

Reviews relies on the [GitHub CLI](https://cli.github.com/) (`gh`). Install it on the machine running Cockpit and run `gh auth login` once. Cockpit shells out to `gh` for org listings, repo lookups, PR data, and diffs.
