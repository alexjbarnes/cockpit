"use client";

import { use, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useShellCwd } from "@/components/app-shell";
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
  const name = searchParams.get("name") || undefined;

  useShellCwd(cwd || undefined);

  useEffect(() => {
    addActiveSession(id);
    clearUnreadSession(id);
  }, [id]);

  return <ChatView sessionId={id} cwd={cwd} initialName={name} />;
}
