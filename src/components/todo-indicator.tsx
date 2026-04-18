"use client";

import { CheckCircle2, Circle, ListChecks, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TodoItem } from "@/types";

interface TodoIndicatorProps {
  todos: TodoItem[];
}

export function TodoIndicator({ todos }: TodoIndicatorProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  const activeCount = useMemo(() => todos.filter((t) => t.status !== "completed").length, [todos]);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 relative"
        onClick={() => setOpen(true)}
        title={`${activeCount} todo${activeCount !== 1 ? "s" : ""}`}
      >
        <ListChecks className="h-4 w-4" />
        {activeCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
            {activeCount}
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
              <h2 className="text-base font-semibold">Todo</h2>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            {todos.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No todo items</p>
            ) : (
              <div className="space-y-1 max-h-80 overflow-y-auto">
                {todos.map((todo, i) => (
                  <div key={i} className="flex items-start gap-2.5 rounded-md px-3 py-2">
                    <StatusIcon status={todo.status} />
                    <div className={`min-w-0 flex-1 text-sm ${todo.status === "completed" ? "text-muted-foreground line-through" : ""}`}>
                      {todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}
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

function StatusIcon({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-green-500" />;
  }
  if (status === "in_progress") {
    return <Loader2 className="h-4 w-4 shrink-0 mt-0.5 animate-spin text-blue-500" />;
  }
  return <Circle className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />;
}
