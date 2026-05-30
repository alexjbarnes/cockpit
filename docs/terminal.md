# Embedded terminal

Cockpit includes a full terminal in the browser, so you can run commands next to a session without leaving the UI. It is a real shell on the server (node-pty), rendered with xterm.js.

## Opening a terminal

Click the terminal button in the header (Ctrl+`) to open one. Terminals open as tabs in the session view and can be split across panes like any other tab (see [Sessions](sessions.md#tabbed-layout)). The shell starts in the active session's working directory.

The shell is detected from the host: the login shell from `getent passwd` on Linux or `dscl` on macOS, falling back to `$SHELL` or `/bin/sh`.

## Settings

Open the terminal settings modal from the panel to adjust:

- **Theme.** 10 presets, including a Cockpit theme that matches the app and common choices like Dracula, Catppuccin, Tokyo Night, Nord, Gruvbox, Solarized, Monokai, and One Dark.
- **Font size.**
- **Scrollback.** Number of lines retained.

Changes apply live without restarting the shell.

## Behaviour

- **Scrollback survives tab moves.** Terminal instances are cached across React remounts, so dragging a terminal tab between panes or toggling split view keeps its history.
- **Reconnect.** If the backend terminal goes away, the panel offers a reconnect that starts a fresh shell in the same directory.
- **Mobile.** A toolbar exposes keys that are awkward on a touch keyboard (arrows, Esc, Tab, Ctrl). Keyboard open/close is detected with the visualViewport API so the layout reflows cleanly.

## Notes

- Terminals are served over a dedicated WebSocket, separate from the session stream.
- Nerd Font glyphs render if a Nerd Font is installed and selected by your browser's monospace font.
