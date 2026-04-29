"use client";

import { X } from "lucide-react";
import { useCallback, useEffect } from "react";
import { MarkdownRender } from "@/components/markdown-render";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { pathBasename } from "@/lib/path";

interface PlanViewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  content: string;
  filePath: string;
}

export function PlanViewModal({ open, onOpenChange, content, filePath }: PlanViewModalProps) {
  const onClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  if (!open) return null;

  const basename = pathBasename(filePath) || filePath;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={handleOverlayClick}>
      <Card className="w-full max-w-3xl flex flex-col" style={{ maxHeight: "calc(100dvh - 2rem)" }}>
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
          <span className="text-sm font-medium text-muted-foreground">{basename}</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <MarkdownRender content={content} className="flex-1 min-h-0 overflow-y-auto p-4" />
      </Card>
    </div>
  );
}
