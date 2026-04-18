"use client";

import { Trash2, X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}

function Dialog({ open, onOpenChange, children, className }: DialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="fixed inset-0 bg-black/80" onClick={() => onOpenChange(false)} />
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-12">
        <div className={cn("w-full max-h-full flex flex-col", className || "max-w-lg")}>{children}</div>
      </div>
    </div>
  );
}

function DialogContent({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { onClose?: () => void; onDelete?: () => void }) {
  return (
    <div className={cn("relative rounded-lg border bg-background p-6 shadow-lg overflow-y-auto", className)} {...props}>
      {(props.onClose || props.onDelete) && (
        <div className="sticky top-0 z-10 flex justify-between -mx-2 -mt-2 mb-2">
          {props.onClose ? (
            <button className="rounded-sm opacity-70 hover:opacity-100" onClick={props.onClose}>
              <X className="h-4 w-4" />
            </button>
          ) : (
            <span />
          )}
          {props.onDelete && (
            <button className="rounded-sm opacity-70 hover:opacity-100 text-destructive" onClick={props.onDelete}>
              <Trash2 className="h-4 w-4" />
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
