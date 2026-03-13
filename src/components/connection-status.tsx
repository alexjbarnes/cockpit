"use client";

import { useWebSocket } from "@/hooks/use-websocket";
import { cn } from "@/lib/utils";

export function ConnectionStatus() {
  const { connected } = useWebSocket();

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground" title={connected ? "Connected" : "Reconnecting..."}>
      <div
        className={cn(
          "h-2 w-2 rounded-full",
          connected ? "bg-green-500" : "bg-yellow-500 animate-pulse"
        )}
      />
      {!connected && <span>Reconnecting...</span>}
    </div>
  );
}
