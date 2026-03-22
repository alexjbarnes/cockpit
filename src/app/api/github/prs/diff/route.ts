import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { validateToken } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token =
    req.cookies.get("cockpit_token")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateToken(token);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      if (err && !(err as NodeJS.ErrnoException).code && stdout) {
        resolve(stdout);
      } else if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function splitDiff(raw: string): { path: string; patch: string }[] {
  const lines = raw.split("\n");
  const files: { path: string; lines: string[] }[] = [];
  let current: { path: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      // Handle renames: diff --git a/old b/new - take b/ path
      const match = line.match(/diff --git a\/.+ b\/(.+)/);
      current = { path: match?.[1] || "unknown", lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) files.push(current);

  return files.map((f) => ({ path: f.path, patch: f.lines.join("\n") }));
}

interface GHFile {
  filename: string;
  patch?: string;
  status: string;
  previous_filename?: string;
}

// Build a full git-style diff from the REST API per-file patch.
// PatchDiff expects the diff --git header, --- / +++ lines, and hunks.
function buildFullPatch(f: GHFile): string {
  const prev = f.previous_filename || f.filename;
  const lines: string[] = [];

  lines.push(`diff --git a/${prev} b/${f.filename}`);

  if (f.status === "added") {
    lines.push("new file mode 100644");
    lines.push("--- /dev/null");
    lines.push(`+++ b/${f.filename}`);
  } else if (f.status === "removed") {
    lines.push("deleted file mode 100644");
    lines.push(`--- a/${prev}`);
    lines.push("+++ /dev/null");
  } else {
    lines.push(`--- a/${prev}`);
    lines.push(`+++ b/${f.filename}`);
  }

  if (f.patch) lines.push(f.patch);
  return lines.join("\n");
}

// Fallback: fetch per-file patches via GitHub REST API when the full
// diff exceeds the 20K line limit (HTTP 406 from gh pr diff).
async function fetchFileDiffs(repo: string, number: string): Promise<{ path: string; patch: string }[]> {
  const stdout = await run("gh", [
    "api",
    `repos/${repo}/pulls/${number}/files?per_page=100`,
    "--paginate",
  ]);

  // gh api --paginate concatenates JSON arrays back-to-back.
  // Parse by finding top-level array boundaries.
  const allFiles: GHFile[] = [];
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) allFiles.push(...parsed);
  } catch {
    // Multiple pages produce "][" at boundaries
    const chunks = stdout.split(/\]\s*\[/).map((chunk, i, arr) => {
      if (arr.length === 1) return chunk;
      if (i === 0) return chunk + "]";
      if (i === arr.length - 1) return "[" + chunk;
      return "[" + chunk + "]";
    });
    for (const chunk of chunks) {
      try {
        const parsed = JSON.parse(chunk);
        if (Array.isArray(parsed)) allFiles.push(...parsed);
      } catch {
        // skip unparseable chunks
      }
    }
  }

  return allFiles
    .filter((f) => f.patch)
    .map((f) => ({
      path: f.filename,
      patch: buildFullPatch(f),
    }));
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const repo = url.searchParams.get("repo");
  const number = url.searchParams.get("number");

  if (!repo || !number) {
    return NextResponse.json(
      { error: "repo and number are required" },
      { status: 400 },
    );
  }

  try {
    const stdout = await run("gh", [
      "pr",
      "diff",
      number,
      "-R",
      repo,
      "--color",
      "never",
    ]);
    const files = splitDiff(stdout);
    return NextResponse.json({ files });
  } catch (err) {
    const errStr = String(err);
    // Diff too large for GitHub's unified diff endpoint - fall back to
    // per-file patches from the REST API
    if (errStr.includes("too_large") || errStr.includes("406")) {
      try {
        const files = await fetchFileDiffs(repo, number);
        return NextResponse.json({ files, partial: true });
      } catch (fallbackErr) {
        return NextResponse.json(
          { error: `Diff too large and per-file fallback failed: ${String(fallbackErr)}` },
          { status: 500 },
        );
      }
    }
    return NextResponse.json(
      { error: errStr },
      { status: 500 },
    );
  }
}
