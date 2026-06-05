import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getClaudeUserConfigFile, getCockpitConfigServerPath, getCockpitDir } from "@/server/paths";

export function ensureCockpitConfigServer(): void {
  const configFile = getClaudeUserConfigFile();
  const serverPath = getCockpitConfigServerPath();

  if (!existsSync(serverPath)) {
    console.warn(`[cockpit-config] compiled server not found at ${serverPath}, skipping registration`);
    return;
  }

  let config: { mcpServers?: Record<string, unknown> };
  try {
    const raw = readFileSync(configFile, "utf-8");
    config = JSON.parse(raw);
  } catch {
    config = {};
  }
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const entryName = "cockpit-config";
  const existingEntry = config.mcpServers[entryName] as { command?: string; args?: string[]; env?: Record<string, string> } | undefined;

  const newArgs = [serverPath];

  if (existingEntry && existingEntry.args?.[0] === serverPath) {
    return;
  }

  const mergedEnv: Record<string, string> = {
    ...(existingEntry?.env ?? {}),
    COCKPIT_CONFIG_DIR: getCockpitDir(),
  };

  config.mcpServers[entryName] = {
    command: "node",
    args: newArgs,
    env: mergedEnv,
  };

  try {
    writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
    console.log(`[cockpit-config] registered server in ${configFile}`);
  } catch (err) {
    console.error(`[cockpit-config] failed to write ${configFile}:`, err);
  }
}
