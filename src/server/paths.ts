import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function getCockpitDir(): string {
  return process.env.COCKPIT_CONFIG_DIR ?? path.join(homedir(), ".cockpit");
}

export function getCockpitCacheDir(): string {
  return process.env.COCKPIT_CACHE_DIR ?? path.join(homedir(), ".cache", "cockpit");
}

export function getClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
}

export function getClaudeUserConfigFile(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
}

export function getCockpitConfigServerPath(): string {
  const jsPath = path.resolve(__dirname, "mcp", "cockpit-config-server.js");
  const tsPath = path.resolve(__dirname, "mcp", "cockpit-config-server.ts");
  return existsSync(tsPath) ? tsPath : jsPath;
}
