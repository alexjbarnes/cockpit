import { homedir } from "node:os";
import path from "node:path";

export function getCockpitDir(): string {
  return process.env.COCKPIT_CONFIG_DIR ?? path.join(homedir(), ".cockpit");
}

export function getCockpitCacheDir(): string {
  return process.env.COCKPIT_CACHE_DIR ?? path.join(homedir(), ".cache", "cockpit");
}

/** Root holding every scheduled job's scratchpad, one directory per job id. */
export function getJobsScratchpadRoot(): string {
  return path.join(getCockpitDir(), "jobs");
}

/**
 * A single job's scratchpad. This is where a job persists state between runs
 * (the prompt points the model at it), and it doubles as the working directory
 * for a job with no cwd of its own.
 */
export function getJobScratchpadDir(jobId: string): string {
  return path.join(getJobsScratchpadRoot(), jobId);
}

export function getClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
}

export function getClaudeUserConfigFile(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
}
