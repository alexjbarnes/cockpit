# UI Review Changes

Playwright-driven UI review of the application on 2026-03-22.

## Fixes Applied

### 1. Page title hidden on mobile (3e9b7f0)
- **File:** `src/components/app-shell.tsx`
- **Problem:** The header title (Settings, Reviews, Files, etc.) was hidden on mobile via `hidden md:block`. Only the hamburger menu icon showed, giving no context about which page you were on.
- **Fix:** Removed `hidden md:block` so the title renders at all viewport sizes.

### 2. Missing favicon (2ba0baf)
- **File:** `src/app/layout.tsx`
- **Problem:** No favicon configured. Browser console showed a 404 for `/favicon.ico` on every page load.
- **Fix:** Added `icons` metadata pointing to the existing `/icon-192.png`.

### 3. Login autocomplete warning (921bebc)
- **File:** `src/app/login/page.tsx`
- **Problem:** Chrome flagged the password input for missing `autocomplete` attribute.
- **Fix:** Added `autoComplete="current-password"` to the input.

## Pages Reviewed

- Home / Sessions list (desktop + mobile)
- Session chat view (desktop + mobile)
- Changes view with stacked diffs (desktop + mobile)
- Settings page (desktop + mobile)
- Reviews / repo list (desktop + mobile)
- PR list view
- File browser + file viewer

## No Issues Found

- Session list renders correctly with expand/collapse
- Active sessions show in sidebar with status indicators
- Chat view renders tool calls, code blocks, and markdown
- Changes view: stacked diffs, sticky headers, checkboxes, commit panel all functional
- File browser: tree loads async, file viewer has syntax highlighting
- Reviews: org/personal account selector, repo list, PR filtering all work
- Settings: all toggle groups, theme switching, customization sections render
- No JavaScript console errors (aside from expected 401 before auth)
