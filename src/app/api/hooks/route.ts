import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { validateToken } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token =
    req.cookies.get("aperture_token")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateToken(token);
}

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;

type HookEvent = typeof HOOK_EVENTS[number];

interface HookEntry {
  type: "command" | "http" | "prompt" | "agent";
  command?: string;
  url?: string;
  matcher?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface HooksMap {
  [event: string]: HookEntry[];
}

interface SettingsFile {
  hooks?: HooksMap;
  [key: string]: unknown;
}

interface HookInfo {
  event: HookEvent;
  hooks: HookEntry[];
  scope: "global" | "project" | "project-local";
  filePath: string;
}

async function readSettings(filePath: string): Promise<SettingsFile> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getSettingsPaths(cwd?: string | null): Array<{ path: string; scope: "global" | "project" | "project-local" }> {
  const paths: Array<{ path: string; scope: "global" | "project" | "project-local" }> = [
    { path: path.join(homedir(), ".claude", "settings.json"), scope: "global" },
  ];
  if (cwd) {
    paths.push({ path: path.join(cwd, ".claude", "settings.json"), scope: "project" });
    paths.push({ path: path.join(cwd, ".claude", "settings.local.json"), scope: "project-local" });
  }
  return paths;
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");

  const settingsPaths = getSettingsPaths(cwd);
  const results: HookInfo[] = [];

  for (const { path: filePath, scope } of settingsPaths) {
    const settings = await readSettings(filePath);
    if (!settings.hooks) continue;

    for (const event of HOOK_EVENTS) {
      const hooks = settings.hooks[event];
      if (hooks && hooks.length > 0) {
        results.push({ event, hooks, scope, filePath });
      }
    }
  }

  return NextResponse.json({ hooks: results, events: HOOK_EVENTS });
}

export async function PUT(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { filePath, event, hooks } = body as {
    filePath: string;
    event: string;
    hooks: HookEntry[];
  };

  if (!filePath || !event) {
    return NextResponse.json({ error: "filePath and event are required" }, { status: 400 });
  }

  if (!HOOK_EVENTS.includes(event as HookEvent)) {
    return NextResponse.json({ error: "Invalid hook event" }, { status: 400 });
  }

  // Resolve __global__ sentinel to actual path
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");
  const resolvedPath = filePath === "__global__"
    ? path.join(homedir(), ".claude", "settings.json")
    : filePath;

  // Security: validate filePath is a known settings location
  const validPaths = getSettingsPaths(cwd).map((p) => p.path);
  if (!validPaths.includes(resolvedPath)) {
    return NextResponse.json({ error: "Invalid settings path" }, { status: 400 });
  }

  const settings = await readSettings(resolvedPath);
  if (!settings.hooks) settings.hooks = {};

  if (hooks.length === 0) {
    delete settings.hooks[event];
  } else {
    settings.hooks[event] = hooks;
  }

  // Clean up empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  await writeFile(resolvedPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

  return NextResponse.json({ ok: true });
}
