"use client";

import { usePageHeader } from "@/components/app-shell";
import { SessionList } from "@/components/session-list";

export default function HomePage() {
  usePageHeader("Cockpit", { usageOnly: true });

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <SessionList />
    </div>
  );
}
