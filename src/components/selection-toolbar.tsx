"use client";

import { Copy, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SelectionToolbarProps {
  count: number;
  onCopy: () => void;
  onCancel: () => void;
}

export function SelectionToolbar({ count, onCopy, onCancel }: SelectionToolbarProps) {
  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 fade-in duration-200">
      <div className="flex items-center gap-2 rounded-full border bg-background px-4 py-2 shadow-lg">
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {count} selected
        </span>
        <Button size="sm" variant="default" onClick={onCopy} className="gap-1.5">
          <Copy className="h-3.5 w-3.5" />
          Copy
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
