"use client";

import { Columns2, FileDiff, FileText, GitBranch, MessageSquare, X } from "lucide-react";
import { Fragment, useRef, useState } from "react";
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
  }
}

interface TabBarProps {
  splitRatio?: number;
}

export function TabBar({ splitRatio }: TabBarProps) {
  const tabs = useTabContext();
  const isDesktop = useIsDesktop();
  const dragTabId = useRef<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  if (!tabs || tabs.tabs.length <= 1) return null;

  const { activeTabId, splitTabId, setActiveTab, closeTab, setSplitTab, moveTab } = tabs;
  const isSplit = isDesktop && splitTabId !== null;
  const nonChatTabs = tabs.tabs.filter((t) => t.type !== "chat");

  const handleDragStart = (tabId: string) => (e: React.DragEvent) => {
    dragTabId.current = tabId;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", tabId);
  };

  const handleDragEnd = () => {
    dragTabId.current = null;
    setDropIndex(null);
  };

  const handleDragOverTab = (displayIdx: number) => (e: React.DragEvent) => {
    if (!dragTabId.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const idx = e.clientX < midX ? displayIdx : displayIdx + 1;
    const dragIdx = nonChatTabs.findIndex((t) => t.id === dragTabId.current);
    if (idx === dragIdx || idx === dragIdx + 1) {
      setDropIndex(null);
      return;
    }
    setDropIndex(idx);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (dragTabId.current && dropIndex !== null) {
      moveTab(dragTabId.current, dropIndex + 1);
    }
    dragTabId.current = null;
    setDropIndex(null);
  };

  const renderIndicator = (index: number) => (
    <div
      key={`ind-${index}`}
      onDragOver={(e) => {
        if (!dragTabId.current) return;
        e.preventDefault();
        setDropIndex(index);
      }}
      onDrop={handleDrop}
      className={cn("self-stretch shrink-0 rounded-full transition-all", dropIndex === index ? "w-0.5 bg-primary mx-0.5" : "w-0")}
    />
  );

  const renderTabButton = (tab: Tab, active: boolean, onClick: () => void, draggable: boolean, displayIdx: number) => (
    <button
      draggable={draggable}
      onDragStart={draggable ? handleDragStart(tab.id) : undefined}
      onDragEnd={draggable ? handleDragEnd : undefined}
      onDragOver={draggable ? handleDragOverTab(displayIdx) : undefined}
      onDrop={draggable ? handleDrop : undefined}
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
    return (
      <div className="shrink-0 border-b flex items-center bg-background">
        <div className="flex items-center overflow-x-auto scrollbar-none min-w-0" style={{ width: `${(1 - ratio) * 100}%` }}>
          {renderTabButton(tabs.tabs[0], true, () => {}, false, -1)}
        </div>
        <div className="w-1 shrink-0 bg-border" />
        <div
          className="flex items-center overflow-x-auto scrollbar-none min-w-0"
          style={{ width: `${ratio * 100}%` }}
          onDragOver={(e) => {
            if (dragTabId.current) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={handleDrop}
        >
          {nonChatTabs.map((tab, i) => (
            <Fragment key={tab.id}>
              {renderIndicator(i)}
              {renderTabButton(tab, tab.id === splitTabId, () => setSplitTab(tab.id), true, i)}
            </Fragment>
          ))}
          {renderIndicator(nonChatTabs.length)}
          {splitToggle}
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-b flex items-center overflow-x-auto scrollbar-none bg-background">
      {renderTabButton(tabs.tabs[0], activeTabId === "chat", () => setActiveTab("chat"), false, -1)}
      {nonChatTabs.map((tab, i) => (
        <Fragment key={tab.id}>
          {renderIndicator(i)}
          {renderTabButton(tab, tab.id === activeTabId, () => setActiveTab(tab.id), true, i)}
        </Fragment>
      ))}
      {renderIndicator(nonChatTabs.length)}
      {splitToggle}
    </div>
  );
}
