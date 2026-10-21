/**
 * The OpenTelemetry settings a session's CLI gets, and the check that keeps
 * cockpit from taking over a pipeline that belongs to someone else.
 *
 * Settings precedence decides most of this. A session's --settings file (where
 * cockpit writes these) beats the user's and the project's settings and the
 * process env for the same key, but managed settings beat it, and more than key
 * for key: when they set a general OTLP protocol, endpoint or headers, Claude
 * Code removes every per-signal value set below them (CLI 2.1.217 and later).
 * So:
 * - cockpit asks for http/protobuf, OTel's default, and its receiver reads JSON
 *   as well, so an HTTP protocol chosen there of either kind still lands;
 * - gRPC chosen there cannot reach an HTTP receiver, so it leaves the session
 *   alone;
 * - when a source cockpit does not control names a destination, cockpit leaves
 *   telemetry alone for that session rather than either diverting someone's
 *   pipeline or, worse, switching on prompt capture into a collector whose
 *   address it cannot override.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const TELEMETRY_TOKEN_HEADER = "x-cockpit-otel-token";

const SIGNALS = ["METRICS", "LOGS", "TRACES"] as const;

export interface TelemetryEnvOptions {
  /** The hook router's base URL; the receiver is under /otel. */
  baseUrl: string;
  token: string;
  sessionId: string;
  /** OTEL_RESOURCE_ATTRIBUTES the CLI would otherwise have, kept alongside cockpit's. */
  existingResourceAttributes?: string;
}

export function buildTelemetryEnv(o: TelemetryEnvOptions): Record<string, string> {
  const base = `${o.baseUrl}/otel`;
  const header = `${TELEMETRY_TOKEN_HEADER}=${o.token}`;
  const own = `cockpit.session_id=${o.sessionId}`;
  const others = (o.existingResourceAttributes ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("cockpit.session_id="));
  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_ENDPOINT: base,
    OTEL_EXPORTER_OTLP_HEADERS: header,
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta",
    OTEL_METRIC_EXPORT_INTERVAL: "10000",
    OTEL_LOGS_EXPORT_INTERVAL: "5000",
    OTEL_TRACES_EXPORT_INTERVAL: "5000",
    OTEL_LOG_USER_PROMPTS: "1",
    OTEL_LOG_ASSISTANT_RESPONSES: "1",
    OTEL_LOG_TOOL_DETAILS: "1",
    OTEL_LOG_TOOL_CONTENT: "1",
    OTEL_LOG_MANAGED_SETTINGS: "1",
    OTEL_METRICS_INCLUDE_VERSION: "true",
    OTEL_METRICS_INCLUDE_ENTRYPOINT: "true",
    OTEL_METRICS_INCLUDE_REPOSITORY: "true",
    OTEL_RESOURCE_ATTRIBUTES: [...others, own].join(","),
  };
  for (const s of SIGNALS) {
    env[`OTEL_EXPORTER_OTLP_${s}_PROTOCOL`] = "http/protobuf";
    // Per-signal endpoints are used as given, with no /v1/<signal> appended.
    env[`OTEL_EXPORTER_OTLP_${s}_ENDPOINT`] = `${base}/v1/${s.toLowerCase()}`;
    env[`OTEL_EXPORTER_OTLP_${s}_HEADERS`] = header;
  }
  // Detailed beta tracing (ENABLE_BETA_TRACING_DETAILED with
  // BETA_TRACING_ENDPOINT), which adds the system prompt, tool definitions and
  // each request's new context, is not set: on CLI 2.1.296 it works in -p and
  // SDK runs but does nothing in an interactive session, which is all cockpit
  // runs, wherever the pair is set.
  return env;
}

/** One place the CLI may get settings from that cockpit does not write. */
export interface SettingsSource {
  label: string;
  env: Record<string, unknown>;
  /** The whole settings object, for keys outside `env` (otelHeadersHelper). */
  settings?: Record<string, unknown>;
  /** Managed settings: beat cockpit's settings file key for key. */
  managed?: boolean;
}

export interface ExternalOtel {
  /** Leave telemetry alone for this session, because of this key. */
  skip: { source: string; key: string } | null;
}

const DESTINATION_KEY = /^(OTEL_EXPORTER_OTLP(_(METRICS|LOGS|TRACES))?_(ENDPOINT|HEADERS)|BETA_TRACING_ENDPOINT)$/;
const PROTOCOL_KEY = /^OTEL_EXPORTER_OTLP(_(METRICS|LOGS|TRACES))?_PROTOCOL$/;

function isTruthy(v: unknown): boolean {
  if (typeof v !== "string") return v === true || (typeof v === "number" && v !== 0);
  return !["", "0", "false", "no", "off"].includes(v.trim().toLowerCase());
}

function hasValue(v: unknown): boolean {
  return typeof v === "string" ? v.trim().length > 0 : v !== undefined && v !== null && v !== false;
}

function destination(s: SettingsSource): string | null {
  for (const [key, value] of Object.entries(s.env ?? {})) if (DESTINATION_KEY.test(key) && hasValue(value)) return key;
  if (s.settings && hasValue(s.settings.otelHeadersHelper)) return "otelHeadersHelper";
  return null;
}

/**
 * Whether cockpit should leave this session's telemetry alone.
 *
 * A managed destination always means yes: cockpit cannot override it, so its
 * prompt and tool switches would flow there. A destination anywhere else means
 * yes only if telemetry is already switched on somewhere, because only then is
 * it someone's working pipeline; otherwise it is a stray variable cockpit's
 * own keys override anyway. Switching telemetry on, choosing an exporter, or
 * choosing an HTTP protocol without a destination is taken over. A managed
 * gRPC protocol is not: cockpit's receiver speaks HTTP only, so nothing would
 * arrive.
 */
export function assessExternalOtel(sources: SettingsSource[]): ExternalOtel {
  const enabled = sources.some((s) => isTruthy(s.env?.CLAUDE_CODE_ENABLE_TELEMETRY));
  for (const s of sources) {
    const key = destination(s);
    if (key && (s.managed || enabled)) return { skip: { source: s.label, key } };
    if (!s.managed) continue;
    for (const [k, v] of Object.entries(s.env ?? {})) {
      if (PROTOCOL_KEY.test(k) && typeof v === "string" && v.trim().toLowerCase() === "grpc") return { skip: { source: s.label, key: k } };
    }
  }
  return { skip: null };
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toSource(label: string, settings: Record<string, unknown>, managed: boolean): SettingsSource {
  const env =
    settings.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? (settings.env as Record<string, unknown>) : {};
  return { label, env, settings, managed };
}

export function managedSettingsDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

/**
 * The managed settings cockpit can see: the server-managed
 * settings the CLI caches in its config dir, and the managed-settings files
 * (with their drop-in directory) in the system directory. MDM profiles and the
 * Windows registry are not read.
 */
export async function readManagedSettingsSources(claudeDir: string, systemDir = managedSettingsDir()): Promise<SettingsSource[]> {
  const sources: SettingsSource[] = [];
  const remote = await readJson(path.join(claudeDir, "remote-settings.json"));
  if (remote) sources.push(toSource("server-managed settings", remote, true));
  const file = await readJson(path.join(systemDir, "managed-settings.json"));
  if (file) sources.push(toSource("managed-settings.json", file, true));
  let dropIns: string[] = [];
  try {
    dropIns = (await readdir(path.join(systemDir, "managed-settings.d"))).filter((f) => f.endsWith(".json")).sort();
  } catch {
    // no drop-in directory
  }
  for (const name of dropIns) {
    const parsed = await readJson(path.join(systemDir, "managed-settings.d", name));
    if (parsed) sources.push(toSource(`managed-settings.d/${name}`, parsed, true));
  }
  return sources;
}

/** The project's own settings files in the session's directory. */
export async function readProjectSettingsSources(cwd: string): Promise<SettingsSource[]> {
  const sources: SettingsSource[] = [];
  for (const name of ["settings.json", "settings.local.json"]) {
    const parsed = await readJson(path.join(cwd, ".claude", name));
    if (parsed) sources.push(toSource(`.claude/${name}`, parsed, false));
  }
  return sources;
}
