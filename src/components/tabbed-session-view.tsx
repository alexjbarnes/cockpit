"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Tab } from "@/contexts/tab-context";
import { TabProvider, useTabContext } from "@/contexts/tab-context";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { cn } from "@/lib/utils";
import { useShell } from "./app-shell";
import { ChangesView } from "./changes-view";
import { ChatView } from "./chat-view";
import { DiffView } from "./diff-view";
import { FilesView } from "./files-view";
import { ResizeHandle } from "./resize-handle";
import { TabBar } from "./tab-bar";

interface TabbedSessionViewProps {
  sessionId: string;
  cwd: string;
  initialName?: string;
  historyView?: boolean;
}

export function TabbedSessionView(props: TabbedSessionViewProps) {
  return (
    <TabProvider sessionId={props.sessionId}>
      <TabbedContent {...props} />
    </TabProvider>
  );
}

function TabbedContent({ sessionId, cwd, initialName, historyView }: TabbedSessionViewProps) {
  const tabs = useTabContext()!;
  const { setTabActions } = useShell();
  const isDesktop = useIsDesktop();
  const containerRef = useRef<HTMLDivElement>(null);
  const [splitRatio, setSplitRatio] = useState(0.5);

  useEffect(() => {
    setTabActions({ openFile: tabs.openFile, openDiff: tabs.openDiff, openChanges: tabs.openChanges });
    return () => setTabActions(null);
  }, [tabs.openFile, tabs.openDiff, tabs.openChanges, setTabActions]);

  const { activeTabId, splitTabId, tabs: tabList } = tabs;
  const isSplit = isDesktop && splitTabId !== null;

  const handleResize = useCallback((delta: number) => {
    const container = containerRef.current;
    if (!container) return;
    const width = container.offsetWidth;
    if (width === 0) return;
    setSplitRatio((prev) => {
      const next = prev + delta / width;
      return Math.max(0.25, Math.min(0.75, next));
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "w") {
        if (tabs.activeTabId !== "chat") {
          e.preventDefault();
          tabs.closeTab(tabs.activeTabId);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabs]);

  const fileTabs = tabList.filter((t): t is Tab & { type: "file" } => t.type === "file");
  const diffTabs = tabList.filter((t): t is Tab & { type: "diff" } => t.type === "diff");
  const hasChanges = tabList.some((t) => t.type === "changes");

  if (isSplit) {
    const rightTabId = splitTabId;
    return (
      <>
        <TabBar />
        <div ref={containerRef} className="flex-1 min-h-0 flex flex-row">
          <div className="flex flex-col min-w-0 min-h-0" style={{ width: `${(1 - splitRatio) * 100}%` }}>
            <ChatView sessionId={sessionId} cwd={cwd} initialName={initialName} historyView={historyView} />
          </div>
          <ResizeHandle onResize={handleResize} />
          <div className="flex flex-col min-w-0 min-h-0" style={{ width: `${splitRatio * 100}%` }}>
            {renderTabContent(rightTabId, fileTabs, diffTabs, hasChanges, cwd, sessionId)}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <TabBar />
      <ChatView
        sessionId={sessionId}
        cwd={cwd}
        initialName={initialName}
        historyView={historyView}
        className={cn(activeTabId !== "chat" && "hidden")}
      />
      {fileTabs.map((tab) => (
        <div key={tab.id} className={cn("flex flex-col flex-1 min-h-0", activeTabId !== tab.id && "hidden")}>
          <FilesView cwd={cwd} initialFile={tab.filePath} manageSidebar={false} />
        </div>
      ))}
      {diffTabs.map((tab) => (
        <div key={tab.id} className={cn("flex flex-col flex-1 min-h-0", activeTabId !== tab.id && "hidden")}>
          <DiffView cwd={cwd} filePath={tab.filePath} />
        </div>
      ))}
      {hasChanges && (
        <div className={cn("flex flex-col flex-1 min-h-0", activeTabId !== "changes" && "hidden")}>
          <ChangesView cwd={cwd} sessionId={sessionId} embeddedChat={false} />
        </div>
      )}
    </>
  );
}

function renderTabContent(
  tabId: string,
  fileTabs: Array<Tab & { type: "file" }>,
  diffTabs: Array<Tab & { type: "diff" }>,
  hasChanges: boolean,
  cwd: string,
  sessionId: string,
) {
  const fileTab = fileTabs.find((t) => t.id === tabId);
  if (fileTab) {
    return <FilesView cwd={cwd} initialFile={fileTab.filePath} manageSidebar={false} />;
  }
  const diffTab = diffTabs.find((t) => t.id === tabId);
  if (diffTab) {
    return <DiffView cwd={cwd} filePath={diffTab.filePath} />;
  }
  if (tabId === "changes" && hasChanges) {
    return <ChangesView cwd={cwd} sessionId={sessionId} embeddedChat={false} />;
  }
  return null;
}
