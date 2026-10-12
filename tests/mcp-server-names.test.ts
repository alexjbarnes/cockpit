// Whether a job's required MCP server is one this machine can give it: file
// servers must be in the config, account connectors need no evidence because
// they are not file state at all.
import { describe, expect, it } from "vitest";
import { ACCOUNT_CONNECTOR_PREFIX, isAccountConnector, isConfiguredMcpServer } from "@/server/mcp-server-names";

describe("isAccountConnector", () => {
  it("recognises the CLI's naming for a connector", () => {
    expect(isAccountConnector("claude.ai Microsoft 365")).toBe(true);
    expect(isAccountConnector(`${ACCOUNT_CONNECTOR_PREFIX}Gmail`)).toBe(true);
  });

  it("does not mistake a file server for one", () => {
    expect(isAccountConnector("gmail")).toBe(false);
    expect(isAccountConnector("conduit")).toBe(false);
    expect(isAccountConnector("claude.ai-something")).toBe(false);
  });
});

describe("isConfiguredMcpServer", () => {
  it("finds a file server in the configured list", () => {
    expect(isConfiguredMcpServer("gmail", ["gmail", "conduit"])).toBe(true);
    expect(isConfiguredMcpServer("conduit", ["gmail"])).toBe(false);
  });

  it("accepts a connector with nothing configured at all", () => {
    expect(isConfiguredMcpServer("claude.ai Microsoft 365", [])).toBe(true);
  });
});
