"use client";

import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/** A full-width row that opens a page: the Settings page's rows, and the
 *  phone's More page. */
export function NavRow({ label, onClick, icon, testId }: { label: string; onClick: () => void; icon?: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex w-full items-center justify-between rounded-lg px-3 py-3 text-sm hover:bg-muted/50 transition-colors"
    >
      <span className="flex items-center gap-3">
        {icon}
        {label}
      </span>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </button>
  );
}
