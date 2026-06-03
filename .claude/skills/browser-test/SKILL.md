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

## 3. Clear the service worker — the one that wastes the most time

cockpit registers a service worker that caches the app shell (cache name like `cockpit-shell-v2`). It serves stale JS **across server restarts and `.next` deletes**. Until you clear it, you are looking at OLD code no matter what you change. After navigating, run this, then navigate again:

```js
async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const n of await caches.keys()) await caches.delete(n);
}
```

Confirm you're on current code before trusting anything: read a class or text you just changed off the live DOM via `browser_evaluate` and compare to source.

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
kill $(lsof -ti:3010) 2>/dev/null; pkill -f "tsx server.ts" 2>/dev/null
rm -rf /tmp/cockpit-verify /tmp/cockpit-verify.log
rm -f /home/dev/repos/cockpit/*.png   # screenshots browser_take_screenshot saved into the repo root
```

Leave `.next` (gitignored). The live instance on 3001 is untouched throughout.
