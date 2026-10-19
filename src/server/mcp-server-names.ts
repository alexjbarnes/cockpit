/**
 * Whether a name in a job's MCP-server list is one this machine can actually
 * give it. A leaf module (no imports) so the job scheduler and mcp-discovery
 * share it without pulling either's dependencies into the other — and so a
 * unit test can use it without mocking a module graph.
 */

/** Account connectors are named `claude.ai <name>` in every CLI listing (see
 *  mcp-auth.ts) and live on the Claude account rather than in a config file. */
export const ACCOUNT_CONNECTOR_PREFIX = "claude.ai ";

export function isAccountConnector(name: string): boolean {
  return name.startsWith(ACCOUNT_CONNECTOR_PREFIX);
}

/**
 * Account connectors count as present without evidence: nothing cockpit reads
 * tells it whether one exists on the account without asking the CLI (`claude
 * mcp list`, seconds), and treating them as missing failed every scheduled job
 * whose list named one, instantly, before it ran. A connector that genuinely is
 * not there costs a run without it, which is what the CLI did before the
 * pre-flight existed.
 */
export function isConfiguredMcpServer(name: string, configured: Iterable<string>): boolean {
  if (isAccountConnector(name)) return true;
  for (const known of configured) if (known === name) return true;
  return false;
}
