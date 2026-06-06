---
description: Verify a cockpit UI/frontend change in a real browser with Playwright — screenshots, mobile viewport, reproduce a visual bug. Use when asked to visually confirm a UI change, screenshot the running app, or reproduce a rendering/layout bug. Covers cockpit-specific setup the generic run/verify skills miss: isolated dev server on a spare port, password auth, and the service-worker / NODE_ENV / .next caches that otherwise serve stale code.
---

# Browser-test a cockpit UI change with Playwright

Run an isolated cockpit dev server and drive it with the Playwright MCP. Use this over the generic `run`/`verify` skills: cockpit has three caches that will serve you stale code and burn a lot of time if you don't handle them up front.

## When to use
- Visually confirm a UI / layout / CSS change renders correctly.
- Reproduce a rendering bug, especially on mobile.
- Screenshot a page or dialog at a given viewport.

## 1. Start an isolated dev server

Never test against the live instance (port 3001, runs from a packaged tarball). Spin up your own on a spare port with a throwaway config dir.

Three things bite you, all handled below:
- The shell exports `NODE_ENV=production`, so plain `tsx server.ts` runs Next in **production mode** (serves the prebuilt `.next`, ignores your source). Force `NODE_ENV=development`.
- A separate `COCKPIT_CONFIG_DIR` keeps the test server off `~/.cockpit` — no job-scheduler or lock collisions, and a fresh auth state.
- Foreground `sleep` is blocked in this environment; poll readiness with `curl --retry`.

```bash
rm -rf /tmp/cockpit-verify && mkdir -p /tmp/cockpit-verify
cd /home/dev/repos/cockpit
NODE_ENV=development COCKPIT_CONFIG_DIR=/tmp/cockpit-verify PORT=3010 \
  nohup npx tsx server.ts > /tmp/cockpit-verify.log 2>&1 &
curl -s -o /dev/null -w "%{http_code}" --retry 120 --retry-delay 1 \
  --retry-all-errors --retry-connrefused --max-time 12 http://localhost:3010/login
```

First load compiles on demand (~10-30s); the retry covers it. If it never returns 200, read `/tmp/cockpit-verify.log`.

## 2. Authenticate

A fresh config has no password, so `/login` renders the **setup** screen. Set one and you get a valid signed session cookie.

The `COCKPIT_TOKEN` bypass alone does NOT work: `validateSession` returns false when no password is stored, *before* it checks the token. Set a password.

Load the Playwright tools first:
`ToolSearch` → `select:mcp__playwright__browser_navigate,mcp__playwright__browser_resize,mcp__playwright__browser_evaluate,mcp__playwright__browser_take_screenshot`

Then `browser_navigate` to `http://localhost:3010/login` and submit the setup form via `browser_evaluate` (React inputs need the native value setter + an input event, so a plain `.value =` won't register):

```js
() => {
  const set = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
    d.set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const ps = document.querySelectorAll("input[type=password]");
  set(ps[0], "verify123");
  if (ps[1]) set(ps[1], "verify123");
  [...document.querySelectorAll("button")].find((b) => /set password|login/i.test(b.textContent || ""))?.click();
}
```

You land on `/`, authenticated.

## 3. The service worker — now auto-handled in dev (was the #1 time sink)

cockpit's PWA service worker (`sw.js`, cache `cockpit-shell-v2`) is **cache-first for `/_next/static`**. That is correct in production (content-hashed URLs) but poison in dev: turbopack dev chunk URLs are stable while their contents change across edits and server restarts, so the SW serves a stale chunk against a fresh shell. As of the layout.tsx fix, **the SW is no longer registered in development**, and a dev page actively unregisters any leftover SW and clears its caches on load. So a fresh spare port is clean, and a port previously poisoned by an old SW self-heals.

**The symptom this caused** (worth recognising — it cost hours): a **blank page** where every `/_next/static/*.js` chunk loads `200`, React never mounts (`document.body.innerText` empty, only a `<div hidden><!--$--><!--/$--></div>` placeholder), and the console shows **only** HMR-websocket failures. That is a stale SW serving mismatched cached chunks, not a code bug.

Why it bit the MCP but not the ui-reviewer: SW scope is **per origin including port**. The ui-reviewer uses a fresh spare port (and a fresh browser profile) each run, so its origin never has a prior SW. The MCP reuses a small set of ports/profile, so a port that hosted an earlier server still carries that origin's stale SW. Two consequences:
- **Prefer a unique, not-recently-used port** per run (and vary it if you hit a blank page).
- If you do hit the blank page on a reused port, just **reload once** — the dev cleanup script already unregistered the SW on the first load; the reload lands clean. Belt-and-braces manual clear (rarely needed now):

```js
async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const n of await caches.keys()) await caches.delete(n);
}
```

After it, navigate again. Confirm you're on current code: read a class or text you just changed off the live DOM via `browser_evaluate` and compare to source. A quick tell that no SW is interfering: `navigator.serviceWorker.controller === null`.

## 4. Drive the UI

- `browser_resize` to a mobile size to reproduce mobile bugs — e.g. `393×600`, or `360×440` for a worst case. Real phones show less height than `100vh` implies (browser chrome), so test shorter than you think.
- Click via `browser_evaluate` (find by text, `.click()`) — more reliable than ref-based `browser_click`:
  ```js
  () => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "New Session")?.click()
  ```
- Verify with **geometry, not just the screenshot**. Read `getBoundingClientRect()` for the element and `window.innerHeight`, and assert containment/visibility (e.g. `rect.bottom <= innerHeight`, element inside its scroll container). `getBoundingClientRect` returns geometric position even for clipped content, so pair it with a `browser_take_screenshot` + Read the PNG to confirm what's actually visible.

## 5. Iterate after a source edit

HMR does NOT pick up edits here: Next infers the workspace root as the parent `/home/dev/repos` (multiple lockfiles), which breaks file watching for `src/`. After each edit:

1. Kill the server, `rm -rf .next`, restart (step 1).
2. Re-run the service-worker clear (step 3) and reload.

Skip either and you keep seeing stale code.

## 6. Teardown

```bash
kill $(lsof -ti:3010) 2>/dev/null || true   # kill by PORT only
rm -rf /tmp/cockpit-verify /tmp/cockpit-verify.log
rm -f /home/dev/repos/cockpit/*.png   # screenshots browser_take_screenshot saved into the repo root
```

Kill by **port**, not `pkill -f "tsx server.ts"` — that pattern matches every cockpit dev server (sibling worktrees, the implement-issue review server, the ui-reviewer's server) and will take them all down. Leave `.next` (gitignored). The live instance on 3001 is untouched throughout.
