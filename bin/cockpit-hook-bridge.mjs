#!/usr/bin/env node
/**
 * Cockpit hook bridge: pipes Claude hook payloads to the cockpit server.
 *
 * Invoked by Claude Code per .claude/settings.json hook configuration.
 * Reads JSON payload from stdin, posts it to the cockpit hook router,
 * writes any returned stdout/stderr, and exits with the returned code.
 *
 * Env vars set by cockpit when it spawns claude:
 *   COCKPIT_HOOK_URL      e.g. http://127.0.0.1:54321
 *   COCKPIT_HOOK_TOKEN    per-session token
 *   COCKPIT_SESSION_ID    cockpit's internal session id
 *
 * Usage: cockpit-hook-bridge <eventName>
 *   eventName ∈ {PreToolUse, PostToolUse, Stop, UserPromptSubmit, Notification, PermissionRequest}
 */

const eventName = process.argv[2];
if (!eventName) {
  process.stderr.write("cockpit-hook-bridge: missing event name argument\n");
  process.exit(0);
}

const url = process.env.COCKPIT_HOOK_URL;
const token = process.env.COCKPIT_HOOK_TOKEN;
const sessionId = process.env.COCKPIT_SESSION_ID;
if (!url || !token || !sessionId) {
  process.stderr.write("cockpit-hook-bridge: missing COCKPIT_HOOK_URL / COCKPIT_HOOK_TOKEN / COCKPIT_SESSION_ID\n");
  process.exit(0);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  process.stdin.setEncoding("utf8");
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

const TIMEOUT_MS = eventName === "PermissionRequest" ? 10 * 60 * 1000 : 60 * 1000;

function permissionDenyJson() {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "hook bridge timed out waiting for cockpit" },
    },
  });
}

async function main() {
  const body = await readStdin();
  const target = `${url}/hook/${eventName}`;

  let res;
  try {
    res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cockpit-Session": sessionId,
        "X-Cockpit-Token": token,
      },
      body: body || "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const isTimeout = err && err.name === "TimeoutError";
    process.stderr.write(`cockpit-hook-bridge: request ${isTimeout ? "timed out" : "failed"}: ${msg}\n`);
    if (isTimeout && eventName === "PermissionRequest") {
      process.stdout.write(permissionDenyJson());
    }
    process.exit(0);
  }

  if (!res.ok) {
    process.stderr.write(`cockpit-hook-bridge: router returned ${res.status}\n`);
    if (eventName === "PermissionRequest") {
      process.stdout.write(permissionDenyJson());
    }
    process.exit(0);
  }

  let parsed;
  try {
    parsed = await res.json();
  } catch {
    process.exit(0);
  }

  if (parsed && typeof parsed === "object") {
    if (typeof parsed.stdout === "string" && parsed.stdout.length > 0) process.stdout.write(parsed.stdout);
    if (typeof parsed.stderr === "string" && parsed.stderr.length > 0) process.stderr.write(parsed.stderr);
    process.exit(typeof parsed.exitCode === "number" ? parsed.exitCode : 0);
  }

  process.exit(0);
}

main();
