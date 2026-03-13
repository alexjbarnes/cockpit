"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { ContextUsage } from "@/types";

interface ContextIndicatorProps {
  usage: ContextUsage;
}

export function ContextIndicator({ usage }: ContextIndicatorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const pct = Math.round((usage.used / usage.total) * 100);
  const strokeColor = pct > 80 ? "#ef4444" : pct > 50 ? "#f97316" : "#22c55e";

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open, handleClickOutside]);

  const formatTokens = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  // SVG arc parameters
  const size = 14;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.min(pct, 100) / 100) * circumference;

  return (
    <div ref={ref} className="relative flex items-center justify-center w-8 h-6">
      <button
        onClick={() => setOpen((v) => !v)}
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
        <div className="absolute bottom-full mb-2 left-0 w-52 rounded-md border border-input bg-popover p-3 shadow-md text-xs z-50">
          <div className="flex justify-between mb-1.5">
            <span className="text-muted-foreground">Context usage</span>
            <span className="font-medium">{pct}%</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden mb-2">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: strokeColor }}
            />
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>{formatTokens(usage.used)} used</span>
            <span>{formatTokens(usage.total)} total</span>
          </div>
        </div>
      )}
    </div>
  );
}
