import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { debugLog } from "@/server/debug-logger";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err && !(err as NodeJS.ErrnoException).code && stdout) {
        // git diff exits with code 1 when there are differences
        resolve(stdout);
      } else if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

async function getOldContent(cwd: string, file: string): Promise<string | null> {
  try {
    return await run("git", ["show", `HEAD:${file}`], cwd);
  } catch {
    return null;
  }
}

async function getNewContent(cwd: string, file: string): Promise<string | null> {
  try {
    return await readFile(join(cwd, file), "utf-8");
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");
  const file = url.searchParams.get("file");
  if (!cwd || !file) {
    return NextResponse.json({ error: "cwd and file are required" }, { status: 400 });
  }

  debugLog(`[git/diff] hit cwd=${cwd} file=${file}`);

  try {
    let diff = "";
    // Try tracked file diff first (staged + unstaged vs HEAD)
    try {
      diff = await run("git", ["diff", "HEAD", "--", file], cwd);
    } catch {
      try {
        diff = await run("git", ["diff", "--cached", "--", file], cwd);
      } catch {
        // no diff available
      }
    }

    if (diff) debugLog(`[git/diff] tracked diff for ${file}: ${diff.length} chars`);

    // If no diff, the file might be untracked - show full content as addition
    if (!diff) {
      try {
        const content = await run("git", ["show", `:${file}`], cwd);
        const lines = content.split(/\r?\n/);
        diff = [`--- /dev/null`, `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
        debugLog(`[git/diff] staged untracked ${file}: ${lines.length} lines`);
      } catch {
        try {
          const content = await readFile(join(cwd, file), "utf-8");
          const lines = content.split(/\r?\n/);
          diff = [`--- /dev/null`, `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
          debugLog(`[git/diff] readFile untracked ${file}: ${lines.length} lines`);
        } catch {
          return NextResponse.json({ error: "File not found" }, { status: 404 });
        }
      }
    }

    // Fetch full file contents for expand-context support
    const [oldContent, newContent] = await Promise.all([getOldContent(cwd, file), getNewContent(cwd, file)]);

    debugLog(
      `[git/diff] returning ${file}: diff=${diff.length}chars old=${oldContent?.length ?? "null"} new=${newContent?.length ?? "null"}`,
    );
    return NextResponse.json({
      diff,
      oldContent: oldContent ?? undefined,
      newContent: newContent ?? undefined,
    });
  } catch {
    return NextResponse.json({ error: "Failed to get diff" }, { status: 500 });
  }
}
