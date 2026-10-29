/**
 * What a session's tabs look like after a reload. The tab set and the active
 * tab are persisted; the split is too, because a reload is exactly when the
 * user expects the layout they left to come back. The decisions live here, away
 * from the React context, so they can be tested without a DOM.
 */

export interface RestoredSplit {
  splitTabId: string | null;
  rightPaneTabIds: string[];
}

/** The split, kept only where it still makes sense: every id it names must be
 *  a tab that is open, and the chat tab cannot live in the right pane. A split
 *  with no split tab is no split, which is how closing one leaves the state. */
export function restoreSplit(splitTabId: unknown, rightPaneTabIds: unknown, openTabIds: string[]): RestoredSplit {
  const open = new Set(openTabIds);
  const valid = (id: unknown): id is string => typeof id === "string" && id !== "chat" && open.has(id);
  const wanted = valid(splitTabId) ? splitTabId : null;
  if (!wanted) return { splitTabId: null, rightPaneTabIds: [] };

  const right = Array.isArray(rightPaneTabIds) ? rightPaneTabIds.filter(valid) : [];
  return { splitTabId: wanted, rightPaneTabIds: right.includes(wanted) ? right : [...right, wanted] };
}

/** Identity of the layout: which tabs are open, in order, and the split. A
 *  change to any of it is persisted straight away rather than debounced, so a
 *  reload a moment after splitting still finds the split. */
export function tabLayoutSignature(tabIds: string[], splitTabId: string | null, rightPaneTabIds: string[]): string {
  return `${tabIds.join("|")}#${splitTabId ?? ""}#${rightPaneTabIds.join(",")}`;
}
