import { spawn } from "node:child_process";
import type { InitData } from "@/types";

const FETCH_TIMEOUT_MS = 30_000;

/**
 * Spawn a one-shot `claude -p --output-format stream-json` process and extract
 * the system/init event. Kills the process as soon as init is received (before
 * any API call for the prompt), so this costs zero tokens.
 *
 * `--no-session-persistence` stops this throwaway probe from writing a session
 * transcript to ~/.claude/projects. Without it the CLI persists the "hi" prompt
 * at startup (before we can kill it), and that transcript then surfaces in the
 * session history as a stray "hi" session, once per init fetch, per cwd. Keep it.
 */
export function fetchCliInitData(opts: { cwd: string; bin?: string }): Promise<InitData | null> {
  const bin = opts.bin ?? "claude";
  const args = ["-p", "--no-session-persistence", "--verbose", "--output-format", "stream-json", "hi"];

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: InitData | null) => {
      if (resolved) return;
      resolved = true;
      try {
        proc.kill();
      } catch {}
      resolve(result);
    };

    console.log(`[cli-init-fetch] spawning: ${bin} ${args.join(" ")} (cwd=${opts.cwd})`);

    const proc = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let stderrBuf = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === "system" && (event as Record<string, unknown>).subtype === "init") {
            const initData = parseInitEvent(event);
            console.log(`[cli-init-fetch] got init: ${initData.slashCommands.length} commands, ${initData.skills.length} skills`);
            done(initData);
            return;
          }
        } catch {
          // not JSON, skip
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-1024);
    });

    proc.on("close", (code) => {
      console.log(`[cli-init-fetch] process exited code=${code}${stderrBuf ? ` stderr=${stderrBuf.slice(0, 200)}` : ""}`);
      done(null);
    });
    proc.on("error", (err) => {
      console.log(`[cli-init-fetch] spawn error: ${err.message}`);
      done(null);
    });
    setTimeout(() => {
      console.log("[cli-init-fetch] timeout reached, giving up");
      done(null);
    }, FETCH_TIMEOUT_MS);
  });
}

function parseInitEvent(event: Record<string, unknown>): InitData {
  const slashCommands = (event.slash_commands || []) as string[];
  const skills = (event.skills || []) as string[];
  const rawAgents = (event.agents || []) as Array<string | Record<string, unknown>>;
  const agents = rawAgents.map((a) =>
    typeof a === "string" ? { name: a } : { name: (a.name || "") as string, description: a.description as string | undefined },
  );
  const version = (event.claude_code_version || "") as string;
  const model = (event.model || "") as string;
  const rawServers = (event.mcp_servers || []) as Array<{ name?: string; status?: string }>;
  const mcpServers = rawServers.map((s) => ({
    name: (s.name || "") as string,
    status: (s.status || "") as string,
  }));
  return { slashCommands, skills, agents, version, model, mcpServers };
}
