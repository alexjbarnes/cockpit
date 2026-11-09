"use client";

import { cn } from "@/lib/utils";

/** A row of mutually exclusive buttons, for a short choice such as a range.
 *  The default is a bordered group; `track` matches the session model switch:
 *  a muted track with the chosen option raised on the background colour. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  testId,
  variant = "outline",
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
  testId?: string;
  variant?: "outline" | "track";
}) {
  const track = variant === "track";
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("shrink-0 gap-0.5 p-0.5", track ? "flex w-full rounded-lg bg-muted" : "inline-flex rounded-md border")}
      data-testid={testId}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "text-xs font-medium transition-colors",
            track ? "min-w-0 flex-1 truncate rounded-md px-2 py-1.5" : "rounded px-2.5 py-1",
            o.value === value
              ? track
                ? "bg-background text-foreground shadow-sm"
                : "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
