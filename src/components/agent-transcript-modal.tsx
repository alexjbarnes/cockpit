"use client";

import { Loader2, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { useHistoryModal } from "@/hooks/use-history-modal";
import { isAsyncLaunchOutput } from "@/lib/agent-tasks";
import { type AgentTarget, agentRunning, atLatest, sameTranscript, splitAgentTranscript } from "@/lib/agent-transcript";
import type { ChatMessage } from "@/types";
import { useShell } from "./app-shell";
import { MessageBubble } from "./message-bubble";
import { ToolCard } from "./tool-card";

/** How often an open transcript re-reads a still-working agent. Each poll is
 *  one read of that agent's JSONL, and only while its transcript is open. */
const TRANSCRIPT_POLL_MS = 3000;

interface AgentTranscripts {
  openAgent: (agent: AgentTarget) => void;
}

const AgentTranscriptContext = createContext<AgentTranscripts | null>(null);

/** Opens an agent's transcript over the page, or null outside a provider. */
export function useAgentTranscripts(): AgentTranscripts | null {
  return useContext(AgentTranscriptContext);
}

/**
 * Shows agents' transcripts in a modal over everything else. The app shell
 * provides one for the session it shows; a view of another session's messages
 * (the assistant, a job run, a search result) wraps them in its own, so their
 * agents are looked up in that session.
 */
export function AgentTranscriptProvider({ sessionId, cwd, children }: { sessionId?: string; cwd?: string; children: ReactNode }) {
  const { value: agent, open, close } = useHistoryModal<AgentTarget>();
  const transcripts = useMemo(() => ({ openAgent: open }), [open]);
  return (
    <AgentTranscriptContext.Provider value={transcripts}>
      {children}
      {agent &&
        createPortal(<AgentTranscriptModal key={agent.id} agent={agent} sessionId={sessionId} cwd={cwd} onClose={close} />, document.body)}
    </AgentTranscriptContext.Provider>
  );
}

/** The agent's transcript, re-read while it works and once more when it stops. */
function useAgentMessages(id: string, sessionId: string | undefined, cwd: string | undefined, running: boolean) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    const params = new URLSearchParams({ toolUseId: id });
    if (cwd) params.set("cwd", cwd);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/subagents?${params}`);
      if (res.status !== 404 && !res.ok) throw new Error("Couldn't load the agent's transcript");
      const next = res.status === 404 ? [] : (((await res.json()) as { messages?: ChatMessage[] }).messages ?? []);
      setMessages((prev) => (sameTranscript(prev, next) ? prev : next));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id, sessionId, cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), TRANSCRIPT_POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  // One last read when the agent stops, for whatever it wrote after the final poll.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void load();
    wasRunning.current = running;
  }, [running, load]);

  return { messages, error, loading: !!sessionId && messages === null && error === null };
}

function AgentTranscriptModal({
  agent,
  sessionId,
  cwd,
  onClose,
}: {
  agent: AgentTarget;
  sessionId?: string;
  cwd?: string;
  onClose: () => void;
}) {
  const { backgroundTasks } = useShell();
  const running = agentRunning(agent, backgroundTasks);
  const { messages, error, loading } = useAgentMessages(agent.id, sessionId, cwd, running);
  const { prompt, work } = useMemo(() => splitAgentTranscript(messages ?? [], agent.prompt), [messages, agent.prompt]);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const expandedToolIds = useRef<Set<string>>(new Set());

  // Take focus from the page underneath: left in the composer, the Escape
  // that closes this would also reach it and stop Claude mid-turn.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Opens at the latest message and stays there as the agent adds more, until
  // the reader scrolls up; scrolling back down picks the latest up again.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    let following = true;
    const observer = new ResizeObserver(() => {
      if (following) scroller.scrollTop = scroller.scrollHeight;
    });
    const onScroll = () => {
      following = atLatest(scroller);
    };
    observer.observe(content);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
    };
  }, []);

  const tags = [agent.agentType, agent.model].filter((t): t is string => !!t);
  // With no transcript to show, the launch's own record stands in: the calls
  // nested under it and, for an agent that did not run in the background, its
  // result.
  const nested = agent.tool?.children ?? [];
  const result = agent.tool && !isAsyncLaunchOutput(agent.tool.output) ? agent.tool.output : "";
  const settled = !loading && !error;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={agent.description ? `Agent: ${agent.description}` : "Agent transcript"}
        className="flex h-full w-full flex-col overflow-hidden bg-background outline-none sm:h-[85dvh] sm:max-w-4xl sm:rounded-lg sm:border sm:shadow-lg"
        data-testid="agent-transcript"
      >
        <div className="flex shrink-0 items-start gap-2 border-b px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-mono text-sm font-medium">Agent</span>
              {running && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
              {tags.map((tag) => (
                <span key={tag} className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>
            {agent.description && <span className="truncate text-xs text-muted-foreground">{agent.description}</span>}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={onClose}
            title="Close"
            data-testid="agent-transcript-close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3" data-testid="agent-transcript-scroll">
          <div ref={contentRef} className="space-y-4">
            {prompt && (
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-[11px] leading-relaxed text-muted-foreground">
                {prompt}
              </pre>
            )}
            {work.map((m) => (
              <MessageBubble key={m.id} message={m} expandedToolIds={expandedToolIds} />
            ))}
            {settled && work.length === 0 && nested.length > 0 && (
              <div className="space-y-1">
                {nested.map((child) => (
                  <ToolCard key={child.id} tool={child} expandedToolIds={expandedToolIds} />
                ))}
              </div>
            )}
            {settled && work.length === 0 && result && (
              <pre className="whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-[11px] leading-relaxed text-muted-foreground">
                {result}
              </pre>
            )}
            {settled && work.length === 0 && nested.length === 0 && !result && !running && (
              <p className="text-xs italic text-muted-foreground">
                {messages?.length ? "The agent hasn't replied yet." : "No transcript recorded for this agent."}
              </p>
            )}
            {loading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading the transcript…
              </div>
            )}
            {error && <p className="text-xs text-red-500">{error}</p>}
            {running && !loading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="agent-transcript-working">
                <Loader2 className="h-3 w-3 animate-spin" />
                Working…
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
