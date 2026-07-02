import { ClaudePtyAdapter } from "./claude-pty-adapter";
import { ClaudeStreamAdapter } from "./claude-stream-adapter";
import type { Harness, HarnessAdapter, HarnessId } from "./types";

export const HARNESS_REGISTRY: Record<HarnessId, Harness> = {
  claude: {
    id: "claude",
    displayName: "Claude Code",
    capabilities: {
      supportsPty: true,
      supportsSkills: true,
      supportsSlashCommands: true,
      supportsSubagents: true,
      supportsHooks: true,
      supportsMcp: true,
      supportsPlanMode: true,
      supportsEffort: true,
    },
    transports: ["stream", "pty"],
  },
};

const streamAdapter = new ClaudeStreamAdapter();
const ptyAdapter = new ClaudePtyAdapter();

export function getHarnessAdapter(harness: HarnessId, runtime: "stream" | "pty"): HarnessAdapter {
  if (harness === "claude") {
    return runtime === "pty" ? ptyAdapter : streamAdapter;
  }
  throw new Error(`Unknown harness: ${harness satisfies never}`);
}
