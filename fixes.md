# UI/UX Audit Findings

Captured via Playwright visual audit on 2026-03-22, testing both desktop (1440x900) and mobile (390x844) viewports against the production build.

## Critical

### ~~1. "No active sessions" / "No sessions found" flash on page load~~ FIXED
The main area showed "No sessions found" before the API response arrived. Added a `loaded` gate so the empty-state message only renders after the first fetch completes. The sidebar "No active sessions" message is accurate (driven by localStorage) and not a flash.

## Medium

### 3. Sidebar "Active Sessions" does not populate from home page
The sidebar "Active Sessions" list stays empty ("No active sessions") on the home page even after WS connects and session data loads in the main area. The main content shows "cockpit - 1 running" but the sidebar does not reflect this. Active sessions only appear in the sidebar after navigating to a specific session. The sidebar should subscribe to active session state from the WS on the home page too.
- **Seen on**: Desktop
- **Screenshot**: `screenshots/04-desktop-home-prod.png`

### 4. No session name in mobile header
On mobile, the session header only shows action icons (todos, background tasks, account usage, git status, browse files) but no session name. On desktop the session name is shown as a clickable button. Mobile users have no way to see which session they are in without opening the sidebar.
- **Seen on**: Mobile
- **Screenshot**: `screenshots/11-mobile-session.png`

### 5. Cannot scroll to top of conversation
Pressing Home key does not scroll the message area. Programmatic `main.scrollTop = 0` also did not visually scroll the view. The message container appears pinned to the bottom with no way for the user to scroll to the beginning of a long conversation. May be related to the auto-scroll-on-new-message behavior not having an escape hatch.
- **Seen on**: Desktop
- **Screenshot**: `screenshots/07-desktop-session-scrolled-top.png` (identical to bottom view)

### 6. Mobile sidebar overlay bleeds content from behind
When the mobile sidebar is open, the main content behind it is partially visible on the right edge. The overlay does not fully cover the viewport width or lacks a backdrop.
- **Seen on**: Mobile
- **Screenshot**: `screenshots/12-mobile-sidebar-open.png`

## Low

### 7. Session name truncated with no tooltip
Long session names (derived from the first message) are truncated with ellipsis in both the sidebar and header. No tooltip shows the full name on hover/long-press.
- **Seen on**: Desktop and mobile

### 8. Duplicate project names in session list
The session list on the home page shows two entries for "roasta" (12d ago with 7 sessions, 14d ago with 81 sessions). These appear to be the same project at different paths but look confusing without the path context visible.
- **Seen on**: Desktop
- **Screenshot**: `screenshots/04-desktop-home-prod.png`

### 9. Star/favorite button has no visible state feedback
The star button next to each project in the session list does not appear to provide visual feedback when toggled. No filled star vs outline distinction visible.
- **Seen on**: Desktop

### 10. Header icons have no labels on mobile
The five header action buttons (todos, background tasks, account usage, git status, browse files) are icon-only on both desktop and mobile. On desktop they have tooltip text but on mobile there is no way to discover what each icon does without trial and error.
- **Seen on**: Mobile
