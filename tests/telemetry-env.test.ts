// The telemetry settings a session's CLI gets, and the check that keeps
// cockpit from taking over someone else's OpenTelemetry pipeline.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessExternalOtel,
  buildTelemetryEnv,
  managedSettingsDir,
  readManagedSettingsSources,
  readProjectSettingsSources,
} from "@/server/telemetry/env";

describe("buildTelemetryEnv", () => {
  const env = buildTelemetryEnv({ baseUrl: "http://127.0.0.1:9000", token: "tok", sessionId: "sess" });

  it("switches every signal on, as JSON, at cockpit's receiver with the spawn's token", () => {
    expect(env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9000/otel",
      OTEL_EXPORTER_OTLP_HEADERS: "x-cockpit-otel-token=tok",
      OTEL_RESOURCE_ATTRIBUTES: "cockpit.session_id=sess",
    });
    // Per-signal keys, which a managed general protocol cannot override, and
    // whose endpoints are used exactly as given.
    for (const s of ["metrics", "logs", "traces"]) {
      const S = s.toUpperCase();
      expect(env[`OTEL_EXPORTER_OTLP_${S}_PROTOCOL`]).toBe("http/protobuf");
      expect(env[`OTEL_EXPORTER_OTLP_${S}_ENDPOINT`]).toBe(`http://127.0.0.1:9000/otel/v1/${s}`);
      expect(env[`OTEL_EXPORTER_OTLP_${S}_HEADERS`]).toBe("x-cockpit-otel-token=tok");
    }
  });

  it("captures the content too, but never the raw API bodies", () => {
    for (const k of [
      "OTEL_LOG_USER_PROMPTS",
      "OTEL_LOG_ASSISTANT_RESPONSES",
      "OTEL_LOG_TOOL_DETAILS",
      "OTEL_LOG_TOOL_CONTENT",
      "OTEL_LOG_MANAGED_SETTINGS",
    ]) {
      expect(env[k], k).toBe("1");
    }
    expect(env.OTEL_LOG_RAW_API_BODIES).toBeUndefined();
    // Detailed beta tracing does nothing in an interactive session (CLI
    // 2.1.296), so it is not switched on.
    expect(env.ENABLE_BETA_TRACING_DETAILED).toBeUndefined();
    expect(env.BETA_TRACING_ENDPOINT).toBeUndefined();
  });

  it("keeps the user's resource attributes, replacing only a stale session id", () => {
    const merged = buildTelemetryEnv({
      baseUrl: "http://h:1",
      token: "t",
      sessionId: "new",
      existingResourceAttributes: "team=core, cockpit.session_id=old ,,env=dev",
    });
    expect(merged.OTEL_RESOURCE_ATTRIBUTES).toBe("team=core,env=dev,cockpit.session_id=new");
  });

  it("names the provider serving the spawn, encoded, replacing one already there", () => {
    const env = buildTelemetryEnv({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      sessionId: "s 1",
      providerId: "zen-go",
      existingResourceAttributes: "cockpit.provider=stale,team=core",
    });
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe("team=core,cockpit.session_id=s%201,cockpit.provider=zen-go");
  });
});

describe("assessExternalOtel", () => {
  it("takes over when nothing names a destination", () => {
    expect(assessExternalOtel([])).toEqual({ skip: null });
    // This user's organisation: on, an exporter, a protocol, no destination.
    const org = {
      label: "server-managed settings",
      managed: true,
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" },
    };
    expect(assessExternalOtel([org])).toEqual({ skip: null });
  });

  it("steps aside for a managed gRPC protocol, which cannot reach an HTTP receiver, and takes over an HTTP one", () => {
    const managed = (env: Record<string, string>) => assessExternalOtel([{ label: "managed", managed: true, env }]).skip;
    expect(managed({ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" })).toEqual({ source: "managed", key: "OTEL_EXPORTER_OTLP_PROTOCOL" });
    expect(managed({ OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: " GRPC " })).toEqual({ source: "managed", key: "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL" });
    expect(managed({ OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" })).toBeNull();
    expect(managed({ OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" })).toBeNull();
    // A developer's own gRPC loses to the session's settings file.
    expect(assessExternalOtel([{ label: "user", env: { OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" } }]).skip).toBeNull();
  });

  it("always steps aside for a managed destination, whose address it could not override", () => {
    for (const key of [
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "BETA_TRACING_ENDPOINT",
    ]) {
      expect(assessExternalOtel([{ label: "managed", managed: true, env: { [key]: "x" } }]).skip, key).toEqual({ source: "managed", key });
    }
    expect(assessExternalOtel([{ label: "managed", managed: true, env: {}, settings: { otelHeadersHelper: "/bin/helper" } }]).skip).toEqual(
      {
        source: "managed",
        key: "otelHeadersHelper",
      },
    );
  });

  it("steps aside for the user's own destination only while telemetry is switched on somewhere", () => {
    const stray = { label: "user settings", env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" } };
    // A stray endpoint, with telemetry off everywhere: nobody's pipeline.
    expect(assessExternalOtel([stray]).skip).toBeNull();
    for (const on of ["1", "true", "YES"]) {
      expect(assessExternalOtel([{ label: "env", env: { CLAUDE_CODE_ENABLE_TELEMETRY: on } }, stray]).skip, on).toEqual({
        source: "user settings",
        key: "OTEL_EXPORTER_OTLP_ENDPOINT",
      });
    }
    for (const off of ["0", "false", "", " off "]) {
      expect(assessExternalOtel([{ label: "env", env: { CLAUDE_CODE_ENABLE_TELEMETRY: off } }, stray]).skip, off).toBeNull();
    }
    expect(assessExternalOtel([{ label: "env", env: { CLAUDE_CODE_ENABLE_TELEMETRY: true } }, stray]).skip).not.toBeNull();
    // An empty value names nothing.
    expect(assessExternalOtel([{ label: "m", managed: true, env: { OTEL_EXPORTER_OTLP_ENDPOINT: " " } }]).skip).toBeNull();
  });
});

describe("reading settings sources", () => {
  it("finds the managed settings for each platform", () => {
    expect(managedSettingsDir("darwin")).toBe("/Library/Application Support/ClaudeCode");
    expect(managedSettingsDir("win32")).toBe("C:\\Program Files\\ClaudeCode");
    expect(managedSettingsDir("linux")).toBe("/etc/claude-code");
  });

  it("reads the cached server-managed settings, the managed file and its drop-ins, skipping what will not parse", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "cockpit-tel-claude-"));
    const systemDir = mkdtempSync(join(tmpdir(), "cockpit-tel-system-"));
    writeFileSync(join(claudeDir, "remote-settings.json"), JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1" } }));
    writeFileSync(join(systemDir, "managed-settings.json"), JSON.stringify({ otelHeadersHelper: "/bin/h" }));
    mkdirSync(join(systemDir, "managed-settings.d"));
    writeFileSync(join(systemDir, "managed-settings.d", "20-b.json"), JSON.stringify({ env: { B: "1" } }));
    writeFileSync(join(systemDir, "managed-settings.d", "10-a.json"), JSON.stringify({ env: ["not", "an", "object"] }));
    writeFileSync(join(systemDir, "managed-settings.d", "30-bad.json"), "{ nope");
    writeFileSync(join(systemDir, "managed-settings.d", "notes.txt"), "ignored");
    const sources = await readManagedSettingsSources(claudeDir, systemDir);
    expect(sources.map((s) => [s.label, s.env, s.managed])).toEqual([
      ["server-managed settings", { CLAUDE_CODE_ENABLE_TELEMETRY: "1" }, true],
      ["managed-settings.json", {}, true],
      ["managed-settings.d/10-a.json", {}, true],
      ["managed-settings.d/20-b.json", { B: "1" }, true],
    ]);
    expect(await readManagedSettingsSources(join(claudeDir, "missing"), join(systemDir, "missing"))).toEqual([]);
  });

  it("reads a project's shared and local settings, not as managed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cockpit-tel-cwd-"));
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ env: { L: "1" } }));
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify([1, 2]));
    expect(await readProjectSettingsSources(cwd)).toEqual([
      { label: ".claude/settings.local.json", env: { L: "1" }, settings: { env: { L: "1" } }, managed: false },
    ]);
  });
});
