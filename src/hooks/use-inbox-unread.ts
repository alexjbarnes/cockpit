"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/** How many inbox messages are unread, for the Inbox item's dot. Polled once
 *  for the whole shell rather than by each navigation surface. */
export function useInboxUnread(): number {
  const [unread, setUnread] = useState(0);
  const pathname = usePathname();

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname triggers a refetch on navigation
  useEffect(() => {
    const check = () => {
      fetch("/api/inbox?count=true")
        .then((r) => r.json())
        .then((d) => setUnread(d.unread || 0))
        .catch(() => {});
    };
    check();
    const interval = setInterval(check, 15_000);
    return () => clearInterval(interval);
  }, [pathname]);

  return unread;
}
