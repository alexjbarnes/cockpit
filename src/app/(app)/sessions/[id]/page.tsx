"use client";

import { useSearchParams } from "next/navigation";
import { use, useEffect } from "react";
import { useShellCwd, useShellSessionId } from "@/components/app-shell";
import { clearUnreadSession, pinSession } from "@/components/sidebar";
import { TabbedSessionView } from "@/components/tabbed-session-view";

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const cwd = searchParams.get("cwd") || "";
  const name = searchParams.get("name") || undefined;
  const historyView = searchParams.get("historyView") === "true";

  useEffect(() => {
    console.log(`[session-page] mounted ${id.slice(0, 8)} at ${performance.now().toFixed(0)}ms`);
  }, [id]);

  useShellCwd(cwd || undefined);
  useShellSessionId(id);

  useEffect(() => {
    pinSession(id);
    clearUnreadSession(id);
  }, [id]);

  return <TabbedSessionView sessionId={id} cwd={cwd || ""} initialName={name} historyView={historyView} />;
}
