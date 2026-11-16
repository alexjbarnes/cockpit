"use client";

import type { LucideIcon } from "lucide-react";
import { Bot, CalendarClock, ChartLine, ClipboardList, Ellipsis, GitPullRequest, Inbox, MessageSquare, Settings } from "lucide-react";

/** Everything the navigation can show, in one place so the rail, the bar and
 *  the More page cannot drift apart. */
export type NavKey = "sessions" | "issues" | "inbox" | "jobs" | "insights" | "reviews" | "assistant" | "settings" | "more";

export const NAV_ITEMS: Record<NavKey, { label: string; title: string; icon: LucideIcon }> = {
  sessions: { label: "Sessions", title: "Sessions", icon: MessageSquare },
  issues: { label: "Issues", title: "Issues", icon: ClipboardList },
  inbox: { label: "Inbox", title: "Inbox", icon: Inbox },
  jobs: { label: "Jobs", title: "Scheduled Jobs", icon: CalendarClock },
  insights: { label: "Insights", title: "Insights", icon: ChartLine },
  reviews: { label: "Reviews", title: "Reviews", icon: GitPullRequest },
  assistant: { label: "Assistant", title: "Cockpit Assistant", icon: Bot },
  settings: { label: "Settings", title: "Settings", icon: Settings },
  more: { label: "More", title: "More", icon: Ellipsis },
};
