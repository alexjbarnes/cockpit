"use client";

import { useEffect, useRef, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { MessageBubble } from "./message-bubble";
import { InputArea } from "./input-area";
import { PermissionPrompt } from "./permission-prompt";
import { ModelPicker } from "./model-picker";

export function ChatView({ sessionId, cwd }: { sessionId: string; cwd?: string }) {
  const { messages, isResponding, pendingPermissions, modelPicker, sendMessage, interrupt, respondToPermission, selectModel } = useSession(sessionId, cwd);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distanceFromBottom < 80;
  }, []);

  useEffect(() => {
    if (stickToBottom.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  return (
    <>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto p-4"
        onScroll={handleScroll}
      >
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.length === 0 && (
            <p className="text-center text-sm text-muted-foreground pt-20">
              Send a message to start the conversation.
            </p>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          {isResponding && messages[messages.length - 1]?.role !== "assistant" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Thinking...</span>
            </div>
          )}
          {pendingPermissions.map((p) => (
            <PermissionPrompt
              key={p.requestId}
              permission={p}
              onRespond={respondToPermission}
            />
          ))}
          {modelPicker !== null && (
            <ModelPicker currentModel={modelPicker} onSelect={selectModel} />
          )}
        </div>
      </div>
      <div className="shrink-0">
        <InputArea
          onSend={sendMessage}
          onInterrupt={interrupt}
          isResponding={isResponding}
        />
      </div>
    </>
  );
}
