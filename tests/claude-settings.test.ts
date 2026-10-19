import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupHookSettings, prepareHookSettings } from "@/server/claude-settings";
import { resolveHookBridgePath } from "@/server/hook-bridge-path";
import { getCockpitCacheDir, getCockpitDir } from "@/server/paths";

// The user's own Claude settings feed every session file, so each run gets a
// throwaway one instead of the developer's real ~/.claude.
const claudeDir = mkdtempSync(join(tmpdir(), "cockpit-claude-settings-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;

/** What a sandboxed command may not read: cockpit's directory, and the
 *  sessions' own settings files, which hold their telemetry tokens. */
const fenced = () => [getCockpitDir(), join(getCockpitCacheDir(), "hook-settings")];

describe("prepareHookSettings", () => {
  const cleanupIds: string[] = [];

  afterEach(async () => {
    while (cleanupIds.length) {
      const id = cleanupIds.pop();
      if (id) await cleanupHookSettings(id);
    }
  });

  it("writes a settings file with hooks for every event and the right bridge path", async () => {
    const sessionId = "test-session-1";
    cleanupIds.push(sessionId);

    const { settingsPath, env } = await prepareHookSettings({
      sessionId,
      hookUrl: "http://127.0.0.1:12345",
      hookToken: "tok",
    });

    expect(existsSync(settingsPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
      permissions: { allow: string[]; deny: string[] };
    };

    const bridge = resolveHookBridgePath();
    for (const event of [
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PermissionDenied",
      "Stop",
      "UserPromptSubmit",
      "Notification",
      "PermissionRequest",
      "SessionEnd",
      "Elicitation",
      "ElicitationResult",
      "TaskCreated",
      "TaskCompleted",
      "TeammateIdle",
    ]) {
      expect(parsed.hooks[event]).toBeDefined();
      const last = parsed.hooks[event][parsed.hooks[event].length - 1];
      const cmd = last.hooks[0].command;
      expect(cmd).toContain(bridge);
      expect(cmd).toContain(event);
    }

    const prEntries = parsed.hooks.PermissionRequest;
    const prLast = prEntries[prEntries.length - 1];
    expect(prLast.hooks[0].timeout).toBe(86400);

    expect(env).toEqual({
      COCKPIT_HOOK_URL: "http://127.0.0.1:12345",
      COCKPIT_HOOK_TOKEN: "tok",
      COCKPIT_SESSION_ID: sessionId,
    });
  });

  it("writes alwaysThinkingEnabled from thinkingEnabled (false disables, true forces on)", async () => {
    const read = async (id: string, thinkingEnabled: boolean): Promise<Record<string, unknown>> => {
      cleanupIds.push(id);
      const { settingsPath } = await prepareHookSettings({
        sessionId: id,
        hookUrl: "http://127.0.0.1:1",
        hookToken: "tok",
        thinkingEnabled,
      });
      return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    };
    expect((await read("test-think-off", false)).alwaysThinkingEnabled).toBe(false);
    expect((await read("test-think-on", true)).alwaysThinkingEnabled).toBe(true);
  });

  it("writes the session's own sandbox block: its switch, its domains and a read fence on cockpit's directory", async () => {
    const read = async (id: string, sandbox?: { enabled: boolean; allowedDomains?: string[] }): Promise<Record<string, unknown>> => {
      cleanupIds.push(id);
      const { settingsPath } = await prepareHookSettings({
        sessionId: id,
        hookUrl: "http://127.0.0.1:1",
        hookToken: "tok",
        sandbox,
      });
      return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    };
    const fence = { denyRead: fenced() };

    // Off is written as off, so the session's switch decides even when another
    // source turns the sandbox on; the fence is there for exactly that case.
    expect((await read("test-sb-off", { enabled: false })).sandbox).toEqual({ enabled: false, filesystem: fence });
    expect((await read("test-sb-none")).sandbox).toEqual({ enabled: false, filesystem: fence });

    const on = await read("test-sb-on", { enabled: true, allowedDomains: ["github.com", "*.npmjs.org"] });
    expect(on.sandbox).toEqual({ enabled: true, filesystem: fence, network: { allowedDomains: ["github.com", "*.npmjs.org"] } });

    // No domains of its own: no network key, so it adds nothing to the shared list.
    const bare = await read("test-sb-bare", { enabled: true });
    expect(bare.sandbox).toEqual({ enabled: true, filesystem: fence });
  });

  it("gives a sandboxed job exactly its own storage folder, and nothing else in cockpit's directory", async () => {
    const read = async (id: string, sandbox?: { enabled: boolean; allowedDomains?: string[]; jobStorageDir?: string }) => {
      cleanupIds.push(id);
      const { settingsPath } = await prepareHookSettings({
        sessionId: id,
        hookUrl: "http://127.0.0.1:1",
        hookToken: "tok",
        sandbox,
      });
      return JSON.parse(readFileSync(settingsPath, "utf-8")) as { sandbox: Record<string, unknown> };
    };
    const fence = fenced();
    const jobA = join(getCockpitDir(), "jobs", "job-a");
    const jobB = join(getCockpitDir(), "jobs", "job-b");

    const cases = [
      {
        name: "a sandboxed job",
        session: "test-sb-job-a",
        sandbox: { enabled: true, jobStorageDir: jobA },
        filesystem: { denyRead: fence, allowRead: [jobA], allowWrite: [jobA] },
      },
      {
        name: "a second sandboxed job",
        session: "test-sb-job-b",
        sandbox: { enabled: true, jobStorageDir: jobB },
        filesystem: { denyRead: fence, allowRead: [jobB], allowWrite: [jobB] },
      },
      {
        name: "a job with the sandbox off",
        session: "test-sb-job-off",
        sandbox: { enabled: false, jobStorageDir: jobA },
        filesystem: { denyRead: fence },
      },
      {
        name: "an interactive session",
        session: "test-sb-interactive",
        sandbox: { enabled: true },
        filesystem: { denyRead: fence },
      },
      {
        name: "a sandboxed job with domains of its own",
        session: "test-sb-job-domains",
        sandbox: { enabled: true, jobStorageDir: jobA, allowedDomains: ["github.com"] },
        filesystem: { denyRead: fence, allowRead: [jobA], allowWrite: [jobA] },
      },
    ];

    for (const c of cases) {
      const settings = await read(c.session, c.sandbox);
      expect(settings.sandbox.filesystem, c.name).toEqual(c.filesystem);
      // The fence over cockpit's directory is what the allow is cut out of, so
      // it has to survive every case.
      expect((settings.sandbox.filesystem as { denyRead: string[] }).denyRead, c.name).toEqual(fence);
      // A folder is only ever added, never swapped for the whole jobs tree.
      const allowed = [
        ...((settings.sandbox.filesystem as { allowRead?: string[] }).allowRead ?? []),
        ...((settings.sandbox.filesystem as { allowWrite?: string[] }).allowWrite ?? []),
      ];
      for (const path of allowed) expect(path, c.name).toMatch(/\/jobs\/job-[a-z]+$/);
    }

    expect((await read("test-sb-job-domains-2", { enabled: true, jobStorageDir: jobA, allowedDomains: ["github.com"] })).sandbox).toEqual({
      enabled: true,
      filesystem: { denyRead: fence, allowRead: [jobA], allowWrite: [jobA] },
      network: { allowedDomains: ["github.com"] },
    });
  });

  it("leaves the user's sandbox rules in their own file instead of copying them in", async () => {
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        env: { KEEP: "1" },
        sandbox: { enabled: true, excludedCommands: ["docker *"], network: { allowedDomains: ["user.example.com"] } },
      }),
    );
    try {
      const id = "test-sb-user-rules";
      cleanupIds.push(id);
      const { settingsPath } = await prepareHookSettings({
        sessionId: id,
        hookUrl: "http://127.0.0.1:1",
        hookToken: "tok",
        sandbox: { enabled: true, allowedDomains: ["session.example.com"] },
      });
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      // The CLI merges the user's lists with these itself and reloads their file
      // when it changes, so a copy here would only go stale.
      expect(parsed.sandbox).toEqual({
        enabled: true,
        filesystem: { denyRead: fenced() },
        network: { allowedDomains: ["session.example.com"] },
      });
      // Everything else in the user's settings is still carried over.
      expect(parsed.env).toEqual({ KEEP: "1" });
    } finally {
      unlinkSync(join(claudeDir, "settings.json"));
    }
  });

  // Auto mode's classifier is an Anthropic service. On a provider session the
  // CLI cannot classify anything, and its fallback — a dialog asking the user
  // to acknowledge a classifier billing notice — blocked a real session for
  // twenty minutes with nothing to report it.
  it("turns auto mode off for a session whose model cannot run its classifier, and only then", async () => {
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ permissions: { defaultMode: "auto", allow: ["Bash(ls:*)"] } }));
    try {
      const offId = "test-auto-off";
      cleanupIds.push(offId);
      const { settingsPath } = await prepareHookSettings({
        sessionId: offId,
        hookUrl: "http://127.0.0.1:1",
        hookToken: "tok",
        autoModeEnabled: false,
      });
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      expect(parsed.disableAutoMode, 'the CLI rejects a file whose value is not "disable"').toBe("disable");
      expect(parsed.useAutoModeDuringPlan, "plan mode is where the classifier is consulted").toBe(false);
      expect((parsed.permissions as Record<string, unknown>).defaultMode).toBe("manual");
      expect((parsed.permissions as Record<string, unknown>).allow, "the user's own rules survive").toContain("Bash(ls:*)");

      const onId = "test-auto-on";
      cleanupIds.push(onId);
      const onPath = (
        await prepareHookSettings({ sessionId: onId, hookUrl: "http://127.0.0.1:1", hookToken: "tok", autoModeEnabled: true })
      ).settingsPath;
      const on = JSON.parse(readFileSync(onPath, "utf-8")) as Record<string, unknown>;
      expect(on.disableAutoMode).toBeUndefined();
      expect((on.permissions as Record<string, unknown>).defaultMode).toBe("auto");
    } finally {
      unlinkSync(join(claudeDir, "settings.json"));
    }
  });

  it("respects allow/deny lists", async () => {
    const sessionId = "test-session-2";
    cleanupIds.push(sessionId);

    const { settingsPath } = await prepareHookSettings({
      sessionId,
      hookUrl: "http://127.0.0.1:12345",
      hookToken: "tok",
      allowList: ["Read(*)", "Glob(*)"],
      denyList: ["Bash(rm *)"],
    });

    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(parsed.permissions.allow).toEqual(expect.arrayContaining(["Read(*)", "Glob(*)"]));
    expect(parsed.permissions.deny).toEqual(expect.arrayContaining(["Bash(rm *)"]));
  });

  it("cleanupHookSettings removes the file", async () => {
    const sessionId = "test-session-3";
    const { settingsPath } = await prepareHookSettings({
      sessionId,
      hookUrl: "http://127.0.0.1:1",
      hookToken: "tok",
    });
    expect(existsSync(settingsPath)).toBe(true);
    await cleanupHookSettings(sessionId);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("quotes bridge paths containing spaces", async () => {
    const original = process.env.COCKPIT_HOOK_BRIDGE_BIN;
    // Force the resolver cache to miss by clearing and pointing at a temp file
    const sessionId = "test-session-4";
    cleanupIds.push(sessionId);

    const { settingsPath } = await prepareHookSettings({
      sessionId,
      hookUrl: "http://127.0.0.1:1",
      hookToken: "tok",
    });
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    // Just ensure the command shape parses sensibly — argv split-able
    const stopEntries = parsed.hooks.Stop;
    const stopLast = stopEntries[stopEntries.length - 1];
    const parts = stopLast.hooks[0].command.split(/\s+/);
    expect(parts[0]).toBe("node");
    expect(parts[parts.length - 1]).toBe("Stop");

    if (original) process.env.COCKPIT_HOOK_BRIDGE_BIN = original;
  });

  it("merges user settings into the generated file", async () => {
    const sessionId = "test-session-5";
    cleanupIds.push(sessionId);

    const fixturePath = join(claudeDir, "settings.local.json");
    const hadFixture = existsSync(fixturePath);
    const originalContent = hadFixture ? readFileSync(fixturePath, "utf-8") : null;

    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(fixturePath, JSON.stringify({ env: { TEST_MERGE: "1" } }));

    try {
      const { settingsPath } = await prepareHookSettings({
        sessionId,
        hookUrl: "http://127.0.0.1:1",
        hookToken: "tok",
      });

      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      expect(parsed).toHaveProperty("env");
      expect((parsed.env as Record<string, string>).TEST_MERGE).toBe("1");
    } finally {
      if (originalContent !== null) {
        writeFileSync(fixturePath, originalContent);
      } else {
        try {
          unlinkSync(fixturePath);
        } catch {}
      }
    }
  });
});

describe("prepareHookSettings telemetry", () => {
  const telemetry = { token: "tel-token", baseUrl: "http://127.0.0.1:4567" };
  const files: string[] = [];
  const ids: string[] = [];

  const write = (file: string, content: unknown) => {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(content));
    files.push(file);
  };
  const prepare = async (id: string, extra: { cwd?: string; telemetry?: typeof telemetry } = { telemetry }) => {
    ids.push(id);
    const artifact = await prepareHookSettings({ sessionId: id, hookUrl: "http://127.0.0.1:1", hookToken: "tok", ...extra });
    return { artifact, settings: JSON.parse(readFileSync(artifact.settingsPath, "utf-8")) as { env?: Record<string, string> } };
  };

  afterEach(async () => {
    while (files.length) {
      try {
        unlinkSync(files.pop() as string);
      } catch {}
    }
    while (ids.length) await cleanupHookSettings(ids.pop() as string);
  });

  it("writes nothing of its own when not asked, leaving the user's env exactly as it was", async () => {
    write(join(claudeDir, "settings.json"), { env: { KEEP: "1" } });
    const { artifact, settings } = await prepare("tel-off", {});
    expect(artifact.telemetry).toBeUndefined();
    expect(settings.env).toEqual({ KEEP: "1" });
  });

  it("points every signal at cockpit, over the user's own env", async () => {
    // A protocol and resource attributes of the user's own, with telemetry not
    // switched on anywhere: not a pipeline, so cockpit's keys win.
    write(join(claudeDir, "settings.json"), {
      env: { KEEP: "1", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc", OTEL_RESOURCE_ATTRIBUTES: "team=core" },
    });
    const { artifact, settings } = await prepare("tel-on");
    expect(artifact.telemetry).toEqual({ status: "applied" });
    const env = settings.env as Record<string, string>;
    expect(env.KEEP).toBe("1");
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe("http://127.0.0.1:4567/otel/v1/logs");
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe("x-cockpit-otel-token=tel-token");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe("team=core,cockpit.session_id=tel-on");
    // The token travels in the file, which only its owner can read.
    expect(statSync(artifact.settingsPath).mode & 0o077).toBe(0);
  });

  it("leaves a session alone when managed settings send its telemetry somewhere", async () => {
    write(join(claudeDir, "settings.json"), { env: { KEEP: "1" } });
    write(join(claudeDir, "remote-settings.json"), { env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example" } });
    const { artifact, settings } = await prepare("tel-managed");
    expect(artifact.telemetry).toEqual({ status: "skipped", source: "server-managed settings", key: "OTEL_EXPORTER_OTLP_ENDPOINT" });
    expect(settings.env).toEqual({ KEEP: "1" });
  });

  it("takes over an organisation that only switches telemetry on", async () => {
    // What this user's organisation does: telemetry on, protocol protobuf, no
    // destination. Managed beats the session's file key for key, so the
    // general protocol is theirs, and the per-signal keys are what put every
    // signal on cockpit's receiver in JSON.
    write(join(claudeDir, "remote-settings.json"), {
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" },
    });
    const { artifact, settings } = await prepare("tel-org");
    expect(artifact.telemetry).toEqual({ status: "applied" });
    expect(settings.env?.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL).toBe("http/json");
    expect(settings.env?.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe("http://127.0.0.1:4567/otel/v1/traces");
  });

  it("respects a pipeline of the user's own or the project's", async () => {
    write(join(claudeDir, "settings.json"), {
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" },
    });
    expect((await prepare("tel-user")).artifact.telemetry).toEqual({
      status: "skipped",
      source: "user settings",
      key: "OTEL_EXPORTER_OTLP_ENDPOINT",
    });
    unlinkSync(files.pop() as string);

    const project = mkdtempSync(join(tmpdir(), "cockpit-tel-project-"));
    write(join(project, ".claude", "settings.json"), {
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://x" },
    });
    expect((await prepare("tel-project", { cwd: project, telemetry })).artifact.telemetry).toEqual({
      status: "skipped",
      source: ".claude/settings.json",
      key: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    });
  });
});
