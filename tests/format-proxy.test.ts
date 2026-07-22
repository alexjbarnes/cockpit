// Translation engine + proxy server tests. Shapes mirror the live captures
// from the OpenRouter spike (docs/internal/or-fixtures): the OpenAI door's
// tool_calls response and the Anthropic door's equivalents.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { anthropicToOpenAIRequest, FormatProxy, openAIToAnthropicResponse, StreamTranslator } from "@/server/format-proxy";

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
    expect(out.usage).toEqual({ input_tokens: 24, output_tokens: 64 });
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
      usage: { output_tokens: number };
    };
    expect(md.delta.stop_reason).toBe("end_turn");
    expect(md.usage.output_tokens).toBe(5);
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
    expect((events.find((e) => e.event === "message_delta")?.data.delta as { stop_reason: string }).stop_reason).toBe("tool_use");
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
    expect(models.data).toEqual([{ id: "opencode/gpt-5.5", type: "model" }]);
    const count = await (await fetch(`${proxy.getUrl("zen")}/v1/messages/count_tokens`, { method: "POST", body: "{}" })).json();
    expect(count).toEqual({ input_tokens: 0 });
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
    expect(body.usage).toEqual({ input_tokens: 3, output_tokens: 4 });
    expect(seenAuth).toBe("Bearer zen-key-1");
    expect(JSON.parse(seenBody).messages).toEqual([{ role: "user", content: "hi" }]);
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
});
