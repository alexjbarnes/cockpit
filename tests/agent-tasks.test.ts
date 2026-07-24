// Shapes here mirror a real async agent launch captured from a live session:
// the Agent tool use completes immediately with "Async agent launched
// successfully ... agentId: ac6a880af087a5341" while the agent keeps running,
// and the CLI only reports it again on SubagentStop.
import { describe, expect, it } from "vitest";
import { agentIdFromOutput, deriveAgentTasks, isAsyncLaunchOutput } from "@/lib/agent-tasks";
import type { BackgroundTask, ChatMessage, ToolUse } from "@/types";

const ASYNC_OUTPUT =
  "Async agent launched successfully. (This tool result is internal metadata)\nagentId: ac6a880af087a5341 (internal ID - do not mention to user.";

function tool(partial: Partial<ToolUse> & { id: string }): ToolUse {
  return { name: "Agent", input: "{}", output: "", status: "done", ...partial };
}

function msg(tools: ToolUse[]): ChatMessage {
  return { id: `m-${tools.map((t) => t.id).join("-")}`, role: "assistant", content: "", toolUses: tools, blocks: [], timestamp: 0 };
}

describe("launch output helpers", () => {
  it("recognises a background launch and pulls the agent id out of it", () => {
    expect(isAsyncLaunchOutput(ASYNC_OUTPUT)).toBe(true);
    expect(agentIdFromOutput(ASYNC_OUTPUT)).toBe("ac6a880af087a5341");
  });

  it("treats a real agent result as ordinary output", () => {
    const result = "The file contains the text 'hello world'.";
    expect(isAsyncLaunchOutput(result)).toBe(false);
    expect(agentIdFromOutput(result)).toBeUndefined();
    expect(isAsyncLaunchOutput(undefined)).toBe(false);
  });
});

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

  it("marks an async agent completed from a stream task_notification keyed by the tool_use id", () => {
    // Stream mode (no hooks): the CLI's task_notification is keyed by the
    // launching tool_use id, not the runtime agent id the launch output
    // reports. The completion must still match, even mid-turn, or the agent
    // spins on the sessionActive fallback until the whole turn ends.
    const messages = [msg([tool({ id: "toolu_1", output: ASYNC_OUTPUT, input: JSON.stringify({ description: "d" }) })])];
    const streamCompletion: BackgroundTask[] = [
      { taskId: "toolu_1", toolUseId: "toolu_1", status: "completed", description: "Explore", summary: "done" },
    ];

    // sessionActive true: the parent turn is still working, exactly the case
    // in the report.
    const tasks = deriveAgentTasks(messages, streamCompletion, true);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ taskId: "ac6a880af087a5341", status: "completed" });
  });

  it("does not double-list an agent whose completion is keyed by the tool_use id", () => {
    const messages = [msg([tool({ id: "toolu_1", output: ASYNC_OUTPUT, input: JSON.stringify({ description: "d" }) })])];
    const hooks: BackgroundTask[] = [{ taskId: "toolu_1", toolUseId: "toolu_1", status: "completed", description: "Explore" }];
    expect(deriveAgentTasks(messages, hooks, true)).toHaveLength(1);
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

  it("keeps an agent the CLI still reports as running after the turn ended", () => {
    // The real sequence: Stop fires while the launched agent works on, and its
    // payload says so. An idle session must not override that.
    const messages = [msg([tool({ id: "t1", output: ASYNC_OUTPUT, input: JSON.stringify({ description: "d" }) })])];
    const hooks: BackgroundTask[] = [
      { taskId: "ac6a880af087a5341", toolUseId: "ac6a880af087a5341", status: "running", description: "read note" },
    ];

    expect(deriveAgentTasks(messages, hooks, false)[0].status).toBe("running");
  });

  it("truncates a long description so the panel stays readable", () => {
    const long = "x".repeat(500);
    const [task] = deriveAgentTasks([msg([tool({ id: "t1", status: "running", input: JSON.stringify({ prompt: long }) })])], []);
    expect(task.description).toHaveLength(201);
    expect(task.description.endsWith("…")).toBe(true);
  });
});
