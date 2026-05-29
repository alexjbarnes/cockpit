import { describe, expect, it } from "vitest";
import type { ParsedEvent } from "@/server/event-parser";
import { createStreamState, isReadOnlyBashCommand, processEvents, type StreamState } from "@/server/stream-processor";
import type { ToolUse } from "@/types";

const defaults = { planMode: false, compacting: false };

function makeEvent(overrides: Partial<ParsedEvent>): ParsedEvent {
  return { type: "text_delta", ...overrides } as ParsedEvent;
}

describe("isReadOnlyBashCommand", () => {
  it("returns true for simple read-only commands", () => {
    expect(isReadOnlyBashCommand("ls")).toBe(true);
    expect(isReadOnlyBashCommand("cat foo.txt")).toBe(true);
    expect(isReadOnlyBashCommand("head -n 10 file")).toBe(true);
    expect(isReadOnlyBashCommand("tail -f log")).toBe(true);
    expect(isReadOnlyBashCommand("wc -l file")).toBe(true);
    expect(isReadOnlyBashCommand("grep pattern file")).toBe(true);
    expect(isReadOnlyBashCommand("rg pattern")).toBe(true);
    expect(isReadOnlyBashCommand("find . -name '*.ts'")).toBe(true);
    expect(isReadOnlyBashCommand("stat file")).toBe(true);
    expect(isReadOnlyBashCommand("file somefile")).toBe(true);
    expect(isReadOnlyBashCommand("du -sh .")).toBe(true);
    expect(isReadOnlyBashCommand("df -h")).toBe(true);
    expect(isReadOnlyBashCommand("tree")).toBe(true);
    expect(isReadOnlyBashCommand("echo hello")).toBe(true);
    expect(isReadOnlyBashCommand("pwd")).toBe(true);
    expect(isReadOnlyBashCommand("which node")).toBe(true);
    expect(isReadOnlyBashCommand("whoami")).toBe(true);
    expect(isReadOnlyBashCommand("env")).toBe(true);
    expect(isReadOnlyBashCommand("uname -a")).toBe(true);
    expect(isReadOnlyBashCommand("hostname")).toBe(true);
    expect(isReadOnlyBashCommand("date")).toBe(true);
    expect(isReadOnlyBashCommand("id")).toBe(true);
  });

  it("returns true for utility commands", () => {
    expect(isReadOnlyBashCommand("printf '%s' hello")).toBe(true);
    expect(isReadOnlyBashCommand("basename /foo/bar")).toBe(true);
    expect(isReadOnlyBashCommand("dirname /foo/bar")).toBe(true);
    expect(isReadOnlyBashCommand("realpath ./file")).toBe(true);
    expect(isReadOnlyBashCommand("readlink symlink")).toBe(true);
    expect(isReadOnlyBashCommand("type ls")).toBe(true);
    expect(isReadOnlyBashCommand("whereis ls")).toBe(true);
    expect(isReadOnlyBashCommand("printenv HOME")).toBe(true);
  });

  it("returns true for Windows commands", () => {
    expect(isReadOnlyBashCommand("dir")).toBe(true);
    expect(isReadOnlyBashCommand("findstr pattern file")).toBe(true);
    expect(isReadOnlyBashCommand("where node")).toBe(true);
    expect(isReadOnlyBashCommand("more file")).toBe(true);
    expect(isReadOnlyBashCommand("sort file")).toBe(true);
  });

  it("returns true for read-only git subcommands", () => {
    expect(isReadOnlyBashCommand("git status")).toBe(true);
    expect(isReadOnlyBashCommand("git log --oneline")).toBe(true);
    expect(isReadOnlyBashCommand("git diff")).toBe(true);
    expect(isReadOnlyBashCommand("git show HEAD")).toBe(true);
    expect(isReadOnlyBashCommand("git blame file")).toBe(true);
    expect(isReadOnlyBashCommand("git branch -a")).toBe(true);
    expect(isReadOnlyBashCommand("git remote -v")).toBe(true);
    expect(isReadOnlyBashCommand("git ls-files")).toBe(true);
    expect(isReadOnlyBashCommand("git ls-tree HEAD")).toBe(true);
    expect(isReadOnlyBashCommand("git rev-parse HEAD")).toBe(true);
    expect(isReadOnlyBashCommand("git describe")).toBe(true);
    expect(isReadOnlyBashCommand("git tag")).toBe(true);
    expect(isReadOnlyBashCommand("git reflog")).toBe(true);
  });

  it("returns true for piped read-only commands", () => {
    expect(isReadOnlyBashCommand("cat file | grep pattern")).toBe(true);
    expect(isReadOnlyBashCommand("ls | sort")).toBe(true);
    expect(isReadOnlyBashCommand("git log | head -5")).toBe(true);
    expect(isReadOnlyBashCommand("find . -name '*.ts' | wc -l")).toBe(true);
  });

  it("returns false for write commands", () => {
    expect(isReadOnlyBashCommand("rm file")).toBe(false);
    expect(isReadOnlyBashCommand("mkdir dir")).toBe(false);
    expect(isReadOnlyBashCommand("cp a b")).toBe(false);
    expect(isReadOnlyBashCommand("mv a b")).toBe(false);
    expect(isReadOnlyBashCommand("npm install")).toBe(false);
    expect(isReadOnlyBashCommand("node script.js")).toBe(false);
    expect(isReadOnlyBashCommand("python script.py")).toBe(false);
  });

  it("returns false for write git subcommands", () => {
    expect(isReadOnlyBashCommand("git commit -m 'msg'")).toBe(false);
    expect(isReadOnlyBashCommand("git push")).toBe(false);
    expect(isReadOnlyBashCommand("git pull")).toBe(false);
    expect(isReadOnlyBashCommand("git checkout main")).toBe(false);
    expect(isReadOnlyBashCommand("git merge branch")).toBe(false);
    expect(isReadOnlyBashCommand("git rebase main")).toBe(false);
    expect(isReadOnlyBashCommand("git reset --hard")).toBe(false);
  });

  it("returns false for git with no subcommand", () => {
    expect(isReadOnlyBashCommand("git")).toBe(false);
  });

  it("returns false for shell operators", () => {
    expect(isReadOnlyBashCommand("ls; rm file")).toBe(false);
    expect(isReadOnlyBashCommand("ls && rm file")).toBe(false);
    expect(isReadOnlyBashCommand("ls || rm file")).toBe(false);
    expect(isReadOnlyBashCommand("cat file > out")).toBe(false);
    expect(isReadOnlyBashCommand("cat file < in")).toBe(false);
    expect(isReadOnlyBashCommand("echo `rm file`")).toBe(false);
    expect(isReadOnlyBashCommand("echo $(rm file)")).toBe(false);
    expect(isReadOnlyBashCommand("cat <(ls)")).toBe(false);
  });

  it("returns false for background operator", () => {
    expect(isReadOnlyBashCommand("ls &")).toBe(false);
    expect(isReadOnlyBashCommand("cat file &")).toBe(false);
  });

  it("returns false for empty or whitespace input", () => {
    expect(isReadOnlyBashCommand("")).toBe(false);
    expect(isReadOnlyBashCommand("   ")).toBe(false);
  });

  it("handles leading/trailing whitespace", () => {
    expect(isReadOnlyBashCommand("  ls  ")).toBe(true);
    expect(isReadOnlyBashCommand("  git status  ")).toBe(true);
  });

  it("returns false for pipe with write command", () => {
    expect(isReadOnlyBashCommand("ls | rm")).toBe(false);
    expect(isReadOnlyBashCommand("cat file | node -e 'code'")).toBe(false);
  });
});

describe("createStreamState", () => {
  it("returns a fresh state", () => {
    const state = createStreamState();
    expect(state.pendingToolUses).toEqual([]);
    expect(state.pendingBlocks).toEqual([]);
    expect(state.agentStack).toEqual([]);
    expect(state.currentAssistantMsgId).toBeNull();
    expect(state.flushedOnMessageDone).toBe(false);
  });
});

describe("processEvents", () => {
  function makeState(overrides?: Partial<StreamState>): StreamState {
    return { ...createStreamState(), ...overrides };
  }

  describe("text_delta", () => {
    it("creates a text block on first delta", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      const events: ParsedEvent[] = [makeEvent({ type: "text_delta", text: "hello" })];
      const result = processEvents(events, state, defaults);

      expect(state.pendingBlocks).toHaveLength(1);
      expect(state.pendingBlocks[0]).toEqual({ type: "text", text: "hello" });
      expect(result.emit).toHaveLength(1);
    });

    it("appends to existing text block", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.pendingBlocks.push({ type: "text", text: "hello" });
      const events: ParsedEvent[] = [makeEvent({ type: "text_delta", text: " world" })];
      processEvents(events, state, defaults);

      expect(state.pendingBlocks).toHaveLength(1);
      expect((state.pendingBlocks[0] as { text: string }).text).toBe("hello world");
    });

    it("skips text_delta when inside agent", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.agentStack.push({ id: "agent-1", name: "Agent", input: "", output: "", status: "running" });
      const events: ParsedEvent[] = [makeEvent({ type: "text_delta", text: "agent text" })];
      processEvents(events, state, defaults);

      expect(state.pendingBlocks).toHaveLength(0);
    });

    it("ignores text_delta with empty text", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      const events: ParsedEvent[] = [makeEvent({ type: "text_delta", text: "" })];
      processEvents(events, state, defaults);

      expect(state.pendingBlocks).toHaveLength(0);
    });
  });

  describe("thinking", () => {
    it("creates a thinking block", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      const events: ParsedEvent[] = [makeEvent({ type: "thinking", text: "hmm" })];
      processEvents(events, state, defaults);

      expect(state.pendingBlocks).toHaveLength(1);
      expect(state.pendingBlocks[0]).toEqual({ type: "thinking", text: "hmm", redacted: undefined });
    });

    it("appends to existing thinking block", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.pendingBlocks.push({ type: "thinking", text: "first" });
      const events: ParsedEvent[] = [makeEvent({ type: "thinking", text: " second" })];
      processEvents(events, state, defaults);

      expect(state.pendingBlocks).toHaveLength(1);
      const block = state.pendingBlocks[0] as { text: string };
      expect(block.text).toBe("first second");
    });

    it("handles redacted thinking", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      const events: ParsedEvent[] = [makeEvent({ type: "thinking", redacted: true })];
      processEvents(events, state, defaults);

      expect(state.pendingBlocks).toHaveLength(1);
      expect((state.pendingBlocks[0] as { redacted: boolean }).redacted).toBe(true);
    });

    it("sets redacted flag on existing thinking block", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.pendingBlocks.push({ type: "thinking", text: "start" });
      const events: ParsedEvent[] = [makeEvent({ type: "thinking", redacted: true })];
      processEvents(events, state, defaults);

      expect(state.pendingBlocks).toHaveLength(1);
      expect((state.pendingBlocks[0] as { redacted: boolean }).redacted).toBe(true);
    });

    it("skips thinking when inside agent", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.agentStack.push({ id: "agent-1", name: "Agent", input: "", output: "", status: "running" });
      const events: ParsedEvent[] = [makeEvent({ type: "thinking", text: "agent thinking" })];
      processEvents(events, state, defaults);

      expect(state.pendingBlocks).toHaveLength(0);
    });

    it("computes durationMs when thinkingStartedAt is set", () => {
      const startedAt = Date.now() - 5000;
      const state = makeState({ currentAssistantMsgId: "msg-1", thinkingStartedAt: startedAt });
      const events: ParsedEvent[] = [makeEvent({ type: "thinking", text: "hmm" })];
      const result = processEvents(events, state, defaults);

      expect(state.pendingBlocks).toHaveLength(1);
      const block = state.pendingBlocks[0] as { type: string; durationMs?: number };
      expect(block.type).toBe("thinking");
      expect(block.durationMs).toBeGreaterThanOrEqual(5000);

      const thinkingEmits = result.emit.filter((e) => e.type === "thinking");
      expect(thinkingEmits).toHaveLength(1);
      expect(thinkingEmits[0].durationMs).toBeGreaterThanOrEqual(5000);
    });

    it("leaves durationMs undefined when thinkingStartedAt is null", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      const events: ParsedEvent[] = [makeEvent({ type: "thinking", text: "hmm" })];
      const result = processEvents(events, state, defaults);
      const block = state.pendingBlocks[0] as { durationMs?: number };
      expect(block.durationMs).toBeUndefined();
      expect(result.emit.find((e) => e.type === "thinking")?.durationMs).toBeUndefined();
    });

    it("emits a single thinking event when followed by text_delta", () => {
      const state = makeState({
        currentAssistantMsgId: "msg-1",
        thinkingStartedAt: Date.now() - 1000,
      });
      const events: ParsedEvent[] = [makeEvent({ type: "thinking", text: "hmm" }), makeEvent({ type: "text_delta", text: "answer" })];
      const result = processEvents(events, state, defaults);

      const thinkingEmits = result.emit.filter((e) => e.type === "thinking");
      expect(thinkingEmits).toHaveLength(1);
      expect(thinkingEmits[0].text).toBe("hmm");
      expect(thinkingEmits[0].durationMs).toBeGreaterThanOrEqual(1000);
    });
  });

  describe("tool_use_start", () => {
    it("creates a tool use and adds to pending", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      const events: ParsedEvent[] = [
        makeEvent({
          type: "tool_use_start",
          toolId: "t1",
          toolName: "Read",
          toolInput: '{"file":"/a"}',
          assistantMessageId: "msg-1",
        }),
      ];
      processEvents(events, state, defaults);

      expect(state.pendingToolUses).toHaveLength(1);
      expect(state.pendingToolUses[0].name).toBe("Read");
      expect(state.pendingToolUses[0].status).toBe("running");
      expect(state.pendingBlocks).toHaveLength(1);
      expect(state.pendingBlocks[0].type).toBe("tool_use");
    });

    it("pushes Agent tools onto agentStack", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      const events: ParsedEvent[] = [
        makeEvent({
          type: "tool_use_start",
          toolId: "a1",
          toolName: "Agent",
          toolInput: "{}",
          assistantMessageId: "msg-1",
        }),
      ];
      processEvents(events, state, defaults);

      expect(state.agentStack).toHaveLength(1);
      expect(state.agentStack[0].name).toBe("Agent");
    });

    it("nests sub-agent tools as children", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.agentStack.push({ id: "a1", name: "Agent", input: "", output: "", status: "running" });
      const events: ParsedEvent[] = [
        makeEvent({
          type: "tool_use_start",
          toolId: "t1",
          toolName: "Read",
          toolInput: "{}",
          assistantMessageId: "sub-msg",
        }),
      ];
      processEvents(events, state, defaults);

      expect(state.agentStack[0].children).toHaveLength(1);
      expect(state.agentStack[0].children![0].name).toBe("Read");
      expect(state.pendingToolUses).toHaveLength(0);
    });

    it("keeps main thread tools at top level even with active agent", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.agentStack.push({ id: "a1", name: "Agent", input: "", output: "", status: "running" });
      const events: ParsedEvent[] = [
        makeEvent({
          type: "tool_use_start",
          toolId: "t1",
          toolName: "Read",
          toolInput: "{}",
          assistantMessageId: "msg-1",
        }),
      ];
      processEvents(events, state, defaults);

      expect(state.pendingToolUses).toHaveLength(1);
      expect(state.agentStack[0].children).toBeUndefined();
    });
  });

  describe("tool_result", () => {
    it("marks tool as done", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.pendingToolUses.push({ id: "t1", name: "Read", input: "", output: "", status: "running" });
      const events: ParsedEvent[] = [
        makeEvent({
          type: "tool_result",
          toolId: "t1",
          toolOutput: "file content",
          filePath: "/a/b",
        }),
      ];
      processEvents(events, state, defaults);

      expect(state.pendingToolUses[0].output).toBe("file content");
      expect(state.pendingToolUses[0].filePath).toBe("/a/b");
      expect(state.pendingToolUses[0].status).toBe("done");
    });

    it("completes agent tool and removes from stack", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.agentStack.push({ id: "a1", name: "Agent", input: "", output: "", status: "running" });
      state.pendingToolUses.push(state.agentStack[0]);
      const events: ParsedEvent[] = [
        makeEvent({
          type: "tool_result",
          toolId: "a1",
          toolOutput: "agent result",
        }),
      ];
      processEvents(events, state, defaults);

      expect(state.agentStack).toHaveLength(0);
      expect(state.pendingToolUses[0].status).toBe("done");
    });

    it("sets filePath on agent tool result", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.agentStack.push({ id: "a1", name: "Agent", input: "", output: "", status: "running" });
      state.pendingToolUses.push(state.agentStack[0]);
      const events: ParsedEvent[] = [
        makeEvent({
          type: "tool_result",
          toolId: "a1",
          toolOutput: "result",
          filePath: "/agent/path",
        }),
      ];
      processEvents(events, state, defaults);

      expect(state.pendingToolUses[0].filePath).toBe("/agent/path");
    });

    it("sets filePath on agent child result", () => {
      const child: ToolUse = { id: "c1", name: "Read", input: "", output: "", status: "running" };
      const agent: ToolUse = { id: "a1", name: "Agent", input: "", output: "", status: "running", children: [child] };
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.agentStack.push(agent);
      const events: ParsedEvent[] = [
        makeEvent({
          type: "tool_result",
          toolId: "c1",
          toolOutput: "child result",
          filePath: "/child/path",
        }),
      ];
      processEvents(events, state, defaults);

      expect(agent.children![0].filePath).toBe("/child/path");
    });

    it("completes child tool of agent", () => {
      const child = { id: "c1", name: "Read", input: "", output: "", status: "running" as const };
      const agent = { id: "a1", name: "Agent", input: "", output: "", status: "running" as const, children: [child] };
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.agentStack.push(agent);
      const events: ParsedEvent[] = [
        makeEvent({
          type: "tool_result",
          toolId: "c1",
          toolOutput: "child result",
        }),
      ];
      processEvents(events, state, defaults);

      expect(agent.children[0].status).toBe("done");
      expect(agent.children[0].output).toBe("child result");
    });
  });

  describe("tool_progress", () => {
    it("appends to agent output", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.agentStack.push({ id: "a1", name: "Agent", input: "", output: "start", status: "running" });
      const events: ParsedEvent[] = [makeEvent({ type: "tool_progress", toolId: "a1", text: " more" })];
      processEvents(events, state, defaults);

      expect(state.agentStack[0].output).toBe("start more");
    });

    it("appends to agent child output", () => {
      const child = { id: "c1", name: "Read", input: "", output: "", status: "running" as const };
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.agentStack.push({ id: "a1", name: "Agent", input: "", output: "", status: "running", children: [child] });
      const events: ParsedEvent[] = [makeEvent({ type: "tool_progress", toolId: "c1", text: "progress" })];
      processEvents(events, state, defaults);

      expect(child.output).toBe("progress");
    });

    it("appends to pending tool when no agent context", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.pendingToolUses.push({ id: "t1", name: "Bash", input: "", output: "", status: "running" });
      const events: ParsedEvent[] = [makeEvent({ type: "tool_progress", toolId: "t1", text: "output" })];
      processEvents(events, state, defaults);

      expect(state.pendingToolUses[0].output).toBe("output");
    });

    it("falls through to pending tool when not found in agent children", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.agentStack.push({ id: "a1", name: "Agent", input: "", output: "", status: "running", children: [] });
      state.pendingToolUses.push({ id: "t1", name: "Bash", input: "", output: "", status: "running" });
      const events: ParsedEvent[] = [makeEvent({ type: "tool_progress", toolId: "t1", text: "output" })];
      processEvents(events, state, defaults);

      expect(state.pendingToolUses[0].output).toBe("output");
    });
  });

  describe("system_message", () => {
    it("collects system messages", () => {
      const state = makeState();
      const events: ParsedEvent[] = [makeEvent({ type: "system_message", text: "hello" })];
      const result = processEvents(events, state, defaults);

      expect(result.systemMessages).toEqual(["hello"]);
      expect(result.emit).toHaveLength(1);
    });

    it("collects permission_mode messages but skips emit", () => {
      const state = makeState();
      const events: ParsedEvent[] = [makeEvent({ type: "system_message", text: "__permission_mode::plan" })];
      const result = processEvents(events, state, defaults);

      expect(result.systemMessages).toEqual(["__permission_mode::plan"]);
      expect(result.emit).toHaveLength(0);
    });
  });

  describe("message_done", () => {
    it("assembles final message with blocks and tool uses", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.pendingBlocks.push({ type: "text", text: "response" });
      state.pendingToolUses.push({ id: "t1", name: "Read", input: "", output: "ok", status: "done" });
      const msg = { id: "x", role: "assistant" as const, content: "", toolUses: [] as any[], blocks: [] as any[], timestamp: 0 };
      const events: ParsedEvent[] = [makeEvent({ type: "message_done", message: msg })];
      const result = processEvents(events, state, defaults);

      expect(result.statusChange).toBe("idle");
      expect(result.emit).toHaveLength(1);
      expect(msg.id).toBe("msg-1");
      expect(msg.blocks).toHaveLength(1);
      expect(msg.toolUses).toHaveLength(1);
      expect(state.pendingBlocks).toHaveLength(0);
      expect(state.pendingToolUses).toHaveLength(0);
    });

    it("handles interrupted turn", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.pendingBlocks.push({ type: "text", text: "partial" });
      const msg = { id: "x", role: "assistant" as const, content: "", toolUses: [] as any[], blocks: [] as any[], timestamp: 0 };
      const events: ParsedEvent[] = [makeEvent({ type: "message_done", message: msg, interrupted: true })];
      const result = processEvents(events, state, defaults);

      expect(result.statusChange).toBe("idle");
      expect(state.pendingBlocks).toHaveLength(0);
      expect(state.currentAssistantMsgId).toBeNull();
      expect(state.flushedOnMessageDone).toBe(true);
    });

    it("handles empty message_done (already finalized)", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      const msg = { id: "x", role: "assistant" as const, content: "", toolUses: [] as any[], blocks: [] as any[], timestamp: 0 };
      const events: ParsedEvent[] = [makeEvent({ type: "message_done", message: msg })];
      const result = processEvents(events, state, defaults);

      expect(result.statusChange).toBe("idle");
      expect(result.emit).toHaveLength(0);
      expect(result.snapshot).toBeNull();
    });

    it("sets compactDone on empty message_done when compacting", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      const msg = { id: "x", role: "assistant" as const, content: "", toolUses: [] as any[], blocks: [] as any[], timestamp: 0 };
      const events: ParsedEvent[] = [makeEvent({ type: "message_done", message: msg })];
      const result = processEvents(events, state, { planMode: false, compacting: true });

      expect(result.compactDone).toBe(true);
    });

    it("filters 'No response requested.' messages", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.pendingBlocks.push({ type: "text", text: "No response requested." });
      const msg = { id: "x", role: "assistant" as const, content: "", toolUses: [] as any[], blocks: [] as any[], timestamp: 0 };
      const events: ParsedEvent[] = [makeEvent({ type: "message_done", message: msg })];
      const result = processEvents(events, state, defaults);

      expect(result.statusChange).toBe("idle");
      expect(result.emit).toHaveLength(0);
      expect(state.pendingBlocks).toHaveLength(0);
    });

    it("extracts API errors", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.pendingBlocks.push({ type: "text", text: 'API Error: 500 {"type":"error","message":"overloaded"}' });
      const msg = { id: "x", role: "assistant" as const, content: "", toolUses: [] as any[], blocks: [] as any[], timestamp: 0 };
      const events: ParsedEvent[] = [makeEvent({ type: "message_done", message: msg })];
      const result = processEvents(events, state, defaults);

      expect(result.errors).toEqual(["overloaded (HTTP 500)"]);
      expect(result.statusChange).toBe("idle");
      expect(result.emit).toHaveLength(0);
    });

    it("handles API error without message field", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.pendingBlocks.push({ type: "text", text: "API Error: 503 service unavailable" });
      const msg = { id: "x", role: "assistant" as const, content: "", toolUses: [] as any[], blocks: [] as any[], timestamp: 0 };
      const events: ParsedEvent[] = [makeEvent({ type: "message_done", message: msg })];
      const result = processEvents(events, state, defaults);

      expect(result.errors[0]).toContain("API Error: 503");
    });

    it("uses message.content when no streamed text but has tool uses", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      const tool = { id: "t1", name: "Read", input: "", output: "ok", status: "done" as const };
      state.pendingToolUses.push(tool);
      state.pendingBlocks.push({ type: "tool_use", toolUse: tool });
      const msg = {
        id: "x",
        role: "assistant" as const,
        content: "fallback content",
        toolUses: [] as any[],
        blocks: [] as any[],
        timestamp: 0,
      };
      const events: ParsedEvent[] = [makeEvent({ type: "message_done", message: msg })];
      const result = processEvents(events, state, defaults);

      expect(result.emit).toHaveLength(1);
      expect(msg.blocks).toHaveLength(2);
      expect(msg.blocks[1].text).toBe("fallback content");
    });

    it("sets compactDone when compacting", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.pendingBlocks.push({ type: "text", text: "response" });
      const msg = { id: "x", role: "assistant" as const, content: "", toolUses: [] as any[], blocks: [] as any[], timestamp: 0 };
      const events: ParsedEvent[] = [makeEvent({ type: "message_done", message: msg })];
      const result = processEvents(events, state, { planMode: false, compacting: true });

      expect(result.compactDone).toBe(true);
    });
  });

  describe("assistant message boundary", () => {
    it("finalizes intermediate message when assistant ID changes", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.pendingBlocks.push({ type: "text", text: "first response" });
      state.pendingToolUses.push({ id: "t1", name: "Read", input: "", output: "ok", status: "done" });
      const events: ParsedEvent[] = [
        makeEvent({
          type: "text_delta",
          text: "second",
          assistantMessageId: "msg-2",
        }),
      ];
      const result = processEvents(events, state, defaults);

      expect(result.intermediateMessages).toHaveLength(1);
      expect(result.intermediateMessages[0].id).toBe("msg-1");
      expect(result.intermediateMessages[0].content).toBe("first response");
      expect(state.currentAssistantMsgId).toBe("msg-2");
    });

    it("does not finalize when inside agent stack", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.agentStack.push({ id: "a1", name: "Agent", input: "", output: "", status: "running" });
      state.pendingBlocks.push({ type: "text", text: "content" });
      const events: ParsedEvent[] = [
        makeEvent({
          type: "text_delta",
          text: "sub",
          assistantMessageId: "sub-msg",
        }),
      ];
      const result = processEvents(events, state, defaults);

      expect(result.intermediateMessages).toHaveLength(0);
      expect(state.currentAssistantMsgId).toBe("msg-1");
    });
  });

  describe("permission_request", () => {
    it("stores permission requests", () => {
      const state = makeState();
      const events: ParsedEvent[] = [
        makeEvent({
          type: "permission_request",
          requestId: "req-1",
          toolName: "Bash",
          toolInput: "rm -rf /",
          rawToolInput: { command: "rm -rf /" },
        }),
      ];
      const result = processEvents(events, state, defaults);

      expect(result.permissionActions).toHaveLength(1);
      expect(result.permissionActions[0].type).toBe("store");
      expect(result.permissionActions[0].requestId).toBe("req-1");
      expect(result.emit).toHaveLength(1);
    });

    it("auto-approves read-only gh commands", () => {
      const state = makeState();
      const events: ParsedEvent[] = [
        makeEvent({
          type: "permission_request",
          requestId: "req-1",
          toolName: "Bash",
          rawToolInput: { command: "gh pr list" },
        }),
      ];
      const result = processEvents(events, state, defaults);

      expect(result.permissionActions[0].type).toBe("auto_approve");
      expect(result.emit).toHaveLength(0);
    });

    it("requires approval for gh commands that post externally", () => {
      for (const cmd of ["gh pr review 42 --approve", "gh pr comment 42 --body test", "gh issue comment 1 --body hi"]) {
        const state = makeState();
        const events: ParsedEvent[] = [
          makeEvent({
            type: "permission_request",
            requestId: "req-1",
            toolName: "Bash",
            rawToolInput: { command: cmd },
          }),
        ];
        const result = processEvents(events, state, defaults);
        expect(result.permissionActions[0].type).toBe("store");
      }
    });

    describe("plan mode", () => {
      const planOpts = { planMode: true, compacting: false };

      it("auto-approves read-only bash in plan mode", () => {
        const state = makeState();
        const events: ParsedEvent[] = [
          makeEvent({
            type: "permission_request",
            requestId: "req-1",
            toolName: "Bash",
            rawToolInput: { command: "ls -la" },
          }),
        ];
        const result = processEvents(events, state, planOpts);

        expect(result.permissionActions[0].type).toBe("auto_approve");
      });

      it("auto-denies write bash in plan mode", () => {
        const state = makeState();
        const events: ParsedEvent[] = [
          makeEvent({
            type: "permission_request",
            requestId: "req-1",
            toolName: "Bash",
            rawToolInput: { command: "npm install foo" },
          }),
        ];
        const result = processEvents(events, state, planOpts);

        expect(result.permissionActions[0].type).toBe("auto_deny");
        expect(result.permissionActions[0].denyReason).toContain("plan mode");
      });

      it("auto-denies write tools in plan mode", () => {
        for (const toolName of ["Edit", "Write", "NotebookEdit"]) {
          const state = makeState();
          const events: ParsedEvent[] = [
            makeEvent({
              type: "permission_request",
              requestId: "req-1",
              toolName,
            }),
          ];
          const result = processEvents(events, state, planOpts);

          expect(result.permissionActions[0].type).toBe("auto_deny");
          expect(result.permissionActions[0].denyReason).toContain(toolName);
        }
      });

      it("auto-approves non-write, non-user-facing tools in plan mode", () => {
        const state = makeState();
        const events: ParsedEvent[] = [
          makeEvent({
            type: "permission_request",
            requestId: "req-1",
            toolName: "Read",
            rawToolInput: { file: "/a" },
          }),
        ];
        const result = processEvents(events, state, planOpts);

        expect(result.permissionActions[0].type).toBe("auto_approve");
      });

      it("stores user-facing tools in plan mode", () => {
        for (const toolName of ["ExitPlanMode", "AskUserQuestion", "EnterPlanMode"]) {
          const state = makeState();
          const events: ParsedEvent[] = [
            makeEvent({
              type: "permission_request",
              requestId: "req-1",
              toolName,
            }),
          ];
          const result = processEvents(events, state, planOpts);

          expect(result.permissionActions[0].type).toBe("store");
        }
      });
    });
  });

  describe("snapshot", () => {
    it("builds snapshot with current state", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      state.pendingBlocks.push({ type: "text", text: "hello" });
      state.pendingToolUses.push({ id: "t1", name: "Read", input: "", output: "", status: "running" });
      const events: ParsedEvent[] = [makeEvent({ type: "text_delta", text: " world" })];
      const result = processEvents(events, state, defaults);

      expect(result.snapshot).toBeTruthy();
      expect(result.snapshot!.messageId).toBe("msg-1");
      expect(result.snapshot!.content).toBe("hello world");
      expect(result.snapshot!.toolUses).toHaveLength(1);
    });

    it("returns null snapshot when no blocks", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      const events: ParsedEvent[] = [makeEvent({ type: "text_delta", text: "" })];
      const result = processEvents(events, state, defaults);

      expect(result.snapshot).toBeNull();
    });

    it("returns null snapshot when no assistant message id", () => {
      const state = makeState();
      const events: ParsedEvent[] = [makeEvent({ type: "text_delta", text: "text" })];
      const result = processEvents(events, state, defaults);

      expect(result.snapshot).toBeNull();
    });
  });

  describe("multi-event sequences", () => {
    it("processes thinking then text then message_done", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      const msg = { id: "x", role: "assistant" as const, content: "", toolUses: [] as any[], blocks: [] as any[], timestamp: 0 };
      const events: ParsedEvent[] = [
        makeEvent({ type: "thinking", text: "thinking..." }),
        makeEvent({ type: "text_delta", text: "response" }),
        makeEvent({ type: "message_done", message: msg }),
      ];
      const result = processEvents(events, state, defaults);

      expect(result.statusChange).toBe("idle");
      expect(msg.blocks).toHaveLength(2);
      expect(msg.blocks[0].type).toBe("thinking");
      expect(msg.blocks[1].type).toBe("text");
    });

    it("processes tool_use_start then tool_result then message_done", () => {
      const state = makeState({ currentAssistantMsgId: "msg-1" });
      const msg = { id: "x", role: "assistant" as const, content: "", toolUses: [] as any[], blocks: [] as any[], timestamp: 0 };
      const events: ParsedEvent[] = [
        makeEvent({ type: "tool_use_start", toolId: "t1", toolName: "Read", toolInput: "{}", assistantMessageId: "msg-1" }),
        makeEvent({ type: "tool_result", toolId: "t1", toolOutput: "content" }),
        makeEvent({ type: "text_delta", text: "done" }),
        makeEvent({ type: "message_done", message: msg }),
      ];
      const _result = processEvents(events, state, defaults);

      expect(msg.toolUses).toHaveLength(1);
      expect(msg.toolUses[0].status).toBe("done");
      expect(msg.blocks).toHaveLength(2);
    });
  });
});
