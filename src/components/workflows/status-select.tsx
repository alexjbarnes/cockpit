"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { statusColor } from "@/lib/issue-display";
import { cn } from "@/lib/utils";

/** The same select the issue page uses for a status, so one looks like the other. */
const SELECT = "min-w-0 flex-1 rounded-md border bg-background px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const NEW = "\u0000new";

/** A status as the board shows it: its colour dot and its name. */
export function StatusName({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span className={cn("h-2 w-2 shrink-0 rounded-full", name ? statusColor(name) : "bg-muted-foreground/40")} />
      <span className="truncate">{name || "No status"}</span>
    </span>
  );
}

/**
 * Pick an issue status: the project's own statuses in a dropdown, with its
 * colour beside it, as everywhere else in the app. "New status" takes a name
 * for one no project has yet.
 */
export function StatusSelect({
  value,
  onChange,
  statuses,
  none,
  testId,
  label,
}: {
  value: string;
  onChange: (status: string) => void;
  statuses: readonly string[];
  /** Offer no status at all, under this wording. */
  none?: string;
  testId?: string;
  label: string;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const options = value && !statuses.includes(value) ? [value, ...statuses] : statuses;

  if (naming) {
    const commit = () => {
      const trimmed = name.trim();
      if (trimmed) onChange(trimmed);
      setNaming(false);
      setName("");
    };
    return (
      <Input
        autoFocus
        value={name}
        aria-label={`New status for: ${label}`}
        placeholder="Name the new status"
        data-testid={testId ? `${testId}-new` : undefined}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", value ? statusColor(value) : "bg-muted-foreground/30")} />
      <select
        aria-label={label}
        data-testid={testId}
        value={value}
        onChange={(e) => (e.target.value === NEW ? setNaming(true) : onChange(e.target.value))}
        className={SELECT}
      >
        {(none !== undefined || !value) && <option value="">{none ?? "Choose a status"}</option>}
        {options.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
        <option value={NEW}>New status…</option>
      </select>
    </div>
  );
}
