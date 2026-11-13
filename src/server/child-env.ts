// The environment handed to a process the user works in: a Claude session or
// a terminal. It starts from cockpit's own, minus what is only there because
// cockpit is a server.
//
// Without this every shell inside a session inherited NODE_ENV=production and
// cockpit's PORT. A dev server started there served a production build, or
// tried to bind the port cockpit itself was listening on, and nothing on
// screen said why. Cockpit's own settings (COCKPIT_*) went the same way,
// its auth-bypass token included.

const SERVER_ONLY = new Set(["NODE_ENV", "PORT", "NEXT_DEPLOYMENT_ID", "NEXT_RUNTIME", "NEXT_PHASE"]);

/** What the hook bridge reads from the CLI's environment. Everything else
 *  named COCKPIT_ configures the server and stays with it. */
const BRIDGE_VARS = /^COCKPIT_(HOOK_|SESSION_ID$|[A-Z_]*HOOK_TIMEOUT_MS$)/;

function isServerOnly(name: string): boolean {
  if (SERVER_ONLY.has(name)) return true;
  if (name.startsWith("__NEXT_") || name.startsWith("NEXT_PRIVATE_")) return true;
  return name.startsWith("COCKPIT_") && !BRIDGE_VARS.test(name);
}

/** A copy of `source` without the server's own variables. */
export function userEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || isServerOnly(name)) continue;
    env[name] = value;
  }
  return env;
}
