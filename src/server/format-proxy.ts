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
  /** Whether each model takes images (models.dev input modalities). A model
   *  known to be false is never sent one; a model absent here is sent them as
   *  before, since the flag is not always known. */
  supportsImageInputByModel?: Record<string, boolean>;
  /** Models this upstream serves on Anthropic wire while the rest of its
   *  catalog is OpenAI wire. A request naming one is relayed verbatim to
   *  `{baseUrl}/messages`; every other model is translated to
   *  /chat/completions. CommandCode is why this exists: its catalog is one
   *  provider with two wires, Claude models answering only /messages and
   *  everything else only /chat/completions. */
  anthropicWireModels?: string[];
  /** Where a relayed Anthropic request goes, when the upstream's door is not
   *  the CLI's own /v1 path. CommandCode mirrors OpenAI's shape — /messages
   *  beside /chat/completions — so its relays drop the /v1 the CLI adds. */
  anthropicMessagesPath?: string;
}

export type UpstreamResolver = (providerId: string) => ProxyUpstream | null;

/** Token usage observed on a translated request, reported to the meter so
 *  providers without a spend API (zen) still get a local usage view. */
export interface ProxyUsageEvent {
  providerId: string;
  modelId: string;
  /** The upstream's prompt tokens, which include the cache reads below. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the upstream's cache, which the meter prices at
   *  the cache rate rather than the input rate. */
  cacheReadTokens: number;
}

// ── Request translation (Anthropic → OpenAI) ────────────────────────────

interface AnthropicContentBlock {
  type: string;
  text?: string;
  /** Chain-of-thought on a thinking block, mapped to/from the upstream's
   *  reasoning_content — see the assistant branch of anthropicToOpenAIRequest. */
  thinking?: string;
  /** The opaque blob a redacted_thinking block carries instead of its text. */
  data?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
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

/** An image block as an OpenAI image part, or null for one this wire cannot
 *  carry. The payload is checked: a block with no data used to become the URL
 *  "data:image/png;base64,undefined". */
function imagePart(block: AnthropicContentBlock): Record<string, unknown> | null {
  if (block.type !== "image") return null;
  if (block.source?.type === "base64") {
    if (!block.source.data || !block.source.media_type) return null;
    return { type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
  }
  if (block.source?.type === "url" && block.source.url) {
    return { type: "image_url", image_url: { url: block.source.url } };
  }
  return null;
}

/** Every image in a tool result's content that this wire can carry. */
function imagePartsInToolResult(content: string | AnthropicContentBlock[] | undefined): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.map(imagePart).filter((p): p is Record<string, unknown> => p !== null);
}

/** What a model is told in place of an image it cannot be shown. */
function omittedImageNote(count: number, model: string | undefined): string {
  return `[${count === 1 ? "image" : `${count} images`} omitted: ${model ?? "this model"} does not accept images]`;
}

/** What a model is told about a block this wire has no room for, which is
 *  better than the stringified content array it used to receive. */
function unsupportedBlockNote(block: AnthropicContentBlock): string {
  const kind = block.type === "document" ? `document (${block.source?.media_type ?? "unknown type"})` : block.type;
  return `[${kind} omitted: this wire carries text and images only]`;
}

/** A tool result's content when it holds no text and no image this wire can
 *  carry. Stringifying the array here is where "[object Object]" came from. */
function toolResultFallback(content: string | AnthropicContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (!Array.isArray(content)) return JSON.stringify(content);
  const kinds = [...new Set(content.map((b) => (typeof b === "string" ? "text" : b.type)))].filter(Boolean);
  return `[tool returned ${kinds.join(", ") || "content"} that cannot be sent to this model]`;
}

export function anthropicToOpenAIRequest(
  body: AnthropicRequest,
  opts?: { effortLevels?: string[]; modelTakesImages?: boolean },
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  // Assistant turns that called a tool but carried no thinking; they only
  // need a placeholder reasoning_content if this request ends up in thinking
  // mode, which is not known until reasoning_effort is resolved below.
  const assistantsNeedingReasoning: Array<Record<string, unknown>> = [];
  // tool_use id to tool name, so an image a tool returned can be labelled with
  // the tool that produced it when it moves into the user turn.
  const toolNames = new Map<string, string>();

  const system = blockText(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    // A message with no content at all (null, absent, or something that is not
    // a block array) is skipped rather than throwing: this runs inside the
    // request handler, where a throw would answer nothing at all.
    if (!Array.isArray(msg.content)) continue;

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
      for (const b of msg.content) if (b.type === "tool_use" && b.id) toolNames.set(b.id, b.name ?? "tool");
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
      // A redacted thinking block carries its reasoning as an opaque blob this
      // wire has no field for, but its presence still means the turn reasoned:
      // the placeholder below is what keeps such a turn acceptable to an
      // upstream that demands reasoning_content back in thinking mode.
      const hadRedactedThinking = msg.content.some((b) => b.type === "redacted_thinking");
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
      else if (toolCalls.length > 0 || hadRedactedThinking) assistantsNeedingReasoning.push(out);
      messages.push(out);
      continue;
    }

    // user message: tool_results become role:"tool" messages (which OpenAI
    // requires directly after the assistant tool_calls turn), remaining
    // text/image blocks follow as the user turn.
    //
    // An image a tool returned — the Read tool on a screenshot is the usual
    // case — cannot ride in a tool message on this wire, so it moves into the
    // user turn that follows, and the tool message says so. The fallback below
    // it used to stringify the content array, handing the model the literal
    // text "[object Object]" in place of the picture.
    const toolImages: Array<{ part: Record<string, unknown>; tool: string }> = [];
    for (const b of msg.content) {
      if (b.type !== "tool_result") continue;
      const text = blockText(b.content);
      const images = imagePartsInToolResult(b.content);
      if (images.length === 0) {
        messages.push({ role: "tool", tool_call_id: b.tool_use_id ?? "", content: text || toolResultFallback(b.content) });
        continue;
      }
      if (opts?.modelTakesImages === false) {
        messages.push({
          role: "tool",
          tool_call_id: b.tool_use_id ?? "",
          content: [text, omittedImageNote(images.length, body.model)].filter(Boolean).join("\n"),
        });
        continue;
      }
      messages.push({
        role: "tool",
        tool_call_id: b.tool_use_id ?? "",
        content: text || "The tool returned an image, which follows in the next message.",
      });
      const tool = toolNames.get(b.tool_use_id ?? "") ?? "tool";
      for (const part of images) toolImages.push({ part, tool });
    }
    const parts: Array<Record<string, unknown>> = [];
    if (toolImages.length > 0) {
      const byTool = [...new Set(toolImages.map((t) => t.tool))];
      parts.push({
        type: "text",
        text: `${toolImages.length === 1 ? "Image" : "Images"} returned by the ${byTool.join(" and ")} tool:`,
      });
      for (const t of toolImages) parts.push(t.part);
    }
    for (const b of msg.content) {
      if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
      if (b.type === "image") {
        if (opts?.modelTakesImages === false) {
          parts.push({ type: "text", text: omittedImageNote(1, body.model) });
          continue;
        }
        const part = imagePart(b);
        parts.push(part ?? { type: "text", text: unsupportedBlockNote(b) });
      }
      // A PDF the user attached: this wire carries text and images only, so the
      // model is told one was there rather than the block vanishing.
      if (b.type === "document") parts.push({ type: "text", text: unsupportedBlockNote(b) });
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
    // "none" is a real tool_choice on both wires, so a client that forbids
    // tools does not get them allowed by the translation.
    out.tool_choice =
      t === "any"
        ? "required"
        : t === "tool"
          ? { type: "function", function: { name: body.tool_choice.name } }
          : t === "none"
            ? "none"
            : "auto";
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

// ── Usage, including prompt caching ─────────────────────────────────────

/**
 * The upstream's usage block. Cached prompt tokens are reported under two
 * different names depending on the door: `prompt_tokens_details.cached_tokens`
 * is the OpenAI-compatible field most gateways use, and DeepSeek reports
 * `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` instead. Read both.
 *
 * Worth knowing: caching on these providers is automatic prefix caching, not
 * the Anthropic `cache_control` breakpoints the CLI sends. Those breakpoints do
 * not survive translation (the request builder keeps only a block's type/text),
 * which costs nothing here because the upstream never wanted them — but it does
 * mean nothing in a translated request can influence what gets cached.
 */
interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

/** Prompt tokens served from the upstream's cache, whichever name it used. */
function cachedPromptTokens(usage: OpenAIUsage | null | undefined): number {
  return usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
}

/**
 * Usage in Anthropic's shape, with the cache hit split out.
 *
 * Anthropic's `input_tokens` EXCLUDES cache reads while OpenAI-style
 * `prompt_tokens` includes them, so the cached part has to be subtracted or
 * every consumer that sums the three fields — the context gauge, the session
 * token report — double-counts it.
 */
function anthropicUsage(usage: OpenAIUsage | null | undefined): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
} {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = Math.min(cachedPromptTokens(usage), prompt);
  return { input_tokens: prompt - cached, output_tokens: usage?.completion_tokens ?? 0, cache_read_input_tokens: cached };
}

/** Cache fields for the proxy log, so hit rate is answerable from debug.jsonl. */
function cacheLogFields(usage: OpenAIUsage | null | undefined): Record<string, number | null> {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = cachedPromptTokens(usage);
  return {
    cachedInputTokens: cached,
    cacheMissTokens: usage?.prompt_cache_miss_tokens ?? (prompt ? prompt - cached : 0),
    cacheHitRatio: prompt > 0 ? Math.round((cached / prompt) * 100) / 100 : null,
  };
}

// ── Response translation (OpenAI → Anthropic) ───────────────────────────

const STOP_REASON: Record<string, string> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  length: "max_tokens",
  content_filter: "end_turn",
};

function parseArgs(raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === "") return {};
  // Some compatible servers send the arguments as an object rather than a
  // string. JSON.parse would stringify that to "[object Object]" and throw,
  // wrapping the whole thing in __raw, so an object is taken as it is.
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return { __raw: String(raw) };
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
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } }>;
    };
    finish_reason?: string;
  }>;
  usage?: OpenAIUsage;
  error?: { message?: string; type?: string };
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
    usage: anthropicUsage(body.usage),
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
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage | null;
  /** Some gateways report a failure as a chunk rather than an HTTP status. */
  error?: { message?: string; type?: string } | null;
}

/** Stateful translator: feed OpenAI SSE lines, collect Anthropic SSE text.
 *  Blocks are opened/closed as the OpenAI delta stream switches between text
 *  and per-index tool calls. */
export class StreamTranslator {
  private started = false;
  private blockIndex = -1;
  private openBlock: "none" | "text" | "tool" | "thinking" = "none";
  private openToolIndex = -1;
  private lastToolIndex = 0;
  /** What each tool call index announced. The id and name arrive once, on the
   *  first fragment, and a stream may switch indexes and come back, or send a
   *  continuation fragment with no index at all, so both are remembered per
   *  index rather than read from whichever fragment reopens the block. */
  private readonly announcedTools = new Map<number, { id: string; name: string }>();
  private finishReason: string | null = null;
  private usage: OpenAIUsage | null = null;
  private buffer = "";
  /** An error the upstream put in the stream itself (data: {"error": ...}),
   *  which the CLI would otherwise read as an empty turn. */
  private upstreamError: string | null = null;
  /** Whether the stream reached its own end marker. A stream that stops without
   *  one and without a finish_reason was cut short, which is not end_turn. */
  private sawDone = false;

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
        this.sawDone = true;
        out += this.finish();
        continue;
      }
      let chunk: OpenAIChunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.error) this.upstreamError = chunk.error.message ?? chunk.error.type ?? "Upstream reported an error";
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
      // A fragment with no index belongs to the tool call already in flight,
      // not to index 0: defaulting to 0 split a second call in two.
      const toolIndex = tc.index ?? (this.openBlock === "tool" ? this.openToolIndex : this.lastToolIndex);
      this.lastToolIndex = toolIndex;
      const announced = this.announcedTools.get(toolIndex) ?? { id: `call_${toolIndex}`, name: "" };
      if (tc.id) announced.id = tc.id;
      if (tc.function?.name) announced.name = tc.function.name;
      this.announcedTools.set(toolIndex, announced);

      if (this.openBlock !== "tool" || this.openToolIndex !== toolIndex) {
        out += this.closeBlock();
        this.blockIndex += 1;
        this.openBlock = "tool";
        this.openToolIndex = toolIndex;
        out += this.event("content_block_start", {
          index: this.blockIndex,
          content_block: { type: "tool_use", id: announced.id, name: announced.name, input: {} },
        });
      }
      const args = tc.function?.arguments;
      const partial = typeof args === "string" ? args : args === undefined || args === null ? "" : JSON.stringify(args);
      if (partial) {
        out += this.event("content_block_delta", {
          index: this.blockIndex,
          delta: { type: "input_json_delta", partial_json: partial },
        });
      }
    }
    return out;
  }

  /** Usage from the final OpenAI chunk (stream_options.include_usage), for
   *  metering after the stream closes. */
  getUsage(): OpenAIUsage | null {
    return this.usage;
  }

  /** Close everything out; safe to call once at stream end. */
  finish(): string {
    if (!this.started) return "";
    // An upstream failure or a stream that stopped before its own end is
    // reported as an error event: closed as a normal end_turn, the CLI cannot
    // tell a half-finished answer from a complete one.
    const failure = this.upstreamError ?? (this.sawDone || this.finishReason ? null : "Upstream stream ended before the turn finished");
    if (failure) {
      this.started = false;
      return this.event("error", { error: { type: "api_error", message: failure } });
    }
    let out = this.closeBlock();
    out += this.event("message_delta", {
      delta: { stop_reason: STOP_REASON[this.finishReason ?? "stop"] ?? "end_turn", stop_sequence: null },
      // input_tokens must ride here, not message_start: OpenAI only reports
      // usage in the final chunk (stream_options.include_usage), long after
      // message_start went out with zeros. The CLI merges message_delta usage
      // into its transcript record; without input_tokens the context gauge
      // reads 0 forever and the UI hides the indicator.
      // Cache reads ride along as cache_read_input_tokens, which is what makes
      // a proxied session's cache figures anything other than zero.
      usage: anthropicUsage(this.usage),
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
  // OpenRouter also refuses through a plain {"error":{...}} object with HTTP
  // 200 — moderation on :free models, or "no endpoints found that support X".
  // Measured live (2026-08-23): the CLI's streaming attempt received zero
  // events and its non-streaming retry received exactly this shape, which it
  // reports as "body is JSON but not a Message". Anthropic Messages never
  // carry an "error" key, so its presence in a 200 body is always an error.
  if (t.startsWith("{") && t.slice(0, 200).includes('"error"')) return true;
  return false;
}

/** Best-effort extraction of the upstream error message from a peeked error
 *  body (SSE `data:` line or a JSON error object), for a clearer surfaced
 *  error than the CLI's generic one. */
function saturationMessage(peek: string): string {
  return peek.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? "Upstream provider is temporarily saturated";
}

/** The built-in providers served by opencode.ai. Kept as literals rather than
 *  imported from providers.ts, which imports this module. */
const OPENCODE_PROVIDER_IDS = new Set(["zen", "zen-go"]);

/** OpenCode groups a conversation's requests by x-opencode-session and warns
 *  that from 2026-09-06 requests without one may be rejected; the grouping is
 *  also what lets their side keep a prompt cache warm across a turn. The CLI
 *  already stamps every request with X-Claude-Code-Session-Id, which is stable
 *  for the life of a conversation and distinct per subagent, so it is the id to
 *  forward. Vendor-specific, so it goes to OpenCode alone and not to whatever
 *  endpoint a custom provider points at. Passthrough upstreams need nothing:
 *  they get the CLI's headers verbatim. Only the translated path rebuilds them
 *  from scratch. */
function conversationHeader(req: IncomingMessage, providerId: string): Record<string, string> {
  const id = req.headers["x-claude-code-session-id"];
  if (!OPENCODE_PROVIDER_IDS.has(providerId) || typeof id !== "string" || !id) return {};
  return { "x-opencode-session": id };
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
    const server = createServer((req, res) => {
      // A throw anywhere in a handler would otherwise be an unhandled rejection,
      // which on Node 24 ends the process and takes every proxied session with
      // it. Answer the request instead.
      this.handle(req, res).catch((err) => {
        console.error(`[format-proxy] handler failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) jsonError(res, 502, `Proxy failed: ${err instanceof Error ? err.message : String(err)}`);
        else res.end();
      });
    });
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
      // A provider whose catalog straddles both wires is routed by the model
      // the request names, so the body is read here and handed to whichever
      // path runs. Reading it once also means the relay sends exactly the
      // bytes the translation path would have seen.
      if (upstream.anthropicWireModels?.length) {
        const body = await readBody(req);
        let model: unknown;
        try {
          model = (JSON.parse(body) as { model?: unknown }).model;
        } catch {
          logProxy(providerId, "bad-request-body", { status: 400 });
          jsonError(res, 400, "Invalid JSON body");
          return;
        }
        if (typeof model === "string" && upstream.anthropicWireModels.includes(model)) {
          const relayPath = upstream.anthropicMessagesPath ?? path;
          await this.passthrough(req, res, upstream, relayPath + (query ? `?${query}` : ""), providerId, body, true);
          return;
        }
        await this.proxyMessages(req, res, upstream, providerId, body);
        return;
      }
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
    /** The request body, when the caller has already read it to route by. */
    preReadBody?: string,
    /** Replace whatever auth the client sent with this upstream's own key.
     *  Needed when one provider serves both wires: the CLI on those sessions
     *  authenticates to this proxy with a placeholder token (it is configured
     *  for the translated path), so relaying its headers verbatim would hand
     *  the placeholder to a provider that checks for a real key. */
    ownKeyOnly = false,
  ): Promise<void> {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : (preReadBody ?? (await readBody(req)));
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value !== "string") continue;
      if (key === "host" || key === "connection" || key === "content-length" || key === "transfer-encoding") continue;
      if (ownKeyOnly && (key === "authorization" || key === "x-api-key")) continue;
      headers[key] = value;
    }
    if (ownKeyOnly && upstream.apiKey) {
      headers.authorization = `Bearer ${upstream.apiKey}`;
    } else if (!headers.authorization && !headers["x-api-key"] && upstream.apiKey) {
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
      // A JSON 200 is the shape that slips past saturation detection when a new
      // refusal appears; logging its start makes any such case answerable from
      // debug.jsonl instead of ending at the CLI's "malformed response" again.
      bodyPeek:
        reader && (upstreamRes.headers.get("content-type") ?? "").includes("json")
          ? firstChunk
            ? new TextDecoder().decode(firstChunk).slice(0, 256)
            : ""
          : undefined,
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

  private async proxyMessages(
    req: IncomingMessage,
    res: ServerResponse,
    upstream: ProxyUpstream,
    providerId: string,
    /** The request body, when the caller has already read it to route by. */
    preReadBody?: string,
  ): Promise<void> {
    let anthropicBody: AnthropicRequest;
    try {
      anthropicBody = JSON.parse(preReadBody ?? (await readBody(req)));
    } catch {
      logProxy(providerId, "bad-request-body", { status: 400 });
      jsonError(res, 400, "Invalid JSON body");
      return;
    }

    const openaiBody = anthropicToOpenAIRequest(anthropicBody, {
      effortLevels: upstream.effortByModel?.[anthropicBody.model],
      modelTakesImages: upstream.supportsImageInputByModel?.[anthropicBody.model],
    });
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
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${upstream.apiKey}`, ...conversationHeader(req, providerId) },
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
      // A 200 whose body is an error object: the message the upstream wrote is
      // the only useful thing here, and without this the CLI gets an empty turn
      // and blames the proxy for a malformed response.
      if (body.error) {
        const message = body.error.message ?? body.error.type ?? "Upstream reported an error";
        logProxy(providerId, "error-in-200", { model: anthropicBody.model, stream: false, message: message.slice(0, 300) });
        jsonError(res, 502, message);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(openAIToAnthropicResponse(body)));
      logProxy(providerId, "complete", {
        model: anthropicBody.model,
        stream: false,
        finishReason: body.choices?.[0]?.finish_reason ?? null,
        inputTokens: body.usage?.prompt_tokens ?? null,
        outputTokens: body.usage?.completion_tokens ?? null,
        ...cacheLogFields(body.usage),
      });
      if (body.usage) {
        this.onUsage?.({
          providerId,
          modelId: anthropicBody.model,
          inputTokens: body.usage.prompt_tokens ?? 0,
          outputTokens: body.usage.completion_tokens ?? 0,
          cacheReadTokens: Math.min(cachedPromptTokens(body.usage), body.usage.prompt_tokens ?? 0),
        });
      }
      return;
    }

    const translator = new StreamTranslator();
    const reader = upstreamRes.body?.getReader();
    if (!reader) {
      logProxy(providerId, "stream-no-body", { model: anthropicBody.model });
      res.end(translator.finish());
      return;
    }
    const decoder = new TextDecoder();
    // A 200 that answers a streaming request with a JSON error rather than a
    // stream (or with nothing at all) is answered as an error here: relayed,
    // the CLI sees a turn with no events and reports a malformed response.
    const first = await reader.read();
    const firstText = first.value ? decoder.decode(first.value, { stream: true }) : "";
    const asJsonError = firstText.trim().startsWith("{")
      ? (JSON.parse(firstText) as { error?: { message?: string; type?: string } }).error
      : null;
    if (asJsonError || (first.done && !firstText)) {
      const message = asJsonError?.message ?? asJsonError?.type ?? "Upstream returned an empty response";
      logProxy(providerId, "error-in-200", { model: anthropicBody.model, stream: true, message: message.slice(0, 300) });
      await reader.cancel().catch(() => {});
      jsonError(res, 502, message);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    let aborted: string | null = null;
    try {
      if (firstText) {
        const out = translator.feed(firstText);
        if (out) res.write(out);
      }
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
      ...cacheLogFields(usage),
    });
    if (usage) {
      this.onUsage?.({
        providerId,
        modelId: anthropicBody.model,
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cacheReadTokens: Math.min(cachedPromptTokens(usage), usage.prompt_tokens ?? 0),
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
