"use client";

import { Activity, CheckCircle2, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BackgroundTask } from "@/types";

interface BackgroundTasksButtonProps {
  tasks: BackgroundTask[];
}

export function BackgroundTasksButton({ tasks }: BackgroundTasksButtonProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  const running = tasks.filter((t) => t.status === "running");

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 relative"
        onClick={() => setOpen(true)}
        title={`${running.length} background task${running.length !== 1 ? "s" : ""}`}
      >
        <Activity className="h-4 w-4" />
        {running.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
            {running.length}
          </span>
        )}
      </Button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-md mx-4 rounded-lg border bg-background p-5 shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">Background Tasks</h2>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            {tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No background tasks</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {tasks.map((task) => (
                  <div key={task.taskId} className="flex items-start gap-3 rounded-md border border-border px-3 py-2.5">
                    {task.status === "completed" ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-green-500" />
                    ) : (
                      <Loader2 className="h-4 w-4 shrink-0 mt-0.5 animate-spin text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate">{task.description}</div>
                      {task.activity && task.activity !== task.description && (
                        <div className="text-xs text-muted-foreground truncate mt-0.5">{task.activity}</div>
                      )}
                      {task.status === "completed" && task.summary && (
                        <div className="text-xs text-muted-foreground truncate mt-0.5">{task.summary}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
