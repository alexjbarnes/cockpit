"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
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

export type Tab = ChatTab | FileTab | DiffTab | ChangesTab;

interface TabState {
  tabs: Tab[];
  activeTabId: string;
  splitTabId: string | null;
}

export interface TabContextValue {
  tabs: Tab[];
  activeTabId: string;
  splitTabId: string | null;
  openFile: (filePath: string) => void;
  openDiff: (filePath: string) => void;
  openChanges: () => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setSplitTab: (tabId: string | null) => void;
  moveTab: (tabId: string, toIndex: number) => void;
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

const stateCache = new Map<string, TabState>();

const DEFAULT_STATE: TabState = {
  tabs: [CHAT_TAB],
  activeTabId: "chat",
  splitTabId: null,
};

interface PersistedTab {
  type: "file" | "diff" | "changes";
  filePath?: string;
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
          const loaded = { tabs, activeTabId, splitTabId: null };
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

  const closeTab = useCallback((tabId: string) => {
    if (tabId === "chat") return;
    setState((prev) => {
      const idx = prev.tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return prev;
      const next = prev.tabs.filter((t) => t.id !== tabId);
      let activeTabId = prev.activeTabId;
      if (activeTabId === tabId) {
        const nearIdx = Math.min(idx, next.length - 1);
        activeTabId = next[nearIdx].id;
      }
      const splitTabId = prev.splitTabId === tabId ? null : prev.splitTabId;
      return { tabs: next, activeTabId, splitTabId };
    });
  }, []);

  const setActiveTab = useCallback((tabId: string) => {
    setState((prev) => ({ ...prev, activeTabId: tabId }));
  }, []);

  const setSplitTab = useCallback((tabId: string | null) => {
    setState((prev) => ({ ...prev, splitTabId: tabId }));
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

  return (
    <TabContext.Provider
      value={{
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        splitTabId: state.splitTabId,
        openFile,
        openDiff,
        openChanges,
        closeTab,
        setActiveTab,
        setSplitTab,
        moveTab,
      }}
    >
      {children}
    </TabContext.Provider>
  );
}

export function useTabContext(): TabContextValue | null {
  return useContext(TabContext);
}
