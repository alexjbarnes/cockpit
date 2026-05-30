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
 * Optional tuning (milliseconds):
 *   COCKPIT_PERMISSION_HOOK_TIMEOUT_MS  how long to wait for a permission/question
 *                                       answer before giving up (default 24h)
 *   COCKPIT_HOOK_TIMEOUT_MS             how long to wait for any other hook (default 60s)
 *
 * Usage: cockpit-hook-bridge <eventName>
 *   eventName ∈ {PreToolUse, PostToolUse, Stop, UserPromptSubmit, Notification, PermissionRequest}
 *
 * NOTE: this uses node:http directly rather than the global fetch(). fetch is
 * undici, whose default headersTimeout/bodyTimeout are 5 minutes, so a held
 * PermissionRequest response (the CLI blocks while the user decides) was aborted
 * after 5 minutes — the CLI then hung with no decision and the user's eventual
 * answer landed on a dead socket. node:http only times out on the explicit cap
 * below, so a permission prompt can wait as long as the CLI's own hook timeout.
 */

import { request as httpRequest } from "node:http";

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

function envMs(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// A permission/question can block on the user for a long time. Match the CLI's
// own permission hook timeout (24h) rather than fetch's hidden 5-minute ceiling.
const TIMEOUT_MS =
  eventName === "PermissionRequest"
    ? envMs("COCKPIT_PERMISSION_HOOK_TIMEOUT_MS", 24 * 60 * 60 * 1000)
    : envMs("COCKPIT_HOOK_TIMEOUT_MS", 60 * 1000);

function permissionDenyJson(message) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message },
    },
  });
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  process.stdin.setEncoding("utf8");
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

/**
 * POST the payload and resolve with { status, body }. Rejects on transport
 * error or when the request exceeds TIMEOUT_MS with no response.
 */
function postHook(target, payload) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(target);
    } catch (err) {
      reject(err);
      return;
    }

    const req = httpRequest(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "X-Cockpit-Session": sessionId,
          "X-Cockpit-Token": token,
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );

    // The socket sits idle while the user decides; this is the only ceiling on
    // how long we wait for the response.
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error("timed out waiting for cockpit"), { code: "ETIMEDOUT" }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function main() {
  const body = await readStdin();
  const target = `${url}/hook/${eventName}`;

  let res;
  try {
    res = await postHook(target, body || "{}");
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const timedOut = err && err.code === "ETIMEDOUT";
    process.stderr.write(`cockpit-hook-bridge: request ${timedOut ? "timed out" : "failed"}: ${msg}\n`);
    // A permission request must always yield a decision, or the CLI hangs.
    if (eventName === "PermissionRequest") {
      process.stdout.write(permissionDenyJson(`hook bridge ${timedOut ? "timed out waiting for" : "could not reach"} cockpit`));
    }
    process.exit(0);
  }

  if (res.status < 200 || res.status >= 300) {
    process.stderr.write(`cockpit-hook-bridge: router returned ${res.status}\n`);
    if (eventName === "PermissionRequest") {
      process.stdout.write(permissionDenyJson(`hook router returned ${res.status}`));
    }
    process.exit(0);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    if (eventName === "PermissionRequest") {
      process.stdout.write(permissionDenyJson("hook router sent an unreadable response"));
    }
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
