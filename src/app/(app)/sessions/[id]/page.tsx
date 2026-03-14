"use client";

import { use, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { usePageHeader, useShellCwd } from "@/components/app-shell";
import { ChatView } from "@/components/chat-view";
import { addActiveSession, clearUnreadSession } from "@/components/sidebar";

export default function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const cwd = searchParams.get("cwd") || "";

  usePageHeader("Session", true);
  useShellCwd(cwd || undefined);

  useEffect(() => {
    addActiveSession(id);
    clearUnreadSession(id);
  }, [id]);

  return <ChatView sessionId={id} cwd={cwd} />;
}
