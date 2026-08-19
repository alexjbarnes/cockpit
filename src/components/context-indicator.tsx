"use client";

import { Shrink, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ContextUsage } from "@/types";

interface ContextIndicatorProps {
  usage: ContextUsage;
  sessionId: string;
  cwd?: string;
  onCompact?: () => void;
}

interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function ContextIndicator({ usage, sessionId, cwd, onCompact }: ContextIndicatorProps) {
  const [open, setOpen] = useState(false);
  const [totals, setTotals] = useState<TokenTotals | null>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  // Fetched on open, not pushed: it costs a full transcript scan, and nothing
  // outside this panel wants it. Re-fetched each time so it reflects the turns
  // since it was last looked at.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/sessions/${sessionId}/usage${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((t: TokenTotals | null) => {
        if (live) setTotals(t);
      })
      .catch(() => {
        if (live) setTotals(null);
      });
    return () => {
      live = false;
    };
  }, [open, sessionId, cwd]);

  // Share of the prompt tokens this session has paid for that were served from
  // the provider's cache. The denominator is every prompt token — Anthropic
  // reports cache reads and writes outside input_tokens, so summing all three
  // is what "the whole prompt" means.
  const promptTokens = totals ? totals.input + totals.cacheRead + totals.cacheCreate : 0;
  const hitRate = promptTokens > 0 ? Math.round(((totals?.cacheRead ?? 0) / promptTokens) * 100) : null;

  const pct = Math.round((usage.used / usage.total) * 100);
  const strokeColor = pct > 80 ? "#ef4444" : pct > 50 ? "#f97316" : "#22c55e";

  const size = 14;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.min(pct, 100) / 100) * circumference;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center justify-center w-8 h-6 rounded-md hover:bg-muted transition-colors"
        title={`Context: ${pct}%`}
        data-testid="context-indicator"
      >
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            className="text-muted-foreground/25"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={circumference - filled}
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-sm mx-4 rounded-lg border bg-background p-5 shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">Context Usage</h2>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex justify-between text-sm mb-2">
              <span>Tokens used</span>
              <span className="text-muted-foreground">{pct}%</span>
            </div>
            <div className="h-2.5 rounded-full bg-muted overflow-hidden mb-2">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: strokeColor }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span data-testid="context-used">{formatTokens(usage.used)} used</span>
              <span data-testid="context-total">{formatTokens(usage.total)} total</span>
            </div>
            {totals && (
              <div className="mt-5 pt-4 border-t" data-testid="session-totals">
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="text-sm font-medium">Session totals</h3>
                  {hitRate !== null && (
                    <span className="text-xs text-muted-foreground" data-testid="cache-hit-rate">
                      {hitRate}% from cache
                    </span>
                  )}
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <dt>Input</dt>
                  <dd className="text-right tabular-nums" data-testid="total-input">
                    {formatTokens(totals.input)}
                  </dd>
                  <dt>Output</dt>
                  <dd className="text-right tabular-nums" data-testid="total-output">
                    {formatTokens(totals.output)}
                  </dd>
                  <dt>Cache read</dt>
                  <dd className="text-right tabular-nums" data-testid="total-cache-read">
                    {formatTokens(totals.cacheRead)}
                  </dd>
                  <dt>Cache write</dt>
                  <dd className="text-right tabular-nums" data-testid="total-cache-write">
                    {formatTokens(totals.cacheCreate)}
                  </dd>
                </dl>
                {hitRate === null && <p className="mt-2 text-xs text-muted-foreground">No completed turns yet.</p>}
              </div>
            )}
            {onCompact && (
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-4"
                onClick={() => {
                  onCompact();
                  setOpen(false);
                }}
              >
                <Shrink className="h-3.5 w-3.5 mr-2" />
                Compact now
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
