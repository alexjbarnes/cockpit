# Design Decisions

Deliberate UI/UX choices that should not be undone without discussion.

## Mobile Header

The page title is intentionally hidden on mobile (`hidden md:block`) in the app shell header. Session names take priority in the limited header space. The bottom nav bar and page content provide enough context for which page the user is on.

## Diff Viewer Checkboxes

In the changes view (not PR review), checkboxes mean "staged for commit". They sync between the sidebar file list and the diff headers. Checking a file in the diff header stages it and collapses the diff. This is distinct from a PR review context where checkboxes would mean "reviewed".

## Pierre Diffs: FileDiff over PatchDiff

We use `FileDiff` with `parsePatchFiles` + full file contents (`oldLines`/`newLines`) instead of `PatchDiff`. PatchDiff can never show expand buttons because `DiffHunksRenderer.js` checks `ast.hunks == null` and PatchDiff always has hunks. See `docs/pierre-diffs.md` for details.

## Chat Width as Ratio

The chat panel width in changes view is stored as a ratio (0.15-0.5) instead of fixed pixels. This ensures both panels scale proportionally when the browser window resizes.

## Refresh Button Fetches from Remote

The manual Refresh button in changes view calls `git fetch` before `git status`. Auto-refresh (triggered after Claude completes a turn) skips the fetch to stay fast.

## Orgs API Includes Personal Account

The GitHub orgs endpoint always includes the authenticated user's personal account first, then any org memberships. If `read:org` scope is missing, it falls back gracefully to just the personal account instead of showing an error.

## WebSocket Message Acknowledgment

The server sends an immediate `message:ack` when it receives `message:send`. The client clears its inflight queue on ack rather than on `session:status`. This prevents duplicate message sends if the WebSocket drops between send and status update.

## Session Compacting State

The server tracks `session.compacting` and re-sends `__compact::start` to clients that connect mid-compaction. This ensures the compacting indicator survives page navigation.
