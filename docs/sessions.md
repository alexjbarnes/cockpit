# Sessions

The session is the unit of conversation in Cockpit. You can run many in parallel, switch between them on any device, and keep them open across days.

## Sessions home

The home page lists every session known to Cockpit, grouped by working directory. Each row shows the session name, working directory, model in use, last activity time, and an unread indicator. Pinned sessions surface at the top so the conversations you care about stay one tap away.

Click a row to open it. The menu icon opens rename, pin, and delete actions.

## Sidebar

The sidebar shows open sessions and pinned ones. Click any session to switch without losing your place in the current one. The sidebar collapses on mobile, where the bottom nav handles primary navigation.

## Chat view

The chat view streams Claude Code output in real time over a WebSocket connection.

Messages render as they arrive:

- User and assistant messages
- Tool calls (collapsible cards per tool)
- File reads, edits, writes with previews
- Bash invocations and their output
- Diffs for code changes
- Markdown with syntax-highlighted code blocks
- Plans (auto-detected when written to `~/.claude/plans/`)
- Todo list
- Background task status
- Permission prompts

Long histories use windowed rendering. The initial view loads 50 messages, with 30 more fetched as you scroll up.

## Session settings

Each session has its own settings, separate from the defaults you set globally. Tap the settings icon next to the message box to change:

- Model (Haiku, Sonnet, Opus, with version switcher)
- Extended context (200K or 1M tokens)
- Thinking level (Low, Medium, High, XHigh, Max)
- Permission bypass for this session

Changes apply on the next turn.

## Attachments

Three ways to send files with a message:

1. Paperclip button. Opens a file picker. Accepts images, PDFs, and text files.
2. Drag and drop. Drop files onto the chat area.
3. Paste. Images from the clipboard attach automatically. Long pasted text is auto-collapsed into a file with a detected extension (language detection runs through magika).

Attached files appear as chips above the input. Remove them with the X.

## Plan mode

When Claude proposes a plan, Cockpit detects it (writes to `~/.claude/plans/`) and shows a modal preview instead of inline tool output.

Approval options:

- Accept and continue. Claude executes the plan in the same session.
- Accept and clear context. Cockpit clears the conversation, then runs the plan in a fresh context. The previous transcript is preserved (see Session linking below).
- Reject with feedback. Provide notes; Claude revises before proposing again.
- Reject. Claude stops.

## Permissions

Tool calls that need approval show an inline prompt. Each prompt names the tool, previews the input (file path, command, etc.), and offers:

- Allow once
- Allow always for this session
- Allow always for this project
- Deny

Permissions are scoped per session, project, or globally. The Settings page has a bypass toggle for power users. Off by default with an orange warning when on.

## Slash commands

Type `/` to open the menu. Cockpit supports the same slash commands as Claude Code.

## Session linking via /clear

`/clear` starts a fresh CLI conversation, but Cockpit keeps the chat view continuous. The server stitches the new transcript onto the previous one, so you see the full history even though Claude only sees post-clear messages.

This means:

- Long-running threads can `/clear` repeatedly without losing the visual record
- Plan mode "clear and continue" leaves a complete trail
- Search works across pre- and post-clear messages

The CLI session ID changes on each clear. Cockpit tracks the chain via `cliSessionId` in session prefs.

## Diff viewer

Code changes render as diffs:

- Split (side by side) or inline (unified), set in Settings
- Syntax highlighted via shiki
- Expandable context above and below each hunk
- Per-file collapse

The same component renders the changes view and PR reviews.

## File view

Open files referenced by Claude or browse the working directory. Files render with:

- Syntax highlighting via shiki
- Line numbers
- Copy button
- Full-page view for large files
- CodeMirror editor for editing (markdown and YAML language support)

## Usage

The header shows live token usage for the current session and your overall API spend. Click for a breakdown by model and message.

## Background tasks

When Claude runs a long operation (a slow Bash command, a large file scan), a task indicator surfaces in the chat. Keep typing or switch sessions; the indicator stays visible until the task ends.

## Message queue

Sending a message while Claude is mid-response does not interrupt the current turn. Cockpit queues the message on the server and delivers it on the next user turn.

The queue:

- Lives on the server. Messages survive a browser refresh or device switch.
- Surfaces a queue indicator in the chat. Tap it to open the queue modal.
- Lets you edit (moves the message back to the input area), delete, or reorder queued messages.
- Auto-pauses when you interrupt Claude, so a half-finished thought does not get sent on resume. The modal has a Resume button to release the paused queue.

## Side questions (/btw)

`/btw <question>` asks a quick side question without disturbing the running session. Cockpit spawns a separate, tool-less Claude process that answers from the conversation context only. Useful for "what did that error mean?" or "why did Claude pick this approach?" while the main turn keeps running.

The answer appears in the chat but does not become part of the conversation Claude sees on the next turn.

## Todo list

The todo indicator surfaces Claude's current task list in the chat. As Claude marks items in_progress and completed, the indicator updates in real time. Click for the full list with status.

## Message search

Open the search modal from the toolbar. Matches highlight in place. Search runs server-side over the stitched transcript, so it covers pre-clear messages too.

Multi-select messages and use the selection toolbar to copy a slice of the conversation to your clipboard.

## Mobile

The chat view works the same on phones as on desktops, with mobile-specific affordances:

- Bottom nav for primary navigation
- Touch-friendly tool cards and modals
- Virtual-keyboard aware input area
- Same WebSocket connection as desktop, so a session opened on your laptop continues from your phone
