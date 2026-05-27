"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface ThinkingStripDialogProps {
  open: boolean;
  models: string[];
  onStrip: () => Promise<void>;
  onNewSession: () => void;
  onCancel: () => void;
}

export function ThinkingStripDialog({ open, models, onStrip, onNewSession, onCancel }: ThinkingStripDialogProps) {
  const [stripping, setStripping] = useState(false);

  const handleStrip = async () => {
    setStripping(true);
    try {
      await onStrip();
    } finally {
      setStripping(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent onClose={onCancel}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Incompatible Thinking Blocks
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 mt-1">
          <p className="text-sm text-muted-foreground">
            This session contains thinking blocks from <span className="font-mono text-foreground">{models.join(", ")}</span>. Anthropic
            models cannot continue a conversation that includes non-Anthropic thinking blocks.
          </p>

          <div className="flex flex-col gap-2 pt-2">
            <Button onClick={handleStrip} disabled={stripping} variant="default">
              {stripping ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Stripping...
                </>
              ) : (
                "Strip thinking blocks and switch"
              )}
            </Button>
            <Button onClick={onNewSession} variant="outline" disabled={stripping}>
              Start a new session instead
            </Button>
            <Button onClick={onCancel} variant="ghost" disabled={stripping} className="text-muted-foreground">
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
