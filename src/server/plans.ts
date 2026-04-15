import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PLANS_DIR = join(homedir(), ".claude", "plans");

export function findLatestPlanFile(): string | undefined {
  try {
    const files = readdirSync(PLANS_DIR)
      .filter((f) => f.endsWith(".md") && !f.includes("-agent-"));
    if (files.length === 0) return undefined;
    let latest = files[0];
    let latestMtime = 0;
    for (const f of files) {
      const mtime = statSync(join(PLANS_DIR, f)).mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latest = f;
      }
    }
    return join(PLANS_DIR, latest);
  } catch {
    return undefined;
  }
}
