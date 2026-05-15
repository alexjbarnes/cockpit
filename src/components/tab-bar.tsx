"use client";

import { Columns2, FileDiff, FileText, GitBranch, MessageSquare, Terminal, X } from "lucide-react";
import { useRef, useState } from "react";
import type { Tab } from "@/contexts/tab-context";
import { useTabContext } from "@/contexts/tab-context";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { cn } from "@/lib/utils";

function tabIcon(tab: Tab) {
  switch (tab.type) {
    case "chat":
      return <MessageSquare className="h-3 w-3 md:h-3.5 md:w-3.5 shrink-0" />;
    case "file":
      return <FileText className="h-3 w-3 md:h-3.5 md:w-3.5 shrink-0" />;
    case "diff":
      return <FileDiff className="h-3 w-3 md:h-3.5 md:w-3.5 shrink-0" />;
    case "changes":
      return <GitBranch className="h-3 w-3 md:h-3.5 md:w-3.5 shrink-0" />;
    case "terminal":
      return <Terminal className="h-3 w-3 md:h-3.5 md:w-3.5 shrink-0" />;
  }
}

function tabLabel(tab: Tab): string {
  switch (tab.type) {
    case "chat":
      return "Chat";
    case "file":
    case "diff":
      return tab.label;
    case "changes":
      return "Changes";
    case "terminal":
      return tab.label;
  }
}

function computeDropIndex(container: HTMLElement, clientX: number, dragId: string, tabIds: string[]): number | null {
  const children = Array.from(container.querySelectorAll<HTMLElement>("[data-tab-id]"));
  if (children.length === 0) return 0;

  const dragIdx = tabIds.indexOf(dragId);

  for (let i = 0; i < children.length; i++) {
    const rect = children[i].getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    if (clientX < midX) {
      if (i === dragIdx || i === dragIdx + 1) return null;
      return i;
    }
  }

  const lastIdx = children.length;
  if (lastIdx === dragIdx || lastIdx === dragIdx + 1) return null;
  return lastIdx;
}

function paneDropToGlobalIndex(paneTabs: Tab[], dropIdx: number, allTabs: Tab[]): number {
  if (paneTabs.length === 0 || dropIdx >= paneTabs.length) {
    const lastPaneTab = paneTabs[paneTabs.length - 1];
    if (!lastPaneTab) return allTabs.length;
    return allTabs.findIndex((t) => t.id === lastPaneTab.id) + 1;
  }
  return allTabs.findIndex((t) => t.id === paneTabs[dropIdx].id);
}

interface TabBarProps {
  splitRatio?: number;
}

export function TabBar({ splitRatio }: TabBarProps) {
  const tabs = useTabContext();
  const isDesktop = useIsDesktop();
  const dragTabId = useRef<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dropPane, setDropPane] = useState<"left" | "right" | null>(null);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  if (!tabs || tabs.tabs.length <= 1) return null;

  const { activeTabId, splitTabId, rightPaneTabIds, setActiveTab, closeTab, setSplitTab, moveTab, moveTabToPane } = tabs;
  const isSplit = isDesktop && splitTabId !== null;
  const nonChatTabs = tabs.tabs.filter((t) => t.type !== "chat");
  const nonChatIds = nonChatTabs.map((t) => t.id);

  const handleDragStart = (tabId: string) => (e: React.DragEvent) => {
    dragTabId.current = tabId;
    setDragging(true);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", tabId);
  };

  const handleDragEnd = () => {
    dragTabId.current = null;
    setDropIndex(null);
    setDropPane(null);
    setDragging(false);
  };

  const cleanup = () => {
    dragTabId.current = null;
    setDropIndex(null);
    setDropPane(null);
    setDragging(false);
  };

  const handleContainerDragOver = (e: React.DragEvent) => {
    if (!dragTabId.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    if (!containerRef.current) return;
    const idx = computeDropIndex(containerRef.current, e.clientX, dragTabId.current, nonChatIds);
    setDropIndex(idx);
    setDropPane(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (dragTabId.current && dropIndex !== null) {
      moveTab(dragTabId.current, dropIndex + 1);
    }
    cleanup();
  };

  const renderDropIndicator = (index: number, pane?: "left" | "right") => (
    <div
      key={`ind-${pane || "main"}-${index}`}
      className={cn(
        "self-stretch shrink-0 rounded-full transition-all",
        dropIndex === index && dropPane === (pane ?? null) ? "w-0.5 bg-primary mx-0.5" : dragging ? "w-1" : "w-0",
      )}
    />
  );

  const renderTabButton = (tab: Tab, active: boolean, onClick: () => void, draggable: boolean) => (
    <button
      data-tab-id={tab.type !== "chat" ? tab.id : undefined}
      draggable={draggable}
      onDragStart={draggable ? handleDragStart(tab.id) : undefined}
      onDragEnd={draggable ? handleDragEnd : undefined}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 md:px-4 md:py-2.5 text-xs md:text-sm font-medium whitespace-nowrap border-b-2 transition-colors group",
        active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
        draggable && "cursor-grab active:cursor-grabbing",
      )}
    >
      {tabIcon(tab)}
      <span className="truncate max-w-[120px]">{tabLabel(tab)}</span>
      {tab.type !== "chat" && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            closeTab(tab.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              closeTab(tab.id);
            }
          }}
          className="ml-0.5 rounded p-0.5 hover:bg-muted"
        >
          <X className="h-2.5 w-2.5 md:h-3 md:w-3" />
        </span>
      )}
    </button>
  );

  const splitToggle =
    isDesktop && nonChatTabs.length > 0 ? (
      <button
        onClick={() => {
          if (splitTabId) {
            setSplitTab(null);
          } else {
            const nonChat = tabs.tabs.find((t) => t.id === activeTabId && t.type !== "chat");
            const target = nonChat || tabs.tabs.find((t) => t.type !== "chat");
            if (target) {
              setSplitTab(target.id);
              if (activeTabId !== "chat") setActiveTab("chat");
            }
          }
        }}
        title={splitTabId ? "Close split view" : "Split view"}
        className={cn(
          "ml-auto shrink-0 flex items-center justify-center px-2 py-1.5 md:px-3 md:py-2.5 text-muted-foreground hover:text-foreground transition-colors",
          splitTabId && "text-primary",
        )}
      >
        <Columns2 className="h-3.5 w-3.5 md:h-4 md:w-4" />
      </button>
    ) : null;

  if (isSplit) {
    const ratio = splitRatio ?? 0.5;
    const leftPaneTabs = tabs.tabs.filter((t) => !rightPaneTabIds.includes(t.id));
    const leftPaneNonChat = leftPaneTabs.filter((t) => t.type !== "chat");
    const leftPaneNonChatIds = leftPaneNonChat.map((t) => t.id);
    const rightPaneTabs = tabs.tabs.filter((t) => rightPaneTabIds.includes(t.id));
    const rightPaneIds = rightPaneTabs.map((t) => t.id);

    const handleLeftDragOver = (e: React.DragEvent) => {
      if (!dragTabId.current) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!leftPaneRef.current) {
        setDropIndex(0);
        setDropPane("left");
        return;
      }
      const idx = computeDropIndex(leftPaneRef.current, e.clientX, dragTabId.current, leftPaneNonChatIds);
      setDropIndex(idx ?? 0);
      setDropPane("left");
    };

    const handleRightDragOver = (e: React.DragEvent) => {
      if (!dragTabId.current) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!rightPaneRef.current) {
        setDropIndex(0);
        setDropPane("right");
        return;
      }
      const idx = computeDropIndex(rightPaneRef.current, e.clientX, dragTabId.current, rightPaneIds);
      setDropIndex(idx ?? 0);
      setDropPane("right");
    };

    const handleSplitDrop = (e: React.DragEvent) => {
      e.preventDefault();
      const tabId = dragTabId.current;
      if (!tabId) {
        cleanup();
        return;
      }
      const isFromRight = rightPaneTabIds.includes(tabId);
      if (dropPane === "left" && isFromRight) {
        moveTabToPane(tabId, "left");
      } else if (dropPane === "right" && !isFromRight) {
        moveTabToPane(tabId, "right");
      } else if (dropIndex !== null && dropPane) {
        const paneTabs = dropPane === "left" ? leftPaneNonChat : rightPaneTabs;
        const globalIdx = paneDropToGlobalIndex(paneTabs, dropIndex, tabs.tabs);
        moveTab(tabId, globalIdx);
      }
      cleanup();
    };

    return (
      <div className="shrink-0 border-b flex items-center bg-background">
        <div
          ref={leftPaneRef}
          className="flex items-center overflow-x-auto scrollbar-none min-w-0"
          style={{ width: `${(1 - ratio) * 100}%` }}
          onDragOver={handleLeftDragOver}
          onDrop={handleSplitDrop}
        >
          {renderTabButton(leftPaneTabs[0], activeTabId === leftPaneTabs[0].id, () => setActiveTab(leftPaneTabs[0].id), false)}
          {leftPaneNonChat.map((tab, i) => (
            <div key={tab.id} className="flex items-center">
              {renderDropIndicator(i, "left")}
              {renderTabButton(tab, tab.id === activeTabId, () => setActiveTab(tab.id), true)}
            </div>
          ))}
          {renderDropIndicator(leftPaneNonChat.length, "left")}
        </div>
        <div className="w-1 shrink-0 bg-border" />
        <div
          ref={rightPaneRef}
          className="flex items-center overflow-x-auto scrollbar-none min-w-0"
          style={{ width: `${ratio * 100}%` }}
          onDragOver={handleRightDragOver}
          onDrop={handleSplitDrop}
        >
          {rightPaneTabs.map((tab, i) => (
            <div key={tab.id} className="flex items-center">
              {renderDropIndicator(i, "right")}
              {renderTabButton(tab, tab.id === splitTabId, () => setSplitTab(tab.id), true)}
            </div>
          ))}
          {renderDropIndicator(rightPaneTabs.length, "right")}
          {splitToggle}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="shrink-0 border-b flex items-center overflow-x-auto scrollbar-none bg-background"
      onDragOver={handleContainerDragOver}
      onDrop={handleDrop}
    >
      {renderTabButton(tabs.tabs[0], activeTabId === "chat", () => setActiveTab("chat"), false)}
      {nonChatTabs.map((tab, i) => (
        <div key={tab.id} className="flex items-center">
          {renderDropIndicator(i)}
          {renderTabButton(tab, tab.id === activeTabId, () => setActiveTab(tab.id), true)}
        </div>
      ))}
      {renderDropIndicator(nonChatTabs.length)}
      {splitToggle}
    </div>
  );
}
