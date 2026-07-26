"use client";

import { Trash2, X } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}

function Dialog({ open, onOpenChange, children, className }: DialogProps) {
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, onOpenChange]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center px-4 py-12"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div className={cn("w-full max-h-full flex flex-col", className || "max-w-lg")}>{children}</div>
    </div>,
    document.body,
  );
}

function DialogContent({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { onClose?: () => void; onDelete?: () => void }) {
  return (
    <div className={cn("relative rounded-lg border bg-background text-foreground p-6 shadow-lg overflow-y-auto", className)} {...props}>
      {/* Right-aligned and pulled flush with the content's top padding, so it
          reads as sitting beside the title rather than stranded on its own row
          above it. Still in flow and sticky, not absolute, so it stays reachable
          while a long dialog scrolls. */}
      {(props.onClose || props.onDelete) && (
        <div className="sticky top-0 z-10 flex justify-end gap-1 -mx-2 -mt-4 -mb-2">
          {props.onDelete && (
            <button className="rounded-sm p-1 opacity-70 hover:opacity-100 text-destructive" onClick={props.onDelete}>
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          {props.onClose && (
            <button className="rounded-sm p-1 opacity-70 hover:opacity-100" onClick={props.onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />;
}

export { Dialog, DialogContent, DialogHeader, DialogTitle };
