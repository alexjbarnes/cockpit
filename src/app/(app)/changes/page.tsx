"use client";

import { useSearchParams } from "next/navigation";
import { usePageHeader, useShellCwd } from "@/components/app-shell";
import { ChangesView } from "@/components/changes-view";

export default function ChangesPage() {
  const searchParams = useSearchParams();
  const cwd = searchParams.get("cwd") || "";

  usePageHeader("Changes", true);
  useShellCwd(cwd || undefined);

  if (!cwd) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No working directory specified.
      </div>
    );
  }

  return <ChangesView cwd={cwd} />;
}
