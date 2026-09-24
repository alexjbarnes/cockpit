// A page that connects to a running session must be told the mode the CLI
// reports, not only the one that was chosen, since the two can part.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const emitter = new EventEmitter();
    const stdin = new (require("node:stream").PassThrough)();
    return Object.assign(emitter, { pid: 99999, stdin, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  }),
}));

vi.mock("@/server/plans", () => ({ findLatestPlanFile: () => null, readPlanFile: () => null }));

import { createSession as createAuthSession, setupPassword } from "@/server/auth";
import { SessionManager } from "@/server/session-manager";
import { TerminalManager } from "@/server/terminal-manager";
import { createWebSocketHandler } from "@/server/ws-handler";

beforeAll(async () => {
  await setupPassword("test-password");
});

describe("the CLI's real permission mode on connect", () => {
  let server: Server;
  let manager: SessionManager;
  let port: number;
  let validToken: string;
  let sandbox: string;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        sandbox = mkdtempSync(join(tmpdir(), "cli-perm-mode-"));
        manager = new SessionManager({ defaultRuntime: "stream" });
        server = createServer();
        createWebSocketHandler(server, manager, new TerminalManager());
        validToken = createAuthSession();
        server.listen(0, () => {
          const addr = server.address();
          port = typeof addr === "object" && addr ? addr.port : 0;
          resolve();
        });
      }),
  );

  afterEach(() => {
    server.close();
    rmSync(sandbox, { recursive: true, force: true });
  });

  async function systemTextsOnConnect(sessionId: string): Promise<string[]> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${port}/ws?token=${validToken}`);
      socket.on("open", () => resolve(socket));
      socket.on("error", reject);
    });
    const messages: Record<string, unknown>[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    ws.send(JSON.stringify({ type: "session:connect", sessionId, cwd: sandbox }));
    await vi.waitFor(() => expect(messages.some((m) => m.type === "session:status")).toBe(true), { timeout: 5000, interval: 20 });
    ws.close();
    return messages.filter((m) => m.type === "session:system").map((m) => m.text as string);
  }

  it("replays the mode the CLI last reported", async () => {
    const session = manager.createSession(sandbox);
    (manager as unknown as { sessions: Map<string, { cliPermissionMode?: string }> }).sessions.get(session.id)!.cliPermissionMode = "auto";

    expect(await systemTextsOnConnect(session.id)).toContain("__cli_perm_mode::auto");
  });

  it("says nothing before the CLI has reported a mode", async () => {
    const session = manager.createSession(sandbox);

    const texts = await systemTextsOnConnect(session.id);
    expect(texts.some((t) => t.startsWith("__cli_perm_mode::"))).toBe(false);
  });
});
