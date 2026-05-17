// Mock Anthropic Messages API server for e2e testing
//
// Speaks the SSE streaming protocol that Claude Code expects from the API.
// Each test posts a response script via POST /__script, and the server plays
// it back when Claude Code sends POST /v1/messages requests.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resetSeq } from "./builder";
import type { TurnScript } from "./types";

export interface MockApiServer {
  readonly port: number;
  /** Set the response script for subsequent conversations */
  setScript(script: TurnScript[]): void;
  /** Return all requests received so far (for debugging) */
  getRequests(): StoredRequest[];
  /** Reset state between tests */
  reset(): void;
  /** Shut down the server */
  stop(): Promise<void>;
}

interface StoredRequest {
  timestamp: number;
  method: string;
  url: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

export function createMockApiServer(): Promise<MockApiServer> {
  return new Promise((resolve) => {
    let script: TurnScript[] = [];
    let turnIndex = 0;
    const requests: StoredRequest[] = [];

    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // CORS for test control endpoints
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, anthropic-version, anthropic-beta");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // ── Control endpoints ──────────────────────────────────────────

      if (req.method === "POST" && req.url === "/__script") {
        readBody(req).then((body) => {
          script = JSON.parse(body) as TurnScript[];
          turnIndex = 0;
          resetSeq();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, turns: script.length }));
        });
        return;
      }

      if (req.method === "GET" && req.url === "/__requests") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(requests));
        return;
      }

      if (req.method === "POST" && req.url === "/__reset") {
        script = [];
        turnIndex = 0;
        requests.length = 0;
        resetSeq();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── Anthropic Messages API ──────────────────────────────────────

      if (req.method === "POST" && req.url === "/v1/messages") {
        const auth = req.headers.authorization || "";
        if (!auth.startsWith("Bearer ") || !auth.slice(7).trim()) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { type: "authentication_error", message: "Missing API key" } }));
          return;
        }

        readBody(req).then((raw) => {
          requests.push({
            timestamp: Date.now(),
            method: req.method!,
            url: req.url!,
            body: raw,
            headers: req.headers as Record<string, string | string[] | undefined>,
          });

          if (script.length === 0) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { type: "server_error", message: "No script configured — POST /__script first" } }));
            return;
          }

          const turn = script[turnIndex] ?? script[script.length - 1];
          const isError = turn.events.length > 0 && turn.events[0].event === "__error__";

          if (isError) {
            const err = turn.events[0].data as { status: number; body: Record<string, unknown> };
            res.writeHead(err.status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(err.body));
            return;
          }

          // SSE streaming response
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Transfer-Encoding": "chunked",
          });

          let i = 0;
          function flushNext() {
            if (i >= turn.events.length) {
              res.end();
              turnIndex = Math.min(turnIndex + 1, script.length - 1);
              return;
            }
            const ev = turn.events[i++];
            // Small delay between events to simulate streaming
            const delay = i === 1 ? 0 : 5;
            setTimeout(() => {
              res.write(`event: ${ev.event}\n`);
              res.write(`data: ${JSON.stringify(ev.data)}\n\n`);
              flushNext();
            }, delay);
          }
          flushNext();
        });
        return;
      }

      // ── 404 ──────────────────────────────────────────────────────────

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "not_found", message: `Unknown endpoint: ${req.method} ${req.url}` } }));
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Failed to start mock API server");
      }

      resolve({
        port: addr.port,
        setScript(s: TurnScript[]) {
          script = s;
          turnIndex = 0;
          resetSeq();
        },
        getRequests(): StoredRequest[] {
          return [...requests];
        },
        reset() {
          script = [];
          turnIndex = 0;
          requests.length = 0;
          resetSeq();
        },
        stop(): Promise<void> {
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}
