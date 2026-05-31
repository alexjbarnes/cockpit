import { execFileSync } from "node:child_process";

let resolvedClaudeBin: string | null = null;

/**
 * Resolve the `claude` executable path once and cache it for the process.
 * Falls back to the bare "claude" name (relying on PATH) if resolution fails.
 */
export function getClaudeBin(): string {
  if (resolvedClaudeBin) return resolvedClaudeBin;
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    resolvedClaudeBin = execFileSync(cmd, ["claude"], { encoding: "utf-8" }).trim().split("\n")[0];
  } catch {
    resolvedClaudeBin = "claude";
  }
  return resolvedClaudeBin;
}
