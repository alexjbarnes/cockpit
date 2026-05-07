"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
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

export function TabProvider({ sessionId, children }: { sessionId: string; children: React.ReactNode }) {
  const [state, setState] = useState<TabState>(() => stateCache.get(sessionId) || DEFAULT_STATE);

  useEffect(() => {
    stateCache.set(sessionId, state);
  }, [sessionId, state]);

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
      }}
    >
      {children}
    </TabContext.Provider>
  );
}

export function useTabContext(): TabContextValue | null {
  return useContext(TabContext);
}
