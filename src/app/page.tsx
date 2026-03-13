"use client";

import { AppShell } from "@/components/app-shell";
import { SessionList } from "@/components/session-list";

export default function HomePage() {
  return (
    <AppShell title="Aperture">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <SessionList />
      </div>
    </AppShell>
  );
}
