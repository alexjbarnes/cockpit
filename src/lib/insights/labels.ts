/**
 * Names for what telemetry records as identifiers: what a request was for,
 * which project a session's folder belongs to, which MCP server a tool is on.
 */

import type { Project } from "@/types";
import { projectForCwd } from "../issue-display";

const PURPOSES: Record<string, string> = {
  repl_main_thread: "Conversation",
  generate_session_title: "Session titles",
  web_fetch_apply: "Web fetch",
  compact: "Compaction",
  subagents: "Subagents",
  other: "Other",
};

/** What a request was for, from its `query_source`. */
export function purposeLabel(source: string | null | undefined): string {
  if (!source) return "Other";
  if (PURPOSES[source]) return PURPOSES[source];
  if (/^agent\b|subagent/.test(source)) return "Subagents";
  const words = source.replace(/[_:]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Other";
}

/** The key a purpose is grouped under, so every subagent lands in one row. */
export function purposeKey(source: string | null | undefined): string {
  if (!source) return "other";
  return /^agent\b|subagent/.test(source) ? "subagents" : source;
}

export function effortLabel(effort: string | null | undefined): string {
  if (!effort) return "Default";
  return effort === "xhigh" ? "Extra high" : effort[0].toUpperCase() + effort.slice(1);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A worktree folder named after an issue: `<repo>-<PREFIX>-<n>`. */
const WORKTREE = /^(.+)-([A-Z][A-Z0-9]*)-(\d+)$/;

/**
 * The project a session's folder belongs to: a tracker project whose repo
 * holds it; failing that, a worktree named after one of a project's issues;
 * failing that, the folder's own name (a worktree's repo name).
 */
export function projectForSession(projects: readonly Project[], cwd: string | undefined): { key: string; label: string } | undefined {
  if (!cwd) return undefined;
  const tracked = projectForCwd([...projects], cwd);
  if (tracked) return { key: tracked.id, label: tracked.name };
  const folder = cwd.replace(/\/+$/, "").split("/").pop();
  // A scratch folder named by an id (a scheduled job's) is not a project.
  if (!folder || UUID.test(folder)) return undefined;
  const worktree = folder.match(WORKTREE);
  if (worktree) {
    const owner = projects.find((p) => !p.archived && p.prefix === worktree[2]);
    if (owner) return { key: owner.id, label: owner.name };
    return { key: `dir:${worktree[1]}`, label: worktree[1] };
  }
  return { key: `dir:${folder}`, label: folder };
}

/** The server and tool of an MCP tool name (`mcp__server__tool`), or null. */
export function mcpTool(name: string): { server: string; tool: string } | null {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? { server: m[1], tool: m[2] } : null;
}
