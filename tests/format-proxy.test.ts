// Translation engine + proxy server tests. Shapes mirror the live captures
// from the OpenRouter spike (docs/internal/or-fixtures): the OpenAI door's
// tool_calls response and the Anthropic door's equivalents.
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The proxy's only diagnostics are debug-log entries, and the real logger is
// gated on COCKPIT_DEBUG at module load. Capture the calls instead, so the
// instrumentation is proven to fire rather than merely to compile.
const { proxyLogs } = vi.hoisted(() => ({
  proxyLogs: [] as { providerId: string; label: string; data: Record<string, unknown> }[],
}));
vi.mock("@/server/debug-logger", () => ({
  logProxy: (providerId: string, label: string, data?: Record<string, unknown>) => {
    proxyLogs.push({ providerId, label, data: data ?? {} });
  },
}));

import {
  anthropicToOpenAIRequest,
  estimateInputTokens,
  FormatProxy,
  openAIToAnthropicResponse,
  StreamTranslator,
} from "@/server/format-proxy";

describe("anthropicToOpenAIRequest", () => {
  it("maps system, text turns, tools, and stream options", () => {
    const out = anthropicToOpenAIRequest({
      model: "opencode/gpt-5.5",
      max_tokens: 300,
      system: [{ type: "text", text: "You are terse." }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "get_weather", description: "d", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
      stream: true,
    });
    expect(out.model).toBe("opencode/gpt-5.5");
    expect(out.messages).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "hi" },
    ]);
    expect(out.tools).toEqual([{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object" } } }]);
    expect(out.tool_choice).toBe("auto");
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.max_tokens).toBe(300);
  });

  it("maps assistant tool_use and user tool_result into tool_calls / tool messages", () => {
    const out = anthropicToOpenAIRequest({
      model: "m",
      messages: [
        { role: "user", content: "What is the weather in Leeds?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Leeds" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "22C, sunny" },
            { type: "text", text: "thanks" },
          ],
        },
      ],
    });
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs[1]).toEqual({
      role: "assistant",
      content: "Checking.",
      tool_calls: [{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Leeds"}' } }],
    });
    // tool message must precede the trailing user text
    expect(msgs[2]).toEqual({ role: "tool", tool_call_id: "toolu_1", content: "22C, sunny" });
    expect(msgs[3]).toEqual({ role: "user", content: "thanks" });
  });

  it("maps base64 images to data-url image parts", () => {
    const out = anthropicToOpenAIRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            { type: "text", text: "what colour?" },
          ],
        },
      ],
    });
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "text", text: "what colour?" },
    ]);
  });

  it("maps tool_choice any and specific tool", () => {
    const base = { model: "m", messages: [] };
    expect(anthropicToOpenAIRequest({ ...base, tool_choice: { type: "any" } }).tool_choice).toBe("required");
    expect(anthropicToOpenAIRequest({ ...base, tool_choice: { type: "tool", name: "x" } }).tool_choice).toEqual({
      type: "function",
      function: { name: "x" },
    });
  });
});

describe("anthropicToOpenAIRequest reasoning round trip", () => {
  // The response direction turns an upstream reasoning_content into an
  // Anthropic thinking block, so the CLI replays that block in history. Not
  // sending it back broke every multi-turn zen session on
  // deepseek-v4-flash-free with HTTP 400 "The `reasoning_content` in the
  // thinking mode must be passed back to the API".
  it("sends an assistant turn's thinking block back as reasoning_content", () => {
    const out = anthropicToOpenAIRequest({
      model: "deepseek-v4-flash-free",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "The user says hi.", signature: "" },
            { type: "text", text: "Hello." },
          ],
        },
        { role: "user", content: "again" },
      ],
    } as never);
    const assistant = (out.messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant");
    expect(assistant?.reasoning_content).toBe("The user says hi.");
    expect(assistant?.content).toBe("Hello.");
  });

  it("joins multiple thinking blocks in order", () => {
    const out = anthropicToOpenAIRequest({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "first" },
            { type: "thinking", thinking: "second" },
          ],
        },
      ],
    } as never);
    const assistant = (out.messages as Array<Record<string, unknown>>)[0];
    expect(assistant.reasoning_content).toBe("first\nsecond");
  });

  it("keeps thinking alongside tool_calls, the shape that actually failed", () => {
    const out = anthropicToOpenAIRequest({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should read the file." },
            { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } },
          ],
        },
      ],
    } as never);
    const assistant = (out.messages as Array<Record<string, unknown>>)[0];
    expect(assistant.reasoning_content).toBe("I should read the file.");
    expect((assistant.tool_calls as unknown[]).length).toBe(1);
  });

  it("omits the field entirely for an assistant turn with no thinking, so non-reasoning upstreams never see it", () => {
    const out = anthropicToOpenAIRequest({
      model: "m",
      messages: [{ role: "assistant", content: [{ type: "text", text: "plain" }] }],
    } as never);
    const assistant = (out.messages as Array<Record<string, unknown>>)[0];
    expect("reasoning_content" in assistant).toBe(false);
  });

  it("omits the field when a thinking block is present but empty", () => {
    const out = anthropicToOpenAIRequest({
      model: "m",
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "" }] }],
    } as never);
    expect("reasoning_content" in (out.messages as Array<Record<string, unknown>>)[0]).toBe(false);
  });
});

describe("anthropicToOpenAIRequest reasoning placeholder in thinking mode", () => {
  // Measured against the live upstream: in thinking mode DeepSeek accepts an
  // assistant turn with tool_calls alone, but refuses one with BOTH content
  // and tool_calls unless reasoning_content is present — an empty string is
  // enough. Not every assistant turn reasons, so this shape appears
  // constantly in a long session and was killing turns even after thinking
  // blocks were being sent back.
  const toolUse = { type: "tool_use", id: "t1", name: "w", input: {} };

  it("adds an empty reasoning_content to a text+tool_calls turn that did no thinking", () => {
    const out = anthropicToOpenAIRequest(
      {
        model: "m",
        thinking: { type: "enabled", budget_tokens: 10000 },
        messages: [{ role: "assistant", content: [{ type: "text", text: "Checking." }, toolUse] }],
      } as never,
      { effortLevels: ["high", "max"] },
    );
    const assistant = (out.messages as Array<Record<string, unknown>>)[0];
    expect(out.reasoning_effort).toBeTruthy();
    expect(assistant.reasoning_content).toBe("");
  });

  it("leaves a real thinking block's text alone rather than blanking it", () => {
    const out = anthropicToOpenAIRequest(
      {
        model: "m",
        thinking: { type: "enabled", budget_tokens: 10000 },
        messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "because" }, toolUse] }],
      } as never,
      { effortLevels: ["high", "max"] },
    );
    expect((out.messages as Array<Record<string, unknown>>)[0].reasoning_content).toBe("because");
  });

  it("does not add the field when the request is not in thinking mode", () => {
    const out = anthropicToOpenAIRequest(
      {
        model: "m",
        thinking: { type: "enabled", budget_tokens: 10000 },
        messages: [{ role: "assistant", content: [{ type: "text", text: "Checking." }, toolUse] }],
      } as never,
      {}, // no effortLevels => no reasoning_effort => not thinking mode
    );
    expect(out.reasoning_effort).toBeUndefined();
    expect("reasoning_content" in (out.messages as Array<Record<string, unknown>>)[0]).toBe(false);
  });

  it("does not add the field to an assistant turn with no tool calls", () => {
    const out = anthropicToOpenAIRequest(
      {
        model: "m",
        thinking: { type: "enabled", budget_tokens: 10000 },
        messages: [{ role: "assistant", content: [{ type: "text", text: "Just talking." }] }],
      } as never,
      { effortLevels: ["high", "max"] },
    );
    expect("reasoning_content" in (out.messages as Array<Record<string, unknown>>)[0]).toBe(false);
  });
});

describe("openAIToAnthropicResponse", () => {
  it("maps a tool_calls response (live capture shape)", () => {
    const out = openAIToAnthropicResponse({
      id: "gen-1",
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      choices: [
        {
          message: { content: null, tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: '{"city":"Leeds"}' } }] },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 24, completion_tokens: 64 },
    });
    expect(out.stop_reason).toBe("tool_use");
    expect(out.content).toEqual([{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Leeds" } }]);
    expect(out.usage).toEqual({ input_tokens: 24, output_tokens: 64, cache_read_input_tokens: 0 });
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
  });

  it("maps text responses and finish reasons, tolerating broken tool args", () => {
    const out = openAIToAnthropicResponse({
      choices: [
        { message: { content: "hi", tool_calls: [{ id: "c", function: { name: "t", arguments: "{broken" } }] }, finish_reason: "length" },
      ],
    });
    expect(out.stop_reason).toBe("max_tokens");
    const content = out.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "hi" });
    expect(content[1]).toMatchObject({ type: "tool_use", input: { __raw: "{broken" } });
  });
});

function sse(events: string[]): string {
  return events.map((e) => `data: ${e}\n`).join("\n") + "\n";
}

function parseAnthropicSSE(out: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of out.split("\n\n")) {
    const ev = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
  }
  return events;
}

describe("StreamTranslator", () => {
  it("translates a text stream into the Anthropic event vocabulary", () => {
    const t = new StreamTranslator();
    const out = t.feed(
      sse([
        '{"id":"c1","model":"m","choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
        '{"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}',
        '{"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
        "[DONE]",
      ]),
    );
    const events = parseAnthropicSSE(out);
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const deltas = events.filter((e) => e.event === "content_block_delta").map((e) => (e.data.delta as { text: string }).text);
    expect(deltas.join("")).toBe("Hello");
    const md = events.find((e) => e.event === "message_delta")?.data as {
      delta: { stop_reason: string };
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(md.delta.stop_reason).toBe("end_turn");
    expect(md.usage.output_tokens).toBe(5);
    // prompt_tokens must surface as input_tokens here — message_start already
    // shipped with zeros before the upstream reported usage. Dropping it means
    // a zeroed context gauge and no indicator in the UI.
    expect(md.usage.input_tokens).toBe(10);
  });

  it("translates tool-call deltas into tool_use blocks with input_json_delta", () => {
    const t = new StreamTranslator();
    const out = t.feed(
      sse([
        '{"id":"c1","choices":[{"delta":{"content":"Checking."},"finish_reason":null}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]},"finish_reason":null}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Leeds\\"}"}}]},"finish_reason":null}]}',
        '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        "[DONE]",
      ]),
    );
    const events = parseAnthropicSSE(out);
    const starts = events.filter((e) => e.event === "content_block_start");
    expect(starts).toHaveLength(2);
    expect((starts[0].data.content_block as { type: string }).type).toBe("text");
    expect(starts[1].data.content_block).toEqual({ type: "tool_use", id: "call_9", name: "get_weather", input: {} });
    const jsonDeltas = events
      .filter((e) => e.event === "content_block_delta" && (e.data.delta as { type: string }).type === "input_json_delta")
      .map((e) => (e.data.delta as { partial_json: string }).partial_json);
    expect(jsonDeltas.join("")).toBe('{"city":"Leeds"}');
    const messageDelta = events.find((e) => e.event === "message_delta")?.data.delta as { stop_reason: string } | undefined;
    expect(messageDelta?.stop_reason).toBe("tool_use");
    expect(events.filter((e) => e.event === "content_block_stop")).toHaveLength(2);
  });

  it("maps reasoning deltas to a thinking block before the answer text", () => {
    const t = new StreamTranslator();
    const out = t.feed(
      sse([
        '{"id":"c1","model":"m","choices":[{"delta":{"reasoning_content":"pondering"},"finish_reason":null}]}',
        '{"choices":[{"delta":{"reasoning_content":" deeply"},"finish_reason":null}]}',
        '{"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}',
        "[DONE]",
      ]),
    );
    const events = parseAnthropicSSE(out);
    const starts = events.filter((e) => e.event === "content_block_start");
    expect((starts[0].data.content_block as { type: string }).type).toBe("thinking");
    expect((starts[1].data.content_block as { type: string }).type).toBe("text");
    const thinkingDeltas = events
      .filter((e) => e.event === "content_block_delta" && (e.data.delta as { type: string }).type === "thinking_delta")
      .map((e) => (e.data.delta as { thinking: string }).thinking);
    expect(thinkingDeltas.join("")).toBe("pondering deeply");
    expect(events.filter((e) => e.event === "content_block_stop")).toHaveLength(2);
  });

  it("buffers lines split across feeds", () => {
    const t = new StreamTranslator();
    const full = sse(['{"id":"c1","choices":[{"delta":{"content":"AB"},"finish_reason":null}]}', "[DONE]"]);
    let out = "";
    for (const ch of full) out += t.feed(ch);
    const deltas = parseAnthropicSSE(out).filter((e) => e.event === "content_block_delta");
    expect(deltas).toHaveLength(1);
  });
});

// Caching on the translated providers is automatic prefix caching, so the only
// thing cockpit can do about it is report it. Before this, the proxy read
// prompt_tokens and completion_tokens and nothing else, so cache_read_input_tokens
// was absent on every proxied response — which is what the session token report
// and the context gauge read, so a proxied session showed zero cache forever
// whatever the upstream actually served.
describe("prompt-cache reporting through the proxy", () => {
  it("splits an OpenAI-style cached_tokens out of input_tokens", () => {
    const out = openAIToAnthropicResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } },
    });
    // Anthropic's input_tokens excludes cache reads; prompt_tokens includes
    // them. Reporting both in full would double-count 900 tokens in every
    // consumer that sums the three fields.
    expect(out.usage).toEqual({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 });
  });

  it("reads DeepSeek's own cache field names", () => {
    const out = openAIToAnthropicResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 500, completion_tokens: 5, prompt_cache_hit_tokens: 448, prompt_cache_miss_tokens: 52 },
    });
    expect(out.usage).toEqual({ input_tokens: 52, output_tokens: 5, cache_read_input_tokens: 448 });
  });

  it("reports zero cache rather than negative input when the upstream is inconsistent", () => {
    const out = openAIToAnthropicResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 400 } },
    });
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 10 });
  });

  it("carries the cache read through the streaming path's message_delta", () => {
    const t = new StreamTranslator();
    const out = t.feed(
      sse([
        '{"id":"c1","model":"m","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '{"choices":[],"usage":{"prompt_tokens":800,"completion_tokens":4,"prompt_cache_hit_tokens":768}}',
        "[DONE]",
      ]),
    );
    const events = parseAnthropicSSE(out);
    const md = events.find((e) => e.event === "message_delta")?.data as {
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
    };
    expect(md.usage).toEqual({ input_tokens: 32, output_tokens: 4, cache_read_input_tokens: 768 });
  });
});

describe("openAIToAnthropicResponse reasoning", () => {
  it("surfaces reasoning_content as a thinking block ahead of the text", () => {
    const out = openAIToAnthropicResponse({
      choices: [{ message: { content: "ok", reasoning_content: "chain of thought" }, finish_reason: "stop" }],
    });
    const content = out.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: "thinking", thinking: "chain of thought" });
    expect(content[1]).toEqual({ type: "text", text: "ok" });
  });
});

describe("FormatProxy server", () => {
  let proxy: FormatProxy | null = null;
  let upstream: Server | null = null;

  afterEach(async () => {
    await proxy?.stop();
    proxy = null;
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    upstream = null;
  });

  async function startUpstream(handler: (body: string, res: import("node:http").ServerResponse) => void): Promise<number> {
    upstream = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => {
        data += c;
      });
      req.on("end", () => handler(data, res));
    });
    await new Promise<void>((r) => upstream?.listen(0, "127.0.0.1", () => r()));
    const addr = upstream?.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  it("serves the provider catalog on the models probe and stubs count_tokens", async () => {
    proxy = new FormatProxy(() => ({ baseUrl: "http://127.0.0.1:1", apiKey: "k", modelIds: ["opencode/gpt-5.5"] }));
    await proxy.start();
    const models = await (await fetch(`${proxy.getUrl("zen")}/v1/models`)).json();
    expect(models.data).toEqual([{ id: "opencode/gpt-5.5", type: "model", display_name: "opencode/gpt-5.5" }]);
    const count = await (await fetch(`${proxy.getUrl("zen")}/v1/messages/count_tokens`, { method: "POST", body: "{}" })).json();
    expect(count).toEqual({ input_tokens: 0 });
  });

  it("answers the model-metadata probes locally in passthrough mode instead of relaying them", async () => {
    // OpenRouter's Anthropic door 404s count_tokens and single-model lookups
    // (verified live). The CLI reports ANY 404 as "the selected model may not
    // exist", so relaying them turns a valid model into a phantom error.
    let upstreamHits = 0;
    const port = await startUpstream((_body, res) => {
      upstreamHits += 1;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not Found", code: 404 } }));
    });
    const modelId = "nvidia/nemotron-3-ultra-550b-a55b:free";
    proxy = new FormatProxy(() => ({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "k",
      wireFormat: "anthropic",
      modelIds: [modelId],
    }));
    await proxy.start();

    // A slash- and colon-bearing id survives the path round trip.
    const single = await fetch(`${proxy.getUrl("openrouter")}/v1/models/${modelId}`);
    expect(single.status).toBe(200);
    expect(await single.json()).toEqual({ type: "model", id: modelId, display_name: modelId });

    const count = await fetch(`${proxy.getUrl("openrouter")}/v1/messages/count_tokens`, {
      method: "POST",
      body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "12345678" }] }),
    });
    expect(count.status).toBe(200);
    // 8 chars of prompt ≈ 2 tokens; the model id is excluded from the count.
    expect(await count.json()).toEqual({ input_tokens: 2 });

    const list = await fetch(`${proxy.getUrl("openrouter")}/v1/models`);
    expect((await list.json()).data).toEqual([{ type: "model", id: modelId, display_name: modelId }]);

    // None of it reached the upstream that would have 404'd.
    expect(upstreamHits).toBe(0);
  });

  it("404s a single-model lookup only when the id really is absent", async () => {
    proxy = new FormatProxy(() => ({ baseUrl: "http://127.0.0.1:1", apiKey: "k", wireFormat: "anthropic", modelIds: ["vendor/real"] }));
    await proxy.start();
    const res = await fetch(`${proxy.getUrl("openrouter")}/v1/models/vendor%2Fghost`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toContain("vendor/ghost");
  });

  it("404s unknown providers with an anthropic-shaped error", async () => {
    proxy = new FormatProxy(() => null);
    await proxy.start();
    const res = await fetch(`${proxy.getUrl("nope")}/v1/messages`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect((await res.json()).type).toBe("error");
  });

  it("translates a non-stream round trip and injects the upstream key", async () => {
    let seenAuth = "";
    let seenBody = "";
    const port = await startUpstream((body, res) => {
      seenBody = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "gen-1",
          model: "opencode/gpt-5.5",
          choices: [{ message: { content: "hello from zen" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        }),
      );
    });
    upstream?.on("request", (req) => {
      seenAuth = String(req.headers.authorization ?? "");
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "zen-key-1", modelIds: [] }));
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("zen")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opencode/gpt-5.5", max_tokens: 50, messages: [{ role: "user", content: "hi" }] }),
    });
    const body = await res.json();
    expect(body.type).toBe("message");
    expect(body.content).toEqual([{ type: "text", text: "hello from zen" }]);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage).toEqual({ input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0 });
    expect(seenAuth).toBe("Bearer zen-key-1");
    expect(JSON.parse(seenBody).messages).toEqual([{ role: "user", content: "hi" }]);
  });

  // Cache hit rate was unanswerable from the logs: "complete" carried only
  // input/output tokens, so there was no way to tell a session serving most of
  // its prompt from cache from one missing every time.
  it("logs the cache hit rate on completion", async () => {
    const port = await startUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "gen-1",
          model: "deepseek-v4-flash",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1000, completion_tokens: 8, prompt_cache_hit_tokens: 750, prompt_cache_miss_tokens: 250 },
        }),
      );
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", modelIds: [] }));
    await proxy.start();
    proxyLogs.length = 0;

    await fetch(`${proxy.getUrl("zen-go")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 50, messages: [{ role: "user", content: "hi" }] }),
    });

    const complete = proxyLogs.find((l) => l.label === "complete");
    expect(complete?.data).toMatchObject({ cachedInputTokens: 750, cacheMissTokens: 250, cacheHitRatio: 0.75 });
  });

  it("translates a streaming round trip end to end", async () => {
    const port = await startUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"id":"c1","model":"m","choices":[{"delta":{"content":"str"},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"eam"},"finish_reason":"stop"}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", modelIds: [] }));
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("zen")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const events = parseAnthropicSSE(text);
    expect(events[0].event).toBe("message_start");
    const deltas = events.filter((e) => e.event === "content_block_delta").map((e) => (e.data.delta as { text: string }).text);
    expect(deltas.join("")).toBe("stream");
    expect(events.at(-1)?.event).toBe("message_stop");
  });

  it("passthrough mode relays anthropic wire verbatim and forwards client auth", async () => {
    let seenBody = "";
    let seenAuth = "";
    let seenPath = "";
    const port = await startUpstream((body, res) => {
      seenBody = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "direct" }] }));
    });
    upstream?.on("request", (req) => {
      seenAuth = String(req.headers.authorization ?? "");
      seenPath = String(req.url ?? "");
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "stored-key", wireFormat: "anthropic", modelIds: [] }));
    await proxy.start();

    const anthropicBody = JSON.stringify({ model: "vendor/x:free", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    const res = await fetch(`${proxy.getUrl("openrouter")}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer client-key" },
      body: anthropicBody,
    });
    const body = await res.json();
    expect(body.content).toEqual([{ type: "text", text: "direct" }]);
    // verbatim body, client auth wins, query string preserved
    expect(seenBody).toBe(anthropicBody);
    expect(seenAuth).toBe("Bearer client-key");
    expect(seenPath).toBe("/v1/messages?beta=true");
  });

  it("passthrough injects the stored key only when the client sent no auth", async () => {
    let seenAuth = "";
    const port = await startUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    upstream?.on("request", (req) => {
      seenAuth = String(req.headers.authorization ?? "");
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "stored-key", wireFormat: "anthropic", modelIds: [] }));
    await proxy.start();

    // A relayed path (the model-metadata probes are answered locally now).
    await fetch(`${proxy.getUrl("openrouter")}/v1/messages`, { method: "POST", body: "{}" });
    expect(seenAuth).toBe("Bearer stored-key");
  });

  it("retries saturation-class failures with backoff, then succeeds", async () => {
    let calls = 0;
    const port = await startUpstream((_body, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "temporarily rate-limited upstream" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "after retry" }] }));
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", wireFormat: "anthropic", modelIds: [] }), {
      retryBackoffMs: [10, 10],
    });
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("openrouter")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 5, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).content).toEqual([{ type: "text", text: "after retry" }]);
    expect(calls).toBe(2);
  });

  it("retries a 200 that wraps an SSE error (free-model saturation), then streams the retry", async () => {
    // OpenRouter's free tier signals upstream saturation as HTTP 200 with an
    // `event: error` body instead of a 429 (verified live), which the CLI then
    // reports as a malformed proxy response.
    let calls = 0;
    const port = await startUpstream((_body, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Upstream error from Nvidia: ResourceExhausted","error_type":"provider_unavailable"}}\n\n',
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", wireFormat: "anthropic", modelIds: [] }), {
      retryBackoffMs: [10, 10],
    });
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("openrouter")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 5, stream: true, messages: [] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The good retry streamed through intact, first chunk included, and the
    // error body from attempt 1 is gone.
    expect(text).toContain("message_start");
    expect(text).toContain("message_stop");
    expect(text).not.toContain("ResourceExhausted");
    expect(calls).toBe(2);
  });

  it("retries an empty 200 then serves the retry", async () => {
    let calls = 0;
    const port = await startUpstream((_body, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "recovered" }] }));
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", wireFormat: "anthropic", modelIds: [] }), {
      retryBackoffMs: [10],
    });
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("openrouter")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 5, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).content).toEqual([{ type: "text", text: "recovered" }]);
    expect(calls).toBe(2);
  });

  it("surfaces an exhausted 200-wrapped saturation as an overloaded error, not the raw body", async () => {
    let calls = 0;
    const port = await startUpstream((_body, res) => {
      calls += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        'event: error\ndata: {"error":{"message":"Worker local total request limit reached","error_type":"provider_unavailable"}}\n\n',
      );
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", wireFormat: "anthropic", modelIds: [] }), {
      retryBackoffMs: [10, 10],
    });
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("openrouter")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 5, messages: [] }),
    });
    expect(res.status).toBe(529);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.message).toBe("Worker local total request limit reached");
    expect(calls).toBe(3);
  });

  it("passes a normal streaming 200 straight through without delay or a dropped chunk", async () => {
    let calls = 0;
    const port = await startUpstream((_body, res) => {
      calls += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", wireFormat: "anthropic", modelIds: [] }), {
      retryBackoffMs: [10, 10],
    });
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("openrouter")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 5, stream: true, messages: [] }),
    });
    const text = await res.text();
    expect(calls).toBe(1);
    // The peeked first chunk is written exactly once, not dropped or doubled.
    expect(text).toBe('event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  });

  it("gives up after the retry budget and relays the final 429", async () => {
    let calls = 0;
    const port = await startUpstream((_body, res) => {
      calls += 1;
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "still saturated" } }));
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", wireFormat: "anthropic", modelIds: [] }), {
      retryBackoffMs: [10, 10],
    });
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("openrouter")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 5, messages: [] }),
    });
    expect(res.status).toBe(429);
    expect(calls).toBe(3);
  });

  it("retries the translated openai upstream call too", async () => {
    let calls = 0;
    const port = await startUpstream((_body, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "zen after retry" }, finish_reason: "stop" }] }));
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", modelIds: [] }), { retryBackoffMs: [10] });
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("zen")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).content).toEqual([{ type: "text", text: "zen after retry" }]);
    expect(calls).toBe(2);
  });

  it("remaps zen's non-auth 401s so the CLI never demands /login", async () => {
    const port = await startUpstream((_body, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "ModelError", message: "Model x is not supported" } }));
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", modelIds: [] }), { retryBackoffMs: [10] });
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("zen")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x", max_tokens: 5, messages: [] }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe("Model x is not supported");
  });

  it("passes genuine AuthError 401s through untouched", async () => {
    const port = await startUpstream((_body, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "AuthError", message: "Invalid API key." } }));
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", modelIds: [] }), { retryBackoffMs: [10] });
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("zen")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x", max_tokens: 5, messages: [] }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe("Invalid API key.");
  });

  it("retries 401 no-provider-available responses, then succeeds", async () => {
    let calls = 0;
    const port = await startUpstream((_body, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "ProviderError", message: "No provider available" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "routed" }, finish_reason: "stop" }] }));
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", modelIds: [] }), { retryBackoffMs: [10] });
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("zen")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x", max_tokens: 5, messages: [] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).content).toEqual([{ type: "text", text: "routed" }]);
    expect(calls).toBe(2);
  });

  it("surfaces exhausted no-provider retries as 503, not 401", async () => {
    let calls = 0;
    const port = await startUpstream((_body, res) => {
      calls += 1;
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "ProviderError", message: "No provider available" } }));
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", modelIds: [] }), { retryBackoffMs: [10] });
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("zen")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x", max_tokens: 5, messages: [] }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe("No provider available");
    expect(calls).toBe(2);
  });

  it("translates upstream errors into anthropic error shape with the same status", async () => {
    const port = await startUpstream((_body, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited upstream" } }));
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", modelIds: [] }));
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("zen")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 10, messages: [] }),
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.message).toBe("rate limited upstream");
  });

  it("reports non-stream usage to onUsage with provider and model ids", async () => {
    const events: Array<{ providerId: string; modelId: string; inputTokens: number; outputTokens: number }> = [];
    const port = await startUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        }),
      );
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", modelIds: [] }), {
      onUsage: (u) => events.push(u),
    });
    await proxy.start();

    await fetch(`${proxy.getUrl("zen")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opencode/gpt-5.5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(events).toEqual([{ providerId: "zen", modelId: "opencode/gpt-5.5", inputTokens: 12, outputTokens: 7 }]);
  });

  it("reports stream usage from the final include_usage chunk", async () => {
    const events: Array<{ providerId: string; modelId: string; inputTokens: number; outputTokens: number }> = [];
    const port = await startUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        sse([
          '{"id":"c1","choices":[{"delta":{"content":"hey"},"finish_reason":null}]}',
          '{"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}]}',
          '{"id":"c1","choices":[],"usage":{"prompt_tokens":40,"completion_tokens":9}}',
          "[DONE]",
        ]),
      );
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", modelIds: [] }), {
      onUsage: (u) => events.push(u),
    });
    await proxy.start();

    const res = await fetch(`${proxy.getUrl("zen")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m1", max_tokens: 5, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    await res.text();
    expect(events).toEqual([{ providerId: "zen", modelId: "m1", inputTokens: 40, outputTokens: 9 }]);
  });
});

describe("FormatProxy inbound auth", () => {
  let proxy: FormatProxy | null = null;
  let upstream: Server | null = null;

  beforeEach(() => {
    proxyLogs.length = 0;
  });

  afterEach(async () => {
    await proxy?.stop();
    proxy = null;
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    upstream = null;
  });

  it("embeds a per-instance token in the base URL", async () => {
    const a = new FormatProxy(() => null);
    const b = new FormatProxy(() => null);
    await a.start();
    await b.start();
    try {
      const tokenOf = (p: FormatProxy) => new URL(p.getUrl("zen")).pathname.split("/")[1];
      expect(tokenOf(a)).toMatch(/^[0-9a-f]{48}$/);
      expect(tokenOf(a)).not.toBe(tokenOf(b));
      expect(new URL(a.getUrl("zen")).pathname).toBe(`/${tokenOf(a)}/zen`);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("rejects a request that omits the token, without reaching the upstream", async () => {
    let upstreamHits = 0;
    upstream = createServer((_req, res) => {
      upstreamHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => upstream?.listen(0, "127.0.0.1", () => r()));
    const addr = upstream?.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "secret-key", modelIds: [] }));
    await proxy.start();

    // The pre-auth URL shape: no token segment at all.
    const base = new URL(proxy.getUrl("zen"));
    const res = await fetch(`${base.origin}/zen/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 5, messages: [] }),
    });

    expect(res.status).toBe(401);
    // The point of the gate: no upstream call, so no credits spent.
    expect(upstreamHits).toBe(0);
    const body = await res.json();
    expect(body.error.message).toBe("Unauthorized");
  });

  it("rejects a wrong token and never echoes the offered one", async () => {
    proxy = new FormatProxy(() => ({ baseUrl: "http://127.0.0.1:1", apiKey: "k", modelIds: [] }));
    await proxy.start();
    const base = new URL(proxy.getUrl("zen"));
    const res = await fetch(`${base.origin}/${"f".repeat(48)}/zen/v1/models`);

    expect(res.status).toBe(401);
    const logged = proxyLogs.find((l) => l.label === "unauthorized");
    expect(logged).toBeDefined();
    expect(JSON.stringify(proxyLogs)).not.toContain("f".repeat(48));
  });

  it("still serves every route once the token is right", async () => {
    proxy = new FormatProxy(() => ({ baseUrl: "http://127.0.0.1:1", apiKey: "k", modelIds: ["opencode/gpt-5.5"] }));
    await proxy.start();
    const models = await fetch(`${proxy.getUrl("zen")}/v1/models`);
    expect(models.status).toBe(200);
    expect((await models.json()).data).toHaveLength(1);
  });
});

describe("FormatProxy debug logging", () => {
  let proxy: FormatProxy | null = null;
  let upstream: Server | null = null;

  // Earlier describes in this file drive the proxy too, so reset before each
  // test rather than after: otherwise the first test here sees their entries.
  beforeEach(() => {
    proxyLogs.length = 0;
  });

  afterEach(async () => {
    await proxy?.stop();
    proxy = null;
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    upstream = null;
  });

  async function startUpstream(handler: (body: string, res: import("node:http").ServerResponse) => void): Promise<number> {
    upstream = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => {
        data += c;
      });
      req.on("end", () => handler(data, res));
    });
    await new Promise<void>((r) => upstream?.listen(0, "127.0.0.1", () => r()));
    const addr = upstream?.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  const labels = () => proxyLogs.map((l) => l.label);
  const entry = (label: string) => proxyLogs.find((l) => l.label === label);

  it("records the whole 200-wrapped saturation loop, peek included", async () => {
    const port = await startUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('event: error\ndata: {"error":{"message":"Worker local total request limit reached"}}\n\n');
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", wireFormat: "anthropic", modelIds: [] }), {
      retryBackoffMs: [10, 10],
    });
    await proxy.start();
    await fetch(`${proxy.getUrl("openrouter")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 5, messages: [] }),
    });

    expect(labels()).toContain("listening");
    expect(labels()).toContain("request");
    // One per attempt: the initial call plus both retries.
    expect(labels().filter((l) => l === "saturation-200")).toHaveLength(3);
    expect(labels()).toContain("saturation-exhausted");

    expect(entry("request")?.providerId).toBe("openrouter");
    expect(entry("request")?.data.wireFormat).toBe("anthropic");
    // The peek is the evidence for the retry decision, so it is logged verbatim.
    expect(String(entry("saturation-exhausted")?.data.peek)).toContain("Worker local total request limit reached");
    expect(entry("saturation-exhausted")?.data.status).toBe(529);
  });

  it("records an upstream error with both the real and the remapped status", async () => {
    const port = await startUpstream((_body, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "No provider available", type: "ProviderError" } }));
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", modelIds: [] }), { retryBackoffMs: [] });
    await proxy.start();
    await fetch(`${proxy.getUrl("zen")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opencode/gpt-5.5", max_tokens: 5, messages: [], stream: false }),
    });

    expect(entry("translate")?.data.model).toBe("opencode/gpt-5.5");
    expect(entry("translate")?.data.stream).toBe(false);

    const err = entry("upstream-error");
    expect(err?.data.upstreamStatus).toBe(401);
    // Zen's non-auth 401 is remapped so the CLI stops demanding /login. Both
    // numbers are logged, since the remap is exactly what hides the original.
    expect(err?.data.sentStatus).toBe(503);
    expect(err?.data.remapped).toBe(true);
    expect(err?.data.message).toBe("No provider available");
  });

  it("records a completed translated turn with its token counts", async () => {
    const port = await startUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      );
    });
    proxy = new FormatProxy(() => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", modelIds: [] }));
    await proxy.start();
    await fetch(`${proxy.getUrl("zen")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", max_tokens: 5, messages: [], stream: false }),
    });

    const done = entry("complete");
    expect(done?.data.inputTokens).toBe(11);
    expect(done?.data.outputTokens).toBe(7);
    expect(done?.data.finishReason).toBe("stop");
  });

  it("records an unknown provider rather than failing silently", async () => {
    proxy = new FormatProxy(() => null);
    await proxy.start();
    const res = await fetch(`${proxy.getUrl("nope")}/v1/messages`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(entry("unknown-provider")?.providerId).toBe("nope");
    expect(entry("request")?.data.resolved).toBe(false);
  });
});

describe("estimateInputTokens", () => {
  it("counts prompt text across nested blocks and ignores structural fields", () => {
    const body = JSON.stringify({
      model: "some/very-long-model-id-that-should-not-count:free",
      system: [{ type: "text", text: "abcd" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "efgh" }] },
        { role: "assistant", content: "ijkl" },
      ],
    });
    // 12 prompt chars ≈ 3 tokens; model/type/role contribute nothing.
    expect(estimateInputTokens(body)).toBe(3);
  });

  it("returns 0 for an empty request and falls back to raw length on broken JSON", () => {
    expect(estimateInputTokens("{}")).toBe(0);
    expect(estimateInputTokens("not json at all")).toBe(Math.ceil("not json at all".length / 4));
  });
});

describe("reasoning effort mapping", () => {
  const base = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };

  it("maps thinking budgets onto the model's supported effort ladder", () => {
    const levels = { effortLevels: ["low", "medium", "high"] };
    expect(anthropicToOpenAIRequest({ ...base, thinking: { type: "enabled", budget_tokens: 4000 } }, levels).reasoning_effort).toBe("low");
    expect(anthropicToOpenAIRequest({ ...base, thinking: { type: "enabled", budget_tokens: 12000 } }, levels).reasoning_effort).toBe(
      "medium",
    );
    expect(anthropicToOpenAIRequest({ ...base, thinking: { type: "enabled", budget_tokens: 31999 } }, levels).reasoning_effort).toBe(
      "high",
    );
    // Above the ladder clamps down to the strongest supported level.
    expect(anthropicToOpenAIRequest({ ...base, thinking: { type: "enabled", budget_tokens: 500_000 } }, levels).reasoning_effort).toBe(
      "high",
    );
  });

  it("clamps up to the nearest supported level (deepseek-style high/max)", () => {
    const levels = { effortLevels: ["high", "max"] };
    expect(anthropicToOpenAIRequest({ ...base, thinking: { type: "enabled", budget_tokens: 4000 } }, levels).reasoning_effort).toBe("high");
    expect(anthropicToOpenAIRequest({ ...base, thinking: { type: "enabled", budget_tokens: 100_000 } }, levels).reasoning_effort).toBe(
      "max",
    );
  });

  it("passes output_config.effort through and maps adaptive thinking to high", () => {
    expect(
      anthropicToOpenAIRequest({ ...base, output_config: { effort: "max" } }, { effortLevels: ["high", "max"] }).reasoning_effort,
    ).toBe("max");
    expect(
      anthropicToOpenAIRequest({ ...base, thinking: { type: "adaptive" } }, { effortLevels: ["low", "medium", "high"] }).reasoning_effort,
    ).toBe("high");
  });

  it("omits reasoning_effort without declared levels or without a thinking request", () => {
    expect(anthropicToOpenAIRequest({ ...base, thinking: { type: "enabled", budget_tokens: 4000 } })).not.toHaveProperty(
      "reasoning_effort",
    );
    expect(
      anthropicToOpenAIRequest({ ...base, thinking: { type: "enabled", budget_tokens: 4000 } }, { effortLevels: ["bogus"] }),
    ).not.toHaveProperty("reasoning_effort");
    expect(anthropicToOpenAIRequest(base, { effortLevels: ["high"] })).not.toHaveProperty("reasoning_effort");
  });
});
