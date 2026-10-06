import type { PluginUpdateResult } from "@/hooks/use-plugins";

/** How much of a CLI failure message the one-line summary keeps. */
const REASON_LIMIT = 140;

/**
 * One line for a bulk update. A plugin the CLI refuses to update (a synced one
 * has no marketplace behind it) is named with the CLI's own reason, since that
 * is the only place the user can find out why.
 */
export function summariseUpdateResults(results: PluginUpdateResult[]): string {
  const failed = results.filter((r) => !r.ok);
  if (results.length === 0) return "No plugins to update.";
  if (failed.length === 0) return `Updated ${results.length} plugin${results.length === 1 ? "" : "s"}.`;

  const reasons = failed.map((f) => {
    const reason = f.message
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ");
    // The CLI often follows its reason with what to do instead; keep the reason.
    const firstSentence = reason.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? reason;
    const trimmed = firstSentence.length > REASON_LIMIT ? `${firstSentence.slice(0, REASON_LIMIT - 1)}…` : firstSentence;
    return trimmed ? `${f.id}: ${trimmed}` : f.id;
  });
  return `Updated ${results.length - failed.length} of ${results.length}. Failed: ${reasons.join("; ")}`;
}
