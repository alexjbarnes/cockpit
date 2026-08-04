import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listSubagentMetas, listSubagentMetasForSessions, loadSubagentByToolUse } from "@/server/subagent-transcript";

// Real-fixture test: write the on-disk layout the CLI produces and exercise the
// actual parse path, rather than mocking fs.
const CWD = "/repo/proj";
const PROJECT_KEY = CWD.replace(/[/.]/g, "-"); // "-repo-proj"
const SESSION = "sess-1111";
const OTHER_SESSION = "sess-2222";

let root: string;
let prevConfigDir: string | undefined;

function subagentsPath(session: string): string {
  return path.join(root, "projects", PROJECT_KEY, session, "subagents");
}

function jsonl(...entries: Record<string, unknown>[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

async function writeSubagent(session: string, agentId: string, meta: Record<string, unknown> | string, lines: string): Promise<void> {
  const dir = subagentsPath(session);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `agent-${agentId}.jsonl`), lines);
  await writeFile(path.join(dir, `agent-${agentId}.meta.json`), typeof meta === "string" ? meta : JSON.stringify(meta));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cockpit-subagent-"));
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;

  // A normal subagent transcript: a user prompt + an assistant turn.
  await writeSubagent(
    SESSION,
    "aaa111",
    { agentType: "Explore", description: "map the thing", toolUseId: "toolu_MATCH", spawnDepth: 1 },
    jsonl(
      { type: "user", isSidechain: true, message: { role: "user", content: "explore the repo" } },
      {
        type: "assistant",
        message: { id: "m1", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "found it in foo.ts" }] },
      },
    ),
  );

  // A second subagent in the same session, and a malformed meta that must be skipped.
  await writeSubagent(
    SESSION,
    "bbb222",
    { agentType: "general-purpose", description: "second", toolUseId: "toolu_SECOND" },
    jsonl({ type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "second agent" }] } }),
  );
  await writeSubagent(SESSION, "ccc333", "{ not valid json", jsonl({ type: "user", message: { role: "user", content: "x" } }));

  // A meta with no toolUseId must be skipped.
  await writeSubagent(
    SESSION,
    "ddd444",
    { agentType: "x", description: "no tool use" },
    jsonl({ type: "user", message: { role: "user", content: "y" } }),
  );

  // A subagent belonging to a different (resumed) CLI session id.
  await writeSubagent(
    OTHER_SESSION,
    "eee555",
    { agentType: "Plan", description: "from resume", toolUseId: "toolu_RESUME" },
    jsonl({ type: "assistant", message: { id: "m3", role: "assistant", content: [{ type: "text", text: "resume agent" }] } }),
  );
});

afterAll(async () => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  await rm(root, { recursive: true, force: true });
});

describe("listSubagentMetas", () => {
  it("returns valid metas and skips malformed / toolUseId-less sidecars", async () => {
    const metas = await listSubagentMetas(SESSION, CWD);
    const byTool = new Map(metas.map((m) => [m.toolUseId, m]));
    expect(byTool.has("toolu_MATCH")).toBe(true);
    expect(byTool.has("toolu_SECOND")).toBe(true);
    // malformed json (ccc333) and missing toolUseId (ddd444) dropped
    expect(metas).toHaveLength(2);
    expect(byTool.get("toolu_MATCH")).toMatchObject({
      agentId: "aaa111",
      agentType: "Explore",
      description: "map the thing",
      spawnDepth: 1,
    });
  });

  it("returns [] when the subagents dir is absent", async () => {
    const metas = await listSubagentMetas("no-such-session", CWD);
    expect(metas).toEqual([]);
  });
});

describe("listSubagentMetasForSessions", () => {
  it("merges metas across CLI sessions and de-dupes by toolUseId", async () => {
    const metas = await listSubagentMetasForSessions([SESSION, OTHER_SESSION, SESSION], CWD);
    const ids = metas.map((m) => m.toolUseId).sort();
    expect(ids).toEqual(["toolu_MATCH", "toolu_RESUME", "toolu_SECOND"]);
  });
});

describe("loadSubagentByToolUse", () => {
  it("loads and parses the matching subagent transcript", async () => {
    const messages = await loadSubagentByToolUse([SESSION], CWD, "toolu_MATCH");
    expect(messages).not.toBeNull();
    const text = (messages ?? []).map((m) => m.content).join(" ");
    expect(text).toContain("found it in foo.ts");
  });

  it("finds a subagent under a resumed session id", async () => {
    const messages = await loadSubagentByToolUse([SESSION, OTHER_SESSION], CWD, "toolu_RESUME");
    expect(messages).not.toBeNull();
    expect((messages ?? []).some((m) => m.content.includes("resume agent"))).toBe(true);
  });

  // A background agent's card is built from SubagentStart/task-sync hooks
  // (PTY runtime), which carry the agent id and no tool_use id — so keying
  // only on tool_use left every such card reporting no transcript while its
  // file sat on disk.
  it("also resolves by agent id, for background agents whose card carries no tool_use id", async () => {
    const byToolUse = await loadSubagentByToolUse([SESSION], CWD, "toolu_MATCH");
    const byAgentId = await loadSubagentByToolUse([SESSION], CWD, "aaa111");
    expect(byAgentId).not.toBeNull();
    // Compared by content: the transcript parser mints a fresh message id and
    // timestamp on each parse, so the objects are never identity-equal.
    expect((byAgentId ?? []).map((m) => m.content)).toEqual((byToolUse ?? []).map((m) => m.content));
    expect((byAgentId ?? []).map((m) => m.content).join(" ")).toContain("found it in foo.ts");
  });

  it("resolves by agent id under a resumed session id too", async () => {
    const messages = await loadSubagentByToolUse([SESSION, OTHER_SESSION], CWD, "bbb222");
    expect(messages).not.toBeNull();
  });

  it("returns null when no subagent maps to the tool_use id", async () => {
    const messages = await loadSubagentByToolUse([SESSION, OTHER_SESSION], CWD, "toolu_UNKNOWN");
    expect(messages).toBeNull();
  });

  it("returns [] (not null) when the meta exists but its transcript file is gone", async () => {
    const dir = subagentsPath("sess-orphan");
    await mkdir(dir, { recursive: true });
    // meta only, no agent-orphan.jsonl alongside it
    await writeFile(
      path.join(dir, "agent-orphan.meta.json"),
      JSON.stringify({ agentType: "x", description: "orphan", toolUseId: "toolu_ORPHAN" }),
    );
    const messages = await loadSubagentByToolUse(["sess-orphan"], CWD, "toolu_ORPHAN");
    expect(messages).toEqual([]);
  });
});
