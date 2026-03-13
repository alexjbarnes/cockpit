"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

function Dialog({ open, onOpenChange, children }: DialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="fixed inset-0 bg-black/80"
        onClick={() => onOpenChange(false)}
      />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 p-4">
        {children}
      </div>
    </div>
  );
}

function DialogContent({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { onClose?: () => void }) {
  return (
    <div
      className={cn(
        "relative rounded-lg border bg-background p-6 shadow-lg",
        className
      )}
      {...props}
    >
      {props.onClose && (
        <button
          className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100"
          onClick={props.onClose}
        >
          <X className="h-4 w-4" />
        </button>
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
