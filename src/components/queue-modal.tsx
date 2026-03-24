"use client";

import { useEffect } from "react";
import { Pencil, Trash2, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface QueueModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: Array<{ id: string; text: string }>;
  paused: boolean;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  onResume: () => void;
}

export function QueueModal({
  open,
  onOpenChange,
  messages,
  paused,
  onDelete,
  onEdit,
  onResume,
}: QueueModalProps) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onOpenChange(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div className="w-full max-w-md mx-4 rounded-lg border bg-background p-5 shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Queued Messages</h2>
          <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No queued messages
          </p>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {messages.map((msg, i) => (
              <div
                key={msg.id}
                className="flex items-start gap-3 rounded-md border border-border px-3 py-2.5"
              >
                <span className="text-xs text-muted-foreground mt-0.5 shrink-0">
                  {i + 1}.
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm break-words line-clamp-3">{msg.text}</p>
                  <span className={`text-[10px] mt-0.5 inline-block ${paused ? "text-yellow-500" : "text-muted-foreground"}`}>
                    {paused ? "paused" : "queued"}
                  </span>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => {
                      onEdit(msg.id);
                      onOpenChange(false);
                    }}
                    className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    title="Edit (move to input)"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => onDelete(msg.id)}
                    className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {paused && messages.length > 0 && (
          <div className="mt-4 pt-4 border-t">
            <Button
              variant="default"
              size="sm"
              className="w-full"
              onClick={() => {
                onResume();
                onOpenChange(false);
              }}
            >
              <Play className="h-3.5 w-3.5 mr-2" />
              Resume queue
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
