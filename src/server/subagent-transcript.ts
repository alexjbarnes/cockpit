import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "@/types";
import { getTranscriptPath, loadTranscriptFileAbs } from "./transcript";

/**
 * Subagent transcripts (CLI 2.1.x). Each Task/Agent subagent writes its own
 * transcript to `<projectKey>/<cliSessionId>/subagents/agent-<agentId>.jsonl`,
 * with an `agent-<agentId>.meta.json` sidecar linking it back to the parent's
 * Agent tool_use id. The SubagentStart/Stop hooks do NOT carry that parent
 * tool_use id, so the meta sidecar is the only reliable correlation key.
 */
export interface SubagentMeta {
  agentId: string;
  agentType: string;
  description: string;
  /** The parent transcript's Agent tool_use id (`toolu_...`). */
  toolUseId: string;
  spawnDepth?: number;
}

/** `.../projects/<projectKey>/<cliSessionId>/subagents`. */
function subagentsDir(cliSessionId: string, cwd: string): string {
  return path.join(path.dirname(getTranscriptPath(cliSessionId, cwd)), cliSessionId, "subagents");
}

/**
 * All subagent metas for one CLI session, newest files last (readdir order).
 * Returns [] when the session ran no subagents or the dir is absent.
 */
export async function listSubagentMetas(cliSessionId: string, cwd: string): Promise<SubagentMeta[]> {
  const dir = subagentsDir(cliSessionId, cwd);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const metas: SubagentMeta[] = [];
  for (const f of files) {
    if (!f.endsWith(".meta.json")) continue;
    const agentId = f.slice("agent-".length, -".meta.json".length);
    try {
      const raw = await readFile(path.join(dir, f), "utf-8");
      const parsed = JSON.parse(raw) as Partial<SubagentMeta>;
      if (typeof parsed.toolUseId !== "string" || !parsed.toolUseId) continue;
      metas.push({
        agentId: typeof parsed.agentId === "string" && parsed.agentId ? parsed.agentId : agentId,
        agentType: typeof parsed.agentType === "string" ? parsed.agentType : "",
        description: typeof parsed.description === "string" ? parsed.description : "",
        toolUseId: parsed.toolUseId,
        spawnDepth: typeof parsed.spawnDepth === "number" ? parsed.spawnDepth : undefined,
      });
    } catch {
      // skip unreadable / malformed meta
    }
  }
  return metas;
}

/**
 * Metas across several CLI sessions (a cockpit session can span resumes). The
 * caller passes every cliSessionId that has belonged to the session; each is
 * probed for its own subagents dir.
 */
export async function listSubagentMetasForSessions(cliSessionIds: string[], cwd: string): Promise<SubagentMeta[]> {
  const all = await Promise.all(cliSessionIds.map((sid) => listSubagentMetas(sid, cwd)));
  // De-dupe by toolUseId in case the same session id is passed twice.
  const byToolUse = new Map<string, SubagentMeta>();
  for (const meta of all.flat()) {
    if (!byToolUse.has(meta.toolUseId)) byToolUse.set(meta.toolUseId, meta);
  }
  return [...byToolUse.values()];
}

/**
 * The subagent transcript for a parent Agent tool_use id, as ChatMessages, or
 * null when no subagent maps to that tool_use id. Searches every passed CLI
 * session id (resumes) for a matching meta sidecar.
 */
export async function loadSubagentByToolUse(cliSessionIds: string[], cwd: string, toolUseId: string): Promise<ChatMessage[] | null> {
  for (const cliSessionId of cliSessionIds) {
    const metas = await listSubagentMetas(cliSessionId, cwd);
    const match = metas.find((m) => m.toolUseId === toolUseId);
    if (!match) continue;
    const file = path.join(subagentsDir(cliSessionId, cwd), `agent-${match.agentId}.jsonl`);
    return loadTranscriptFileAbs(file);
  }
  return null;
}
