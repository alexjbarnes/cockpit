"use client";

import { GitBranch } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Tab, TerminalTab } from "@/contexts/tab-context";
import { TabProvider, useTabContext } from "@/contexts/tab-context";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useWebSocket } from "@/hooks/use-websocket";
import { pathBasename } from "@/lib/path";
import { cn } from "@/lib/utils";
import { useShell, useShellCwd } from "./app-shell";
import { ChangesView } from "./changes-view";
import { ChatView } from "./chat-view";
import { DiffView } from "./diff-view";
import { FilesView } from "./files-view";
import { ResizeHandle } from "./resize-handle";
import { TabBar } from "./tab-bar";

const TerminalPanel = dynamic(() => import("./terminal-panel").then((m) => m.TerminalPanel), { ssr: false });

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
  // Where the CLI is actually working. EnterWorktree moves a session into a
  // git worktree; the file tree, diffs, changes and new terminals follow it,
  // and the tag above the tabs says which worktree it is.
  const { subscribe } = useWebSocket();
  const [worktreeCwd, setWorktreeCwd] = useState<string | undefined>(undefined);
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== "session:info_updated" || msg.sessionId !== sessionId) return;
      setWorktreeCwd(msg.info.worktreeCwd);
    });
  }, [sessionId, subscribe]);
  const liveCwd = worktreeCwd ?? cwd;
  // The sidebar's file tree and the new-session pickers read the shell's cwd,
  // so they follow the worktree as well.
  useShellCwd(liveCwd);
  const worktreeTag = worktreeCwd ? (
    <div
      data-testid="worktree-tag"
      className="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground"
    >
      <GitBranch className="h-3 w-3 shrink-0" />
      <span className="shrink-0">Worktree</span>
      <span className="shrink-0 font-mono text-foreground">{pathBasename(worktreeCwd)}</span>
      <span className="truncate font-mono opacity-70" title={worktreeCwd}>
        {worktreeCwd}
      </span>
    </div>
  ) : null;

  useEffect(() => {
    setTabActions({ openFile: tabs.openFile, openDiff: tabs.openDiff, openChanges: tabs.openChanges, openTerminal: tabs.openTerminal });
    return () => setTabActions(null);
  }, [tabs.openFile, tabs.openDiff, tabs.openChanges, tabs.openTerminal, setTabActions]);

  const { activeTabId, splitTabId, rightPaneTabIds, tabs: tabList } = tabs;
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
    const onKeyDown = async (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "w") {
        if (tabs.activeTabId !== "chat") {
          e.preventDefault();
          tabs.closeTab(tabs.activeTabId);
        }
      }
      if (mod && e.key === "`") {
        e.preventDefault();
        try {
          const res = await fetch("/api/terminal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd: liveCwd }),
          });
          if (res.ok) {
            const { terminalId } = await res.json();
            tabs.openTerminal(terminalId);
          }
        } catch {}
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabs, liveCwd]);

  const fileTabs = tabList.filter((t): t is Tab & { type: "file" } => t.type === "file");
  const diffTabs = tabList.filter((t): t is Tab & { type: "diff" } => t.type === "diff");
  const terminalTabs = tabList.filter((t): t is TerminalTab => t.type === "terminal");
  const hasChanges = tabList.some((t) => t.type === "changes");

  const handlePaneDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleLeftPaneDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const tabId = e.dataTransfer.getData("text/plain");
      if (!tabId || tabId === "chat") return;
      if (rightPaneTabIds.includes(tabId)) {
        tabs.moveTabToPane(tabId, "left");
      }
    },
    [tabs, rightPaneTabIds],
  );

  const handleRightPaneDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const tabId = e.dataTransfer.getData("text/plain");
      if (!tabId || tabId === "chat") return;
      if (!rightPaneTabIds.includes(tabId)) {
        tabs.moveTabToPane(tabId, "right");
      } else {
        tabs.setSplitTab(tabId);
      }
    },
    [tabs, rightPaneTabIds],
  );

  if (isSplit) {
    const leftFileTabs = fileTabs.filter((t) => !rightPaneTabIds.includes(t.id));
    const leftDiffTabs = diffTabs.filter((t) => !rightPaneTabIds.includes(t.id));
    const leftTerminalTabs = terminalTabs.filter((t) => !rightPaneTabIds.includes(t.id));
    const leftHasChanges = hasChanges && !rightPaneTabIds.includes("changes");
    const rightFileTabs = fileTabs.filter((t) => rightPaneTabIds.includes(t.id));
    const rightDiffTabs = diffTabs.filter((t) => rightPaneTabIds.includes(t.id));
    const rightTerminalTabs = terminalTabs.filter((t) => rightPaneTabIds.includes(t.id));
    const rightHasChanges = hasChanges && rightPaneTabIds.includes("changes");

    return (
      <>
        {worktreeTag}
        <TabBar splitRatio={isSplit ? splitRatio : undefined} />
        <div ref={containerRef} className="flex-1 min-h-0 flex flex-row">
          <div
            className="flex flex-col min-w-0 min-h-0"
            style={{ width: `${(1 - splitRatio) * 100}%` }}
            onDragOver={handlePaneDragOver}
            onDrop={handleLeftPaneDrop}
          >
            <ChatView
              sessionId={sessionId}
              cwd={liveCwd}
              initialName={initialName}
              historyView={historyView}
              className={cn(activeTabId !== "chat" && "hidden")}
            />
            {leftFileTabs.map((tab) => (
              <div key={tab.id} className={cn("flex flex-col flex-1 min-h-0", activeTabId !== tab.id && "hidden")}>
                <FilesView cwd={liveCwd} initialFile={tab.filePath} manageSidebar={false} />
              </div>
            ))}
            {leftDiffTabs.map((tab) => (
              <div key={tab.id} className={cn("flex flex-col flex-1 min-h-0", activeTabId !== tab.id && "hidden")}>
                <DiffView cwd={liveCwd} filePath={tab.filePath} />
              </div>
            ))}
            {leftHasChanges && (
              <div className={cn("flex flex-col flex-1 min-h-0", activeTabId !== "changes" && "hidden")}>
                <ChangesView cwd={liveCwd} sessionId={sessionId} embeddedChat={false} manageSidebar={false} />
              </div>
            )}
            {leftTerminalTabs.map((tab) => (
              <div key={tab.id} className={cn("flex flex-col flex-1 min-h-0 min-w-0", activeTabId !== tab.id && "hidden")}>
                <TerminalPanel terminalId={tab.terminalId} cwd={liveCwd} active={activeTabId === tab.id} />
              </div>
            ))}
          </div>
          <ResizeHandle onResize={handleResize} />
          <div
            className="flex flex-col min-w-0 min-h-0"
            style={{ width: `${splitRatio * 100}%` }}
            onDragOver={handlePaneDragOver}
            onDrop={handleRightPaneDrop}
          >
            {rightFileTabs.map((tab) => (
              <div key={tab.id} className={cn("flex flex-col flex-1 min-h-0", splitTabId !== tab.id && "hidden")}>
                <FilesView cwd={liveCwd} initialFile={tab.filePath} manageSidebar={false} />
              </div>
            ))}
            {rightDiffTabs.map((tab) => (
              <div key={tab.id} className={cn("flex flex-col flex-1 min-h-0", splitTabId !== tab.id && "hidden")}>
                <DiffView cwd={liveCwd} filePath={tab.filePath} />
              </div>
            ))}
            {rightHasChanges && (
              <div className={cn("flex flex-col flex-1 min-h-0", splitTabId !== "changes" && "hidden")}>
                <ChangesView cwd={liveCwd} sessionId={sessionId} embeddedChat={false} manageSidebar={false} />
              </div>
            )}
            {rightTerminalTabs.map((tab) => (
              <div key={tab.id} className={cn("flex flex-col flex-1 min-h-0 min-w-0", splitTabId !== tab.id && "hidden")}>
                <TerminalPanel terminalId={tab.terminalId} cwd={liveCwd} active={splitTabId === tab.id} />
              </div>
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {worktreeTag}
      <TabBar splitRatio={isSplit ? splitRatio : undefined} />
      <ChatView
        sessionId={sessionId}
        cwd={liveCwd}
        initialName={initialName}
        historyView={historyView}
        className={cn(activeTabId !== "chat" && "hidden")}
      />
      {fileTabs.map((tab) => (
        <div key={tab.id} className={cn("flex flex-col flex-1 min-h-0", activeTabId !== tab.id && "hidden")}>
          <FilesView cwd={liveCwd} initialFile={tab.filePath} manageSidebar={false} />
        </div>
      ))}
      {diffTabs.map((tab) => (
        <div key={tab.id} className={cn("flex flex-col flex-1 min-h-0", activeTabId !== tab.id && "hidden")}>
          <DiffView cwd={liveCwd} filePath={tab.filePath} />
        </div>
      ))}
      {hasChanges && (
        <div className={cn("flex flex-col flex-1 min-h-0", activeTabId !== "changes" && "hidden")}>
          <ChangesView cwd={liveCwd} sessionId={sessionId} embeddedChat={false} manageSidebar={false} />
        </div>
      )}
      {terminalTabs.map((tab) => (
        <div key={tab.id} className={cn("flex flex-col flex-1 min-h-0 min-w-0", activeTabId !== tab.id && "hidden")}>
          <TerminalPanel terminalId={tab.terminalId} cwd={liveCwd} active={activeTabId === tab.id} />
        </div>
      ))}
    </>
  );
}
