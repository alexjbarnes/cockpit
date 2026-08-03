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

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { logProxy } from "@/server/debug-logger";

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
  /** Effort levels each model supports (models.dev reasoning_options), used to
   *  map the CLI's thinking budget onto reasoning_effort for translated
   *  requests. Models absent here never get a reasoning_effort field. */
  effortByModel?: Record<string, string[]>;
}

export type UpstreamResolver = (providerId: string) => ProxyUpstream | null;

/** Token usage observed on a translated request, reported to the meter so
 *  providers without a spend API (zen) still get a local usage view. */
export interface ProxyUsageEvent {
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

// ── Request translation (Anthropic → OpenAI) ────────────────────────────

interface AnthropicContentBlock {
  type: string;
  text?: string;
  /** Chain-of-thought on a thinking block, mapped to/from the upstream's
   *  reasoning_content — see the assistant branch of anthropicToOpenAIRequest. */
  thinking?: string;
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
  thinking?: { type?: string; budget_tokens?: number };
  output_config?: { effort?: string };
}

const EFFORT_RANK = ["low", "medium", "high", "xhigh", "max"];

/** Anthropic thinking budgets → reasoning_effort tiers. The CLI's effort
 *  levels reach foreign models as budget_tokens (pre-4.6 style thinking);
 *  output_config.effort, when a newer CLI sends it, passes through directly. */
function budgetToEffort(budget: number): string {
  if (budget <= 8_192) return "low";
  if (budget <= 16_384) return "medium";
  if (budget <= 32_768) return "high";
  if (budget <= 65_536) return "xhigh";
  return "max";
}

/** Clamp a requested effort to what the model supports: the nearest supported
 *  level at or above the request, else the highest supported below it. */
function clampEffort(level: string, supported: string[]): string | null {
  const ranked = supported.filter((s) => EFFORT_RANK.includes(s)).sort((a, b) => EFFORT_RANK.indexOf(a) - EFFORT_RANK.indexOf(b));
  if (ranked.length === 0) return null;
  const want = EFFORT_RANK.indexOf(level);
  for (const s of ranked) if (EFFORT_RANK.indexOf(s) >= want) return s;
  return ranked[ranked.length - 1];
}

function blockText(content: string | AnthropicContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

export function anthropicToOpenAIRequest(body: AnthropicRequest, opts?: { effortLevels?: string[] }): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  // Assistant turns that called a tool but carried no thinking; they only
  // need a placeholder reasoning_content if this request ends up in thinking
  // mode, which is not known until reasoning_effort is resolved below.
  const assistantsNeedingReasoning: Array<Record<string, unknown>> = [];

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
      // Send the model's own chain-of-thought back the way it arrived. The
      // response direction turns an upstream reasoning_content into an
      // Anthropic thinking block, so the CLI replays that block in history on
      // the next turn; dropping it here made the round trip lossy and DeepSeek
      // rejects that outright: "The `reasoning_content` in the thinking mode
      // must be passed back to the API" (HTTP 400, observed killing every
      // multi-turn zen session on deepseek-v4-flash-free). Only ever set when
      // the assistant turn actually carried thinking, which only happens for
      // models that emitted it in the first place, so a model that has never
      // heard of the field never sees it.
      const reasoning = msg.content
        .filter((b) => b.type === "thinking")
        .map((b) => b.thinking ?? "")
        .filter(Boolean)
        .join("\n");
      // A turn that called a tool while also saying something must carry the
      // field even when it did no reasoning at all. DeepSeek refuses
      // {content, tool_calls} with no reasoning_content in thinking mode —
      // measured: tool_calls alone is accepted, tool_calls plus content is
      // not, and an empty string satisfies it. Not every assistant turn
      // reasons, so this shape is common in a long session and was the
      // residual cause of turns dying after the thinking round trip was
      // fixed. Only applied when reasoning_effort is going upstream, so a
      // non-thinking request never gains the field.
      if (reasoning) out.reasoning_content = reasoning;
      else if (toolCalls.length > 0) assistantsNeedingReasoning.push(out);
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
  // Reasoning depth: only models with declared effort levels get a
  // reasoning_effort field — everything else leaves the upstream default, so
  // toggle-only or non-reasoning models never see a parameter they may reject.
  const requested =
    body.output_config?.effort ??
    (body.thinking?.type === "enabled" && body.thinking.budget_tokens
      ? budgetToEffort(body.thinking.budget_tokens)
      : body.thinking?.type === "adaptive"
        ? "high"
        : undefined);
  if (requested) {
    const effort = clampEffort(requested, opts?.effortLevels ?? []);
    if (effort) for (const m of assistantsNeedingReasoning) m.reasoning_content = "";
    if (effort) out.reasoning_effort = effort;
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
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export function openAIToAnthropicResponse(body: OpenAIResponse): Record<string, unknown> {
  const choice = body.choices?.[0];
  const content: Array<Record<string, unknown>> = [];
  // Reasoning models (deepseek's reasoning_content, the normalized reasoning
  // field) put chain-of-thought outside content — surface it as a thinking
  // block so it renders instead of silently vanishing.
  const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
  if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "" });
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
      reasoning_content?: string | null;
      reasoning?: string | null;
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
  private openBlock: "none" | "text" | "tool" | "thinking" = "none";
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
    // Reasoning deltas stream before (and separately from) the answer text.
    // Without this mapping a reasoning model looks hung: the chain-of-thought
    // streamed into a field the translator dropped.
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) {
      if (this.openBlock !== "thinking") {
        out += this.closeBlock();
        this.blockIndex += 1;
        this.openBlock = "thinking";
        out += this.event("content_block_start", {
          index: this.blockIndex,
          content_block: { type: "thinking", thinking: "", signature: "" },
        });
      }
      out += this.event("content_block_delta", { index: this.blockIndex, delta: { type: "thinking_delta", thinking: reasoning } });
    }
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

  /** Usage from the final OpenAI chunk (stream_options.include_usage), for
   *  metering after the stream closes. */
  getUsage(): { prompt_tokens?: number; completion_tokens?: number } | null {
    return this.usage;
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

/** Anthropic /v1/models entry shape, which the CLI's probes expect. */
function modelEntry(id: string): Record<string, unknown> {
  return { type: "model", id, display_name: id };
}

/** Rough input-token count for the count_tokens stub: no upstream we proxy
 *  implements the endpoint, and answering a flat 0 would tell the CLI the
 *  context is permanently empty, suppressing auto-compact until a turn dies on
 *  a hard context error. Four characters per token is the usual approximation;
 *  the number only drives the CLI's own budgeting, never billing. */
export function estimateInputTokens(rawBody: string): number {
  let chars = 0;
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      chars += v.length;
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v && typeof v === "object") {
      for (const [key, value] of Object.entries(v)) {
        // Skip identifiers and enums that carry no prompt weight.
        if (key === "model" || key === "type" || key === "role") continue;
        walk(value);
      }
    }
  };
  try {
    walk(JSON.parse(rawBody));
  } catch {
    chars = rawBody.length;
  }
  return Math.ceil(chars / 4);
}

/** Statuses worth retrying before any response bytes were sent: upstream
 *  saturation (429, and OpenRouter surfaces provider congestion as 429),
 *  gateway failures, and Anthropic's 529 overloaded. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 529]);

/** Some gateways (OpenRouter's free tier especially) signal upstream
 *  saturation as HTTP 200 wrapping an error, not a 429: a streamed
 *  `event: error`, a JSON error object, or an empty body. The CLI then can't
 *  parse a message and throws a misleading "malformed response, check for a
 *  proxy" that points at us. Detect those so passthrough can retry them like
 *  a 429 before relaying. Peek is the decoded start of the first body chunk. */
function is200Saturation(peek: string, emptyBody: boolean): boolean {
  if (emptyBody) return true;
  const t = peek.trimStart();
  if (t.startsWith("event: error")) return true;
  if (t.startsWith("{") && t.slice(0, 200).includes('"type":"error"')) return true;
  return false;
}

/** Best-effort extraction of the upstream error message from a peeked error
 *  body (SSE `data:` line or a JSON error object), for a clearer surfaced
 *  error than the CLI's generic one. */
function saturationMessage(peek: string): string {
  return peek.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? "Upstream provider is temporarily saturated";
}

export class FormatProxy {
  private server: Server | null = null;
  private port = 0;
  private retryBackoffMs: number[];
  private onUsage?: (u: ProxyUsageEvent) => void;
  /**
   * Gate for inbound requests, carried as the first path segment of the base
   * URL rather than a header. Without it any local process could POST to the
   * loopback port and spend the stored provider credits, since the proxy
   * attaches the upstream key itself.
   *
   * It cannot ride on ANTHROPIC_AUTH_TOKEN: for the passthrough providers
   * (OpenRouter, DeepSeek) that variable holds the real upstream key, which
   * the CLI sends and passthrough() forwards verbatim. Overwriting it would
   * send this token upstream instead of the credential. The path needs no
   * cooperation from the CLI at all, since cockpit sets the whole base URL.
   */
  private readonly token = randomBytes(24).toString("hex");

  constructor(
    private resolveUpstream: UpstreamResolver,
    opts?: { retryBackoffMs?: number[]; onUsage?: (u: ProxyUsageEvent) => void },
  ) {
    this.retryBackoffMs = opts?.retryBackoffMs ?? [1000, 3000];
    this.onUsage = opts?.onUsage;
  }

  /** Fetch with bounded retries on saturation-class failures. Safe because it
   *  only runs before any response bytes reach the client. Honors a small
   *  Retry-After when the upstream sends one. */
  private async fetchWithRetry(url: string, init: RequestInit, providerId: string): Promise<Response> {
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
        if (res) {
          if (attempt > 0) logProxy(providerId, "retry-settled", { status: res.status, attempts: attempt + 1 });
          return res;
        }
        logProxy(providerId, "upstream-network-error", {
          url,
          attempts: attempt + 1,
          error: networkErr instanceof Error ? networkErr.message : String(networkErr),
        });
        throw networkErr;
      }
      const retryAfter = Number(res?.headers.get("retry-after") ?? 0);
      const wait = retryAfter > 0 && retryAfter <= 10 ? retryAfter * 1000 : this.retryBackoffMs[attempt];
      logProxy(providerId, "retry", {
        attempt: attempt + 1,
        status: res?.status ?? null,
        networkError: res ? null : networkErr instanceof Error ? networkErr.message : String(networkErr),
        retryAfterHeader: retryAfter || null,
        waitMs: wait,
      });
      await res?.body?.cancel();
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  getUrl(providerId: string): string {
    return `http://127.0.0.1:${this.port}/${this.token}/${providerId}`;
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
    logProxy("-", "listening", { port: this.port });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [pathPart, query] = (req.url || "").split("?");
    const [, token, providerId, ...rest] = pathPart.split("/");
    const path = `/${rest.join("/")}`;
    if (token !== this.token) {
      // Deliberately says nothing about which part was wrong, and never echoes
      // the offered token.
      logProxy(providerId || "-", "unauthorized", { method: req.method, path, status: 401 });
      jsonError(res, 401, "Unauthorized");
      return;
    }
    const upstream = providerId ? this.resolveUpstream(providerId) : null;
    logProxy(providerId || "-", "request", {
      method: req.method,
      path,
      resolved: !!upstream,
      wireFormat: upstream?.wireFormat ?? null,
      baseUrl: upstream?.baseUrl ?? null,
      hasKey: !!upstream?.apiKey,
    });
    if (!upstream) {
      logProxy(providerId || "-", "unknown-provider", { status: 404 });
      jsonError(res, 404, `Unknown proxied provider: ${providerId}`);
      return;
    }

    // Model-metadata endpoints are answered from the catalog for BOTH modes,
    // never relayed. The CLI probes these on any custom base URL, and reports
    // ANY 404 from them as "There's an issue with the selected model (X). It
    // may not exist or you may not have access to it" — even when the model is
    // perfectly valid. OpenRouter's Anthropic door implements /v1/messages but
    // NOT /v1/messages/count_tokens or /v1/models/<id> (both 404, verified
    // live), so relaying those turns a working model into a phantom error.
    if (req.method === "GET" && path === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: (upstream.modelIds ?? []).map(modelEntry), has_more: false }));
      return;
    }

    if (req.method === "GET" && path.startsWith("/v1/models/")) {
      const wanted = decodeURIComponent(path.slice("/v1/models/".length));
      const known = (upstream.modelIds ?? []).find((id) => id === wanted);
      if (!known) {
        logProxy(providerId, "model-not-in-catalog", { model: wanted, catalogSize: (upstream.modelIds ?? []).length });
        jsonError(res, 404, `Model ${wanted} is not in the ${providerId} catalog`);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(modelEntry(known)));
      return;
    }

    if (req.method === "POST" && path === "/v1/messages/count_tokens") {
      const raw = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ input_tokens: estimateInputTokens(raw) }));
      return;
    }

    if (upstream.wireFormat === "anthropic") {
      await this.passthrough(req, res, upstream, path + (query ? `?${query}` : ""), providerId);
      return;
    }

    if (req.method === "POST" && path === "/v1/messages") {
      await this.proxyMessages(req, res, upstream, providerId);
      return;
    }

    logProxy(providerId, "unsupported-path", { method: req.method, path, status: 404 });
    jsonError(res, 404, `Unsupported proxy path: ${path}`);
  }

  /** Anthropic-to-Anthropic relay: forward the request verbatim (client auth
   *  headers included, upstream key injected only when the client sent none),
   *  retry saturation-class failures, then pipe the response bytes straight
   *  through. The CLI sees exactly what the upstream would have sent, minus
   *  the 429s that a retry absorbed. */
  private async passthrough(
    req: IncomingMessage,
    res: ServerResponse,
    upstream: ProxyUpstream,
    pathWithQuery: string,
    providerId: string,
  ): Promise<void> {
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

    // Fetch, then peek the first chunk of a 200 to catch saturation the
    // upstream wrapped in a success status. Retries stay before any byte
    // reaches the client, so the invariant that we never retry mid-response
    // holds. reader/firstChunk carry the committed response out of the loop.
    let upstreamRes: Response;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let firstChunk: Uint8Array | null = null;
    let saturatedPeek: string | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        upstreamRes = await this.fetchWithRetry(`${upstream.baseUrl}${pathWithQuery}`, { method: req.method, headers, body }, providerId);
      } catch (err) {
        logProxy(providerId, "passthrough-failed", { status: 502, error: err instanceof Error ? err.message : String(err) });
        jsonError(res, 502, `Upstream request failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      reader = upstreamRes.body?.getReader() ?? null;
      // Only 200s need the peek: a real error status is relayed as-is below.
      if (!reader || upstreamRes.status !== 200) {
        firstChunk = null;
        saturatedPeek = null;
        break;
      }

      const { done, value } = await reader.read();
      firstChunk = value ?? null;
      const peek = firstChunk ? new TextDecoder().decode(firstChunk).slice(0, 256) : "";
      if (is200Saturation(peek, done && !value)) {
        // The tell for the free-tier bug: a 200 whose body is an error. The
        // peek is what decides it, so it is logged verbatim.
        logProxy(providerId, "saturation-200", { attempt: attempt + 1, emptyBody: done && !value, peek });
        if (attempt < this.retryBackoffMs.length) {
          await reader.cancel().catch(() => {});
          await new Promise((r) => setTimeout(r, this.retryBackoffMs[attempt]));
          continue;
        }
        // Out of retries: surface an honest overloaded error instead of
        // relaying a body the CLI reports as a malformed proxy response.
        await reader.cancel().catch(() => {});
        saturatedPeek = peek;
      }
      break;
    }

    if (saturatedPeek !== null) {
      logProxy(providerId, "saturation-exhausted", { status: 529, peek: saturatedPeek });
      jsonError(res, 529, saturationMessage(saturatedPeek));
      return;
    }

    logProxy(providerId, "passthrough-relay", {
      status: upstreamRes.status,
      contentType: upstreamRes.headers.get("content-type"),
      streamed: !!reader,
    });
    res.writeHead(upstreamRes.status, { "Content-Type": upstreamRes.headers.get("content-type") ?? "application/json" });
    if (!reader) {
      res.end();
      return;
    }
    try {
      if (firstChunk) res.write(Buffer.from(firstChunk));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch (err) {
      // upstream died mid-stream — end what we have
      logProxy(providerId, "passthrough-stream-aborted", { error: err instanceof Error ? err.message : String(err) });
    }
    res.end();
  }

  private async proxyMessages(req: IncomingMessage, res: ServerResponse, upstream: ProxyUpstream, providerId: string): Promise<void> {
    let anthropicBody: AnthropicRequest;
    try {
      anthropicBody = JSON.parse(await readBody(req));
    } catch {
      logProxy(providerId, "bad-request-body", { status: 400 });
      jsonError(res, 400, "Invalid JSON body");
      return;
    }

    const openaiBody = anthropicToOpenAIRequest(anthropicBody, { effortLevels: upstream.effortByModel?.[anthropicBody.model] });
    logProxy(providerId, "translate", {
      model: anthropicBody.model,
      stream: !!anthropicBody.stream,
      messages: Array.isArray(anthropicBody.messages) ? anthropicBody.messages.length : null,
      hasSystem: anthropicBody.system !== undefined,
      effortLevels: upstream.effortByModel?.[anthropicBody.model] ?? null,
      openaiKeys: Object.keys(openaiBody),
    });
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${upstream.apiKey}` },
      body: JSON.stringify(openaiBody),
    };
    let upstreamRes: Response;
    try {
      upstreamRes = await this.fetchWithRetry(`${upstream.baseUrl}/chat/completions`, init, providerId);
      // Zen wraps non-auth failures in 401 ("Model X is not supported",
      // "No provider available" when its routing finds no upstream), which the
      // CLI reads as an auth failure and answers with a "run /login" prompt.
      // Genuine auth errors are AuthError-typed. Routing failures are
      // saturation-class, so retry them like a 429 before giving up.
      for (let attempt = 0; upstreamRes.status === 401 && attempt < this.retryBackoffMs.length; attempt++) {
        const probe = (await upstreamRes
          .clone()
          .json()
          .catch(() => null)) as { error?: { type?: string; message?: string } } | null;
        if (!/no provider available/i.test(probe?.error?.message ?? "")) break;
        logProxy(providerId, "no-provider-retry", { attempt: attempt + 1, upstreamMessage: probe?.error?.message ?? null });
        await new Promise((r) => setTimeout(r, this.retryBackoffMs[attempt]));
        upstreamRes = await fetch(`${upstream.baseUrl}/chat/completions`, init);
      }
    } catch (err) {
      logProxy(providerId, "upstream-failed", {
        status: 502,
        model: anthropicBody.model,
        error: err instanceof Error ? err.message : String(err),
      });
      jsonError(res, 502, `Upstream request failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => "");
      let message = text.slice(0, 500);
      let errType = "";
      try {
        const parsed = JSON.parse(text) as { error?: { type?: string; message?: string } };
        message = parsed.error?.message ?? message;
        errType = parsed.error?.type ?? "";
      } catch {
        // keep raw text
      }
      // Remap zen's non-auth 401s so the CLI reports an API error instead of
      // demanding /login: routing failures read as overloaded (503), unknown
      // models as not found (404). Real AuthError 401s pass through.
      let status = upstreamRes.status;
      if (status === 401 && errType !== "AuthError" && !/api key|unauthorized/i.test(message)) {
        status = /no provider available/i.test(message) ? 503 : 404;
      }
      logProxy(providerId, "upstream-error", {
        model: anthropicBody.model,
        upstreamStatus: upstreamRes.status,
        sentStatus: status,
        remapped: status !== upstreamRes.status,
        errorType: errType || null,
        message: message.slice(0, 500),
      });
      jsonError(res, status, message || `Upstream HTTP ${status}`);
      return;
    }

    if (!anthropicBody.stream) {
      const body = (await upstreamRes.json()) as OpenAIResponse;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(openAIToAnthropicResponse(body)));
      logProxy(providerId, "complete", {
        model: anthropicBody.model,
        stream: false,
        finishReason: body.choices?.[0]?.finish_reason ?? null,
        inputTokens: body.usage?.prompt_tokens ?? null,
        outputTokens: body.usage?.completion_tokens ?? null,
      });
      if (body.usage) {
        this.onUsage?.({
          providerId,
          modelId: anthropicBody.model,
          inputTokens: body.usage.prompt_tokens ?? 0,
          outputTokens: body.usage.completion_tokens ?? 0,
        });
      }
      return;
    }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const translator = new StreamTranslator();
    const reader = upstreamRes.body?.getReader();
    if (!reader) {
      logProxy(providerId, "stream-no-body", { model: anthropicBody.model });
      res.end(translator.finish());
      return;
    }
    const decoder = new TextDecoder();
    let aborted: string | null = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const out = translator.feed(decoder.decode(value, { stream: true }));
        if (out) res.write(out);
      }
    } catch (err) {
      // upstream died mid-stream — close out what we have
      aborted = err instanceof Error ? err.message : String(err);
    }
    const usage = translator.getUsage();
    res.write(translator.finish());
    res.end();
    logProxy(providerId, "complete", {
      model: anthropicBody.model,
      stream: true,
      aborted,
      inputTokens: usage?.prompt_tokens ?? null,
      outputTokens: usage?.completion_tokens ?? null,
    });
    if (usage) {
      this.onUsage?.({
        providerId,
        modelId: anthropicBody.model,
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      });
    }
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
