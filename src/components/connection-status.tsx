"use client";

import { useWebSocket } from "@/hooks/use-websocket";
import { cn } from "@/lib/utils";

export function ConnectionStatus() {
  const { connected } = useWebSocket();

  return (
    <div
      className="flex h-9 w-9 items-center justify-center text-xs text-muted-foreground"
      title={connected ? "Connected" : "Reconnecting..."}
    >
      <div
        className={cn(
          "h-2 w-2 rounded-full",
          connected ? "bg-green-500" : "bg-yellow-500 animate-pulse"
        )}
      />
    </div>
  );
}
