import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.COCKPIT_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cockpit-test-"));

import { CockpitMcpServer } from "@/server/mcp/cockpit-config-server";
import { registerAuthToken } from "@/server/mcp/run-context";

const HOST = "127.0.0.1";
let server: CockpitMcpServer;
let baseUrl: string;
let token: string;

beforeAll(async () => {
  server = new CockpitMcpServer();
  await server.start(HOST, 0);
  baseUrl = server.getUrl(HOST);
  token = "test-token-abc123";
  registerAuthToken(token);
});

afterAll(async () => {
  await server.stop();
});

async function mcpPost(body: unknown, authToken = token): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // SSE or other format — parse the data line
    const match = text.match(/^data: (.+)$/m);
    if (match) {
      try {
        parsed = JSON.parse(match[1]);
      } catch {
        parsed = text;
      }
    }
  }
  return { status: res.status, body: parsed };
}

describe("cockpit-config MCP server (in-process HTTP)", () => {
  it("rejects request with no token", async () => {
    const res = await mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "");
    expect(res.status).toBe(401);
  });

  it("rejects request with invalid token", async () => {
    const res = await mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "invalid-token-xyz");
    expect(res.status).toBe(401);
  });

  it("responds to initialize", async () => {
    const res = await mcpPost({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("cockpit-config");
  });

  it("tools/list returns all expected tool names", async () => {
    const res = await mcpPost({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(res.status).toBe(200);
    const body = res.body as { result?: { tools: { name: string }[] } };
    const names = (body.result?.tools ?? []).map((t) => t.name).sort();
    for (const name of [
      "list_jobs",
      "get_job",
      "create_job",
      "update_job",
      "delete_job",
      "get_settings",
      "update_settings",
      "list_providers",
      "add_provider",
      "update_provider",
      "delete_provider",
      "list_mcp_servers",
      "get_mcp_server",
      "save_mcp_server",
      "delete_mcp_server",
      "get_notification_settings",
      "update_notification_settings",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("create_job writes via job-storage", async () => {
    const res = await mcpPost({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "create_job",
        arguments: {
          name: "test-job",
          schedule: { type: "simple", frequency: "hourly" },
          prompt: "run tests",
          cwd: "/tmp",
        },
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { result?: { content: { text: string }[] } };
    const text = body.result?.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.created.name).toBe("test-job");
    expect(parsed.created.id).toBeDefined();

    // Verify job persisted via list_jobs
    const listRes = await mcpPost({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_jobs", arguments: {} },
    });
    const listBody = listRes.body as { result?: { content: { text: string }[] } };
    const jobs = JSON.parse(listBody.result?.content?.[0]?.text ?? "[]");
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.some((j: { name: string }) => j.name === "test-job")).toBe(true);
  });
});
