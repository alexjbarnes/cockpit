/**
 * PTY Spike Tests
 *
 * Validates that we can run Claude Code interactively (no -p flag)
 * and get structured I/O through hooks + session JSONL tailing.
 *
 * The goal: interactive mode sets CLAUDE_CODE_ENTRYPOINT=cli (subscription billing)
 * while still giving cockpit programmatic control via:
 *   - Input:  PTY stdin writes (text typed into the REPL)
 *   - Output: Hooks fire with structured JSON, session JSONL for message content
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node-pty";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const TEST_TIMEOUT = 90_000;
const CLAUDE_AVAILABLE = (() => {
  try {
    execSync(`${CLAUDE_BIN} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const RUN_INTEGRATION = process.env.COCKPIT_INTEGRATION_TESTS === "1";

let hookOutputDir: string;
let hookScriptDir: string;
let workDir: string;

function createHookScript(hookEvent: string): string {
  const outputPath = join(hookOutputDir, `${hookEvent}.jsonl`);
  const scriptPath = join(hookScriptDir, `${hookEvent}.sh`);
  writeFileSync(scriptPath, `#!/bin/bash\nread -r line\necho "$line" >> "${outputPath}"\n`, { mode: 0o755 });
  return scriptPath;
}

function createPermissionHookScript(): string {
  const outputPath = join(hookOutputDir, "PermissionRequest.jsonl");
  const scriptPath = join(hookScriptDir, "PermissionRequest.sh");
  writeFileSync(
    scriptPath,
    `#!/bin/bash
read -r line
echo "$line" >> "${outputPath}"
echo '{"hookSpecificOutput":{"decision":"allow"}}'
`,
    { mode: 0o755 },
  );
  return scriptPath;
}

function writeProjectSettings() {
  const events = ["PostToolUse", "Stop", "Notification", "UserPromptSubmit"];
  const hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> = {};

  for (const event of events) {
    hooks[event] = [{ matcher: "", hooks: [{ type: "command", command: createHookScript(event) }] }];
  }
  hooks.PermissionRequest = [{ matcher: "", hooks: [{ type: "command", command: createPermissionHookScript() }] }];

  const claudeDir = join(workDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify(
      {
        hooks,
        permissions: { allow: ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)"], deny: [] },
      },
      null,
      2,
    ),
  );
}

function readHookOutput(hookEvent: string): string[] {
  const outputPath = join(hookOutputDir, `${hookEvent}.jsonl`);
  if (!existsSync(outputPath)) return [];
  return readFileSync(outputPath, "utf-8").trim().split("\n").filter(Boolean);
}

function clearHookOutputs() {
  const events = ["PostToolUse", "Stop", "Notification", "UserPromptSubmit", "PermissionRequest"];
  for (const event of events) {
    const path = join(hookOutputDir, `${event}.jsonl`);
    if (existsSync(path)) unlinkSync(path);
  }
}

function collectPtyOutput(pty: ReturnType<typeof spawn>): () => string {
  let buffer = "";
  pty.onData((data) => {
    buffer += data;
  });
  return () => buffer;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
const ANSI_EXTRA_RE = /\x1b[>=?][^\x1b]*/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "").replace(ANSI_EXTRA_RE, "");
}

async function waitFor(condition: () => boolean, { timeout = 30_000, interval = 300, label = "condition" } = {}): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeout}ms`);
}

function spawnClaude(): ReturnType<typeof spawn> {
  return spawn(CLAUDE_BIN, ["--dangerously-skip-permissions", "--verbose"], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: workDir,
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      CLAUDE_CODE_ENTRYPOINT: undefined,
    },
  });
}

async function waitForRepl(pty: ReturnType<typeof spawn>, getOutput: () => string, timeout = 30_000): Promise<void> {
  // Wait for initial output
  await waitFor(() => getOutput().length > 100, { timeout, label: "initial output" });

  // Check for trust dialog and auto-accept it
  await new Promise((r) => setTimeout(r, 1500));
  const clean = stripAnsi(getOutput());
  if (clean.includes("trust this folder") || clean.includes("Yes,")) {
    pty.write("\r");
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Now wait for the actual REPL input prompt to appear
  await waitFor(
    () => {
      const output = stripAnsi(getOutput());
      // The REPL shows a ">" prompt or the input area
      return output.length > 800;
    },
    { timeout: 15_000, label: "REPL input ready" },
  );
  await new Promise((r) => setTimeout(r, 1000));
}

beforeAll(() => {
  hookOutputDir = mkdtempSync(join(tmpdir(), "cockpit-pty-hooks-out-"));
  hookScriptDir = mkdtempSync(join(tmpdir(), "cockpit-pty-hooks-scripts-"));
  workDir = mkdtempSync(join(tmpdir(), "cockpit-pty-workdir-"));
  execSync("git init && git commit --allow-empty -m init", { cwd: workDir, stdio: "ignore" });
});

afterAll(() => {
  for (const dir of [hookOutputDir, hookScriptDir, workDir]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!RUN_INTEGRATION || !CLAUDE_AVAILABLE)("PTY Interactive Claude Spike", () => {
  let ptyProcess: ReturnType<typeof spawn> | null = null;

  beforeEach(() => {
    clearHookOutputs();
    writeProjectSettings();
  });

  afterEach(() => {
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch {
        // already dead
      }
      ptyProcess = null;
    }
  });

  it(
    "spawns claude interactively with TTY and gets REPL output",
    async () => {
      ptyProcess = spawnClaude();
      const getOutput = collectPtyOutput(ptyProcess);

      await waitForRepl(ptyProcess, getOutput);

      const raw = getOutput();
      const clean = stripAnsi(raw);
      console.log("=== CLEAN PTY OUTPUT (first 1000 chars) ===");
      console.log(clean.slice(0, 1000));
      console.log("=== RAW LENGTH:", raw.length, "CLEAN LENGTH:", clean.length, "===");

      expect(raw.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "sends a message via PTY stdin and the Stop hook fires",
    async () => {
      ptyProcess = spawnClaude();
      const getOutput = collectPtyOutput(ptyProcess);

      await waitForRepl(ptyProcess, getOutput);

      ptyProcess.write('Say exactly "hello test" and nothing else\r');

      await waitFor(() => readHookOutput("Stop").length > 0, {
        timeout: 60_000,
        label: "Stop hook",
      });

      const stopEvents = readHookOutput("Stop");
      expect(stopEvents.length).toBeGreaterThan(0);

      const parsed = JSON.parse(stopEvents[0]!);
      expect(parsed).toBeDefined();
      console.log("=== Stop hook payload ===");
      console.log(JSON.stringify(parsed, null, 2).slice(0, 500));
    },
    TEST_TIMEOUT,
  );

  it(
    "captures UserPromptSubmit hook with the sent message text",
    async () => {
      ptyProcess = spawnClaude();
      const getOutput = collectPtyOutput(ptyProcess);

      await waitForRepl(ptyProcess, getOutput);

      ptyProcess.write("Reply with just the word pineapple\r");

      await waitFor(() => readHookOutput("UserPromptSubmit").length > 0, {
        timeout: 30_000,
        label: "UserPromptSubmit hook",
      });

      const events = readHookOutput("UserPromptSubmit");
      expect(events.length).toBeGreaterThan(0);

      const parsed = JSON.parse(events[0]!);
      console.log("=== UserPromptSubmit hook payload ===");
      console.log(JSON.stringify(parsed, null, 2).slice(0, 500));
      expect(JSON.stringify(parsed)).toContain("pineapple");
    },
    TEST_TIMEOUT,
  );

  it(
    "triggers tool use and captures PostToolUse hook with structured data",
    async () => {
      writeFileSync(join(workDir, "test-file.txt"), "The answer is 42\n");

      ptyProcess = spawnClaude();
      const getOutput = collectPtyOutput(ptyProcess);

      await waitForRepl(ptyProcess, getOutput);

      ptyProcess.write("Read the file test-file.txt and tell me what it says\r");

      await waitFor(() => readHookOutput("PostToolUse").length > 0, {
        timeout: 60_000,
        label: "PostToolUse hook",
      });

      const events = readHookOutput("PostToolUse");
      expect(events.length).toBeGreaterThan(0);

      const parsed = JSON.parse(events[0]!);
      console.log("=== PostToolUse hook payload ===");
      console.log(JSON.stringify(parsed, null, 2).slice(0, 800));
      expect(parsed).toHaveProperty("tool_name");

      await waitFor(() => readHookOutput("Stop").length > 0, {
        timeout: 30_000,
        label: "Stop hook",
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "supports multi-turn: two messages in sequence both produce Stop events",
    async () => {
      ptyProcess = spawnClaude();
      const getOutput = collectPtyOutput(ptyProcess);

      await waitForRepl(ptyProcess, getOutput);

      ptyProcess.write('Say exactly "first" and nothing else\r');
      await waitFor(() => readHookOutput("Stop").length >= 1, {
        timeout: 60_000,
        label: "first Stop",
      });

      ptyProcess.write('Say exactly "second" and nothing else\r');
      await waitFor(() => readHookOutput("Stop").length >= 2, {
        timeout: 60_000,
        label: "second Stop",
      });

      expect(readHookOutput("Stop").length).toBeGreaterThanOrEqual(2);
    },
    TEST_TIMEOUT,
  );
});
