"use client";

import { useSearchParams } from "next/navigation";
import { use, useEffect } from "react";
import { useShellCwd, useShellSessionId } from "@/components/app-shell";
import { ChatView } from "@/components/chat-view";
import { clearUnreadSession, pinSession } from "@/components/sidebar";

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const cwd = searchParams.get("cwd") || "";
  const name = searchParams.get("name") || undefined;
  const historyView = searchParams.get("historyView") === "true";

  useShellCwd(cwd || undefined);
  useShellSessionId(id);

  useEffect(() => {
    if (!historyView) {
      pinSession(id);
    }
    clearUnreadSession(id);
  }, [id, historyView]);

  return <ChatView sessionId={id} cwd={cwd} initialName={name} historyView={historyView} />;
}
