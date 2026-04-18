import { NextRequest, NextResponse } from "next/server";
import { spawn, execFile } from "node:child_process";
import os from "node:os";
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

function runWithStdin(cmd: string, args: string[], cwd: string, input: string, minimalEnv = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const env: Record<string, string> = minimalEnv
      ? {
          PATH: process.env.PATH || "",
          HOME: process.env.HOME || os.homedir(),
          USER: process.env.USER || os.userInfo().username,
          ...(isWin ? {
            USERPROFILE: process.env.USERPROFILE || os.homedir(),
            HOMEDRIVE: process.env.HOMEDRIVE || "",
            HOMEPATH: process.env.HOMEPATH || "",
            SYSTEMROOT: process.env.SYSTEMROOT || "",
          } : {
            TERM: "xterm-256color",
          }),
        }
      : Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] != null));
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    console.log("[generate-message] env keys:", Object.keys(env).join(", "));
    console.log("[generate-message] args:", args.join(" "));
    console.log("[generate-message] cwd:", cwd, "minimalEnv:", minimalEnv);

    const proc = spawn(cmd, args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      ...(isWin ? { shell: true } : { detached: true }),
    });
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

const SYSTEM_PROMPT = "Output ONLY the commit message. No explanations, no markdown, no quotes, no preamble.";

const PROMPT = `Generate a git commit message for the changes below.

Rules:
- First line: short summary under 72 characters, imperative mood (e.g. "Add", "Fix", "Update")
- If needed, add a blank line then a brief body with bullet points
- Focus on the "why" not the "what" when possible

Changes:
`;

// Strip common preamble patterns the model sometimes adds
function cleanMessage(raw: string): string {
  return raw
    .replace(/^(?:here(?:'s| is)(?: your| the| a)? commit message:?\s*)/i, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
}

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
    const t0 = Date.now();
    console.log("[generate-message] files:", files.length, "cwd:", cwd);

    // Use compact diff: numstat for overview + short patch for context
    let numstat = "";
    try {
      numstat = await run("git", ["diff", "--numstat", "HEAD", "--", ...files], cwd);
    } catch {
      try {
        numstat = await run("git", ["diff", "--numstat", "--cached", "--", ...files], cwd);
      } catch {}
    }

    let diff = "";
    try {
      diff = await run("git", ["diff", "--stat", "-p", "-U1", "HEAD", "--", ...files], cwd);
    } catch {
      try {
        diff = await run("git", ["diff", "--stat", "-p", "-U1", "--cached", "--", ...files], cwd);
      } catch {}
    }

    const t1 = Date.now();

    // Cap at 4KB to keep token count low and API response fast
    if (diff.length > 4000) {
      diff = diff.slice(0, 4000) + "\n[truncated]";
    }

    const input = PROMPT + (numstat ? `Summary:\n${numstat}\n` : "") + diff;
    console.log("[generate-message] git diff:", t1 - t0, "ms, input length:", input.length);
    console.log("[generate-message] input length:", input.length);

    const raw = await runWithStdin(
      "claude",
      [
        "-p",
        "--model", "sonnet",
        "--effort", "low",
        "--output-format", "json",
        "--system-prompt", SYSTEM_PROMPT,
        "--no-session-persistence",
        "--tools", "",
        "--disable-slash-commands",
        "--setting-sources", "",
        "--permission-mode", "bypassPermissions",
      ],
      cwd,
      input,
      true
    );

    const t2 = Date.now();
    console.log("[generate-message] claude CLI:", t2 - t1, "ms, raw length:", raw.length);

    let message: string;
    try {
      const parsed = JSON.parse(raw);
      console.log("[generate-message] num_turns:", parsed.num_turns, "api_ms:", parsed.duration_api_ms, "total_ms:", parsed.duration_ms, "cost:", parsed.total_cost_usd);
      message = parsed.result || "";
    } catch {
      message = raw;
    }

    message = cleanMessage(message);

    if (!message) {
      console.error("[generate-message] empty result, raw output:", raw.slice(0, 500));
      return NextResponse.json({ error: "Empty response from model" }, { status: 500 });
    }

    console.log("[generate-message] total:", Date.now() - t0, "ms");
    return NextResponse.json({ message });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to generate message";
    console.error("[generate-message] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
