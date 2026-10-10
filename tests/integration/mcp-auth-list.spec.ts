// The MCP Servers page reads the CLI's own view of the machine (`claude mcp
// list`), which is the only place a server's connection state exists. This
// proves that path end to end with the real binary: cockpit spawns the CLI,
// parses what it prints, and the page renders it.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";
import type { Harness } from "./harness";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_AVAILABLE = (() => {
  try {
    execSync(`${CLAUDE_BIN} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test.skip(!CLAUDE_AVAILABLE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);

/** A stdio MCP server that answers the handshake and nothing else. */
const PROBE_SERVER = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  const result =
    msg.method === "initialize"
      ? { protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05", capabilities: {}, serverInfo: { name: "it-probe", version: "1.0.0" } }
      : { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
`;

function addUserScopeServer(harness: Harness, name: string, command: string, args: string[]): void {
  const file = path.join(harness.claudeDir, ".claude.json");
  const config = JSON.parse(readFileSync(file, "utf-8")) as { mcpServers?: Record<string, unknown> };
  config.mcpServers = { ...(config.mcpServers ?? {}), [name]: { type: "stdio", command, args } };
  writeFileSync(file, JSON.stringify(config, null, 2));
}

test("the page reports a configured server from the CLI's own health check", async ({ page, harness }) => {
  test.setTimeout(180_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-mcpauth-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    const serverScript = path.join(workDir, "probe-server.cjs");
    writeFileSync(serverScript, PROBE_SERVER);
    addUserScopeServer(harness, "it-probe", "node", [serverScript]);

    const res = await page.request.get(`${harness.cockpitUrl}/api/mcp-servers/connectors?cwd=${encodeURIComponent(workDir)}`);
    expect(res.ok()).toBe(true);
    const list = (await res.json()) as { servers: { name: string; scope: string; status: string }[] };

    const probe = list.servers.find((s) => s.name === "it-probe");
    expect(probe).toBeDefined();
    expect(probe?.scope).toBe("local");
    expect(probe?.status).toBe("connected");
    // No Claude account in the harness, so nothing is reported as a connector.
    expect(list.servers.some((s) => s.scope === "connector")).toBe(false);

    // The page shows it too, alongside the account section's empty state.
    await page.goto(`${harness.cockpitUrl}/mcp-servers`);
    await expect(page.getByText("it-probe")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("connectors-empty")).toBeVisible({ timeout: 30_000 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
