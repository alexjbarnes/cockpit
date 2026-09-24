import type { SessionPermissionMode } from "@/types";

/**
 * What actually governs a session's tool calls, from the mode cockpit asked
 * for (`desired`) and the mode the CLI reports in its hook payloads (`cli`,
 * null until the running process has reported one).
 *
 * They are not the same thing in one case: cockpit's bypass keeps the CLI in
 * manual and approves every prompt itself, so a CLI in manual under a desired
 * bypass IS bypass. Any other mode the CLI reports is taken at its word, since
 * it acts on that mode before cockpit is asked anything.
 */
export type EffectivePermissionMode = SessionPermissionMode | "acceptEdits" | "dontAsk";

export function effectivePermissionMode(desired: SessionPermissionMode, cli: string | null): EffectivePermissionMode {
  switch (cli) {
    case "auto":
      return "auto";
    case "bypassPermissions":
      return "bypass";
    case "default":
    case "manual":
      return desired === "bypass" ? "bypass" : "manual";
    case "acceptEdits":
    case "dontAsk":
      return cli;
    // Plan mode is shown on its own; the permission axis is whatever was chosen.
    // Unknown (not reported yet, or a mode this build does not know): trust the
    // request rather than guess.
    default:
      return desired;
  }
}

const LABELS: Record<EffectivePermissionMode, string> = {
  manual: "Manual",
  auto: "Auto",
  bypass: "Bypass",
  acceptEdits: "Accept edits",
  dontAsk: "Don't ask",
};

const CONSEQUENCES: Record<EffectivePermissionMode, string> = {
  manual: "every prompt comes to cockpit to answer",
  auto: "its classifier approves or blocks calls before cockpit is asked",
  bypass: "it approves every call itself",
  acceptEdits: "file edits go through without asking",
  dontAsk: "anything not already allowed is refused",
};

/** A sentence for the session panel when the CLI is not in the mode that was
 *  chosen, saying which mode it is in and what that means; null when they
 *  agree or the CLI has not reported yet. */
export function permissionModeMismatch(desired: SessionPermissionMode, cli: string | null): string | null {
  const effective = effectivePermissionMode(desired, cli);
  if (effective === desired) return null;
  return `Claude Code is running in ${LABELS[effective]}, not ${LABELS[desired]}: ${CONSEQUENCES[effective]}.`;
}
