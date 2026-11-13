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

export interface TerminalTabIdState<T extends { type: string; id: string; terminalId?: string }> {
  tabs: T[];
  activeTabId: string;
  splitTabId: string | null;
  rightPaneTabIds: string[];
}

/** Re-point a terminal tab at a new PTY after a reconnect. The tab id, the
 *  active tab and the split all carry the old terminal id, so they move too;
 *  without this the next mount reconnects to the terminal that is gone. */
export function replaceTerminalTabId<T extends { type: string; id: string; terminalId?: string }>(
  state: TerminalTabIdState<T>,
  oldTerminalId: string,
  newTerminalId: string,
): TerminalTabIdState<T> {
  const oldTabId = `terminal::${oldTerminalId}`;
  const newTabId = `terminal::${newTerminalId}`;
  const index = state.tabs.findIndex((t) => t.type === "terminal" && t.terminalId === oldTerminalId);
  if (index < 0) return state;

  const tabs = state.tabs.map((t, i) => (i === index ? ({ ...t, id: newTabId, terminalId: newTerminalId } as T) : t));
  const remap = (id: string) => (id === oldTabId ? newTabId : id);
  return {
    tabs,
    activeTabId: remap(state.activeTabId),
    splitTabId: state.splitTabId ? remap(state.splitTabId) : null,
    rightPaneTabIds: state.rightPaneTabIds.map(remap),
  };
}
