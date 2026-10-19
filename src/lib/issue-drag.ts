import { type IssuePlacement, placementAt, placeOptimistically, sortIssuesByOrder } from "@/lib/issue-display";
import type { Issue } from "@/types";

/**
 * What a drop means: where the issue goes, and what the list should look like
 * until the server answers. Both halves live here, away from the components,
 * because the drag is the one piece of this feature whose logic is worth
 * testing on its own (components are outside vitest's coverage and it has no
 * DOM).
 *
 * `targetIndex` is the position in the target group *without* the moved issue,
 * which is what dnd-kit reports once the row has left its old slot.
 */
export function resolveIssueDrop(
  issues: Issue[],
  activeKey: string,
  targetStatus: string,
  targetIndex: number,
): { placement: IssuePlacement; optimistic: Issue[] } {
  const group = sortIssuesByOrder(issues.filter((issue) => issue.status === targetStatus && issue.key !== activeKey)).map(
    (issue) => issue.key,
  );
  const placement = placementAt(targetStatus, activeKey, targetIndex, group);
  return { placement, optimistic: placeOptimistically(issues, placement) };
}

/**
 * Fold the server's answer into the list: it returns the issues it renumbered,
 * which may include ones this client is showing in another group (a status is
 * renumbered as a whole, across projects). Never replace the list with it — the
 * response knows nothing about the other statuses.
 */
export function mergeIssueChanges(issues: Issue[], changed: Issue[]): Issue[] {
  if (changed.length === 0) return issues;
  const byId = new Map(changed.map((issue) => [issue.id, issue]));
  const merged = issues.map((issue) => byId.get(issue.id) ?? issue);
  const known = new Set(issues.map((issue) => issue.id));
  for (const issue of changed) {
    if (!known.has(issue.id)) merged.push(issue);
  }
  return merged;
}

/** Send a placement to the server. Returns the renumbered issues. */
export async function sendIssuePlacement(placement: IssuePlacement): Promise<Issue[]> {
  const res = await fetch("/api/issues/order", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: placement.key,
      status: placement.status,
      ...(placement.beforeKey ? { beforeKey: placement.beforeKey } : {}),
      ...(placement.afterKey ? { afterKey: placement.afterKey } : {}),
    }),
  });
  const data = (await res.json().catch(() => null)) as { issues?: Issue[]; error?: string } | null;
  if (!res.ok) throw new Error(data?.error || "Failed to move the issue");
  return data?.issues ?? [];
}
