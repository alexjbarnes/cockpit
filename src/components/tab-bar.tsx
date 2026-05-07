"use client";

import { Columns2, FileDiff, FileText, GitBranch, MessageSquare, X } from "lucide-react";
import type { Tab } from "@/contexts/tab-context";
import { useTabContext } from "@/contexts/tab-context";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { cn } from "@/lib/utils";

function tabIcon(tab: Tab) {
  switch (tab.type) {
    case "chat":
      return <MessageSquare className="h-3 w-3 shrink-0" />;
    case "file":
      return <FileText className="h-3 w-3 shrink-0" />;
    case "diff":
      return <FileDiff className="h-3 w-3 shrink-0" />;
    case "changes":
      return <GitBranch className="h-3 w-3 shrink-0" />;
  }
}

function tabLabel(tab: Tab): string {
  switch (tab.type) {
    case "chat":
      return "Chat";
    case "file":
      return tab.label;
    case "diff":
      return tab.label;
    case "changes":
      return "Changes";
  }
}

export function TabBar() {
  const tabs = useTabContext();
  const isDesktop = useIsDesktop();

  if (!tabs || tabs.tabs.length <= 1) return null;

  const { activeTabId, splitTabId, setActiveTab, closeTab, setSplitTab } = tabs;
  const hasNonChatTab = tabs.tabs.some((t) => t.type !== "chat");

  return (
    <div className="shrink-0 border-b flex items-center overflow-x-auto scrollbar-none bg-background">
      {tabs.tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const inSplit = tab.id === splitTabId;
        return (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors group",
              active
                ? "border-primary text-foreground"
                : inSplit
                  ? "border-primary/50 text-foreground/80"
                  : "border-transparent text-muted-foreground hover:text-foreground",
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
                className="ml-0.5 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-muted transition-opacity"
              >
                <X className="h-2.5 w-2.5" />
              </span>
            )}
          </button>
        );
      })}
      {isDesktop && hasNonChatTab && (
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
            "ml-auto shrink-0 flex items-center justify-center px-2 py-1.5 text-muted-foreground hover:text-foreground transition-colors",
            splitTabId && "text-primary",
          )}
        >
          <Columns2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
