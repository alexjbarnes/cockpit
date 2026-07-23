// Shapes here mirror a real async agent launch captured from a live session:
// the Agent tool use completes immediately with "Async agent launched
// successfully ... agentId: ac6a880af087a5341" while the agent keeps running,
// and the CLI only reports it again on SubagentStop.
import { describe, expect, it } from "vitest";
import { deriveAgentTasks } from "@/lib/agent-tasks";
import type { BackgroundTask, ChatMessage, ToolUse } from "@/types";

const ASYNC_OUTPUT =
  "Async agent launched successfully. (This tool result is internal metadata)\nagentId: ac6a880af087a5341 (internal ID - do not mention to user.";

function tool(partial: Partial<ToolUse> & { id: string }): ToolUse {
  return { name: "Agent", input: "{}", output: "", status: "done", ...partial };
}

function msg(tools: ToolUse[]): ChatMessage {
  return { id: `m-${tools.map((t) => t.id).join("-")}`, role: "assistant", content: "", toolUses: tools, blocks: [], timestamp: 0 };
}

describe("deriveAgentTasks", () => {
  it("reports a launched async agent as running even though its tool use is done", () => {
    const messages = [
      msg([
        tool({
          id: "toolu_1",
          input: JSON.stringify({ description: "Find VeRO endpoint + payload in portal", subagent_type: "Explore" }),
          output: ASYNC_OUTPUT,
          status: "done",
        }),
      ]),
    ];

    expect(deriveAgentTasks(messages, [])).toEqual([
      {
        taskId: "ac6a880af087a5341",
        toolUseId: "ac6a880af087a5341",
        status: "running",
        title: "Explore",
        description: "Find VeRO endpoint + payload in portal",
        activity: undefined,
        summary: undefined,
      },
    ]);
  });

  it("marks an async agent completed when the stop hook lands, matching on agent id", () => {
    const messages = [msg([tool({ id: "toolu_1", output: ASYNC_OUTPUT, input: JSON.stringify({ description: "d" }) })])];
    const hooks: BackgroundTask[] = [
      { taskId: "session-id", toolUseId: "ac6a880af087a5341", status: "completed", description: "Subagent completed", summary: "found it" },
    ];

    const [task] = deriveAgentTasks(messages, hooks);
    expect(task.status).toBe("completed");
    expect(task.summary).toBe("found it");
  });

  it("tracks a synchronous agent through its own tool status", () => {
    const running = deriveAgentTasks([msg([tool({ id: "t1", status: "running", input: JSON.stringify({ description: "d" }) })])], []);
    expect(running[0]).toMatchObject({ taskId: "t1", status: "running" });

    const done = deriveAgentTasks([msg([tool({ id: "t1", status: "done", output: "result text", input: "{}" })])], []);
    expect(done[0]).toMatchObject({ taskId: "t1", status: "completed" });
  });

  it("keeps concurrent agents separate instead of collapsing them", () => {
    const messages = [
      msg([
        tool({ id: "t1", output: "Async agent launched successfully.\nagentId: aaa111", input: JSON.stringify({ description: "one" }) }),
        tool({ id: "t2", output: "Async agent launched successfully.\nagentId: bbb222", input: JSON.stringify({ description: "two" }) }),
      ]),
    ];
    const hooks: BackgroundTask[] = [{ taskId: "sess", toolUseId: "aaa111", status: "completed", description: "done" }];

    const tasks = deriveAgentTasks(messages, hooks);
    expect(tasks.map((t) => [t.taskId, t.status])).toEqual([
      ["aaa111", "completed"],
      ["bbb222", "running"],
    ]);
  });

  it("finds agents nested under a parent agent", () => {
    const child = tool({ id: "child", status: "running", input: JSON.stringify({ description: "nested work" }) });
    const parent = tool({ id: "parent", status: "running", input: JSON.stringify({ description: "outer" }), children: [child] });

    expect(deriveAgentTasks([msg([parent])], []).map((t) => t.taskId)).toEqual(["parent", "child"]);
  });

  it("ignores non-agent tools and tolerates unparseable input", () => {
    const messages = [
      msg([tool({ id: "b1", name: "Bash", status: "running" }), tool({ id: "a1", status: "running", input: "{not json" })]),
    ];

    const tasks = deriveAgentTasks(messages, []);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ taskId: "a1", title: "Agent", description: "Agent" });
  });

  it("keeps a hook task whose agent is outside the loaded messages", () => {
    const hooks: BackgroundTask[] = [{ taskId: "s", toolUseId: "orphan", status: "completed", description: "older agent" }];
    expect(deriveAgentTasks([], hooks)).toEqual(hooks);
  });

  it("does not list one agent twice when it appears in several messages", () => {
    const messages = [
      msg([tool({ id: "t1", output: ASYNC_OUTPUT, input: JSON.stringify({ description: "d" }) })]),
      msg([tool({ id: "t1", output: ASYNC_OUTPUT, input: JSON.stringify({ description: "d" }) })]),
    ];
    expect(deriveAgentTasks(messages, [])).toHaveLength(1);
  });

  it("does not show a finished session's async agents as still running", () => {
    // Reopening an old transcript: the launches are recorded, the completions
    // never were, and the session is not working. Nothing is in flight.
    const messages = [
      msg([
        tool({ id: "t1", output: "Async agent launched successfully.\nagentId: aaa111", input: JSON.stringify({ description: "one" }) }),
        tool({ id: "t2", output: "Async agent launched successfully.\nagentId: bbb222", input: JSON.stringify({ description: "two" }) }),
      ]),
    ];

    expect(deriveAgentTasks(messages, [], false).every((t) => t.status === "completed")).toBe(true);
    expect(deriveAgentTasks(messages, [], true).every((t) => t.status === "running")).toBe(true);
  });

  it("truncates a long description so the panel stays readable", () => {
    const long = "x".repeat(500);
    const [task] = deriveAgentTasks([msg([tool({ id: "t1", status: "running", input: JSON.stringify({ prompt: long }) })])], []);
    expect(task.description).toHaveLength(201);
    expect(task.description.endsWith("…")).toBe(true);
  });
});
