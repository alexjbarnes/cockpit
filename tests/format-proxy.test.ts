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

    await fetch(`${proxy.getUrl("openrouter")}/v1/models`);
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
