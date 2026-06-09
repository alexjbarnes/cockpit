const DOMAIN_LABELS: Record<string, Record<string, string>> = {
  job: {
    name: "Name",
    schedule: "Schedule",
    schedules: "Schedules",
    prompt: "Prompt",
    cwd: "Working directory",
    enabled: "Enabled",
    model: "Model",
    contextSize: "Context size",
    thinkingLevel: "Thinking level",
    bypassPermissions: "Bypass permissions",
    maxDurationMinutes: "Max duration",
    retentionDays: "Retention days",
    skipIfMissed: "Skip if missed",
    inboxOutput: "Inbox output",
    runtime: "Runtime",
    allowedTools: "Allowed tools",
    mcpServers: "MCP servers",
    mcpToolFilters: "MCP tool filters",
    notifyProviders: "Notify providers",
    id: "Job ID",
  },
  settings: {
    thinkingLevel: "Thinking level",
    diffStyle: "Diff style",
    dismissKeyboardOnSend: "Dismiss keyboard on send",
    thinkingExpanded: "Thinking expanded",
    readExpanded: "Read expanded",
    editExpanded: "Edit expanded",
    toolCallsExpanded: "Tool calls expanded",
    messageStitching: "Message stitching",
    reviewsEnabled: "Reviews enabled",
    bypassAllPermissions: "Bypass all permissions",
    modelSlots: "Model",
  },
  provider: {
    id: "Provider ID",
    name: "Name",
    envVars: "Environment variables",
  },
  mcp_server: {
    name: "Name",
    command: "Command",
    args: "Arguments",
  },
  notification_settings: {
    baseUrl: "Base URL",
  },
  notification_provider: {
    id: "Provider ID",
    type: "Type",
    name: "Name",
    enabled: "Enabled",
    botToken: "Bot token",
    chatId: "Chat ID",
    serverUrl: "Server URL",
    topic: "Topic",
    token: "Token",
    filterPriorities: "Filter priorities",
    filterSources: "Filter sources",
  },
};

function humaniseKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(value: unknown): { value: string; block: boolean } {
  if (value === null || value === undefined) return { value: "", block: false };
  if (typeof value === "string") {
    if (value.length > 80 || value.includes("\n")) {
      return { value, block: true };
    }
    return { value, block: false };
  }
  if (typeof value === "boolean") return { value: value ? "Yes" : "No", block: false };
  if (typeof value === "number") return { value: String(value), block: false };
  if (Array.isArray(value)) return { value: value.join(", "), block: false };
  if (typeof value === "object") {
    const lines = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      const label = humaniseKey(k);
      const str = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
      return `${label}: ${str}`;
    });
    return { value: lines.join("\n"), block: true };
  }
  return { value: String(value), block: false };
}

export function formatConfigChange(
  domain: string,
  action: string,
  input: Record<string, unknown>,
): { title: string; rows: { label: string; value: string; block?: boolean }[] } {
  const titleAction = action.charAt(0).toUpperCase() + action.slice(1);
  const title = `${titleAction} ${domain.replace(/_/g, " ")}`;
  const labels = DOMAIN_LABELS[domain] || {};

  // For job update, the id is shown in the proposal card title via displayName; skip it in rows.
  const skipKeys = new Set<string>(domain === "job" && action === "update" ? ["id"] : []);

  const entries = Object.entries(input).filter(([k]) => !skipKeys.has(k));

  if (entries.length === 0) {
    return {
      title,
      rows: [{ label: "Change", value: JSON.stringify(input), block: false }],
    };
  }

  // For notification_provider, flatten the nested config object into individual rows.
  const flatEntries: [string, unknown][] = [];
  for (const [key, val] of entries) {
    if (key === "config" && typeof val === "object" && val !== null && !Array.isArray(val)) {
      for (const [ck, cv] of Object.entries(val as Record<string, unknown>)) {
        flatEntries.push([ck, cv]);
      }
    } else {
      flatEntries.push([key, val]);
    }
  }

  const rows = flatEntries.map(([key, val]) => {
    const label = labels[key] || humaniseKey(key);
    const { value, block } = formatValue(val);
    const row: { label: string; value: string; block?: boolean } = { label, value };
    if (block) row.block = true;
    return row;
  });

  return { title, rows };
}
