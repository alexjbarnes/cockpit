"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { disposeTerminalInstance } from "@/components/terminal-panel";
import { pathBasename } from "@/lib/path";

interface ChatTab {
  type: "chat";
  id: "chat";
}

interface FileTab {
  type: "file";
  id: string;
  filePath: string;
  label: string;
}

interface DiffTab {
  type: "diff";
  id: string;
  filePath: string;
  label: string;
}

interface ChangesTab {
  type: "changes";
  id: "changes";
}

export interface TerminalTab {
  type: "terminal";
  id: string;
  terminalId: string;
  label: string;
}

export type Tab = ChatTab | FileTab | DiffTab | ChangesTab | TerminalTab;

interface TabState {
  tabs: Tab[];
  activeTabId: string;
  splitTabId: string | null;
  rightPaneTabIds: string[];
}

export interface TabContextValue {
  tabs: Tab[];
  activeTabId: string;
  splitTabId: string | null;
  rightPaneTabIds: string[];
  openFile: (filePath: string) => void;
  openDiff: (filePath: string) => void;
  openChanges: () => void;
  openTerminal: (terminalId: string, label?: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setSplitTab: (tabId: string | null) => void;
  moveTab: (tabId: string, toIndex: number) => void;
  moveTabToPane: (tabId: string, pane: "left" | "right") => void;
}

const TabContext = createContext<TabContextValue | null>(null);

const CHAT_TAB: ChatTab = { type: "chat", id: "chat" };
const CHANGES_TAB: ChangesTab = { type: "changes", id: "changes" };

function fileTabId(filePath: string): string {
  return "file::" + filePath;
}

function diffTabId(filePath: string): string {
  return "diff::" + filePath;
}

function terminalTabId(terminalId: string): string {
  return "terminal::" + terminalId;
}

const stateCache = new Map<string, TabState>();

const DEFAULT_STATE: TabState = {
  tabs: [CHAT_TAB],
  activeTabId: "chat",
  splitTabId: null,
  rightPaneTabIds: [],
};

interface PersistedTab {
  type: "file" | "diff" | "changes" | "terminal";
  filePath?: string;
  terminalId?: string;
  label?: string;
}

function deserializeTabs(persisted: PersistedTab[]): Tab[] {
  const tabs: Tab[] = [CHAT_TAB];
  for (const p of persisted) {
    if (p.type === "changes") {
      tabs.push(CHANGES_TAB);
    } else if (p.type === "file" && p.filePath) {
      tabs.push({ type: "file", id: fileTabId(p.filePath), filePath: p.filePath, label: pathBasename(p.filePath) || p.filePath });
    } else if (p.type === "diff" && p.filePath) {
      tabs.push({ type: "diff", id: diffTabId(p.filePath), filePath: p.filePath, label: pathBasename(p.filePath) || p.filePath });
    } else if (p.type === "terminal" && p.terminalId) {
      tabs.push({ type: "terminal", id: terminalTabId(p.terminalId), terminalId: p.terminalId, label: p.label || "Terminal" });
    }
  }
  return tabs;
}

function serializeTabs(tabs: Tab[]): PersistedTab[] {
  const out: PersistedTab[] = [];
  for (const t of tabs) {
    if (t.type === "chat") continue;
    if (t.type === "changes") {
      out.push({ type: "changes" });
    } else if (t.type === "terminal") {
      out.push({ type: "terminal", terminalId: t.terminalId, label: t.label });
    } else {
      out.push({ type: t.type, filePath: t.filePath });
    }
  }
  return out;
}

export function TabProvider({ sessionId, children }: { sessionId: string; children: React.ReactNode }) {
  const [state, setState] = useState<TabState>(() => stateCache.get(sessionId) || DEFAULT_STATE);
  const loadedForRef = useRef<string | null>(stateCache.has(sessionId) ? sessionId : null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (loadedForRef.current === sessionId) return;
    if (stateCache.has(sessionId)) {
      setState(stateCache.get(sessionId)!);
      loadedForRef.current = sessionId;
      return;
    }
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/tabs`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.openTabs?.length) {
          const tabs = deserializeTabs(data.openTabs);
          const activeTabId = data.activeTabId && tabs.some((t: Tab) => t.id === data.activeTabId) ? data.activeTabId : "chat";
          const loaded: TabState = { tabs, activeTabId, splitTabId: null, rightPaneTabIds: [] };
          setState(loaded);
          stateCache.set(sessionId, loaded);
        }
        loadedForRef.current = sessionId;
      })
      .catch(() => {
        loadedForRef.current = sessionId;
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: specific sub-properties avoid re-saving on every render
  useEffect(() => {
    if (loadedForRef.current !== sessionId) return;
    stateCache.set(sessionId, state);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const openTabs = serializeTabs(state.tabs);
      fetch(`/api/sessions/${sessionId}/tabs`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openTabs, activeTabId: state.activeTabId }),
      }).catch(() => {});
    }, 300);
    return () => clearTimeout(saveTimer.current);
  }, [sessionId, state.tabs, state.activeTabId]);

  const openFile = useCallback((filePath: string) => {
    const id = fileTabId(filePath);
    setState((prev) => {
      const existing = prev.tabs.find((t) => t.id === id);
      if (existing) {
        return { ...prev, activeTabId: id };
      }
      const tab: FileTab = {
        type: "file",
        id,
        filePath,
        label: pathBasename(filePath) || filePath,
      };
      return { ...prev, tabs: [...prev.tabs, tab], activeTabId: id };
    });
  }, []);

  const openDiff = useCallback((filePath: string) => {
    const id = diffTabId(filePath);
    setState((prev) => {
      const existing = prev.tabs.find((t) => t.id === id);
      if (existing) {
        return { ...prev, activeTabId: id };
      }
      const tab: DiffTab = {
        type: "diff",
        id,
        filePath,
        label: pathBasename(filePath) || filePath,
      };
      return { ...prev, tabs: [...prev.tabs, tab], activeTabId: id };
    });
  }, []);

  const openChanges = useCallback(() => {
    setState((prev) => {
      const existing = prev.tabs.find((t) => t.id === "changes");
      if (existing) {
        return { ...prev, activeTabId: "changes" };
      }
      return { ...prev, tabs: [...prev.tabs, CHANGES_TAB], activeTabId: "changes" };
    });
  }, []);

  const openTerminal = useCallback((termId: string, label?: string) => {
    const id = terminalTabId(termId);
    setState((prev) => {
      const existing = prev.tabs.find((t) => t.id === id);
      if (existing) {
        return { ...prev, activeTabId: id };
      }
      const tab: TerminalTab = { type: "terminal", id, terminalId: termId, label: label || "Terminal" };
      return { ...prev, tabs: [...prev.tabs, tab], activeTabId: id };
    });
  }, []);

  const closeTab = useCallback((tabId: string) => {
    if (tabId === "chat") return;
    setState((prev) => {
      const closingTab = prev.tabs.find((t) => t.id === tabId);
      if (closingTab?.type === "terminal") {
        disposeTerminalInstance(closingTab.terminalId);
        fetch(`/api/terminal/${closingTab.terminalId}`, { method: "DELETE" }).catch(() => {});
      }
      const idx = prev.tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return prev;
      const next = prev.tabs.filter((t) => t.id !== tabId);
      let activeTabId = prev.activeTabId;
      if (activeTabId === tabId) {
        const leftTabs = next.filter((t) => !prev.rightPaneTabIds.includes(t.id));
        const nearIdx = Math.min(idx, leftTabs.length - 1);
        activeTabId = leftTabs[Math.max(0, nearIdx)]?.id || "chat";
      }
      const rightPaneTabIds = prev.rightPaneTabIds.filter((id) => id !== tabId);
      let splitTabId = prev.splitTabId === tabId ? rightPaneTabIds[0] || null : prev.splitTabId;
      if (rightPaneTabIds.length === 0) splitTabId = null;
      return { tabs: next, activeTabId, splitTabId, rightPaneTabIds };
    });
  }, []);

  const setActiveTab = useCallback((tabId: string) => {
    setState((prev) => ({ ...prev, activeTabId: tabId }));
  }, []);

  const setSplitTab = useCallback((tabId: string | null) => {
    setState((prev) => {
      if (tabId === null) {
        return { ...prev, splitTabId: null, rightPaneTabIds: [] };
      }
      const rightPaneTabIds = prev.rightPaneTabIds.includes(tabId) ? prev.rightPaneTabIds : [...prev.rightPaneTabIds, tabId];
      return { ...prev, splitTabId: tabId, rightPaneTabIds };
    });
  }, []);

  const moveTab = useCallback((tabId: string, toIndex: number) => {
    setState((prev) => {
      const fromIdx = prev.tabs.findIndex((t) => t.id === tabId);
      if (fromIdx < 1 || fromIdx === toIndex) return prev;
      const tabs = [...prev.tabs];
      const [tab] = tabs.splice(fromIdx, 1);
      const adjusted = toIndex > fromIdx ? toIndex - 1 : toIndex;
      const clamped = Math.max(1, Math.min(tabs.length, adjusted));
      tabs.splice(clamped, 0, tab);
      return { ...prev, tabs };
    });
  }, []);

  const moveTabToPane = useCallback((tabId: string, pane: "left" | "right") => {
    if (tabId === "chat") return;
    setState((prev) => {
      const isRight = prev.rightPaneTabIds.includes(tabId);
      if (pane === "right" && !isRight) {
        const rightPaneTabIds = [...prev.rightPaneTabIds, tabId];
        let activeTabId = prev.activeTabId;
        if (activeTabId === tabId) {
          const leftTabs = prev.tabs.filter((t) => !rightPaneTabIds.includes(t.id));
          activeTabId = leftTabs[0]?.id || "chat";
        }
        return { ...prev, rightPaneTabIds, activeTabId, splitTabId: prev.splitTabId || tabId };
      }
      if (pane === "left" && isRight) {
        const rightPaneTabIds = prev.rightPaneTabIds.filter((id) => id !== tabId);
        let splitTabId = prev.splitTabId;
        if (splitTabId === tabId) splitTabId = rightPaneTabIds[0] || null;
        if (rightPaneTabIds.length === 0) splitTabId = null;
        return { ...prev, rightPaneTabIds, splitTabId, activeTabId: tabId };
      }
      return prev;
    });
  }, []);

  return (
    <TabContext.Provider
      value={{
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        splitTabId: state.splitTabId,
        rightPaneTabIds: state.rightPaneTabIds,
        openFile,
        openDiff,
        openChanges,
        openTerminal,
        closeTab,
        setActiveTab,
        setSplitTab,
        moveTab,
        moveTabToPane,
      }}
    >
      {children}
    </TabContext.Provider>
  );
}

export function useTabContext(): TabContextValue | null {
  return useContext(TabContext);
}
