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

    const proc = spawn(cmd, args, { cwd, env });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        console.error("[generate-message] CLI exit code:", code, "stderr:", stderr, "stdout:", stdout.slice(0, 500));
        reject(new Error(stderr || stdout || `Process exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

const SYSTEM_PROMPT = `You generate git commit messages. Return only the commit message string, no explanations.`;

const PROMPT = `Generate a git commit message for the changes below.

Rules:
- First line: short summary under 72 characters, imperative mood (e.g. "Add", "Fix", "Update")
- If needed, add a blank line then a brief body with bullet points
- Focus on the "why" not the "what" when possible

Changes:
`;

const COMMIT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "The git commit message. First line is the summary, optionally followed by a blank line and body.",
    },
  },
  required: ["message"],
});

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

    const raw = await runWithStdin(
      "claude",
      [
        "-p",
        "--model", "haiku",
        "--output-format", "json",
        "--json-schema", COMMIT_SCHEMA,
        "--system-prompt", SYSTEM_PROMPT,
        "--no-session-persistence",
        "--allowedTools", "",
      ],
      cwd,
      input
    );

    let message: string;
    try {
      const parsed = JSON.parse(raw);
      message = parsed.structured_output?.message || parsed.result || "";
    } catch {
      // If JSON parse fails, the raw output might be plain text (fallback)
      message = raw;
    }

    if (!message.trim()) {
      console.error("[generate-message] empty result, raw output:", raw.slice(0, 500));
      return NextResponse.json({ error: "Empty response from model" }, { status: 500 });
    }

    return NextResponse.json({ message: message.trim() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to generate message";
    console.error("[generate-message] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
