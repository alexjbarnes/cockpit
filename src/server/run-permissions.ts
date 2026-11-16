// How an unattended run's permission prompts are answered from an allowlist:
// which tools a list of rules permits, and which MCP tools a list of servers
// and filters does. Shared by scheduled jobs and workflow stages.

/**
 * The MCP tool a run reports through. Replaces parsing a fenced block out of the
 * final message, which failed silently: a job could spend seventeen minutes on a
 * report, emit the block as YAML instead of JSON, and have it dropped with the
 * run still recorded a success. A tool call is schema-validated, and a rejection
 * comes back as an error the model can read and retry.
 */
export const INBOX_TOOL_NAME = "mcp__cockpit-config__add_inbox_message";

/**
 * Does `cmd` chain in another command? A `Bash <prefix>` rule only vouches for
 * the program it names, so anything that can run a second one is refused.
 *
 * Scanned with quote awareness, following the shell's own rules, because the
 * characters only mean "operator" when the shell would treat them as one:
 *   - single quotes: everything inside is literal, nothing can execute
 *   - double quotes: `;` `&` `|` `>` `<` are literal, but `$(` and backticks
 *     still substitute, so those stay refused
 *   - a backslash escapes the next character (except inside single quotes)
 * A blanket regex over the raw text refused ordinary payloads instead — a
 * semicolon in a `curl --data-urlencode "notes=a; b"` value, or the `&`
 * between form fields — while adding no safety, since a quoted metacharacter
 * was never going to execute anything.
 *
 * A single unquoted `|` counts: `curl <url> | sh` runs whatever the URL
 * serves, so a pipe hands execution to a program the rule never named. That
 * also means a rule cannot permit a pipeline — narrow each stage's own rule
 * and let the job run the stages as separate commands.
 *
 * An unterminated quote is malformed; refuse rather than guess at it.
 */
export function hasShellOperators(cmd: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    // Backslash escapes the following character everywhere but single quotes.
    if (ch === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      // Command substitution survives double quoting.
      else if (ch === "`" || (ch === "$" && cmd[i + 1] === "(")) return true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === ">" || ch === "<" || ch === "`") return true;
    if (ch === "$" && cmd[i + 1] === "(") return true;
  }
  return quote !== null;
}

function parseToolRule(rule: string): { tool: string; restriction?: string } {
  const spaceIdx = rule.indexOf(" ");
  if (spaceIdx > 0) return { tool: rule.slice(0, spaceIdx), restriction: rule.slice(spaceIdx + 1) };
  return { tool: rule };
}

export function isToolAllowed(toolName: string, toolInput: string, rules: string[]): boolean {
  for (const rule of rules) {
    const { tool, restriction } = parseToolRule(rule);
    if (tool !== toolName) continue;
    if (!restriction) return true;
    if (toolName === "Bash") {
      let cmd = "";
      try {
        cmd = (JSON.parse(toolInput) as { command?: string }).command || "";
      } catch {
        cmd = toolInput;
      }
      const trimmed = cmd.trim();
      if (hasShellOperators(trimmed)) continue;
      if (trimmed === restriction || trimmed.startsWith(`${restriction} `)) return true;
    }
  }
  return false;
}

function normalizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * The prefixes a server's tool names may carry. The CLI does not always
 * normalise: a server configured as `cockpit-config` emits
 * `mcp__cockpit-config__list_projects`, hyphen intact. Matching only the
 * normalised form denied every call to any server whose name was not already
 * alphanumeric, so both spellings are accepted. Filters stay keyed by the
 * configured name, which is what the job editor and storage use.
 */
function mcpPrefixes(serverName: string): string[] {
  return [...new Set([serverName, normalizeMcpName(serverName)])].map((n) => `${n}__`);
}

export function isMcpToolAllowed(
  toolName: string,
  toolInput: string,
  enabledServers: Set<string>,
  mcpToolFilters?: Record<string, string[]>,
): boolean | null {
  if (!toolName.startsWith("mcp__")) return null;
  const remainder = toolName.slice(5);

  for (const serverName of enabledServers) {
    const prefix = mcpPrefixes(serverName).find((p) => remainder.startsWith(p));
    if (!prefix) continue;
    const tool = remainder.slice(prefix.length);
    if (!mcpToolFilters || !(serverName in mcpToolFilters)) return true;
    const filters = mcpToolFilters[serverName];
    for (const filter of filters) {
      if (filter === tool) return true;
      if (filter.includes(":")) {
        let parsed: { server?: string; tool?: string };
        try {
          parsed = JSON.parse(toolInput) as { server?: string; tool?: string };
        } catch {
          continue;
        }
        const [filterServer, filterTool] = filter.split(":", 2);
        if (parsed.server === filterServer) {
          if (filterTool === "*" || parsed.tool === filterTool) return true;
        }
      }
    }
    return false;
  }

  return false;
}
