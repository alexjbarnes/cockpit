import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMcpConfigArg } from "@/server/session-manager";

describe("buildMcpConfigArg", () => {
  it("writes a file with type http, the correct url, and the Bearer header", () => {
    const url = "http://127.0.0.1:39999";
    const token = "abc123test456token";
    const result = buildMcpConfigArg(url, token);

    expect(typeof result.path).toBe("string");
    expect(existsSync(result.path)).toBe(true);

    const config = JSON.parse(readFileSync(result.path, "utf-8"));
    const entry = config.mcpServers?.["cockpit-config"];
    expect(entry).toBeDefined();
    expect(entry.type).toBe("http");
    expect(entry.url).toBe(`${url}/mcp`);
    expect(entry.headers?.Authorization).toBe(`Bearer ${token}`);
  });

  it("creates the file with mode 0600 (no group or other read)", () => {
    const result = buildMcpConfigArg("http://127.0.0.1:12345", "mode-test-token-xyz");
    const mode = statSync(result.path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("different tokens produce distinct file paths", () => {
    const a = buildMcpConfigArg("http://127.0.0.1:1", "aaaa1111bbbb2222cccc3333");
    const b = buildMcpConfigArg("http://127.0.0.1:1", "dddd4444eeee5555ffff6666");
    expect(a.path).not.toBe(b.path);
  });
});
