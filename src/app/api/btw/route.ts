import { spawn } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

const SYSTEM_PROMPT = `You are answering a quick side question from the user. They are asking about something while Claude is working on a task in the background.

Rules:
- Answer concisely and directly
- You have the conversation context but NO tools (no file access, no commands, no search)
- Answer only from what you know based on the conversation so far
- Keep the response short (a few sentences to a paragraph)
- Do not offer to do anything, just answer the question`;

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { question, context, model, cwd } = body as {
    question: string;
    context: Array<{ role: string; content: string }>;
    model?: string;
    cwd: string;
  };

  if (!question || !cwd) {
    return NextResponse.json({ error: "question and cwd are required" }, { status: 400 });
  }

  try {
    const conversationText = (context || []).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");

    const input = conversationText ? `${conversationText}\n\nUser (side question): ${question}` : question;

    const args = ["-p", "--no-session-persistence", "--allowedTools", "", "--system-prompt", SYSTEM_PROMPT];

    if (model) {
      args.push("--model", model);
    }

    const answer = await new Promise<string>((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      env.MAX_THINKING_TOKENS = "0";
      env.CLAUDE_CODE_SIMPLE = "1";

      const proc = spawn("claude", args, { cwd, env });
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0) reject(new Error(stderr || `Process exited with code ${code}`));
        else resolve(stdout);
      });

      proc.stdin.write(input);
      proc.stdin.end();
    });

    return NextResponse.json({ answer: answer.trim() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to answer question";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
