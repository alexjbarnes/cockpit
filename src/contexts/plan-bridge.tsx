"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { PendingPermission } from "@/hooks/use-session";
import type { PlanAnswerExtras } from "@/lib/plan-review/approval";

/**
 * What the Plan tab needs from the chat. The session's live state (the plan
 * waiting for an answer, and the ways to answer it) lives in the chat view's
 * session hook; the Plan tab is its sibling, not its child. The chat publishes
 * here and the tab reads, so there is still one session hook and one socket
 * conversation, and an answer given in the tab clears the card in the chat.
 */
export interface PlanBridge {
  /** The plan waiting for a decision, if one is. */
  pending: PendingPermission | null;
  bypassActive: boolean;
  respond: (requestId: string, allowed: boolean, extras?: PlanAnswerExtras) => void;
  sendMessage: (text: string) => void;
  setBypass: (enabled: boolean) => void;
  setPlanMode: (enabled: boolean) => void;
}

interface PlanBridgeContextValue {
  bridge: PlanBridge | null;
  publish: (bridge: PlanBridge | null) => void;
}

const PlanBridgeContext = createContext<PlanBridgeContextValue | null>(null);

export function PlanBridgeProvider({ children }: { children: React.ReactNode }) {
  const [bridge, publish] = useState<PlanBridge | null>(null);
  const value = useMemo(() => ({ bridge, publish }), [bridge]);
  return <PlanBridgeContext.Provider value={value}>{children}</PlanBridgeContext.Provider>;
}

/** The chat's side. Null outside a tabbed session (the assistant's modal). */
export function usePlanBridgePublisher(): ((bridge: PlanBridge | null) => void) | null {
  return useContext(PlanBridgeContext)?.publish ?? null;
}

/** The Plan tab's side. */
export function usePlanBridge(): PlanBridge | null {
  return useContext(PlanBridgeContext)?.bridge ?? null;
}
