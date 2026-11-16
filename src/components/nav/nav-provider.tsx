"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useInboxUnread } from "@/hooks/use-inbox-unread";
import { useJobFailureCount } from "@/hooks/use-jobs";
import { usePlaceNavigation } from "@/hooks/use-place-navigation";
import type { NavPlace, Place } from "@/lib/places";

interface NavContextValue {
  place: NavPlace | null;
  go: (place: Place) => void;
  goMore: () => void;
  inboxUnread: number;
  jobFailures: number;
}

const NavContext = createContext<NavContextValue | null>(null);

/**
 * The navigation's shared state: where you are, where each item goes, and the
 * two counts the dots need. Polled once here rather than by each navigation
 * surface.
 */
export function NavProvider({ children }: { children: ReactNode }) {
  const { place, go, goMore } = usePlaceNavigation();
  const inboxUnread = useInboxUnread();
  const { count: jobFailures } = useJobFailureCount();

  const value = useMemo(() => ({ place, go, goMore, inboxUnread, jobFailures }), [place, go, goMore, inboxUnread, jobFailures]);
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNav must be used inside NavProvider");
  return ctx;
}
