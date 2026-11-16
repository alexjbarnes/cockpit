"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface NavItemProps {
  variant: "rail" | "bar";
  label: string;
  title: string;
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
  /** A dot over the icon: unread, a failed job, the assistant's state. */
  badge?: ReactNode;
  testId: string;
}

/** One item of the navigation: an icon with a small label under it. The rail's
 *  items are stacked in a narrow column; the bar's share the width of a phone. */
export function NavItem({ variant, label, title, icon: Icon, active, onClick, badge, testId }: NavItemProps) {
  const rail = variant === "rail";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-current={active ? "page" : undefined}
      data-testid={testId}
      className={cn(
        "flex flex-col items-center gap-[3px] leading-[1.1] transition-colors",
        rail ? "w-[58px] rounded-[10px] px-0 py-2 text-[10.5px]" : "flex-1 py-2 text-[11px]",
        active
          ? rail
            ? "bg-accent font-semibold text-foreground"
            : "font-semibold text-foreground"
          : "text-muted-foreground hover:text-foreground",
        rail && !active && "hover:bg-accent/60",
      )}
    >
      <span className="relative grid h-[22px] w-[22px] place-items-center">
        <Icon className={rail ? "h-[19px] w-[19px]" : "h-[21px] w-[21px]"} />
        {badge}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}
