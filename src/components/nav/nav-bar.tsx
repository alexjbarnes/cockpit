"use client";

import { useAssistant } from "@/components/assistant-provider";
import { AssistantDotBadge } from "@/components/nav/assistant-dot-badge";
import { NavItem } from "@/components/nav/nav-item";
import { NAV_ITEMS, type NavKey } from "@/components/nav/nav-items";
import { useNav } from "@/components/nav/nav-provider";
import { useKeyboardOpen } from "@/hooks/use-keyboard-open";
import { useSettings } from "@/hooks/use-settings";
import type { Place } from "@/lib/places";

/**
 * The phone navigation: a row along the bottom, and a More page for what does
 * not fit. It gives way to the keyboard, detected from the viewport rather
 * than from focus: hiding on focus moved the composer as Send was tapped, so
 * the first tap was lost.
 */
export function NavBar() {
  const { place, go, goMore, inboxUnread } = useNav();
  const { settings } = useSettings();
  const assistant = useAssistant();
  const keyboardOpen = useKeyboardOpen();
  if (keyboardOpen) return null;
  const item = (key: NavKey, active: boolean, onClick: () => void, badge?: React.ReactNode) => {
    const { label, title, icon } = NAV_ITEMS[key];
    return (
      <NavItem
        key={key}
        variant="bar"
        label={label}
        title={title}
        icon={icon}
        active={active}
        onClick={onClick}
        badge={badge}
        testId={`nav-bar-${key}`}
      />
    );
  };
  const page = (key: Place) => item(key, assistant.open ? false : place === key, () => go(key));
  const inMore = place !== null && place !== "sessions" && place !== "issues" && place !== "inbox";

  return (
    <nav className="md:hidden shrink-0 flex border-t bg-background" data-testid="app-nav-bar" aria-label="Main">
      {page("sessions")}
      {settings.issuesEnabled && page("issues")}
      {item(
        "inbox",
        assistant.open ? false : place === "inbox",
        () => go("inbox"),
        inboxUnread > 0 ? <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-blue-500" /> : null,
      )}
      {item("assistant", assistant.open, assistant.openAssistant, <AssistantDotBadge dot={assistant.dot} testId="nav-bar-assistant-dot" />)}
      {item("more", inMore, goMore)}
    </nav>
  );
}
