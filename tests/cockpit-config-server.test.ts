import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.COCKPIT_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cockpit-test-"));
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "claude-test-"));

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

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const res = await mcpPost({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 10000),
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect(res.status).toBe(200);
  return (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text;
}

async function callToolParsed(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const text = await callTool(name, args);
  return JSON.parse(text as string);
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

  it("returns 404 for non-/mcp paths", async () => {
    const res = await fetch(`${baseUrl}/other`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for GET requests", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("responds to initialize", async () => {
    const res = await mcpPost({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    });
    expect(res.status).toBe(200);
    const body = res.body as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("cockpit-config");
  });

  it("tools/list returns all expected tool names", async () => {
    const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
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

  describe("jobs", () => {
    it("list_jobs returns empty array initially", async () => {
      const result = await callToolParsed("list_jobs");
      expect(Array.isArray(result)).toBe(true);
    });

    it("create_job writes via job-storage", async () => {
      const result = (await callToolParsed("create_job", {
        name: "test-job",
        schedule: { type: "simple", frequency: "hourly" },
        prompt: "run tests",
        cwd: "/tmp",
      })) as { created: { name: string; id: string } };
      expect(result.created.name).toBe("test-job");
      expect(result.created.id).toBeDefined();
    });

    it("list_jobs returns the created job", async () => {
      const result = (await callToolParsed("list_jobs")) as { name: string }[];
      expect(Array.isArray(result)).toBe(true);
      expect(result.some((j) => j.name === "test-job")).toBe(true);
    });

    it("get_job returns job by id", async () => {
      const jobs = (await callToolParsed("list_jobs")) as { id: string; name: string }[];
      const job = jobs.find((j) => j.name === "test-job")!;
      const result = (await callToolParsed("get_job", { id: job.id })) as { name: string };
      expect(result.name).toBe("test-job");
    });

    it("get_job returns error for unknown id", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "get_job", arguments: { id: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });

    it("update_job modifies the job", async () => {
      const jobs = (await callToolParsed("list_jobs")) as { id: string; name: string }[];
      const job = jobs.find((j) => j.name === "test-job")!;
      const result = (await callToolParsed("update_job", { id: job.id, name: "updated-job" })) as { after: { name: string } };
      expect(result.after.name).toBe("updated-job");
    });

    it("update_job returns error for unknown id", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "update_job", arguments: { id: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });

    it("delete_job removes the job", async () => {
      const jobs = (await callToolParsed("list_jobs")) as { id: string; name: string }[];
      const job = jobs.find((j) => j.name === "updated-job")!;
      const result = (await callToolParsed("delete_job", { id: job.id })) as { deleted: { name: string } };
      expect(result.deleted.name).toBe("updated-job");
      const after = (await callToolParsed("list_jobs")) as { name: string }[];
      expect(after.some((j) => j.name === "updated-job")).toBe(false);
    });

    it("delete_job returns error for unknown id", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "delete_job", arguments: { id: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });
  });

  describe("settings", () => {
    it("get_settings returns defaults", async () => {
      const result = (await callToolParsed("get_settings")) as Record<string, unknown>;
      expect(result).toHaveProperty("thinkingLevel");
      expect(result).toHaveProperty("diffStyle");
    });

    it("update_settings changes thinkingLevel", async () => {
      const result = (await callToolParsed("update_settings", { thinkingLevel: "low" })) as {
        before: unknown;
        after: { thinkingLevel: string };
      };
      expect(result.after.thinkingLevel).toBe("low");
    });

    it("update_settings blocks bypassAllPermissions", async () => {
      await callTool("update_settings", { bypassAllPermissions: true });
      const settings = (await callToolParsed("get_settings")) as { bypassAllPermissions?: boolean };
      expect(settings.bypassAllPermissions).not.toBe(true);
    });
  });

  describe("providers", () => {
    it("list_providers returns empty array initially", async () => {
      const result = await callToolParsed("list_providers");
      expect(Array.isArray(result)).toBe(true);
    });

    it("add_provider creates a provider", async () => {
      const result = (await callToolParsed("add_provider", {
        name: "test-provider",
        envVars: { API_KEY: "test-key" },
      })) as { created: { name: string; id: string } };
      expect(result.created.name).toBe("test-provider");
      expect(result.created.id).toBeDefined();
    });

    it("list_providers returns created provider", async () => {
      const result = (await callToolParsed("list_providers")) as { name: string }[];
      expect(result.some((p) => p.name === "test-provider")).toBe(true);
    });

    it("update_provider modifies provider", async () => {
      const providers = (await callToolParsed("list_providers")) as { id: string; name: string }[];
      const p = providers.find((p) => p.name === "test-provider")!;
      const result = (await callToolParsed("update_provider", { id: p.id, name: "renamed-provider" })) as { after: { name: string } };
      expect(result.after.name).toBe("renamed-provider");
    });

    it("update_provider returns error for unknown id", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "update_provider", arguments: { id: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });

    it("delete_provider removes provider", async () => {
      const providers = (await callToolParsed("list_providers")) as { id: string; name: string }[];
      const p = providers.find((p) => p.name === "renamed-provider")!;
      const result = (await callToolParsed("delete_provider", { id: p.id })) as { deleted: { name: string } };
      expect(result.deleted.name).toBe("renamed-provider");
    });

    it("delete_provider returns error for unknown id", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "delete_provider", arguments: { id: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });
  });

  describe("mcp-servers", () => {
    it("list_mcp_servers returns empty initially", async () => {
      const result = await callToolParsed("list_mcp_servers");
      expect(Array.isArray(result)).toBe(true);
    });

    it("save_mcp_server creates an entry", async () => {
      const result = (await callToolParsed("save_mcp_server", {
        name: "test-mcp",
        command: "node",
        args: ["/path/to/server.js"],
      })) as { after: { command: string } };
      expect(result.after.command).toBe("node");
    });

    it("get_mcp_server retrieves the entry", async () => {
      const result = (await callToolParsed("get_mcp_server", { name: "test-mcp" })) as { command: string };
      expect(result.command).toBe("node");
    });

    it("get_mcp_server returns error for unknown name", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "get_mcp_server", arguments: { name: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });

    it("delete_mcp_server removes the entry", async () => {
      const result = (await callToolParsed("delete_mcp_server", { name: "test-mcp" })) as { deleted: { command: string } };
      expect(result.deleted.command).toBe("node");
    });

    it("delete_mcp_server returns error for unknown name", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "delete_mcp_server", arguments: { name: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });
  });

  describe("notification settings", () => {
    it("get_notification_settings returns settings", async () => {
      const result = (await callToolParsed("get_notification_settings")) as Record<string, unknown>;
      expect(result).toHaveProperty("providers");
    });

    it("update_notification_settings changes baseUrl", async () => {
      const result = (await callToolParsed("update_notification_settings", { baseUrl: "https://example.com/hook" })) as {
        after: { baseUrl?: string };
      };
      expect(result.after.baseUrl).toBe("https://example.com/hook");
    });
  });

  it("returns error for unknown tool", async () => {
    const res = await mcpPost({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    });
    const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
    expect(JSON.parse(text).error).toContain("Unknown tool");
  });
});
