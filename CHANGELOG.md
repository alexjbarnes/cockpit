# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-06-13

### Added
- **Fable 5, with a model/thinking/context pill.** The chat input gained Fable 5 as a selectable model, an "off" thinking level, and a compact pill showing the session's current model, thinking level, and context window — tap it to switch any of them inline. The model picker also drops the redundant model-id text from each row and always shows the version pills (a single pill for a single-version model).
- **Open-session buttons in search.** Each global-search result and the message-context view now have a button that jumps straight into that session.
- **Scroll position persists across navigation.** Every list page (sessions, settings, jobs, reviews, inbox, skills, commands, agents, hooks, MCP servers, plugins) restores its scroll position when you leave and return, instead of snapping back to the top. Search results also keep their scroll when you close the message-context view.

### Fixed
- **Cockpit wedged after a Claude CLI self-update.** Cockpit resolved the `claude` binary once and cached it for the server's lifetime. When the CLI self-updated and deleted the old versioned binary, every new session then failed to spawn with `claude exited during startup … execvp: No such file or directory` until cockpit was restarted. The cached path is now re-validated and re-resolved when it no longer exists.
- **Unsaved custom-provider model dropped on Save.** On the provider editor's Models tab, a model you typed but hadn't committed with "+ Add model" (or an in-progress inline edit) was silently lost when you clicked the bottom Save. Both are now folded into the provider on Save.
- **Session delete after "Load all".** Deleting a session in a folder expanded with "Load all" appeared to do nothing — the session was deleted on disk but the expanded list kept a stale copy until a reload. The list now refreshes after a delete. The per-row delete control is also always visible on mobile instead of only on hover.
- **Model and thinking level reverting across a restart.** The `/model` slash command and the cockpit assistant's model/thinking selections now persist across a server restart instead of reverting to a stale or default value.
- **Continuing a cleared or compacted session from history.** Sending from a history view now continues the exact transcript link you are viewing instead of diverging to the conversation's head, so new turns no longer disappear on refresh.
- **Duplicate thinking strips on Fable turns.** Fable emits several thinking blocks per turn; the transcript rendered each as its own strip. Adjacent thinking blocks are now coalesced into one.
- **Keyboard access for search and session cards.** Search results and session rows were invalid button-inside-button markup; they are now proper controls that activate with Enter or Space and keep their secondary actions (open, copy, delete) working.

## [0.4.0] - 2026-06-11

### Added
- **Cockpit Assistant.** An AI agent embedded in cockpit, opened from a modal anywhere in the app, that inspects and changes cockpit's own configuration through conversation instead of clicking the UI. It runs as a single persistent session backed by a `cockpit-config` MCP server. Read tools (list/get) answer questions about your jobs, providers, MCP servers, app settings, and notification settings and run automatically. Write tools (create/update/delete/run/stop a scheduled job, add or edit providers, MCP servers, settings, and notification providers) are shown as a proposal card you approve or reject before anything changes. It can also run a job now, stop a running one, and tell you which jobs are currently running.
- **Plugin management.** A new Plugins page (under Settings) for managing Claude Code plugins. The Installed tab lists your plugins with version and scope and lets you enable, disable, or uninstall each one. The Browse tab searches the marketplace catalog and installs any plugin (user scope) in one click. The Marketplaces tab lists configured marketplaces and lets you add one (from a GitHub repo, URL, or local path), update it, or remove it. Every action runs the CLI's own `claude plugin` commands, so install/git logic and the security blocklist stay owned by the CLI rather than reimplemented in cockpit.
- **Stop a running job.** A Stop Now button on the job, run-detail, and run-history views ends an in-flight scheduled run, exposed to the assistant as a `stop_job` MCP tool. Stopped runs record a `stopped` status distinct from failure.
- **MCP tool discovery in the job editor.** A scheduled job can list a configured MCP server's tools and pick which ones to allow, instead of typing tool names by hand. MCP servers also gained a detail view with inline actions.
- **Fuzzy search in the slash and mention menus.** The `/` command menu and `@` agent/skill mention menu now match by subsequence, so a few characters surface the right skill or agent without an exact prefix.
- **Image previews in the file viewer.** Opening an image (PNG, JPEG, GIF, WebP, SVG, BMP, ICO, AVIF, APNG) now renders the image instead of showing "Binary file". Bytes are served from the file-read endpoint with a sandboxed content-security-policy, so an opened SVG can't execute scripts.
- **Edit/Preview toggle in markdown editors.** Multi-line markdown fields (job prompts and similar) switch between raw editing and a rendered preview.
- **Inbox read/unread toggle.** The inbox header now toggles all messages between read and unread, rather than only marking them read.

### Changed
- **Full-bleed layout.** Settings sub-pages (Sessions defaults, Appearance, Model providers, the provider editor) and the main sessions feed now use the full window width instead of a centred mobile-width column, matching the inbox and other full-container screens.
- **Scheduled-job sessions hidden from the all-sessions feed.** The feed no longer lists the throwaway sessions a scheduled job spawns on each run; reach them from the job's run detail instead. Filtering is by the run's recorded session id, so it catches job sessions regardless of name.
- **Job form clarity.** The job edit form renames "Active" to "Enabled", moves the toggle to the top with a paused hint, and shows a Running indicator when a job is triggered manually.
- **Provider env template no longer seeds `CLAUDE_CODE_EFFORT_LEVEL`.** The add/edit provider screen used to pre-fill this variable, which forces a `reasoning_effort` some providers reject (it broke subagent spawns on, for example, a Deepseek-backed provider). New providers start without it; see `docs/providers.md` for the subagent/effort-level interaction.
- **Run history polish.** A job's run-history list now uses uniform-width status pills (Success/Failed/Timeout/Running), and shows durations over a minute as `Xm Ys` instead of raw seconds.

### Removed
- **Standalone `/files` and `/changes` pages.** These full-page viewers predated the tabbed session view and had no reachable entry point left in the UI. File and changes viewing now happens entirely in session tabs. Bookmarked `/files?…` or `/changes?…` URLs no longer resolve.

### Fixed
- **Notifications dropped intermittently.** A push (ntfy or Telegram) was a single fire-and-forget request with no timeout, so one hung socket, rate-limit, or network blip silently dropped the alert even though the inbox entry had already persisted. Delivery now retries transient failures (network errors, timeouts, 429, 5xx) up to three times with a per-attempt timeout, and fails fast on configuration errors. Applies to both ntfy and Telegram.
- **Custom-provider model ID reaching the CLI with a provider prefix.** A custom-provider session could spawn with a qualified id like `<provider-id>:openai/gpt-oss-20b` passed to `--model`, which the CLI rejected. The root cause was cockpit's two module graphs (the custom server and the Next.js API routes) each caching `providers.json` independently, so a provider saved through one was invisible to the other until a restart. The cache now reloads when the file changes on disk.
- **Legacy custom-provider models.** Models saved with an older bracketed suffix (for example `[1m]`) are now read and resolved cleanly instead of being passed through verbatim.
- **Session-settings provider dropdown.** The provider picker in the in-chat session settings now resolves to the session's current provider instead of defaulting to the first one.
- **PTY initial prompt occasionally lost.** When the `UserPromptSubmit` hook didn't arrive, a scheduled job's (or session's) first prompt could silently never run. Cockpit now confirms delivery against the transcript and resends on a miss.
- **Stray "hi" sessions.** The CLI init probe no longer leaves throwaway "hi" sessions behind in the list.
- **node-pty process leak on job completion.** Each job completion now destroys its session, so PTY-backed job runs no longer accumulate leaked processes.
- **Transcript file-descriptor leak.** Transcript read streams are now closed after use.
- **Slash-command handling in PTY sessions.** CLI-only commands no longer hang the session on "processing" or open a panel cockpit can't render. Interactive dialogs (`/config`, `/mcp`, `/agents`, …) and local actions (`/usage`, `/release-notes`, …) are blocked with a short explanation; model-invoking commands (`/review`, custom skills) still pass through and `/compact` is forwarded as before. The old hand-maintained blocklist was stale (listed commands that no longer exist), incomplete (missed real ones), and ignored aliases. Routing is now driven by a classification generated from the installed CLI binary (`scripts/gen-cli-commands.mjs`), so it covers aliases — `/rc`, `/bg`, `/stats` route like their canonical command — and regenerates with one command after a CLI upgrade.
- **Context gauge wiped to 0 on Stop or a killed turn.** Interrupting a turn (or one ending before any response) writes an assistant message with an all-zero usage block; the gauge took that verbatim and dropped to 0 until the next turn. Zero-usage readings from cancelled turns are now ignored, so the gauge holds the last real value.
- **1M context window silently forced to 200K.** If `CLAUDE_CODE_DISABLE_1M_CONTEXT` was present in cockpit's own environment (for example exported in the shell that launched it), selecting 1M had no effect — the 200K spawn path set the override but the 1M path never cleared an inherited one, so every CLI ran at 200K regardless of the per-session pick. Both spawn paths now make the session's context-size choice authoritative: 200K sets the flag, 1M removes it.
- **`/context` in PTY sessions.** The command is now forwarded to the CLI (showing its live per-category breakdown and the actual window) instead of cockpit's readout of the picked size. If the CLI isn't running yet — for example right after a context-size switch — it spawns one so the breakdown is consistent rather than silently falling back to a one-line estimate. It no longer leaves the session stuck on "processing", and ANSI colour codes are stripped from the output.
- **Post-compaction context gauge in PTY mode.** After compaction the context-usage gauge briefly dropped to its 10% best-guess estimate and then snapped straight back to the pre-compaction figure, so PTY sessions never showed the reduction that stream sessions did. The transcript watcher recomputes "used" from the most recent assistant turn, which right after a compaction is still the large pre-compaction one until the next reply lands. Transcript usage now resets at the compaction boundary, so the estimate holds until a real post-compaction turn arrives.
- **Mobile terminal shortcut bar.** The Esc/Ctrl/Tab/arrow-key bar above the soft keyboard in the in-session terminal had stopped appearing. Keyboard-open detection compared the visual viewport against the live layout viewport, but the app's `resizes-content` viewport shrinks both together, so the ratio never tripped. Detection now measures against the tallest height seen.
- **File links open in a tab.** The "Open in editor" link on a diff or changes panel now opens the file in a session tab, matching file links in tool cards and the file tree.
- **Empty red pill on the Jobs page.** A directory's failed-job count rendered as an empty red pill — the `destructive-foreground` theme token was set to the same red as its background, so the "N failed" text was invisible. The token is fixed and the badge now uses the shared destructive `Badge` component.
- **`--resume` after a restart or model change.** Resolves the conversation to resume from the on-disk transcript, so the first message after a restart or model switch attaches to the right session.
- **Terminal scrollback on detach.** Corrected the detach-offset trim math and scoped the detach to the closing socket, so one client disconnecting no longer truncates another's scrollback.
- **Clearing job duration and retention fields.** The max-duration and retention number fields can be cleared while editing without snapping back to 0.
- **Pasted text in queued messages.** A queued message that flushes now shows pasted text as a chip instead of expanding to the full pasted file content.
- **Misc layout.** Job card title spans the full width; settings version cards keep their height while loading (no jump); the all-sessions header shows only the usage icon; tool-card messages fill the column width; the new-session dialog keeps its action button visible on small viewports; run-detail action buttons wrap on mobile instead of overflowing; plugin card names stay readable on narrow screens; and clicking a file path in a tool card no longer nests a button inside a button.

### Internal
- **Linear issue pipeline.** A refine → implement → accept workflow lives in `.claude/skills`, with adversarial reviewer agents (plan, code, ui, completeness) in `.claude/agents`. The implement and accept stages run functional verification against a live test server and gate on CI.
- **Repo skills.** A `browser-test` skill (isolated dev server plus Playwright for UI checks) and a `/regen-cli-commands` skill that regenerates the PTY slash-command classification from the installed CLI.
- **In-process cockpit-config MCP server.** Converted from a stdio child process to an in-process HTTP server.
- **Debugging.** Debug-gated tracing across the job-run and PTY spawn lifecycle, and TUI screen snapshots around initial-prompt delivery.
- **Dev correctness.** The shell-cache service worker is disabled in development so source changes show up without a hard reload, and `@pierre/diffs` is pinned to 1.2.2 (1.2.9 pulled an unpublished transitive dependency).
- **Tests.** Broad additions across the assistant, cockpit-config server, fuzzy search, job display, providers, notifications, session manager, and transcript paths, plus replacing fixed-sleep races with `vi.waitFor`.

## [0.3.1] - 2026-05-30

### Fixed
- **Structured questions getting stuck (rendering).** A follow-up `AskUserQuestion` asked right after the previous one was answered now renders instead of staying hidden (blue sidebar status, no prompt) until you pressed stop.
- **Structured questions getting stuck (slow answers).** Answering a question more than five minutes after it appeared (for example after switching browser tabs) no longer hangs the session. In PTY mode the hook bridge held the CLI's blocking permission request open with the global `fetch`, which Node aborts after a five-minute headers timeout, so a late answer landed on a dead connection and the CLI waited forever. The bridge now uses a plain HTTP request with no such ceiling, waits as long as the CLI's own permission timeout, and always returns a decision so the CLI can never hang without one.

## [0.3.0] - 2026-05-30

### Added
- **PTY runtime mode.** A second session runtime that drives the real Claude Code CLI through a pseudo-terminal (node-pty), alongside the default streaming-JSON mode. Pick it per session from the new-session dialog or the session-settings runtime switcher; the choice persists across server restarts. Behind it sits a hook bridge that translates CLI hook events (PreToolUse, PostToolUse, Stop, StopFailure, UserPromptSubmit, UserPromptExpansion, SubagentStart, SubagentStop, Notification, PermissionRequest, PreCompact, PostCompact) into live UI updates.
- **Transcript-driven PTY rendering.** PTY message content is sourced from the CLI's JSONL transcript via a file watcher, so live rendering matches what you see on reload.
- **Attachments in PTY mode.** Image and document attachments work in PTY sessions.
- **PTY API-error detection.** A StopFailure hook plus a debounced output scan surface API errors instead of leaving the spinner stuck.
- **Compaction progress.** The UI shows COMPACTING for both manual `/compact` and automatic compaction (PreCompact/PostCompact hooks).
- **Background tasks from subagents.** SubagentStart/Stop populate the background-tasks button with agent type and description.
- **Multi-provider support.** Configure custom Anthropic-compatible providers (base URL, auth token, env vars) each with their own model list. Manage them from the settings provider list and a dedicated provider editor page. Models resolve through a provider-aware picker, and the in-chat session-settings popover shows each provider's models, effort levels, and context sizes.
- **Per-slot models.** Separate main / subagent / fast model slots (`modelSlots`), switchable over the WebSocket `set_model` path.
- **Selectable context window size.** Choose 200K or 1M context per session on models that support it, shown as inline pills in the model selector and chat input. Replaces the previous extended-context boolean.
- **Opus 4.8.** Added as the default Opus model (with `xhigh` effort); Opus 4.7 retained as a selectable previous generation.
- **Embedded terminal.** xterm.js terminal panels with mobile keyboard support and Nerd Font glyphs. A settings modal offers 10 themes, font size, and scrollback; terminal instances are cached across tab moves so scrollback survives.
- **Tabbed session view.** File, diff, and changes tabs in a split-pane layout, with cross-pane tab dragging. Tabs persist across refreshes.
- **Clickable file paths.** Tool cards link file paths to their diff/file tab, with scroll restoration.
- **Live filesystem refresh.** A filesystem watcher pushes `session:fs_changed` over the WebSocket so git status, diffs, and file views update without a manual refresh.
- **Prompt history modal.** Atuin-style searchable prompt history on the up arrow.
- **Isolated config directories.** `COCKPIT_CONFIG_DIR` and `CLAUDE_CONFIG_DIR` relocate cockpit and CLI config, enabling fully isolated instances.
- **Single-file PR review view** with a shared checked-files store, immediate PR pinning, and a fixed viewed toggle.
- **In-app updates.** Settings shows update buttons for Cockpit and Claude Code with native-install detection, and surfaces each one's changelog.
- **Inbox mark-as-unread.**
- **Job reliability.** Per-job locking with stale-lock recovery on startup, automatic port reclaim before starting the dev/production server, and more durable password storage.

### Changed
- **Settings redesign.** Settings is now a menu with dedicated sub-pages; the provider form was revamped, and the session-settings modal became a tabbed layout.
- **Status accuracy.** The "running" beacon now triggers on the first tool use (PreToolUse) rather than prompt submission.
- **Todos from disk.** Todo/task progress is watched from on-disk files instead of parsed from the event stream.
- **Prompt history source.** History loads from the full JSONL transcript rather than the tail buffer.
- **Model switching.** Model selection flows exclusively through the WebSocket `set_model`/`modelSlots` path; the legacy `/model` text-command path was removed.

### Fixed
- macOS PTY spawn failures (posix_spawnp, non-POSIX login shells, spawn-helper permissions); node-pty upgraded to 1.2.0-beta.13.
- PTY compaction stuck in the "running" state after `/compact` finished.
- Duplicate and mis-ordered messages, and stale status dots, in PTY mode.
- Structured AskUserQuestion prompts not rendering on reconnect, leaving a session that looked stuck until Stop was pressed.
- Context gauge reverting to 200K after a message or server restart on 1M-configured sessions.
- Session-settings dialog crash, and missing thinking/context selectors, for custom-provider models whose config omitted `contextSizes`.
- Restart or model change before the first message passing `--resume` to a nonexistent conversation.
- Cron day-of-month/day-of-week OR logic and duplicate inbox entries.
- Stop button not showing during 529 retry loops.
- Image previews lost when the transcript replaced optimistic messages, and duplicate user messages when sending images.
- Slash-command XML tags rendering as raw text in history.
- Phantom permission prompts and accumulating COMPACTED markers on transcript updates.

### Internal
- **Integration test framework.** A Playwright harness boots the real Claude CLI, a mock Anthropic API, and cockpit in isolated config directories to validate end-to-end behavior without calling the real API.
- **Orphan-process cleanup.** The test harness kills its whole process group on teardown and reaps stragglers via a `/proc`-based scan on suite setup and teardown, preventing leaked CLI/cockpit processes from accumulating.
- **Coverage.** Broad unit-test additions (scheduled jobs, job storage and locking, filesystem watcher, providers, notifications, transcript watcher, auth, hook router) with the coverage gate scoped to production source.

## [0.2.0] - 2026-05-07

### Added
- **Sidebar revamp.** Collapsible sections for Sessions, Reviews, Changes, and Files. Status beacons on each row show whether Claude is working (yellow), waiting for input (blue), has an unread response (green), or is idle (gray). Section open/closed state persists across page loads.
- **Global search.** Ctrl+Shift+F (Cmd+Shift+F on Mac) searches across all session transcripts. Results show role, timestamp, session name, and working directory. Click to jump to the session.
- **Notifications.** Push alerts via Telegram or ntfy.sh. Configure providers at `/settings/notifications` with per-provider enable/disable, priority filtering, and a test button. Base URL setting for clickable links behind reverse proxies.
- **Inbox.** Scheduled job completions and system events post to `/inbox`. Unread count badge in the sidebar. Mark all read or clear all from the inbox page. Messages are also dispatched to configured notification providers.
- **Session deletion.** Delete a session and its transcript from the sessions list or sidebar. Bulk delete per working directory.
- **Reviews in sidebar.** Active PR reviews pin to the sidebar with status beacons. Hide the section entirely with the Reviews toggle in Settings.
- **Collapsible PR description.** Long PR descriptions truncate to 10 lines with a Show more/less toggle.
- **File status in PR reviews.** Each changed file shows an add/modify/delete icon. Viewed files dim with a checkmark.
- **Lazy diff loading.** PR review diffs load on scroll intersection. Full file content is fetched from GitHub for complete context rendering.
- **Merge base diffs.** PR diffs now use the merge base SHA for accurate comparison, falling back to the base branch ref.
- **Message stitching toggle.** New setting to control whether the chat view loads messages from previous CLI sessions across `/clear` boundaries.
- **Reviews enabled toggle.** New setting to hide the Reviews section and page entirely.
- **Dismiss keyboard on send.** New mobile setting to auto-dismiss the on-screen keyboard after sending.
- **Paginated sessions list.** The all-sessions page is paginated to prevent browser lockup with large session counts.
- **Startup banner URLs.** The server startup log prints local and network connection URLs.
- **Usage button on all pages.** The usage button moved to the app-shell header so it is visible everywhere, including PR reviews.
- **Two-line Agent tool cards.** Agent tool calls display in a compact two-line layout.
- **Connection URL header.** Startup banner shows a "Connect via:" header above the local and network URLs.

### Fixed
- PR diffs showing wrong lines. Hunk indices are now reindexed when replacing partial line arrays with full file content from GitHub.
- Bypass toggle not taking effect on active sessions.
- Enter key not submitting freeform answers in QuestionPrompt.
- Message pagination losing middle messages when stitching enabled.
- Bash tool cards clipping long text instead of wrapping.
- Sidebar section ordering when no notification providers are configured.
- Session changes section hiding instead of showing an error state.
- Scheduled job permission errors and save persistence.
- Bottom padding on sessions list so the last item clears the floating action button.

## [0.1.1] - 2026-04-29

### Fixed
- Production builds now use Webpack instead of Turbopack. Turbopack emitted hashed external references (`shiki-<hash>/wasm`) that Node could not resolve at runtime in installed tarballs, causing syntax highlighting to fail with `Failed to load external module` after `npx @alexjbarnes/cockpit`.

### Security
- Override `@tensorflow/tfjs-node` (an optional transitive of `magika`) with an empty stub to drop a vulnerable `@mapbox/node-pre-gyp` chain. `magika` runs in the browser, so the Node bindings are unused.
- Override `postcss` to `^8.5.12` to clear [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) (line return parsing).

## [0.1.0] - 2026-04-29

Initial release.
