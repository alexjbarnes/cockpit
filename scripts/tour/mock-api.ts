// A stand-in Anthropic API for the tour: the real Claude CLI talks to it, and a
// director function decides each reply from the request, so every session in
// the video says exactly what the script wants, with no account or key.
//
// Replies stream the way the real API does (text in small deltas), so the chat
// fills in at a readable pace rather than all at once.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Reply {
  /** Markdown the assistant says. With tools, it is said before them. */
  text?: string;
  tools?: ToolCall[];
  /** Hold before the first byte, to keep a turn visibly in flight. */
  delayMs?: number;
  /** Milliseconds between text deltas. */
  pace?: number;
  /** Token usage reported for the request. */
  usage?: { input: number; output: number; cacheRead?: number };
}

export interface ApiRequest {
  raw: string;
  model: string;
  system: string;
  /** Text of the newest user message. */
  lastUserText: string;
  /** Tool result ids in the newest user message. */
  toolResultIds: string[];
  /** Every user text in the conversation, oldest first. */
  userTexts: string[];
}

export type Director = (req: ApiRequest) => Reply;

interface Block {
  type: string;
  text?: string;
  tool_use_id?: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

function parse(raw: string): ApiRequest {
  let body: { model?: string; system?: unknown; messages?: Array<{ role: string; content: unknown }> } = {};
  try {
    body = JSON.parse(raw);
  } catch {
    // An unreadable body gets the director's fallback.
  }
  const messages = body.messages ?? [];
  const users = messages.filter((m) => m.role === "user");
  const last = users[users.length - 1];
  const toolResultIds = Array.isArray(last?.content)
    ? (last.content as Block[]).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id ?? "")
    : [];
  return {
    raw,
    model: body.model ?? "",
    system: textOf(body.system),
    lastUserText: textOf(last?.content),
    toolResultIds,
    userTexts: users.map((m) => textOf(m.content)).filter(Boolean),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
  });
}

/** Words grouped into deltas of a few at a time, keeping the spaces. */
function chunks(text: string): string[] {
  const parts = text.match(/\S+\s*/g) ?? [text];
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 3) out.push(parts.slice(i, i + 3).join(""));
  return out;
}

let seq = 0;

function events(reply: Reply, model: string): Array<{ event: string; data: unknown }> {
  const out: Array<{ event: string; data: unknown }> = [];
  const usage = reply.usage ?? { input: 2400, output: 180 };
  out.push({
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: `msg_tour_${++seq}`,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input, output_tokens: 1, cache_read_input_tokens: usage.cacheRead ?? 0 },
      },
    },
  });
  let index = 0;
  if (reply.text) {
    out.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
    for (const piece of chunks(reply.text)) {
      out.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } } });
    }
    out.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    index++;
  }
  for (const tool of reply.tools ?? []) {
    out.push({
      event: "content_block_start",
      data: { type: "content_block_start", index, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } },
    });
    out.push({
      event: "content_block_delta",
      data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } },
    });
    out.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    index++;
  }
  out.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: reply.tools?.length ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { input_tokens: usage.input, output_tokens: usage.output },
    },
  });
  out.push({ event: "message_stop", data: { type: "message_stop" } });
  return out;
}

function stream(res: ServerResponse, reply: Reply, model: string): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const list = events(reply, model);
  let i = 0;
  const pace = reply.pace ?? 28;
  const next = () => {
    if (i >= list.length) {
      res.end();
      return;
    }
    const ev = list[i++];
    res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    const isDelta = (ev.data as { type?: string }).type === "content_block_delta";
    setTimeout(next, isDelta ? pace : 4);
  };
  setTimeout(next, reply.delayMs ?? 250);
}

/** OpenAI's streaming shape, for providers cockpit reaches through its format
 *  proxy. Text only. */
function streamOpenAI(res: ServerResponse, reply: Reply): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const pieces = chunks(reply.text ?? "Done.");
  let i = 0;
  const next = () => {
    if (i < pieces.length) {
      res.write(
        `data: ${JSON.stringify({ id: "chatcmpl-tour", choices: [{ delta: { content: pieces[i++] }, finish_reason: null }] })}\n\n`,
      );
      setTimeout(next, reply.pace ?? 28);
      return;
    }
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2400, completion_tokens: 160 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  };
  setTimeout(next, reply.delayMs ?? 250);
}

export interface MockApi {
  port: number;
  url: string;
  setDirector(director: Director): void;
  stop(): Promise<void>;
}

export function startMockApi(initial: Director, extraRoutes: Record<string, unknown> = {}): Promise<MockApi> {
  let director = initial;
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path in extraRoutes) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(extraRoutes[path]));
      return;
    }
    if (req.method === "POST" && path.endsWith("/messages/count_tokens")) {
      void readBody(req).then(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 2400 }));
      });
      return;
    }
    if (req.method === "POST" && path.endsWith("/messages")) {
      void readBody(req).then((raw) => {
        const parsed = parse(raw);
        stream(res, director(parsed), parsed.model || "claude-sonnet-5-5");
      });
      return;
    }
    if (req.method === "POST" && path.endsWith("/chat/completions")) {
      void readBody(req).then((raw) => streamOpenAI(res, director(parse(raw))));
      return;
    }
    void readBody(req).then(() => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "not_found", message: `No tour route for ${req.method} ${path}` } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        setDirector(d) {
          director = d;
        },
        stop: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
