"use client";

import { useAssistant } from "@/components/assistant-provider";
import { AssistantDotBadge } from "@/components/nav/assistant-dot-badge";
import { NavItem } from "@/components/nav/nav-item";
import { NAV_ITEMS, type NavKey } from "@/components/nav/nav-items";
import { useNav } from "@/components/nav/nav-provider";
import { useSettings } from "@/hooks/use-settings";
import type { Place } from "@/lib/places";

function Dot({ className }: { className: string }) {
  return <span className={`absolute top-1 right-1 h-2 w-2 rounded-full ${className}`} />;
}

/**
 * The desktop navigation: a column down the left edge. The session list is
 * not part of it; it shows beside a session, where it is useful.
 */
export function NavRail() {
  const { place, go, inboxUnread, jobFailures } = useNav();
  const { settings } = useSettings();
  const assistant = useAssistant();

  const item = (key: NavKey, active: boolean, onClick: () => void, badge?: React.ReactNode) => {
    const { label, title, icon } = NAV_ITEMS[key];
    return (
      <NavItem
        key={key}
        variant="rail"
        label={label}
        title={title}
        icon={icon}
        active={active}
        onClick={onClick}
        badge={badge}
        testId={`nav-rail-${key}`}
      />
    );
  };
  const page = (key: Place) => item(key, assistant.open ? false : place === key, () => go(key));

  return (
    <nav
      className="hidden md:flex w-[68px] shrink-0 flex-col items-center gap-0.5 border-r bg-background py-2"
      data-testid="app-nav-rail"
      aria-label="Main"
    >
      {page("sessions")}
      {settings.issuesEnabled && page("issues")}
      {item(
        "inbox",
        assistant.open ? false : place === "inbox",
        () => go("inbox"),
        inboxUnread > 0 ? <Dot className="bg-blue-500" /> : null,
      )}
      {item("jobs", assistant.open ? false : place === "jobs", () => go("jobs"), jobFailures > 0 ? <Dot className="bg-red-500" /> : null)}
      {settings.telemetryEnabled && page("insights")}
      {settings.reviewsEnabled && page("reviews")}
      <span className="flex-1" />
      {item("assistant", assistant.open, assistant.openAssistant, <AssistantDotBadge dot={assistant.dot} />)}
      {page("settings")}
    </nav>
  );
}
