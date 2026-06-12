"use client";

import { usePageHeader } from "@/components/app-shell";
import { SessionList } from "@/components/session-list";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";

export default function HomePage() {
  usePageHeader("Cockpit", { usageOnly: true });
  const scrollRef = useScrollRestoration<HTMLDivElement>("sessions-scroll");

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
      <SessionList />
    </div>
  );
}
