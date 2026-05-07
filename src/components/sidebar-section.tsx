"use client";

import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "cockpit_sidebar_sections";

function getSectionOpen(id: string, defaultOpen: boolean): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const map = JSON.parse(raw);
      if (id in map) return map[id];
    }
  } catch {}
  return defaultOpen;
}

function saveSectionOpen(id: string, open: boolean): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[id] = open;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

export function SidebarSection({
  id,
  title,
  badge,
  defaultOpen = true,
  actions,
  children,
}: {
  id: string;
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    setOpen(getSectionOpen(id, defaultOpen));
  }, [id, defaultOpen]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    saveSectionOpen(id, next);
  };

  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-center">
        <button
          type="button"
          onClick={toggle}
          className="flex flex-1 items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent/50 transition-colors min-w-0"
        >
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
          <span className="flex-1 min-w-0 truncate">{title}</span>
          {badge && <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none">{badge}</span>}
        </button>
        {actions && <div className="shrink-0 pr-2 flex items-center">{actions}</div>}
      </div>
      {open && children}
    </div>
  );
}
