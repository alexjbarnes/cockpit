"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import type { InsightsSessionLabel } from "@/types";
import { timeOfDay } from "./charts/kit";

/** Which session the page is narrowed to, and a way into it. */
export function SessionHeader({ label }: { label: InsightsSessionLabel }) {
  const where = [label.job ? `Job: ${label.job.name}` : null, label.project?.label, label.cwd].filter(Boolean);
  const ran = [...label.models, ...label.providers.filter((p) => p !== "anthropic").map((p) => `on ${p}`)];
  return (
    <div
      className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-lg border bg-card p-3"
      data-testid="insights-session-header"
    >
      <div className="min-w-0 space-y-0.5">
        <div className="truncate font-medium">{label.name}</div>
        {where.length > 0 && <div className="truncate text-xs text-muted-foreground">{where.join(" · ")}</div>}
        {ran.length > 0 && <div className="truncate text-xs text-muted-foreground">{ran.join(" · ")}</div>}
        {label.firstMs !== undefined && label.lastMs !== undefined && (
          <div className="text-xs text-muted-foreground">
            {timeOfDay(label.firstMs)} to {timeOfDay(label.lastMs)}
          </div>
        )}
      </div>
      {label.cwd && (
        <Link
          href={`/sessions/${label.id}?cwd=${encodeURIComponent(label.cwd)}`}
          className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          data-testid="insights-open-session"
        >
          Open session
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  );
}
