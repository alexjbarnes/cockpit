import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    // Spy from creation so writes made during spawn() itself (init / thinking-off
    // / initial text) are captured too, not just ones made after a test spies.
    vi.spyOn(stdin, "write");
    return Object.assign(emitter, {
      pid: 99999,
      stdin,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
  }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn(), unlinkSync: vi.fn() };
});

vi.mock("@/server/claude-bin", () => ({ getClaudeBin: () => "claude" }));

vi.mock("@/server/debug-logger", () => ({
  debugLog: vi.fn(),
  logRawLine: vi.fn(),
  logDiag: vi.fn(),
  logParsedEvent: vi.fn(),
  logStatus: vi.fn(),
  logServerMessage: vi.fn(),
  logClientMessage: vi.fn(),
  isDebugEnabled: vi.fn(() => false),
}));

const mockPtyInstances: any[] = [];
let nextPtyStartRejects = false;
vi.mock("@/server/pty-runtime", () => {
  class MockPtyRuntime {
    isAlive = true;
    pid = 12345;
    start = vi.fn(() => (nextPtyStartRejects ? Promise.reject(new Error("boom")) : Promise.resolve(undefined)));
    kill = vi.fn().mockResolvedValue(undefined);
    sendText = vi.fn().mockResolvedValue(undefined);
    sendUserText = vi.fn().mockResolvedValue(undefined);
    interrupt = vi.fn();
    notifyPermissionDecision = vi.fn(() => true);
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      mockPtyInstances.push(this);
    }
  }
  return { PtyRuntime: MockPtyRuntime };
});

let mockHookRouter: unknown = { register: vi.fn(), unregister: vi.fn() };
vi.mock("@/server/singleton", () => ({
  getHookRouter: vi.fn(() => mockHookRouter),
  getCockpitMcp: vi.fn(() => null),
}));

const mockWatcherInstances: any[] = [];
vi.mock("@/server/transcript-watcher", () => {
  class MockTranscriptWatcher {
    cliSessionId: string;
    cwd: string;
    onUpdate: (messages: unknown[], lastUsage: { used: number } | null) => void;
    start = vi.fn();
    stop = vi.fn();
    constructor(cliSessionId: string, cwd: string, onUpdate: (messages: unknown[], lastUsage: { used: number } | null) => void) {
      this.cliSessionId = cliSessionId;
      this.cwd = cwd;
      this.onUpdate = onUpdate;
      mockWatcherInstances.push(this);
    }
  }
  return { TranscriptWatcher: MockTranscriptWatcher };
});

import { spawn } from "node:child_process";
import { getFeatureFlags } from "@/lib/flags";
import { ClaudePtyAdapter } from "@/server/harness/claude-pty-adapter";
import { buildContent, ClaudeStreamAdapter } from "@/server/harness/claude-stream-adapter";
import { getHarnessAdapter, HARNESS_REGISTRY } from "@/server/harness/registry";
import type { HarnessProcessCallbacks, HarnessSpawnConfig } from "@/server/harness/types";

function baseConfig(overrides: Partial<HarnessSpawnConfig> = {}): HarnessSpawnConfig {
  const callbacks: HarnessProcessCallbacks = {
    onParsedEvents: vi.fn(),
    onError: vi.fn(),
    onExit: vi.fn(),
    onRawLine: vi.fn(),
    onTranscriptUpdate: vi.fn(),
  };
  return {
    sessionId: "sess-1",
    cwd: "/tmp/proj",
    cliSessionId: "cli-1",
    willResume: false,
    contextSize: "200k",
    thinkingLevel: "high",
    supportsEffort: true,
    planMode: false,
    bypassAllPermissions: false,
    cockpitAgent: false,
    modelSlots: { main: "sonnet" },
    callbacks,
    ...overrides,
  };
}

describe("buildContent", () => {
  it("returns plain text with no reminder/images/documents", () => {
    expect(buildContent("hi")).toBe("hi");
  });

  it("puts the reminder block first when text and reminder are both present", () => {
    const result = buildContent("hi", undefined, undefined, "remember this") as Record<string, unknown>[];
    expect(result[0]).toEqual({ type: "text", text: "remember this" });
    expect(result[result.length - 1]).toEqual({ type: "text", text: "hi" });
  });

  it("omits the trailing text block when text is empty", () => {
    const result = buildContent("", [{ mediaType: "image/png", data: "AA==" }]) as Record<string, unknown>[];
    expect(result.every((b) => b.type !== "text")).toBe(true);
  });
});

describe("ClaudeStreamAdapter", () => {
  let adapter: ClaudeStreamAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new ClaudeStreamAdapter();
  });

  function spawnHandle(overrides: Partial<HarnessSpawnConfig> = {}) {
    const config = baseConfig(overrides);
    const handle = adapter.spawn(config);
    const mockSpawn = vi.mocked(spawn);
    const proc: any = mockSpawn.mock.results[mockSpawn.mock.results.length - 1].value;
    return { handle, proc, config };
  }

  it("uses --session-id for a new session and --resume for an existing one", () => {
    spawnHandle({ willResume: false });
    let args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain("--session-id");
    expect(args).not.toContain("--resume");

    vi.clearAllMocks();
    spawnHandle({ willResume: true });
    args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain("--resume");
  });

  it("omits --allow-dangerously-skip-permissions in plan mode", () => {
    spawnHandle({ planMode: true });
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).not.toContain("--allow-dangerously-skip-permissions");
    expect(args).toContain("plan");
  });

  it("sets bypassPermissions mode when bypass is active outside plan mode", () => {
    spawnHandle({ bypassAllPermissions: true });
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain("bypassPermissions");
  });

  it("passes --model and --effort when the model supports effort", () => {
    spawnHandle({ model: "claude-sonnet-5", supportsEffort: true, thinkingLevel: "max" });
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(args[args.indexOf("--effort") + 1]).toBe("max");
  });

  it("omits --effort when thinkingLevel is off, and sends an apply_flag_settings control request instead", () => {
    const { proc } = spawnHandle({ supportsEffort: true, thinkingLevel: "off" });
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).not.toContain("--effort");
    const bodies = (proc.stdin.write as any).mock.calls.map((c: any[]) => JSON.parse(c[0]));
    expect(
      bodies.some((b: any) => b.request?.subtype === "apply_flag_settings" && b.request.settings.alwaysThinkingEnabled === false),
    ).toBe(true);
  });

  it("sets CLAUDE_CODE_DISABLE_1M_CONTEXT for 200k and omits it for 1m", () => {
    spawnHandle({ contextSize: "200k" });
    let env = vi.mocked(spawn).mock.calls[0][2]!.env as Record<string, string>;
    expect(env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe("1");

    vi.clearAllMocks();
    spawnHandle({ contextSize: "1m" });
    env = vi.mocked(spawn).mock.calls[0][2]!.env as Record<string, string>;
    expect(env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBeUndefined();
  });

  it("sets ANTHROPIC_SMALL_FAST_MODEL from subagentModel", () => {
    spawnHandle({ subagentModel: "claude-haiku-4-5-20251001" });
    const env = vi.mocked(spawn).mock.calls[0][2]!.env as Record<string, string>;
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-haiku-4-5-20251001");
  });

  it("merges providerEnvVars into the spawned env", () => {
    spawnHandle({ providerEnvVars: { ANTHROPIC_BASE_URL: "http://mock" } });
    const env = vi.mocked(spawn).mock.calls[0][2]!.env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe("http://mock");
  });

  it("appends the cockpit-agent system prompt and mcp config only for cockpitAgent sessions", () => {
    spawnHandle({ cockpitAgent: true, appendSystemPrompt: "SYS", mcpConfigPath: "/tmp/mcp.json" });
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("SYS");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/mcp.json");

    vi.clearAllMocks();
    spawnHandle({ cockpitAgent: false });
    const args2 = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args2).not.toContain("--append-system-prompt");
  });

  it("sends the initial text as a user message on spawn", () => {
    const { proc } = spawnHandle({ text: "hello there" });
    const writes = (proc.stdin.write as any).mock.calls.map((c: any[]) => JSON.parse(c[0]));
    const userWrite = writes.find((w: any) => w.type === "user");
    expect(userWrite.message.content).toBe("hello there");
  });

  describe("HarnessProcess returned by spawn()", () => {
    it("isAlive is true immediately and false after the process closes", () => {
      const { handle, proc } = spawnHandle();
      expect(handle.isAlive).toBe(true);
      proc.emit("close", 0, null);
      expect(handle.isAlive).toBe(false);
    });

    it("ready resolves immediately", async () => {
      const { handle } = spawnHandle();
      await expect(handle.ready).resolves.toBeUndefined();
    });

    it("sendUserMessage writes a user turn with images as content blocks", () => {
      const { handle, proc } = spawnHandle();
      const writeSpy = vi.spyOn(proc.stdin, "write");
      handle.sendUserMessage("check this", [{ mediaType: "image/png", data: "AA==" }]);
      const written = JSON.parse(writeSpy.mock.calls[writeSpy.mock.calls.length - 1][0] as string);
      expect(written.type).toBe("user");
      expect(Array.isArray(written.message.content)).toBe(true);
    });

    it("interrupt writes a control_request", () => {
      const { handle, proc } = spawnHandle();
      const writeSpy = vi.spyOn(proc.stdin, "write");
      handle.interrupt();
      const written = JSON.parse(writeSpy.mock.calls[writeSpy.mock.calls.length - 1][0] as string);
      expect(written.type).toBe("control_request");
      expect(written.request.subtype).toBe("interrupt");
    });

    // No test for the "stdin already null" kill/interrupt fallback: spawn()
    // itself unconditionally does proc.stdin!.on("error", ...) right after
    // spawning, which requires a real stdin stream. child_process.spawn is
    // always called here with stdio:["pipe","pipe","pipe"], which guarantees
    // a non-null stdin, so that branch is defensive and unreachable through
    // this adapter's own spawn() path — there's no way to construct the
    // scenario without bypassing spawn() entirely (ClaudeStreamProcess isn't
    // exported).

    it("kill writes end_session with the given reason and sets a SIGTERM fallback timer", () => {
      vi.useFakeTimers();
      try {
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const { handle, proc } = spawnHandle();
        const writeSpy = vi.spyOn(proc.stdin, "write");
        handle.kill("session_reset");
        const written = JSON.parse(writeSpy.mock.calls[writeSpy.mock.calls.length - 1][0] as string);
        expect(written.request.subtype).toBe("end_session");
        expect(written.request.reason).toBe("session_reset");

        vi.advanceTimersByTime(3001);
        expect(killSpy).toHaveBeenCalledWith(-99999, "SIGTERM");
        killSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it("kill's fallback timer is cleared if the process closes first", () => {
      vi.useFakeTimers();
      try {
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const { handle, proc } = spawnHandle();
        handle.kill();
        proc.emit("close", 0, null);
        killSpy.mockClear();
        vi.advanceTimersByTime(5000);
        expect(killSpy).not.toHaveBeenCalled();
        killSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it("respondToPermission writes allow and deny control_response shapes", () => {
      const { handle, proc } = spawnHandle();
      const writeSpy = vi.spyOn(proc.stdin, "write");
      handle.respondToPermission("req-1", true, { command: "ls" });
      let written = JSON.parse(writeSpy.mock.calls[writeSpy.mock.calls.length - 1][0] as string);
      expect(written.response.response.behavior).toBe("allow");

      handle.respondToPermission("req-2", false, undefined, undefined, "nope");
      written = JSON.parse(writeSpy.mock.calls[writeSpy.mock.calls.length - 1][0] as string);
      expect(written.response.response.behavior).toBe("deny");
      expect(written.response.response.message).toBe("nope");
    });

    it("writeControlRequest resolves onResponse when a matching control_response arrives, and cancelControlRequest forgets it", () => {
      const { handle, proc } = spawnHandle();
      const onResponse = vi.fn();
      handle.writeControlRequest!({ type: "control_request", request_id: "ctrl-1", request: { subtype: "mcp_status" } }, onResponse);

      const line = JSON.stringify({ type: "control_response", request_id: "ctrl-1", response: { ok: true } });
      proc.stdout.emit("data", Buffer.from(line + "\n"));
      expect(onResponse).toHaveBeenCalledWith({ ok: true });

      onResponse.mockClear();
      handle.writeControlRequest!({ type: "control_request", request_id: "ctrl-2", request: { subtype: "mcp_status" } }, onResponse);
      handle.cancelControlRequest!("ctrl-2");
      const line2 = JSON.stringify({ type: "control_response", request_id: "ctrl-2", response: { ok: true } });
      expect(() => proc.stdout.emit("data", Buffer.from(line2 + "\n"))).not.toThrow();
      expect(onResponse).not.toHaveBeenCalled();
    });
  });

  describe("stdout line processing", () => {
    it("routes normal lines through onParsedEvents and onRawLine", () => {
      const { proc, config } = spawnHandle();
      proc.stdout.emit("data", Buffer.from('{"type":"result","result":"hi"}\n'));
      expect(config.callbacks.onRawLine).toHaveBeenCalled();
      expect(config.callbacks.onParsedEvents).toHaveBeenCalled();
    });

    it("buffers incomplete JSON across chunks and parses once complete", () => {
      const { proc, config } = spawnHandle();
      vi.mocked(config.callbacks.onParsedEvents as any).mockClear();
      proc.stdout.emit("data", Buffer.from('{"type":"resu'));
      expect(config.callbacks.onParsedEvents).not.toHaveBeenCalled();
      proc.stdout.emit("data", Buffer.from('lt","result":"hi"}\n'));
      expect(config.callbacks.onParsedEvents).toHaveBeenCalled();
    });

    it("flushes a trailing unterminated line on close", () => {
      const { proc, config } = spawnHandle();
      vi.mocked(config.callbacks.onParsedEvents as any).mockClear();
      proc.stdout.emit("data", Buffer.from('{"type":"result","result":"hi"}'));
      proc.emit("close", 0, null);
      expect(config.callbacks.onParsedEvents).toHaveBeenCalled();
    });

    it("emits onError with stderr on non-zero exit, and stays silent on a clean exit", () => {
      const { proc, config } = spawnHandle();
      proc.stderr.emit("data", Buffer.from("boom"));
      proc.emit("close", 1, null);
      expect(config.callbacks.onError).toHaveBeenCalledWith("boom");

      vi.clearAllMocks();
      const second = spawnHandle();
      second.proc.stderr.emit("data", Buffer.from("just a warning"));
      second.proc.emit("close", 0, null);
      expect(second.config.callbacks.onError).not.toHaveBeenCalled();
    });

    it("calls onExit with code and signal on close, and on a process error event", () => {
      const { proc, config } = spawnHandle();
      proc.emit("close", 0, "SIGTERM");
      expect(config.callbacks.onExit).toHaveBeenCalledWith({ code: 0, signal: "SIGTERM" });

      vi.clearAllMocks();
      const second = spawnHandle();
      second.proc.emit("error", new Error("spawn failed"));
      expect(second.config.callbacks.onError).toHaveBeenCalledWith("spawn failed");
      expect(second.config.callbacks.onExit).toHaveBeenCalledWith({ code: null });
    });
  });
});

describe("ClaudePtyAdapter", () => {
  let adapter: ClaudePtyAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPtyInstances.length = 0;
    mockWatcherInstances.length = 0;
    mockHookRouter = { register: vi.fn(), unregister: vi.fn() };
    adapter = new ClaudePtyAdapter();
  });

  it("throws synchronously when no hook router is registered", () => {
    mockHookRouter = null;
    expect(() => adapter.spawn(baseConfig())).toThrow(/hook router/i);
  });

  it("uses --session-id for a new session and --resume for an existing one", () => {
    adapter.spawn(baseConfig({ willResume: false }));
    expect(mockPtyInstances[0].opts.extraArgs).toContain("--session-id");

    adapter.spawn(baseConfig({ willResume: true }));
    expect(mockPtyInstances[1].opts.extraArgs).toContain("--resume");
  });

  it("passes --model and --effort when supported, and omits --effort when off", () => {
    adapter.spawn(baseConfig({ model: "claude-opus-4-8", supportsEffort: true, thinkingLevel: "xhigh" }));
    const args = mockPtyInstances[0].opts.extraArgs as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-8");
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");

    adapter.spawn(baseConfig({ supportsEffort: true, thinkingLevel: "off" }));
    expect(mockPtyInstances[1].opts.extraArgs).not.toContain("--effort");
    expect(mockPtyInstances[1].opts.thinkingEnabled).toBe(false);
  });

  it("sets plan and bypass permission modes exclusively", () => {
    adapter.spawn(baseConfig({ planMode: true, bypassAllPermissions: true }));
    expect(mockPtyInstances[0].opts.extraArgs).toContain("plan");

    adapter.spawn(baseConfig({ planMode: false, bypassAllPermissions: true, cockpitAgent: false }));
    expect(mockPtyInstances[1].opts.extraArgs).toContain("bypassPermissions");
  });

  it("appends the cockpit-agent system prompt and mcp config only for cockpitAgent sessions", () => {
    adapter.spawn(baseConfig({ cockpitAgent: true, appendSystemPrompt: "SYS", mcpConfigPath: "/tmp/mcp.json" }));
    const args = mockPtyInstances[0].opts.extraArgs as string[];
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("SYS");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/mcp.json");
  });

  it("builds extraEnv from providerEnvVars, context size, and subagent model", () => {
    adapter.spawn(
      baseConfig({
        providerEnvVars: { ANTHROPIC_BASE_URL: "http://mock" },
        contextSize: "200k",
        subagentModel: "claude-haiku-4-5-20251001",
      }),
    );
    const env = mockPtyInstances[0].opts.extraEnv as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe("http://mock");
    expect(env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe("1");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-haiku-4-5-20251001");

    adapter.spawn(baseConfig({ contextSize: "1m" }));
    expect(mockPtyInstances[1].opts.extraEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBeUndefined();
  });

  it("starts the PTY with the initial text and resolves ready once start() resolves, starting the watcher", async () => {
    const handle = adapter.spawn(baseConfig({ text: "hi" }));
    const runtime = mockPtyInstances[0];
    expect(runtime.start).toHaveBeenCalledWith("hi");
    await handle.ready;
    expect(mockWatcherInstances[0].start).toHaveBeenCalled();
  });

  it("ready rejects and stops the watcher when start() rejects", async () => {
    nextPtyStartRejects = true;
    try {
      const handle = adapter.spawn(baseConfig());
      await expect(handle.ready).rejects.toThrow("boom");
      expect(mockWatcherInstances[mockWatcherInstances.length - 1].stop).toHaveBeenCalled();
    } finally {
      nextPtyStartRejects = false;
    }
  });

  describe("HarnessProcess returned by spawn()", () => {
    it("isAlive delegates to the underlying PtyRuntime", () => {
      const handle = adapter.spawn(baseConfig());
      const runtime = mockPtyInstances[0];
      expect(handle.isAlive).toBe(true);
      runtime.isAlive = false;
      expect(handle.isAlive).toBe(false);
    });

    it("sendUserMessage embeds attachment paths and cleans up the previous call's files", () => {
      const handle = adapter.spawn(baseConfig());
      const runtime = mockPtyInstances[0];

      handle.sendUserMessage("first", [{ mediaType: "image/png", data: "AA==" }]);
      expect(runtime.sendUserText).toHaveBeenCalledWith(expect.stringContaining("[Attached image:"));
      expect(runtime.sendUserText).toHaveBeenCalledWith(expect.stringContaining("first"));

      handle.sendUserMessage("second");
      expect(runtime.sendUserText).toHaveBeenLastCalledWith("second");
    });

    it("sendRawCommand returns true and forwards when alive, false when not", () => {
      const handle = adapter.spawn(baseConfig());
      const runtime = mockPtyInstances[0];
      expect(handle.sendRawCommand!("/compact")).toBe(true);
      expect(runtime.sendText).toHaveBeenCalledWith("/compact");

      runtime.isAlive = false;
      expect(handle.sendRawCommand!("/context")).toBe(false);
    });

    it("interrupt and kill delegate to the underlying PtyRuntime, and kill stops the watcher", () => {
      const handle = adapter.spawn(baseConfig());
      const runtime = mockPtyInstances[0];
      handle.interrupt();
      expect(runtime.interrupt).toHaveBeenCalled();

      handle.kill();
      expect(runtime.kill).toHaveBeenCalled();
      expect(mockWatcherInstances[0].stop).toHaveBeenCalled();
    });

    it("respondToPermission maps allow/deny onto notifyPermissionDecision", () => {
      const handle = adapter.spawn(baseConfig());
      const runtime = mockPtyInstances[0];
      handle.respondToPermission("req-1", true, { command: "ls" });
      expect(runtime.notifyPermissionDecision).toHaveBeenCalledWith("req-1", { behavior: "allow", updatedInput: { command: "ls" } });

      handle.respondToPermission("req-2", false, undefined, undefined, "no");
      expect(runtime.notifyPermissionDecision).toHaveBeenCalledWith("req-2", { behavior: "deny", message: "no" });
    });

    it("onExit stops the watcher and forwards code/signal to the callback", () => {
      const config = baseConfig();
      adapter.spawn(config);
      const opts = mockPtyInstances[0].opts as { onExit: (info: { exitCode: number; signal?: number }) => void };
      opts.onExit({ exitCode: 1, signal: 15 });
      expect(mockWatcherInstances[0].stop).toHaveBeenCalled();
      expect(config.callbacks.onExit).toHaveBeenCalledWith({ code: 1, signal: "15" });
    });

    it("onEvents and onError pass straight through to the callbacks", () => {
      const config = baseConfig();
      adapter.spawn(config);
      const opts = mockPtyInstances[0].opts as { onEvents: (e: unknown[]) => void; onError: (e: string) => void };
      opts.onEvents([{ type: "init" }] as any);
      expect(config.callbacks.onParsedEvents).toHaveBeenCalledWith([{ type: "init" }]);
      opts.onError("pty broke");
      expect(config.callbacks.onError).toHaveBeenCalledWith("pty broke");
    });

    it("onTranscriptUpdate forwards messages and usage from the TranscriptWatcher", () => {
      const config = baseConfig();
      adapter.spawn(config);
      mockWatcherInstances[0].onUpdate([{ id: "m1" }], { used: 100 });
      expect(config.callbacks.onTranscriptUpdate).toHaveBeenCalledWith([{ id: "m1" }], { used: 100 });
    });
  });
});

describe("HARNESS_REGISTRY / getHarnessAdapter", () => {
  it("has a fully-capable claude entry supporting both transports", () => {
    expect(HARNESS_REGISTRY.claude.transports).toEqual(["stream", "pty"]);
    expect(HARNESS_REGISTRY.claude.capabilities.supportsPty).toBe(true);
    expect(HARNESS_REGISTRY.claude.capabilities.supportsMcp).toBe(true);
  });

  it("returns a ClaudeStreamAdapter for stream and a ClaudePtyAdapter for pty", () => {
    expect(getHarnessAdapter("claude", "stream")).toBeInstanceOf(ClaudeStreamAdapter);
    expect(getHarnessAdapter("claude", "pty")).toBeInstanceOf(ClaudePtyAdapter);
  });

  it("throws for an unknown harness id", () => {
    expect(() => getHarnessAdapter("codex" as any, "stream")).toThrow(/unknown harness/i);
  });
});

describe("getFeatureFlags", () => {
  const original = process.env.COCKPIT_ENABLE_CODEX;

  afterEach(() => {
    if (original === undefined) delete process.env.COCKPIT_ENABLE_CODEX;
    else process.env.COCKPIT_ENABLE_CODEX = original;
  });

  it("is false when unset", () => {
    delete process.env.COCKPIT_ENABLE_CODEX;
    expect(getFeatureFlags().codexHarness).toBe(false);
  });

  it("is false for any value other than the literal '1'", () => {
    process.env.COCKPIT_ENABLE_CODEX = "true";
    expect(getFeatureFlags().codexHarness).toBe(false);
  });

  it("is true only when set to '1'", () => {
    process.env.COCKPIT_ENABLE_CODEX = "1";
    expect(getFeatureFlags().codexHarness).toBe(true);
  });
});
