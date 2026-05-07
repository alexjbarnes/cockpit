# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
