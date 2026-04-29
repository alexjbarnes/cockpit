"use client";

import { useSearchParams } from "next/navigation";
import { usePageHeader, useShellCwd } from "@/components/app-shell";
import { ChangesView } from "@/components/changes-view";
import { useSessionForCwd } from "@/hooks/use-session-for-cwd";

export default function ChangesPage() {
  const searchParams = useSearchParams();
  const cwd = searchParams.get("cwd") || "";
  const urlSessionId = searchParams.get("sessionId");

  usePageHeader("Changes");
  useShellCwd(cwd || undefined);

  const { sessionId } = useSessionForCwd(cwd, urlSessionId);

  if (!cwd) {
    return <div className="flex items-center justify-center h-full text-sm text-muted-foreground">No working directory specified.</div>;
  }

  return <ChangesView cwd={cwd} sessionId={sessionId} />;
}
