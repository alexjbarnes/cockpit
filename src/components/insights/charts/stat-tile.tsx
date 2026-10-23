import type { ReactNode } from "react";

/** One headline number, with a line of context under it. */
export function StatTile({ label, value, sub, testId }: { label: string; value: ReactNode; sub?: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card p-3" data-testid={testId}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
