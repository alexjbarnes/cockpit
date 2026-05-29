import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getClaudeDir } from "@/server/paths";

function plansDir(): string {
  return join(getClaudeDir(), "plans");
}

export function findLatestPlanFile(): string | undefined {
  try {
    const dir = plansDir();
    const files = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.includes("-agent-"));
    if (files.length === 0) return undefined;
    let latest = files[0];
    let latestMtime = 0;
    for (const f of files) {
      const mtime = statSync(join(dir, f)).mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latest = f;
      }
    }
    return join(dir, latest);
  } catch {
    return undefined;
  }
}

export function readPlanFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}
