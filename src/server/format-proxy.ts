// Anthropic ⇄ OpenAI wire-format translation proxy.
//
// The Claude CLI only speaks the Anthropic Messages API and only takes one
// ANTHROPIC_BASE_URL. Providers that expose an OpenAI-compatible endpoint
// (OpenCode Zen, and any custom OpenAI-format service) get a cockpit-hosted
// bridge instead: sessions point the CLI at this proxy, which translates the
// request to /chat/completions, forwards it upstream with the provider's
// stored key, and translates the response (streaming included) back into
// Anthropic SSE. This is the same job OpenRouter's "Anthropic Skin" does on
// their servers, done locally for providers that don't offer one.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ProxyUpstream {
  /** OpenAI-compatible base (e.g. https://opencode.ai/zen/v1), or for
   *  anthropic passthrough the host base the CLI would have used directly
   *  (e.g. https://openrouter.ai/api). */
  baseUrl: string;
  apiKey: string;
  /** Model ids served on the proxy's /v1/models probe endpoint. */
  modelIds?: string[];
  /** "openai" (default): translate Anthropic ⇄ OpenAI. "anthropic": the
   *  upstream already speaks Anthropic wire — relay verbatim, which exists
   *  purely to add the bounded retry to congested upstreams (free-model
   *  429s) without surfacing every blip as a turn error. */
  wireFormat?: "openai" | "anthropic";
}

export type UpstreamResolver = (providerId: string) => ProxyUpstream | null;

// ── Request translation (Anthropic → OpenAI) ────────────────────────────

interface AnthropicContentBlock {
  type: string;
  text?: string;
  source?: { type: string; media_type?: string; data?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  system?: string | AnthropicContentBlock[];
  messages: Array<{ role: string; content: string | AnthropicContentBlock[] }>;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: { type: string; name?: string };
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
}

function blockText(content: string | AnthropicContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

export function anthropicToOpenAIRequest(body: AnthropicRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  const system = blockText(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === "assistant") {
      const text = blockText(msg.content);
      const toolCalls = msg.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id ?? "",
          type: "function",
          function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
        }));
      const out: Record<string, unknown> = { role: "assistant", content: text || null };
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      messages.push(out);
      continue;
    }

    // user message: tool_results become role:"tool" messages (which OpenAI
    // requires directly after the assistant tool_calls turn), remaining
    // text/image blocks follow as the user turn.
    for (const b of msg.content) {
      if (b.type === "tool_result") {
        messages.push({ role: "tool", tool_call_id: b.tool_use_id ?? "", content: blockText(b.content) || String(b.content ?? "") });
      }
    }
    const parts: Array<Record<string, unknown>> = [];
    for (const b of msg.content) {
      if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
      if (b.type === "image" && b.source?.type === "base64") {
        parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      }
    }
    if (parts.length > 0) {
      const onlyText = parts.every((p) => p.type === "text");
      messages.push({ role: "user", content: onlyText ? parts.map((p) => p.text).join("\n") : parts });
    }
  }

  const out: Record<string, unknown> = { model: body.model, messages, stream: !!body.stream };
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  if (body.stream) out.stream_options = { include_usage: true };
  if (body.tools?.length) {
    out.tools = body.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  if (body.tool_choice) {
    const t = body.tool_choice.type;
    out.tool_choice = t === "any" ? "required" : t === "tool" ? { type: "function", function: { name: body.tool_choice.name } } : "auto";
  }
  return out;
}

// ── Response translation (OpenAI → Anthropic) ───────────────────────────

const STOP_REASON: Record<string, string> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  length: "max_tokens",
  content_filter: "end_turn",
};

function parseArgs(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw };
  }
}

interface OpenAIResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export function openAIToAnthropicResponse(body: OpenAIResponse): Record<string, unknown> {
  const choice = body.choices?.[0];
  const content: Array<Record<string, unknown>> = [];
  if (choice?.message?.content) content.push({ type: "text", text: choice.message.content });
  for (const tc of choice?.message?.tool_calls ?? []) {
    content.push({ type: "tool_use", id: tc.id ?? "", name: tc.function?.name ?? "", input: parseArgs(tc.function?.arguments) });
  }
  return {
    id: body.id ?? "msg_proxy",
    type: "message",
    role: "assistant",
    model: body.model,
    content,
    stop_reason: STOP_REASON[choice?.finish_reason ?? "stop"] ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: body.usage?.prompt_tokens ?? 0,
      output_tokens: body.usage?.completion_tokens ?? 0,
    },
  };
}

// ── Stream translation (OpenAI SSE → Anthropic SSE) ─────────────────────

interface OpenAIChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** Stateful translator: feed OpenAI SSE lines, collect Anthropic SSE text.
 *  Blocks are opened/closed as the OpenAI delta stream switches between text
 *  and per-index tool calls. */
export class StreamTranslator {
  private started = false;
  private blockIndex = -1;
  private openBlock: "none" | "text" | "tool" = "none";
  private openToolIndex = -1;
  private finishReason: string | null = null;
  private usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  private buffer = "";

  private event(name: string, data: Record<string, unknown>): string {
    return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
  }

  private ensureStarted(chunk: OpenAIChunk): string {
    if (this.started) return "";
    this.started = true;
    return this.event("message_start", {
      message: {
        id: chunk.id ?? "msg_proxy",
        type: "message",
        role: "assistant",
        model: chunk.model ?? "",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private closeBlock(): string {
    if (this.openBlock === "none") return "";
    const out = this.event("content_block_stop", { index: this.blockIndex });
    this.openBlock = "none";
    this.openToolIndex = -1;
    return out;
  }

  /** Feed raw SSE text from the OpenAI stream; returns Anthropic SSE text. */
  feed(raw: string): string {
    this.buffer += raw;
    let out = "";
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === "[DONE]") {
        out += this.finish();
        continue;
      }
      let chunk: OpenAIChunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      out += this.handleChunk(chunk);
    }
    return out;
  }

  private handleChunk(chunk: OpenAIChunk): string {
    let out = this.ensureStarted(chunk);
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return out;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;

    const delta = choice.delta ?? {};
    if (delta.content) {
      if (this.openBlock !== "text") {
        out += this.closeBlock();
        this.blockIndex += 1;
        this.openBlock = "text";
        out += this.event("content_block_start", { index: this.blockIndex, content_block: { type: "text", text: "" } });
      }
      out += this.event("content_block_delta", { index: this.blockIndex, delta: { type: "text_delta", text: delta.content } });
    }

    for (const tc of delta.tool_calls ?? []) {
      const toolIndex = tc.index ?? 0;
      if (this.openBlock !== "tool" || this.openToolIndex !== toolIndex) {
        out += this.closeBlock();
        this.blockIndex += 1;
        this.openBlock = "tool";
        this.openToolIndex = toolIndex;
        out += this.event("content_block_start", {
          index: this.blockIndex,
          content_block: { type: "tool_use", id: tc.id ?? `call_${toolIndex}`, name: tc.function?.name ?? "", input: {} },
        });
      }
      if (tc.function?.arguments) {
        out += this.event("content_block_delta", {
          index: this.blockIndex,
          delta: { type: "input_json_delta", partial_json: tc.function.arguments },
        });
      }
    }
    return out;
  }

  /** Close everything out; safe to call once at stream end. */
  finish(): string {
    if (!this.started) return "";
    let out = this.closeBlock();
    out += this.event("message_delta", {
      delta: { stop_reason: STOP_REASON[this.finishReason ?? "stop"] ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: this.usage?.completion_tokens ?? 0 },
    });
    out += this.event("message_stop", {});
    this.started = false;
    return out;
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
  });
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
}

/** Statuses worth retrying before any response bytes were sent: upstream
 *  saturation (429, and OpenRouter surfaces provider congestion as 429),
 *  gateway failures, and Anthropic's 529 overloaded. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 529]);

export class FormatProxy {
  private server: Server | null = null;
  private port = 0;
  private retryBackoffMs: number[];

  constructor(
    private resolveUpstream: UpstreamResolver,
    opts?: { retryBackoffMs?: number[] },
  ) {
    this.retryBackoffMs = opts?.retryBackoffMs ?? [1000, 3000];
  }

  /** Fetch with bounded retries on saturation-class failures. Safe because it
   *  only runs before any response bytes reach the client. Honors a small
   *  Retry-After when the upstream sends one. */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      let networkErr: unknown = null;
      try {
        res = await fetch(url, init);
      } catch (err) {
        networkErr = err;
      }
      const retryable = res ? RETRYABLE_STATUS.has(res.status) : true;
      if (!retryable || attempt >= this.retryBackoffMs.length) {
        if (res) return res;
        throw networkErr;
      }
      const retryAfter = Number(res?.headers.get("retry-after") ?? 0);
      const wait = retryAfter > 0 && retryAfter <= 10 ? retryAfter * 1000 : this.retryBackoffMs[attempt];
      await res?.body?.cancel();
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  getUrl(providerId: string): string {
    return `http://127.0.0.1:${this.port}/${providerId}`;
  }

  get isRunning(): boolean {
    return this.server !== null;
  }

  async start(port = 0): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    this.server = server;
    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [pathPart, query] = (req.url || "").split("?");
    const [, providerId, ...rest] = pathPart.split("/");
    const path = `/${rest.join("/")}`;
    const upstream = providerId ? this.resolveUpstream(providerId) : null;
    if (!upstream) {
      jsonError(res, 404, `Unknown proxied provider: ${providerId}`);
      return;
    }

    if (upstream.wireFormat === "anthropic") {
      await this.passthrough(req, res, upstream, path + (query ? `?${query}` : ""));
      return;
    }

    // The CLI probes the models list on custom base URLs; absent ids read as
    // unavailable models and dead turns, so answer with the provider catalog.
    if (req.method === "GET" && path === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: (upstream.modelIds ?? []).map((id) => ({ id, type: "model" })), has_more: false }));
      return;
    }

    if (req.method === "POST" && path === "/v1/messages/count_tokens") {
      await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 0 }));
      return;
    }

    if (req.method === "POST" && path === "/v1/messages") {
      await this.proxyMessages(req, res, upstream);
      return;
    }

    jsonError(res, 404, `Unsupported proxy path: ${path}`);
  }

  /** Anthropic-to-Anthropic relay: forward the request verbatim (client auth
   *  headers included, upstream key injected only when the client sent none),
   *  retry saturation-class failures, then pipe the response bytes straight
   *  through. The CLI sees exactly what the upstream would have sent, minus
   *  the 429s that a retry absorbed. */
  private async passthrough(req: IncomingMessage, res: ServerResponse, upstream: ProxyUpstream, pathWithQuery: string): Promise<void> {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value !== "string") continue;
      if (key === "host" || key === "connection" || key === "content-length" || key === "transfer-encoding") continue;
      headers[key] = value;
    }
    if (!headers.authorization && !headers["x-api-key"] && upstream.apiKey) {
      headers.authorization = `Bearer ${upstream.apiKey}`;
    }

    let upstreamRes: Response;
    try {
      upstreamRes = await this.fetchWithRetry(`${upstream.baseUrl}${pathWithQuery}`, { method: req.method, headers, body });
    } catch (err) {
      jsonError(res, 502, `Upstream request failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    res.writeHead(upstreamRes.status, { "Content-Type": upstreamRes.headers.get("content-type") ?? "application/json" });
    const reader = upstreamRes.body?.getReader();
    if (!reader) {
      res.end();
      return;
    }
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch {
      // upstream died mid-stream — end what we have
    }
    res.end();
  }

  private async proxyMessages(req: IncomingMessage, res: ServerResponse, upstream: ProxyUpstream): Promise<void> {
    let anthropicBody: AnthropicRequest;
    try {
      anthropicBody = JSON.parse(await readBody(req));
    } catch {
      jsonError(res, 400, "Invalid JSON body");
      return;
    }

    const openaiBody = anthropicToOpenAIRequest(anthropicBody);
    let upstreamRes: Response;
    try {
      upstreamRes = await this.fetchWithRetry(`${upstream.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${upstream.apiKey}` },
        body: JSON.stringify(openaiBody),
      });
    } catch (err) {
      jsonError(res, 502, `Upstream request failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => "");
      let message = text.slice(0, 500);
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        // keep raw text
      }
      jsonError(res, upstreamRes.status, message || `Upstream HTTP ${upstreamRes.status}`);
      return;
    }

    if (!anthropicBody.stream) {
      const body = (await upstreamRes.json()) as OpenAIResponse;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(openAIToAnthropicResponse(body)));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const translator = new StreamTranslator();
    const reader = upstreamRes.body?.getReader();
    if (!reader) {
      res.end(translator.finish());
      return;
    }
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const out = translator.feed(decoder.decode(value, { stream: true }));
        if (out) res.write(out);
      }
    } catch {
      // upstream died mid-stream — close out what we have
    }
    res.write(translator.finish());
    res.end();
  }
}

// Cross-module-graph registry: cockpit runs as two module graphs (the custom
// server that spawns sessions, and the Next.js API routes), so the active
// proxy is stashed on globalThis the same way the other singletons are.
const ACTIVE_PROXY_KEY = "__cockpit_format_proxy__";

export function setActiveFormatProxy(proxy: FormatProxy): void {
  (globalThis as Record<string, unknown>)[ACTIVE_PROXY_KEY] = proxy;
}

export function getActiveFormatProxy(): FormatProxy | null {
  return ((globalThis as Record<string, unknown>)[ACTIVE_PROXY_KEY] as FormatProxy) ?? null;
}
