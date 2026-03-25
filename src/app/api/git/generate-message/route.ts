import { NextRequest, NextResponse } from "next/server";
import { spawn, execFile } from "node:child_process";
import { validateSession, isAuthDisabled } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token =
    req.cookies.get("cockpit_session")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function runWithStdin(cmd: string, args: string[], cwd: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    env.MAX_THINKING_TOKENS = "0";
    env.CLAUDE_CODE_SIMPLE = "1";

    const proc = spawn(cmd, args, { cwd, env });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || `Process exited with code ${code}`));
      else resolve(stdout);
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

const PROMPT = `You are generating a git commit message. Based on the diff summary and changes below, write a concise commit message.

Rules:
- First line: short summary under 72 characters, imperative mood (e.g. "Add", "Fix", "Update")
- If needed, add a blank line then a brief body with bullet points
- Focus on the "why" not the "what" when possible
- Do not wrap the message in quotes or markdown code blocks
- Output only the commit message text, nothing else

Changes:
`;

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { cwd, files } = body as { cwd: string; files: string[] };

  if (!cwd || !files?.length) {
    return NextResponse.json({ error: "cwd and files are required" }, { status: 400 });
  }

  try {
    let numstat = "";
    try {
      numstat = await run("git", ["diff", "--numstat", "HEAD", "--", ...files], cwd);
    } catch {
      try {
        numstat = await run("git", ["diff", "--numstat", "--cached", "--", ...files], cwd);
      } catch {
        // no stats available
      }
    }

    const diffs: string[] = [];
    let totalLength = 0;
    const maxTotal = 30000;

    for (const file of files) {
      if (totalLength > maxTotal) {
        diffs.push(`\n[${files.length - diffs.length} more files truncated]`);
        break;
      }

      let fileDiff = "";
      try {
        fileDiff = await run("git", ["diff", "HEAD", "--", file], cwd);
      } catch {
        try {
          fileDiff = await run("git", ["diff", "--cached", "--", file], cwd);
        } catch {
          const { readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          try {
            const content = await readFile(join(cwd, file), "utf-8");
            fileDiff = `new file: ${file}\n${content.slice(0, 2000)}`;
          } catch {
            fileDiff = `new file: ${file}`;
          }
        }
      }

      if (fileDiff.length > 3000) {
        fileDiff = fileDiff.slice(0, 3000) + "\n[truncated]";
      }

      diffs.push(fileDiff);
      totalLength += fileDiff.length;
    }

    const input = PROMPT + (numstat ? `Summary:\n${numstat}\n` : "") + diffs.join("\n");

    const message = await runWithStdin(
      "claude",
      ["-p", "--model", "haiku", "--no-session-persistence", "--allowedTools", ""],
      cwd,
      input
    );

    return NextResponse.json({ message: message.trim() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to generate message";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
