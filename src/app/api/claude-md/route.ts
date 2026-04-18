import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { NextRequest, NextResponse } from "next/server";
import { isAuthDisabled, validateSession } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

type Scope = "user" | "project" | "project-hidden";

interface ClaudeMdFile {
  scope: Scope;
  cwd?: string;
  dirName?: string;
  content: string;
  exists: boolean;
}

function resolvePath(scope: Scope, cwd?: string | null): string | null {
  switch (scope) {
    case "user":
      return path.join(homedir(), ".claude", "CLAUDE.md");
    case "project":
      return cwd ? path.join(cwd, "CLAUDE.md") : null;
    case "project-hidden":
      return cwd ? path.join(cwd, ".claude", "CLAUDE.md") : null;
  }
}

async function readClaudeMdFile(scope: Scope, cwd?: string): Promise<ClaudeMdFile> {
  const filePath = resolvePath(scope, cwd);
  if (!filePath) return { scope, cwd, content: "", exists: false };

  try {
    const content = await readFile(filePath, "utf-8");
    const dirName = cwd ? path.basename(cwd) || cwd : undefined;
    return { scope, cwd, dirName, content, exists: true };
  } catch {
    const dirName = cwd ? path.basename(cwd) || cwd : undefined;
    return { scope, cwd, dirName, content: "", exists: false };
  }
}

async function extractCwdFromJsonl(filePath: string): Promise<string | null> {
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    let linesRead = 0;
    for await (const line of rl) {
      if (linesRead > 30) break;
      linesRead++;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "user" && entry.cwd) {
          rl.close();
          return entry.cwd;
        }
      } catch {}
    }
    rl.close();
  } catch {
    // ignore
  }
  return null;
}

async function getKnownCwds(): Promise<string[]> {
  const projectsDir = path.join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return [];
  }

  const cwdSet = new Set<string>();

  for (const dir of projectDirs) {
    const dirPath = path.join(projectsDir, dir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    const firstJsonl = files.find((f) => f.endsWith(".jsonl"));
    if (!firstJsonl) continue;

    const cwd = await extractCwdFromJsonl(path.join(dirPath, firstJsonl));
    if (cwd) cwdSet.add(cwd);
  }

  return Array.from(cwdSet).sort();
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") as Scope | null;
  const cwd = url.searchParams.get("cwd");

  // Single file fetch (for the editor page)
  if (scope) {
    const file = await readClaudeMdFile(scope, cwd || undefined);
    return NextResponse.json(file);
  }

  // Full scan: global + all known project dirs
  const globalFile = await readClaudeMdFile("user");
  const cwds = await getKnownCwds();

  const projectFiles: ClaudeMdFile[] = [];
  for (const projectCwd of cwds) {
    const visible = await readClaudeMdFile("project", projectCwd);
    const hidden = await readClaudeMdFile("project-hidden", projectCwd);
    projectFiles.push(visible, hidden);
  }

  return NextResponse.json({
    files: [globalFile, ...projectFiles],
    cwds,
  });
}

export async function PUT(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { scope: Scope; cwd?: string; content: string };
  const { scope, cwd, content } = body;

  const filePath = resolvePath(scope, cwd);
  if (!filePath) {
    return NextResponse.json({ error: "Cannot resolve path" }, { status: 400 });
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");

  return NextResponse.json({ ok: true });
}
