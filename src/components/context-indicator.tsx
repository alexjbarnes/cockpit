"use client";

import { useState, useEffect } from "react";
import { X, Shrink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ContextUsage } from "@/types";

interface ContextIndicatorProps {
  usage: ContextUsage;
  onCompact?: () => void;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function ContextIndicator({ usage, onCompact }: ContextIndicatorProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

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
              <span>{formatTokens(usage.used)} used</span>
              <span>{formatTokens(usage.total)} total</span>
            </div>
            {onCompact && (
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-4"
                onClick={() => { onCompact(); setOpen(false); }}
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
