// Every test file gets a throwaway COCKPIT_CONFIG_DIR, so no test can reach
// the developer's real ~/.cockpit.
//
// This is a guard, not a convenience. tests/auth.test.ts used to unlink
// homedir()/.cockpit/password.json in beforeEach AND afterEach, and four
// WebSocket suites call setupPassword() to mint a session token — so a plain
// `npx vitest run` deleted the developer's password outright, and an
// interrupted run left the real file holding a test password like
// "my-secret", which presents as a corrupted password rather than a missing
// one. Fixing the suites we knew about is not enough on its own; this makes
// the next suite that forgets harmless by default.
//
// Runs as a setupFile rather than globalSetup deliberately: globalSetup runs
// in its own process, so the env var it sets never reaches the test workers.
// A suite that wants its own directory still just assigns the env var at
// module scope, which is evaluated after this and therefore wins.
// The same guard applies to every other COCKPIT_* variable. `make start` and
// `make dev` export COCKPIT_DEBUG, COCKPIT_TOKEN and COCKPIT_ISSUES_ENABLED,
// and a session cockpit spawns inherits them — so a test run started from
// inside cockpit picked up settings a run from a plain shell did not, and the
// suite passed or failed depending on where it was launched. COCKPIT_DEBUG=1
// also had the debug logger writing into the throwaway dir below as tests tore
// it down. A suite that wants one of these sets it itself, at module scope or
// in the test, both of which run after this file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("COCKPIT_")) delete process.env[key];
}

// CLAUDE_CONFIG_DIR belongs in the same guard for the same reason. Cockpit
// reads the CLI's directory through it (paths.ts), and it takes precedence over
// homedir() — so a suite that mocks homedir() to a fake home and expects to
// read nothing real instead read the developer's own ~/.claude. The dev
// container exports it, which is how the hole surfaced; a plain shell does not,
// which is why the suites passed there. Suites that want their own directory
// still assign it at module scope, which runs after this.
delete process.env.CLAUDE_CONFIG_DIR;

const dir = mkdtempSync(path.join(tmpdir(), "cockpit-vitest-"));
process.env.COCKPIT_CONFIG_DIR = dir;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
