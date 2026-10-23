"use client";

import { cn } from "@/lib/utils";

/** A row of mutually exclusive buttons, for a short choice such as a range. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  testId,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
  testId?: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 gap-0.5 rounded-md border p-0.5" data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-2.5 py-1 text-xs font-medium transition-colors",
            o.value === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
