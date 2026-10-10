// The agent transcript modal opens an agent from its card in the chat or its
// row in Background Tasks. These cover what it is handed in each case, when it
// counts the agent as working, and how it reads the transcript it fetches.
import { describe, expect, it } from "vitest";
import {
  agentFromTask,
  agentFromTool,
  agentRunning,
  agentTags,
  atLatest,
  sameTranscript,
  splitAgentTranscript,
} from "@/lib/agent-transcript";
import type { BackgroundTask, ChatMessage, ToolUse } from "@/types";

const ASYNC_OUTPUT =
  "Async agent launched successfully. (This tool result is internal metadata)\nagentId: ac6a880af087a5341 (internal ID - do not mention to user.";

function tool(partial: Partial<ToolUse> = {}): ToolUse {
  return { id: "toolu_1", name: "Agent", input: "{}", output: "", status: "done", ...partial };
}

function task(partial: Partial<BackgroundTask> = {}): BackgroundTask {
  return { taskId: "ac6a880af087a5341", toolUseId: "ac6a880af087a5341", status: "running", description: "Review the PR", ...partial };
}

function message(role: ChatMessage["role"], content: string, id = `${role}-${content.length}`): ChatMessage {
  return { id, role, content, toolUses: [], blocks: [], timestamp: 0 };
}

describe("agentFromTool", () => {
  it("takes the launch's details and both ids a background agent can be reported under", () => {
    const launch = tool({
      input: JSON.stringify({ description: "Review PR 605", prompt: "Review it hard", subagent_type: "reviewer", model: "opus" }),
      output: ASYNC_OUTPUT,
    });
    expect(agentFromTool(launch)).toEqual({
      id: "toolu_1",
      taskIds: ["ac6a880af087a5341", "toolu_1"],
      agentType: "reviewer",
      model: "opus",
      description: "Review PR 605",
      prompt: "Review it hard",
      tool: launch,
    });
  });

  it("has only the tool use id before the launch reports an agent id", () => {
    expect(agentFromTool(tool({ status: "running" })).taskIds).toEqual(["toolu_1"]);
  });

  it("leaves out what the input does not carry, however malformed", () => {
    for (const input of ["not json", "null", "3", JSON.stringify({ description: "  ", prompt: 7 })]) {
      const agent = agentFromTool(tool({ input }));
      expect(agent).toMatchObject({ agentType: undefined, model: undefined, description: undefined, prompt: undefined });
    }
  });
});

describe("agentFromTask", () => {
  it("looks the transcript up by the id the task list reports", () => {
    expect(agentFromTask(task({ title: "reviewer" }))).toEqual({
      id: "ac6a880af087a5341",
      taskIds: ["ac6a880af087a5341"],
      agentType: "reviewer",
      description: "Review the PR",
    });
  });

  it("shows no type when the list only knows it as an agent", () => {
    expect(agentFromTask(task({ title: "Agent" })).agentType).toBeUndefined();
    expect(agentFromTask(task()).agentType).toBeUndefined();
  });
});

describe("agentRunning", () => {
  const agent = agentFromTool(tool({ output: ASYNC_OUTPUT }));

  it("is running while the task list has it running under either id", () => {
    expect(agentRunning(agent, [task()])).toBe(true);
    expect(agentRunning(agent, [task({ toolUseId: "toolu_1" })])).toBe(true);
  });

  it("is not running once finished, or when the list does not have it", () => {
    expect(agentRunning(agent, [task({ status: "completed" })])).toBe(false);
    expect(agentRunning(agent, [task({ toolUseId: "someone-else" })])).toBe(false);
    expect(agentRunning(agent, [])).toBe(false);
  });
});

describe("splitAgentTranscript", () => {
  const prompt = "Review PR 605 and report every defect.";

  it("takes a first user message as the prompt when the launch did not say", () => {
    const work = message("assistant", "Found two defects.");
    expect(splitAgentTranscript([message("user", prompt), work])).toEqual({ prompt, work: [work] });
  });

  it("drops the transcript's copy of a prompt the launch already gave", () => {
    const work = message("assistant", "Found two defects.");
    expect(splitAgentTranscript([message("user", `${prompt}\n`), work], prompt)).toEqual({ prompt, work: [work] });
  });

  it("keeps a first message that is not the prompt", () => {
    const messages = [message("user", "Something else"), message("assistant", "Done.")];
    expect(splitAgentTranscript(messages, prompt)).toEqual({ prompt, work: messages });
    const fromAssistant = [message("assistant", "Done.")];
    expect(splitAgentTranscript(fromAssistant)).toEqual({ prompt: undefined, work: fromAssistant });
  });

  it("has no prompt for an empty transcript or a blank first message", () => {
    expect(splitAgentTranscript([])).toEqual({ prompt: undefined, work: [] });
    expect(splitAgentTranscript([], prompt)).toEqual({ prompt, work: [] });
    expect(splitAgentTranscript([message("user", "  ")]).prompt).toBeUndefined();
  });
});

describe("sameTranscript", () => {
  const first = message("user", "Prompt", "m1");
  const call = { ...message("assistant", "", "m2"), toolUses: [tool({ name: "Bash", status: "running" })] };

  it("is new when nothing was on screen or a message was added", () => {
    expect(sameTranscript(null, [first])).toBe(false);
    expect(sameTranscript([first], [first, call])).toBe(false);
  });

  it("is the same when a re-read finds nothing new", () => {
    expect(sameTranscript([first, call], [first, structuredClone(call)])).toBe(true);
  });

  it("is new when a tool's result lands on the last message", () => {
    const answered = { ...call, toolUses: [tool({ name: "Bash", status: "done", output: "ok" })] };
    expect(sameTranscript([first, call], [first, answered])).toBe(false);
  });
});

describe("atLatest", () => {
  it("counts the end, or near it, as reading the latest", () => {
    expect(atLatest({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(atLatest({ scrollTop: 560, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
  });

  it("does not once the reader has scrolled up", () => {
    expect(atLatest({ scrollTop: 300, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
  });
});

// The chips above the transcript: what the agent is running on. A launch names
// a model only when the caller overrode one, and the thinking level is recorded
// per turn by the CLI and nowhere else, so the transcript is the source.
describe("agentTags", () => {
  const launch = agentFromTool(tool({ input: JSON.stringify({ description: "Review", subagent_type: "reviewer" }), output: ASYNC_OUTPUT }));
  const said = (model: string, effort?: ChatMessage["effort"]): ChatMessage => ({
    ...message("assistant", "…"),
    model,
    effort,
  });

  it("names the model and level the agent's own transcript recorded", () => {
    expect(agentTags(launch, [said("claude-haiku-4-5-20251001", "max")])).toEqual(["reviewer", "claude-haiku-4-5-20251001", "Max"]);
  });

  it("falls back to the launch's model when the transcript has none yet", () => {
    const withModel = agentFromTool(tool({ input: JSON.stringify({ subagent_type: "reviewer", model: "opus" }), output: ASYNC_OUTPUT }));
    expect(agentTags(withModel, [])).toEqual(["reviewer", "opus"]);
  });

  it("prefers the transcript's model over the launch's, since the launch may have said inherit", () => {
    const withModel = agentFromTool(tool({ input: JSON.stringify({ model: "opus" }), output: ASYNC_OUTPUT }));
    expect(agentTags(withModel, [said("claude-haiku-4-5-20251001")])).toEqual(["claude-haiku-4-5-20251001"]);
  });

  // A level changed mid-run should read as the current one, not the first.
  it("reports the newest level and model in the transcript", () => {
    expect(agentTags(launch, [said("model-a", "high"), said("model-b", "xhigh")])).toEqual(["reviewer", "model-b", "XHigh"]);
  });

  it("leaves the level off for a transcript written before the CLI recorded one", () => {
    expect(agentTags(launch, [said("claude-haiku-4-5-20251001")])).toEqual(["reviewer", "claude-haiku-4-5-20251001"]);
  });

  it("shows nothing but the type for an agent with no transcript and no launch details", () => {
    expect(agentTags({ id: "toolu_1", taskIds: ["toolu_1"], agentType: "Explore" }, [])).toEqual(["Explore"]);
    expect(agentTags({ id: "toolu_1", taskIds: ["toolu_1"] }, [])).toEqual([]);
  });
});
