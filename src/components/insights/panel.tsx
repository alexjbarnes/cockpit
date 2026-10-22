import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** A titled card holding one chart or list. */
export function Panel({
  title,
  note,
  action,
  children,
  className,
  testId,
}: {
  title: string;
  /** A short line under the title saying what the numbers are. */
  note?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <Card className={cn("min-w-0", className)} data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">{title}</h2>
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
        </div>
        {action}
      </div>
      <div className="p-4 pt-3">{children}</div>
    </Card>
  );
}

/** Panels side by side from a wide screen, one above another below it. */
export function PanelGrid({ children }: { children: ReactNode }) {
  return <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">{children}</div>;
}
