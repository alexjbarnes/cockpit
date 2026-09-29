// Whether this host can run the Claude CLI's Bash sandbox.
//
// The sandbox is built into the CLI and enabled through settings.json (see
// claude-settings.ts). It runs on macOS (Seatbelt, nothing to install) and
// Linux/WSL2. cockpit gates its sandbox toggle on this so a user can't enable a
// sandbox the host can't actually enforce.
//
// On Linux the CLI needs BOTH bubblewrap and socat: verified against the real
// CLI, with socat missing it prints "Sandbox disabled: ... socat not installed
// ... Commands will run WITHOUT sandboxing" and runs unsandboxed. So socat is
// required for the sandbox to engage at all here, not merely for the network
// layer — both must be present to report supported.
import { execFileSync } from "node:child_process";
import type { SandboxSupport } from "@/types";

function onPath(bin: string): boolean {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(cmd, [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let cached: SandboxSupport | null = null;

/** Cached per process: the binaries don't appear mid-run, and the CLI itself
 *  only checks at startup. */
export function sandboxSupport(): SandboxSupport {
  if (cached) return cached;
  const platform = process.platform;

  if (platform === "darwin") {
    cached = { supported: true, networkIsolation: true, platform };
  } else if (platform === "linux") {
    const missing = ["bwrap", "socat"].filter((b) => !onPath(b));
    cached =
      missing.length === 0
        ? { supported: true, networkIsolation: true, platform }
        : {
            supported: false,
            networkIsolation: false,
            platform,
            reason: `The sandbox needs ${missing.join(" and ")} (apt-get install bubblewrap socat).`,
          };
  } else {
    cached = { supported: false, networkIsolation: false, platform, reason: `The Bash sandbox does not run on ${platform}.` };
  }
  return cached;
}
