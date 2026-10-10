"use client";

import { Clock, Send, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

interface SendModeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSendNow: () => void;
  onSendAfterTurn: () => void;
}

/**
 * Offered on a long press or right-click of Send while Claude is working: hand
 * the message over now, for Claude to read at its next step, or hold it in
 * cockpit's queue and send it as a new message once the turn ends.
 *
 * Nothing here takes focus. The composer behind it is mid-message, and a
 * focused button would close the on-screen keyboard and shrink the viewport
 * this modal is centred in; preventing the default on mousedown leaves focus,
 * and the keyboard, where the user left them.
 */
export function SendModeModal({ open, onOpenChange, onSendNow, onSendAfterTurn }: SendModeModalProps) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onOpenChange]);

  if (!open) return null;

  const options = [
    {
      testId: "send-mode-now",
      icon: Send,
      title: "Send now",
      detail: "Claude reads it at its next step.",
      onSelect: onSendNow,
    },
    {
      testId: "send-mode-after-turn",
      icon: Clock,
      title: "Send when Claude finishes",
      detail: "Queued, then sent as a new message once this turn ends.",
      onSelect: onSendAfterTurn,
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div className="w-full max-w-sm mx-4 rounded-lg border bg-background p-5 shadow-lg" data-testid="send-mode-modal">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Claude is working</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            onMouseDown={(e) => e.preventDefault()}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-2">
          {options.map(({ testId, icon: Icon, title, detail, onSelect }) => (
            <button
              key={testId}
              type="button"
              data-testid={testId}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onOpenChange(false);
                onSelect();
              }}
              className="flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors hover:bg-muted"
            >
              <Icon className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{title}</span>
                <span className="block text-xs text-muted-foreground">{detail}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
