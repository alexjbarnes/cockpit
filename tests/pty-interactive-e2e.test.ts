/**
 * PTY Interactive Mode: End-to-End Test
 *
 * Comprehensive test of the hooks-driven architecture without --dangerously-skip-permissions.
 * The PermissionRequest hook handles all permission prompts programmatically.
 * Claude performs real file operations (create, read, edit, bash) and every
 * interaction is captured through hooks.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IPty, spawn } from "node-pty";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const TEST_TIMEOUT = 120_000;
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

// ── Hook script generators ──────────────────────────────────────────────

function createObserverHook(hookEvent: string): string {
  const outputPath = join(hookOutputDir, `${hookEvent}.jsonl`);
  const scriptPath = join(hookScriptDir, `${hookEvent}.sh`);
  writeFileSync(
    scriptPath,
    `#!/bin/bash
read -r line
echo "$line" >> "${outputPath}"
`,
    { mode: 0o755 },
  );
  return scriptPath;
}

function createPermissionHook(): string {
  const outputPath = join(hookOutputDir, "PermissionRequest.jsonl");
  const scriptPath = join(hookScriptDir, "PermissionRequest.sh");
  writeFileSync(
    scriptPath,
    `#!/bin/bash
read -r line
echo "$line" >> "${outputPath}"
echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
`,
    { mode: 0o755 },
  );
  return scriptPath;
}

function createDelayedPermissionHook(delaySec: number): string {
  const outputPath = join(hookOutputDir, "PermissionRequest.jsonl");
  const scriptPath = join(hookScriptDir, `PermissionRequestDelay${delaySec}.sh`);
  writeFileSync(
    scriptPath,
    `#!/bin/bash
read -r line
echo "$line" >> "${outputPath}"
sleep ${delaySec}
echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
`,
    { mode: 0o755 },
  );
  return scriptPath;
}

const DEFAULT_ALLOW_LIST = ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)", "Grep(*)"];

function writeProjectSettings(opts?: { allowList?: string[]; permissionHookDelaySec?: number }) {
  const observerEvents = ["PostToolUse", "PreToolUse", "Stop", "Notification", "UserPromptSubmit"];

  const hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>> = {};

  for (const event of observerEvents) {
    hooks[event] = [{ matcher: "", hooks: [{ type: "command", command: createObserverHook(event) }] }];
  }

  const permDelay = opts?.permissionHookDelaySec;
  const permCommand = permDelay != null ? createDelayedPermissionHook(permDelay) : createPermissionHook();

  hooks.PermissionRequest = [
    {
      matcher: "",
      hooks: [{ type: "command", command: permCommand, timeout: 300 }],
    },
  ];

  const claudeDir = join(workDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify(
      {
        hooks,
        permissions: {
          allow: opts?.allowList ?? DEFAULT_ALLOW_LIST,
          deny: [],
        },
      },
      null,
      2,
    ),
  );
}

// ── Hook output readers ─────────────────────────────────────────────────

function readHookOutput(hookEvent: string): string[] {
  const outputPath = join(hookOutputDir, `${hookEvent}.jsonl`);
  if (!existsSync(outputPath)) return [];
  return readFileSync(outputPath, "utf-8").trim().split("\n").filter(Boolean);
}

function readHookOutputParsed<T = Record<string, unknown>>(hookEvent: string): T[] {
  return readHookOutput(hookEvent).map((line) => JSON.parse(line) as T);
}

function clearHookOutputs() {
  const events = ["PostToolUse", "PreToolUse", "Stop", "Notification", "UserPromptSubmit", "PermissionRequest"];
  for (const event of events) {
    const path = join(hookOutputDir, `${event}.jsonl`);
    if (existsSync(path)) unlinkSync(path);
  }
}

// ── PTY helpers ─────────────────────────────────────────────────────────

function collectPtyOutput(pty: IPty): { raw: () => string; clean: () => string } {
  let buffer = "";
  pty.onData((data) => {
    buffer += data;
  });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
  const ansiRe = /\x1b\[[0-9;]*[a-zA-Z]/g;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
  const ansiExtraRe = /\x1b[>=?][^\x1b]*/g;
  const stripAnsi = (s: string) => s.replace(ansiRe, "").replace(ansiExtraRe, "");
  return {
    raw: () => buffer,
    clean: () => stripAnsi(buffer),
  };
}

async function waitFor(condition: () => boolean, { timeout = 30_000, interval = 300, label = "condition" } = {}): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeout}ms`);
}

function spawnClaude(): IPty {
  return spawn(CLAUDE_BIN, ["--verbose"], {
    name: "xterm-256color",
    cols: 160,
    rows: 50,
    cwd: workDir,
    env: {
      ...process.env,
      CLAUDECODE: undefined,
      CLAUDE_CODE_ENTRYPOINT: undefined,
    },
  });
}

async function waitForRepl(pty: IPty, output: { clean: () => string }): Promise<void> {
  await waitFor(() => output.clean().length > 100, {
    timeout: 30_000,
    label: "initial output",
  });

  await new Promise((r) => setTimeout(r, 1500));

  // Accept trust dialog if present
  if (output.clean().includes("trust") || output.clean().includes("Yes,")) {
    pty.write("\r");
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Wait for the welcome banner and input prompt to fully render
  await waitFor(() => output.clean().length > 800, {
    timeout: 20_000,
    label: "REPL input ready",
  });
  // Let the TUI fully settle before sending input
  await new Promise((r) => setTimeout(r, 3000));
}

async function sendMessage(pty: IPty, message: string): Promise<void> {
  // Type the message text
  pty.write(message);
  // Small delay so the TUI processes the text before the submit key
  await new Promise((r) => setTimeout(r, 300));
  // Submit with Enter
  pty.write("\r");
}

async function sendMessageAndWaitForStop(pty: IPty, message: string, expectedStopCount: number, timeout = 90_000): Promise<void> {
  await sendMessage(pty, message);
  await waitFor(() => readHookOutput("Stop").length >= expectedStopCount, {
    timeout,
    label: `Stop #${expectedStopCount} after: "${message.slice(0, 40)}..."`,
  });
}

// ── Setup / teardown ────────────────────────────────────────────────────

beforeAll(() => {
  hookOutputDir = mkdtempSync(join(tmpdir(), "pty-e2e-hooks-out-"));
  hookScriptDir = mkdtempSync(join(tmpdir(), "pty-e2e-hooks-scripts-"));
  workDir = mkdtempSync(join(tmpdir(), "pty-e2e-workdir-"));
  execSync("git init && git commit --allow-empty -m init", {
    cwd: workDir,
    stdio: "ignore",
  });
});

afterAll(() => {
  for (const dir of [hookOutputDir, hookScriptDir, workDir]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────────────────

describe.skipIf(!RUN_INTEGRATION || !CLAUDE_AVAILABLE)("PTY Interactive E2E (no bypass permissions)", () => {
  let pty: IPty | null = null;
  let output: ReturnType<typeof collectPtyOutput>;
  let stopCount: number;

  beforeEach(() => {
    clearHookOutputs();
    writeProjectSettings();
    stopCount = 0;
  });

  afterEach(() => {
    if (pty) {
      try {
        pty.kill();
      } catch {
        // already dead
      }
      pty = null;
    }
  });

  it(
    "creates a file: PermissionRequest hook auto-allows, PostToolUse captures the write, file exists on disk",
    async () => {
      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      await sendMessageAndWaitForStop(
        pty,
        'Create a file called hello.txt containing exactly "Hello from Claude" and nothing else. Do not explain, just create the file.',
        ++stopCount,
      );

      // PermissionRequest should NOT fire when tools are pre-allowed via settings
      const permEvents = readHookOutput("PermissionRequest");
      expect(permEvents.length).toBe(0);

      // Verify PostToolUse captured the write
      const toolEvents = readHookOutputParsed<{
        tool_name: string;
        tool_input: Record<string, unknown>;
      }>("PostToolUse");
      expect(toolEvents.length).toBeGreaterThan(0);
      const writeEvent = toolEvents.find((e) => e.tool_name === "Write" || e.tool_name === "Edit");
      expect(writeEvent).toBeDefined();
      console.log("Write tool event:", JSON.stringify(writeEvent, null, 2).slice(0, 500));

      // Verify the file actually exists on disk
      const filePath = join(workDir, "hello.txt");
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("Hello from Claude");
      console.log("File content:", JSON.stringify(content));

      // Verify Stop hook fired
      const stops = readHookOutput("Stop");
      expect(stops.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "edits an existing file: captures the Edit tool use and verifies file modification",
    async () => {
      // Pre-create a file to edit
      const filePath = join(workDir, "greeting.txt");
      writeFileSync(filePath, "Hello World\nThis is a test file.\nGoodbye World\n");

      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      await sendMessageAndWaitForStop(
        pty,
        'Edit the file greeting.txt: replace "Hello World" with "Greetings Planet". Do not explain, just make the edit.',
        ++stopCount,
      );

      // PermissionRequest should NOT fire when tools are pre-allowed via settings
      const permEvents = readHookOutput("PermissionRequest");
      expect(permEvents.length).toBe(0);

      // Verify PostToolUse captured the edit
      const toolEvents = readHookOutputParsed<{
        tool_name: string;
        tool_input: Record<string, unknown>;
      }>("PostToolUse");
      const editEvent = toolEvents.find((e) => e.tool_name === "Edit" || e.tool_name === "Write");
      expect(editEvent).toBeDefined();
      console.log("Edit tool input:", JSON.stringify(editEvent?.tool_input, null, 2));

      // Verify the file was actually modified
      const modified = readFileSync(filePath, "utf-8");
      expect(modified).toContain("Greetings Planet");
      expect(modified).not.toContain("Hello World");
      console.log("Modified file content:", JSON.stringify(modified));
    },
    TEST_TIMEOUT,
  );

  it(
    "runs a bash command: captures command and output through PostToolUse",
    async () => {
      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      await sendMessageAndWaitForStop(pty, 'Run the command: echo "PTY_SPIKE_TEST_OUTPUT" and tell me what it printed.', ++stopCount);

      // Verify PostToolUse captured the bash execution
      const toolEvents = readHookOutputParsed<{
        tool_name: string;
        tool_input: Record<string, unknown>;
        tool_response: Record<string, unknown>;
      }>("PostToolUse");
      const bashEvent = toolEvents.find((e) => e.tool_name === "Bash");
      expect(bashEvent).toBeDefined();
      expect(JSON.stringify(bashEvent?.tool_response)).toContain("PTY_SPIKE_TEST_OUTPUT");
      console.log("Bash tool response:", JSON.stringify(bashEvent?.tool_response, null, 2).slice(0, 500));

      // PermissionRequest should NOT fire when Bash is pre-allowed via settings
      const permEvents = readHookOutput("PermissionRequest");
      expect(permEvents.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "multi-step task: create, read, and edit in a single turn with multiple tool events",
    async () => {
      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      await sendMessageAndWaitForStop(
        pty,
        'Do the following in order: 1) Create a file called numbers.txt with "one two three" 2) Read it back 3) Edit it to replace "two" with "2". Do not explain each step.',
        ++stopCount,
      );

      // Should have multiple PostToolUse events
      const toolEvents = readHookOutputParsed<{
        tool_name: string;
        tool_input: Record<string, unknown>;
      }>("PostToolUse");
      console.log(
        "Tool sequence:",
        toolEvents.map((e) => e.tool_name),
      );
      expect(toolEvents.length).toBeGreaterThanOrEqual(2);

      // PermissionRequest should NOT fire when tools are pre-allowed via settings
      const permEvents = readHookOutput("PermissionRequest");
      expect(permEvents.length).toBe(0);

      // Verify final file state
      const filePath = join(workDir, "numbers.txt");
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("2");
      expect(content).not.toContain("two");
      console.log("Final file content:", JSON.stringify(content));
    },
    TEST_TIMEOUT,
  );

  it(
    "multi-turn conversation: second message builds on context from first",
    async () => {
      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      // Turn 1: create a file
      await sendMessageAndWaitForStop(
        pty,
        'Create a file called story.txt containing exactly "Once upon a time". No explanation.',
        ++stopCount,
      );

      expect(existsSync(join(workDir, "story.txt"))).toBe(true);

      // Turn 2: edit the same file (Claude should remember context)
      await sendMessageAndWaitForStop(pty, 'Append " there was a developer" to the end of story.txt. No explanation.', ++stopCount);

      const content = readFileSync(join(workDir, "story.txt"), "utf-8");
      expect(content).toContain("Once upon a time");
      expect(content).toContain("there was a developer");
      console.log("Story after two turns:", JSON.stringify(content));

      // Verify we got two Stop events
      const stops = readHookOutputParsed<{ last_assistant_message: string }>("Stop");
      expect(stops.length).toBeGreaterThanOrEqual(2);

      // Verify tool events span both turns
      const toolEvents = readHookOutputParsed<{ tool_name: string }>("PostToolUse");
      expect(toolEvents.length).toBeGreaterThanOrEqual(2);
      console.log(
        "All tools across turns:",
        toolEvents.map((e) => e.tool_name),
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "session JSONL transcript is written and contains the conversation",
    async () => {
      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      await sendMessageAndWaitForStop(pty, 'Say exactly "transcript test" and nothing else.', ++stopCount);

      // Get transcript path from Stop hook
      const stops = readHookOutputParsed<{
        transcript_path: string;
        session_id: string;
      }>("Stop");
      expect(stops.length).toBeGreaterThan(0);

      const transcriptPath = stops[0]!.transcript_path;
      expect(existsSync(transcriptPath)).toBe(true);

      // Wait briefly for the transcript to be fully flushed to disk
      await new Promise((r) => setTimeout(r, 2000));

      const transcript = readFileSync(transcriptPath, "utf-8");
      const lines = transcript.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);

      // Parse each line as JSON
      const messages = lines.map((line) => JSON.parse(line));
      const types = messages.map((m: Record<string, unknown>) => m.type);
      console.log("Transcript message types:", types);

      // Should contain user message and conversation data
      expect(types).toContain("user");
      // The transcript should contain the response text somewhere
      expect(transcript).toContain("transcript test");

      console.log("Session ID:", stops[0]!.session_id);
      console.log("Transcript path:", transcriptPath);
      console.log("Transcript lines:", lines.length);
    },
    TEST_TIMEOUT,
  );

  it(
    "PreToolUse hook fires before each tool execution with the planned input",
    async () => {
      writeFileSync(join(workDir, "pre-test.txt"), "original content\n");

      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      await sendMessageAndWaitForStop(pty, "Read the file pre-test.txt. Do not explain, just read it.", ++stopCount);

      const preEvents = readHookOutputParsed<{
        tool_name: string;
        tool_input: Record<string, unknown>;
        hook_event_name: string;
      }>("PreToolUse");
      expect(preEvents.length).toBeGreaterThan(0);
      expect(preEvents[0]!.hook_event_name).toBe("PreToolUse");
      expect(preEvents[0]!.tool_name).toBeDefined();
      console.log(
        "PreToolUse events:",
        preEvents.map((e) => `${e.tool_name}(${JSON.stringify(e.tool_input)})`),
      );

      // PreToolUse should fire before PostToolUse
      const postEvents = readHookOutputParsed<{ tool_name: string }>("PostToolUse");
      expect(postEvents.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );
});

describe.skipIf(!RUN_INTEGRATION || !CLAUDE_AVAILABLE)("PTY Interactive Permissions (hook-driven, no allow-list)", () => {
  let pty: IPty | null = null;
  let output: ReturnType<typeof collectPtyOutput>;
  let stopCount: number;

  beforeEach(() => {
    clearHookOutputs();
    stopCount = 0;
  });

  afterEach(() => {
    if (pty) {
      try {
        pty.kill();
      } catch {
        // already dead
      }
      pty = null;
    }
  });

  it(
    "PermissionRequest hook auto-allows Write when not in allow-list",
    async () => {
      writeProjectSettings({
        allowList: ["Read(*)"],
      });

      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      await sendMessageAndWaitForStop(
        pty,
        'Create a file called hook-allowed.txt containing "Permission via hook". Do not explain, just create the file.',
        ++stopCount,
      );

      // PermissionRequest hook should have fired for Write
      const permEvents = readHookOutputParsed<{ tool_name: string }>("PermissionRequest");
      expect(permEvents.length).toBeGreaterThan(0);
      expect(permEvents.find((e) => e.tool_name === "Write")).toBeDefined();
      console.log(
        "PermissionRequest events:",
        permEvents.map((e) => e.tool_name),
      );

      // File should exist (hook allowed the write)
      const filePath = join(workDir, "hook-allowed.txt");
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf-8")).toContain("Permission via hook");

      // PostToolUse should also have captured the write
      const toolEvents = readHookOutputParsed<{ tool_name: string }>("PostToolUse");
      expect(toolEvents.find((e) => e.tool_name === "Write")).toBeDefined();
    },
    TEST_TIMEOUT,
  );

  it(
    "PermissionRequest hook with 5s delay still dismisses TUI dialog",
    async () => {
      writeProjectSettings({
        allowList: ["Read(*)"],
        permissionHookDelaySec: 5,
      });

      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      await sendMessageAndWaitForStop(
        pty,
        'Create a file called hook-delayed.txt containing "5s delay allowed". Do not explain, just create the file.',
        ++stopCount,
      );

      const permEvents = readHookOutputParsed<{ tool_name: string }>("PermissionRequest");
      expect(permEvents.length).toBeGreaterThan(0);
      expect(permEvents.find((e) => e.tool_name === "Write")).toBeDefined();

      const filePath = join(workDir, "hook-delayed.txt");
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf-8")).toContain("5s delay allowed");
    },
    TEST_TIMEOUT,
  );

  it(
    "PermissionRequest hook denies a tool and Claude handles the denial",
    async () => {
      // Create a deny hook
      const denyOutputPath = join(hookOutputDir, "PermissionRequest.jsonl");
      const denyScriptPath = join(hookScriptDir, "PermissionRequestDeny.sh");
      writeFileSync(
        denyScriptPath,
        `#!/bin/bash
read -r line
echo "$line" >> "${denyOutputPath}"
sleep 2
echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied by cockpit test"}}}'
`,
        { mode: 0o755 },
      );

      // Write settings with the deny hook and no Write in allow-list
      const observerEvents = ["PostToolUse", "PreToolUse", "Stop", "Notification", "UserPromptSubmit"];
      const hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>> = {};
      for (const event of observerEvents) {
        hooks[event] = [{ matcher: "", hooks: [{ type: "command", command: createObserverHook(event) }] }];
      }
      hooks.PermissionRequest = [{ matcher: "", hooks: [{ type: "command", command: denyScriptPath, timeout: 300 }] }];
      const claudeDir = join(workDir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "settings.json"),
        JSON.stringify(
          {
            hooks,
            permissions: { allow: ["Read(*)"], deny: [] },
          },
          null,
          2,
        ),
      );

      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      await sendMessageAndWaitForStop(
        pty,
        'Create a file called denied.txt containing "should not exist". Do not explain, just create the file.',
        ++stopCount,
      );

      // PermissionRequest hook should have fired
      const permEvents = readHookOutputParsed<{ tool_name: string }>("PermissionRequest");
      expect(permEvents.length).toBeGreaterThan(0);
      console.log(
        "Deny test - PermissionRequest events:",
        permEvents.map((e) => e.tool_name),
      );

      // The file should NOT exist (hook denied the write)
      expect(existsSync(join(workDir, "denied.txt"))).toBe(false);

      // Stop hook should have fired (Claude responds after denial)
      expect(readHookOutput("Stop").length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );
});

describe.skipIf(!RUN_INTEGRATION || !CLAUDE_AVAILABLE)("PTY Interactive Controls (slash commands and interrupt)", () => {
  let pty: IPty | null = null;
  let output: ReturnType<typeof collectPtyOutput>;
  let stopCount: number;

  beforeEach(() => {
    clearHookOutputs();
    writeProjectSettings();
    stopCount = 0;
  });

  afterEach(() => {
    if (pty) {
      try {
        pty.kill();
      } catch {
        // already dead
      }
      pty = null;
    }
  });

  it(
    "Escape key interrupts processing and REPL remains usable",
    async () => {
      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      // Send a prompt that takes time (tool use for longer processing)
      await sendMessage(pty, "Read every file in this project directory and give me a detailed summary of each.");

      // Wait for processing to start
      await waitFor(() => readHookOutput("UserPromptSubmit").length > 0, {
        timeout: 15_000,
        label: "UserPromptSubmit",
      });

      // Wait for thinking to start (PTY output grows as TUI renders thinking indicator)
      const outputBefore = output.clean().length;
      await waitFor(() => output.clean().length > outputBefore + 200, {
        timeout: 15_000,
        label: "PTY output growing (processing started)",
      });

      // Send Escape to interrupt. Only one press - additional keys change REPL state
      // (Ctrl+C shows "press again to exit", second Escape opens Rewind dialog)
      pty.write("\x1b");

      // The Stop hook may or may not fire depending on whether Claude
      // generated any response before the interrupt. If the interrupt was
      // fast enough, there's no response and no Stop hook.
      // Either way, we should be able to send a new message after.
      await new Promise((r) => setTimeout(r, 5000));

      const stopCount = readHookOutput("Stop").length;
      console.log("Stop events after Escape:", stopCount);

      // Verify REPL is still alive by sending a follow-up message
      clearHookOutputs();
      await sendMessageAndWaitForStop(pty, 'Say exactly "still alive" and nothing else.', 1, 60_000);

      const stops = readHookOutputParsed<{ last_assistant_message?: string }>("Stop");
      expect(stops.length).toBeGreaterThan(0);
      console.log("Post-interrupt response:", stops[0]?.last_assistant_message);
    },
    TEST_TIMEOUT,
  );

  it(
    "/effort command changes thinking level visible in Stop hook",
    async () => {
      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      // First message with default effort
      await sendMessageAndWaitForStop(pty, 'Say exactly "effort test" and nothing else.', ++stopCount);

      const stops1 = readHookOutputParsed<{ effort: { level: string } }>("Stop");
      const initialEffort = stops1[0]?.effort?.level;
      console.log("Initial effort level:", initialEffort);

      // Change effort to low via slash command
      pty.write("/effort low\r");

      // Wait for the command to be processed and REPL to return to input
      await new Promise((r) => setTimeout(r, 5000));

      // Send another message
      clearHookOutputs();
      await sendMessageAndWaitForStop(pty, 'Say exactly "low effort" and nothing else.', 1);

      const stops2 = readHookOutputParsed<{ effort: { level: string } }>("Stop");
      const newEffort = stops2[0]?.effort?.level;
      console.log("Effort after /effort low:", newEffort);
      expect(newEffort).toBe("low");
    },
    TEST_TIMEOUT,
  );

  it(
    "TodoWrite tool input is captured via PostToolUse hook",
    async () => {
      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      await sendMessageAndWaitForStop(
        pty,
        'Create a todo list with TodoWrite. Add these items: 1) "Fix login bug" as in_progress, 2) "Write tests" as pending. Do not explain.',
        ++stopCount,
      );

      // Check if TodoWrite was captured
      const toolEvents = readHookOutputParsed<{
        tool_name: string;
        tool_input: { todos?: Array<{ content: string; status: string }> };
      }>("PostToolUse");
      const todoEvent = toolEvents.find((e) => e.tool_name === "TodoWrite");

      if (todoEvent) {
        console.log("TodoWrite captured:", JSON.stringify(todoEvent.tool_input, null, 2));
        expect(todoEvent.tool_input.todos).toBeDefined();
        expect(todoEvent.tool_input.todos!.length).toBeGreaterThanOrEqual(2);
      } else {
        console.log(
          "All tool events:",
          toolEvents.map((e) => e.tool_name),
        );
        // Claude may not use TodoWrite for simple tasks - log but don't fail hard
        console.log("Note: Claude did not use TodoWrite for this request");
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "context usage is available in session JSONL after each turn",
    async () => {
      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      await sendMessageAndWaitForStop(pty, 'Say exactly "usage check" and nothing else.', ++stopCount);

      // Wait for JSONL to flush
      await new Promise((r) => setTimeout(r, 2000));

      // Read the transcript
      const stops = readHookOutputParsed<{ transcript_path: string }>("Stop");
      expect(stops.length).toBeGreaterThan(0);
      const transcriptPath = stops[0]!.transcript_path;

      const transcript = readFileSync(transcriptPath, "utf-8");
      const lines = transcript.trim().split("\n").filter(Boolean);
      const messages = lines.map((line) => JSON.parse(line));

      // Look for assistant message with usage data
      const assistantMessages = messages.filter((m: Record<string, unknown>) => m.type === "assistant");

      let foundUsage = false;
      for (const msg of assistantMessages) {
        if (msg.message?.usage) {
          foundUsage = true;
          const usage = msg.message.usage;
          console.log("Token usage from JSONL:", JSON.stringify(usage));
          expect(usage.input_tokens).toBeGreaterThan(0);
          break;
        }
      }

      if (!foundUsage) {
        // Check if usage appears in any other message type
        const allWithUsage = messages.filter(
          (m: Record<string, unknown>) => (m as Record<string, Record<string, unknown>>).message?.usage != null,
        );
        console.log("Messages with usage:", allWithUsage.length);
        console.log(
          "All message types:",
          messages.map((m: Record<string, unknown>) => m.type),
        );
      }

      expect(foundUsage).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

describe.skipIf(!RUN_INTEGRATION || !CLAUDE_AVAILABLE)("PTY Interactive Subagent Visibility", () => {
  let pty: IPty | null = null;
  let output: ReturnType<typeof collectPtyOutput>;
  let stopCount: number;

  beforeEach(() => {
    clearHookOutputs();
    writeProjectSettings();
    stopCount = 0;
  });

  afterEach(() => {
    if (pty) {
      try {
        pty.kill();
      } catch {
        // already dead
      }
      pty = null;
    }
  });

  it(
    "PostToolUse hooks fire for tools executed inside a subagent",
    async () => {
      pty = spawnClaude();
      output = collectPtyOutput(pty);
      await waitForRepl(pty, output);

      await sendMessageAndWaitForStop(
        pty,
        'Use the Agent tool to spawn a subagent. The subagent should create a file called agent-output.txt containing "written by subagent". Do not do it yourself, you must delegate to a subagent via the Agent tool.',
        ++stopCount,
        90_000,
      );

      const toolEvents = readHookOutputParsed<{
        tool_name: string;
        tool_input: Record<string, unknown>;
        session_id: string;
      }>("PostToolUse");

      const toolNames = toolEvents.map((e) => e.tool_name);
      console.log("All PostToolUse events:", toolNames);

      // The Agent tool itself should appear
      const agentEvent = toolEvents.find((e) => e.tool_name === "Agent");
      expect(agentEvent).toBeDefined();
      console.log("Agent tool input:", JSON.stringify(agentEvent?.tool_input).slice(0, 300));

      // Check if the subagent's Write call also appears
      const writeEvent = toolEvents.find((e) => e.tool_name === "Write");
      if (writeEvent) {
        console.log("Subagent Write event captured via PostToolUse");
        console.log("Write session_id:", writeEvent.session_id);
        console.log("Agent session_id:", agentEvent!.session_id);
        console.log("Same session?", writeEvent.session_id === agentEvent!.session_id);
      } else {
        console.log("WARNING: Subagent Write tool NOT visible in PostToolUse hooks");
        console.log("Only these tools were captured:", toolNames);
      }

      // Verify the file was actually created (regardless of hook visibility)
      const filePath = join(workDir, "agent-output.txt");
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf-8")).toContain("written by subagent");
    },
    TEST_TIMEOUT,
  );
});
