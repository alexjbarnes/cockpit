import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFailed } from "vitest";

let nextId = 1;

interface PendingRequest {
  id: number;
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

function startServer(tempDir: string): {
  proc: ChildProcess;
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  kill: () => void;
} {
  const serverPath = join(__dirname, "..", "dist", "src", "server", "mcp", "cockpit-config-server.js");
  const proc = spawn("node", [serverPath], {
    env: { ...process.env, COCKPIT_CONFIG_DIR: tempDir },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map<number, PendingRequest>();
  let buffer = "";

  proc.stdout?.setEncoding("utf-8");
  proc.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.id && pending.has(parsed.id)) {
          const p = pending.get(parsed.id)!;
          pending.delete(parsed.id);
          p.resolve(parsed);
        }
      } catch {
        process.stderr.write(`[cockpit-test] unparseable: ${line}\n`);
      }
    }
  });

  proc.stderr?.setEncoding("utf-8");
  proc.stderr?.on("data", (chunk: string) => {
    process.stderr.write(`[cockpit-test stderr] ${chunk}`);
  });

  function send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const request = { jsonrpc: "2.0", id, method, params };
      pending.set(id, { id, resolve, reject });
      proc.stdin?.write(JSON.stringify(request) + "\n");
    });
  }

  return {
    proc,
    send,
    kill: () => proc.kill(),
  };
}

describe("cockpit-config MCP server", () => {
  it("responds to initialize and tools/list with all tool names", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cockpit-test-"));

    const server = startServer(tempDir);
    onTestFailed(() => server.kill());

    try {
      const initRes = await server.send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      expect((initRes.result as { serverInfo?: { name?: string } })?.serverInfo?.name).toBe("cockpit-config");

      // Send initialized notification (no response expected)
      server.proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      const listRes = await server.send("tools/list");
      const tools = (listRes.result as { tools: { name: string }[] })?.tools || [];
      const toolNames = tools.map((t: { name: string }) => t.name).sort();

      expect(toolNames).toContain("list_jobs");
      expect(toolNames).toContain("get_job");
      expect(toolNames).toContain("create_job");
      expect(toolNames).toContain("update_job");
      expect(toolNames).toContain("delete_job");
      expect(toolNames).toContain("get_settings");
      expect(toolNames).toContain("update_settings");
      expect(toolNames).toContain("list_providers");
      expect(toolNames).toContain("add_provider");
      expect(toolNames).toContain("update_provider");
      expect(toolNames).toContain("delete_provider");
      expect(toolNames).toContain("list_mcp_servers");
      expect(toolNames).toContain("get_mcp_server");
      expect(toolNames).toContain("save_mcp_server");
      expect(toolNames).toContain("delete_mcp_server");
      expect(toolNames).toContain("get_notification_settings");
      expect(toolNames).toContain("update_notification_settings");
    } finally {
      server.kill();
    }
  }, 15000);

  it("create_job writes post to JSON file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cockpit-test-"));

    const server = startServer(tempDir);
    onTestFailed(() => server.kill());

    try {
      await server.send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      server.proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      const createRes = await server.send("tools/call", {
        name: "create_job",
        arguments: {
          name: "test-job",
          schedule: { type: "simple", frequency: "hourly" },
          prompt: "run tests",
          cwd: "/tmp",
        },
      });

      const text = (createRes.result as { content: { text: string }[] })?.content?.[0]?.text || "";
      const parsed = JSON.parse(text);
      expect(parsed.created.name).toBe("test-job");
      expect(parsed.created.id).toBeDefined();

      const filePath = join(tempDir, "scheduled-jobs.json");
      expect(existsSync(filePath)).toBe(true);
      const fileContent = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(fileContent.jobs.length).toBe(1);
      expect(fileContent.jobs[0].name).toBe("test-job");
    } finally {
      server.kill();
    }
  }, 15000);

  it("update_settings returns before/after and writes file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cockpit-test-"));

    const server = startServer(tempDir);
    onTestFailed(() => server.kill());

    try {
      await server.send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      server.proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      const updateRes = await server.send("tools/call", {
        name: "update_settings",
        arguments: { thinkingLevel: "low" },
      });

      const text = (updateRes.result as { content: { text: string }[] })?.content?.[0]?.text || "";
      const parsed = JSON.parse(text);
      expect(parsed.before).toBeDefined();
      expect(parsed.after.thinkingLevel).toBe("low");

      const filePath = join(tempDir, "defaults.json");
      expect(existsSync(filePath)).toBe(true);
      const fileContent = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(fileContent.thinkingLevel).toBe("low");
    } finally {
      server.kill();
    }
  }, 15000);

  it("delete_job with non-existent id returns error not crash", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cockpit-test-"));

    const server = startServer(tempDir);
    onTestFailed(() => server.kill());

    try {
      await server.send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      server.proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      const deleteRes = await server.send("tools/call", {
        name: "delete_job",
        arguments: { id: "nonexistent-id" },
      });

      const text = (deleteRes.result as { content: { text: string }[] })?.content?.[0]?.text || "";
      const parsed = JSON.parse(text);
      expect(parsed.error).toContain("not found");
    } finally {
      server.kill();
    }
  }, 15000);

  it("add_provider then list_providers shows new provider", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cockpit-test-"));

    const server = startServer(tempDir);
    onTestFailed(() => server.kill());

    try {
      await server.send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      server.proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      const addRes = await server.send("tools/call", {
        name: "add_provider",
        arguments: {
          name: "test-provider",
          envVars: { API_KEY: "test" },
        },
      });

      const addText = (addRes.result as { content: { text: string }[] })?.content?.[0]?.text || "";
      const addParsed = JSON.parse(addText);
      expect(addParsed.created.name).toBe("test-provider");
      expect(addParsed.created.id).toBeDefined();

      const listRes = await server.send("tools/call", {
        name: "list_providers",
        arguments: {},
      });

      const listText = (listRes.result as { content: { text: string }[] })?.content?.[0]?.text || "";
      const listParsed = JSON.parse(listText);
      expect(Array.isArray(listParsed)).toBe(true);
      expect(listParsed.length).toBeGreaterThanOrEqual(1);
      expect(listParsed.some((p: { name: string }) => p.name === "test-provider")).toBe(true);
    } finally {
      server.kill();
    }
  }, 15000);
});
