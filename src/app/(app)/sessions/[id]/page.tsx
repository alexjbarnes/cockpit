"use client";

import { useSearchParams } from "next/navigation";
import { use, useEffect } from "react";
import { useShellSessionId } from "@/components/app-shell";
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

  // The shell's cwd is published by TabbedSessionView, which knows the
  // session's live working directory. Setting it here from the URL's cwd would
  // run after that effect and put the original checkout back over a worktree.
  useShellSessionId(id);

  useEffect(() => {
    pinSession(id);
    clearUnreadSession(id);
  }, [id]);

  return <TabbedSessionView sessionId={id} cwd={cwd || ""} initialName={name} historyView={historyView} />;
}
