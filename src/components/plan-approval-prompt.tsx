"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { ClipboardCheck, Send } from "lucide-react";
import type { PendingPermission } from "@/hooks/use-session";
import type { PermissionMode } from "@/types";

interface AllowedPrompt {
  tool: string;
  prompt: string;
}

interface PlanApprovalPromptProps {
  permission: PendingPermission;
  onRespond: (requestId: string, allowed: boolean, permissionMode?: PermissionMode, suggestionIndex?: number) => void;
  onSendMessage: (text: string) => void;
  onSetBypass: (enabled: boolean) => void;
}

interface PlanOption {
  label: string;
  clearContext: boolean;
  autoAccept: boolean;
}

const OPTIONS: PlanOption[] = [
  { label: "Yes, clear context and auto-accept edits", clearContext: true, autoAccept: true },
  { label: "Yes, clear context and manually approve edits", clearContext: true, autoAccept: false },
  { label: "Yes, auto-accept edits", clearContext: false, autoAccept: true },
  { label: "Yes, manually approve edits", clearContext: false, autoAccept: false },
];

export function PlanApprovalPrompt({ permission, onRespond, onSendMessage, onSetBypass }: PlanApprovalPromptProps) {
  const [selected, setSelected] = useState(0);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);

  const allowedPrompts = useMemo<AllowedPrompt[]>(() => {
    if (!permission.input) return [];
    try {
      const parsed = JSON.parse(permission.input);
      return (parsed.allowedPrompts as AllowedPrompt[]) || [];
    } catch {
      return [];
    }
  }, [permission.input]);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (showFeedback) {
      feedbackRef.current?.focus();
    }
  }, [showFeedback]);

  const handleProceed = useCallback((optionIndex: number) => {
    const opt = OPTIONS[optionIndex];
    if (opt.autoAccept) {
      onSetBypass(true);
    }
    if (opt.clearContext) {
      // Reject ExitPlanMode (stops agent from continuing in old context),
      // clear conversation, then start a fresh turn. /clear kills the process
      // and creates a new session ID so the CLI starts with a clean context.
      // The new session won't know the plan file, so we include its path.
      const planRef = permission.planFilePath
        ? ` at ${permission.planFilePath}`
        : "";
      onRespond(permission.requestId, false, "deny");
      setTimeout(() => {
        onSendMessage("/clear");
        setTimeout(() => onSendMessage(`Implement the plan${planRef}`), 200);
      }, 100);
    } else {
      onRespond(permission.requestId, true, "allow");
    }
  }, [permission.requestId, permission.planFilePath, onRespond, onSendMessage, onSetBypass]);

  const handleSendFeedback = useCallback(() => {
    const text = feedback.trim();
    if (!text) return;
    onRespond(permission.requestId, false, "deny");
    setTimeout(() => onSendMessage(text), 100);
  }, [feedback, permission.requestId, onRespond, onSendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showFeedback) {
      if (e.key === "Escape") {
        e.preventDefault();
        setShowFeedback(false);
        containerRef.current?.focus();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSendFeedback();
      }
      return;
    }

    if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      setSelected((s) => Math.min(OPTIONS.length, s + 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selected === OPTIONS.length) {
        setShowFeedback(true);
      } else {
        handleProceed(selected);
      }
    }
  }, [showFeedback, selected, handleProceed, handleSendFeedback]);

  return (
    <div className="mx-auto max-w-3xl">
      <div
        ref={containerRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="rounded-lg border border-blue-500/50 bg-blue-500/10 p-4 outline-none"
      >
        <div className="flex items-start gap-3">
          <ClipboardCheck className="h-5 w-5 shrink-0 text-blue-500 mt-0.5" />
          <div className="flex-1 min-w-0 space-y-3">
            <div className="text-sm font-medium">Would you like to proceed?</div>
            {allowedPrompts.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  Permissions requested for implementation:
                </div>
                <ul className="text-xs text-muted-foreground space-y-0.5">
                  {allowedPrompts.map((p, i) => (
                    <li key={i} className="flex items-center gap-1.5 pl-2">
                      <span className="font-mono text-foreground/70">{p.tool}</span>
                      <span>{p.prompt}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="space-y-0.5">
              {OPTIONS.map((opt, i) => (
                <button
                  key={i}
                  onClick={() => handleProceed(i)}
                  onMouseEnter={() => setSelected(i)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                    selected === i
                      ? "bg-blue-600/20 text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="shrink-0 font-mono text-blue-500 w-4">{i + 1}.</span>
                  <span>{opt.label}</span>
                  {i === 0 && (
                    <span className="ml-auto text-[10px] text-muted-foreground hidden sm:inline">default</span>
                  )}
                </button>
              ))}
              <button
                onClick={() => setShowFeedback(true)}
                onMouseEnter={() => setSelected(OPTIONS.length)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                  selected === OPTIONS.length
                    ? "bg-blue-600/20 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="shrink-0 font-mono text-blue-500 w-4">5.</span>
                <span>Tell Claude what to change</span>
              </button>
            </div>
            {showFeedback && (
              <div className="space-y-2">
                <textarea
                  ref={feedbackRef}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Describe what you'd like to change about the plan..."
                  className="w-full rounded border border-border bg-background px-3 py-2 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
                  rows={3}
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleSendFeedback}
                    disabled={!feedback.trim()}
                    className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Send className="h-3 w-3" />
                    Send feedback
                  </button>
                  <button
                    onClick={() => {
                      setShowFeedback(false);
                      containerRef.current?.focus();
                    }}
                    className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
