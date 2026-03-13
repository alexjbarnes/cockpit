"use client";

import { useEffect, useRef, useCallback, useMemo } from "react";
import { Loader2 } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { useSettings } from "@/hooks/use-settings";
import { MessageBubble } from "./message-bubble";
import { InputArea } from "./input-area";
import { PermissionPrompt } from "./permission-prompt";
import { ModelPicker } from "./model-picker";

export function ChatView({ sessionId, cwd }: { sessionId: string; cwd?: string }) {
  const { messages, historyLoaded, isResponding, pendingPermissions, modelPicker, bypassActive, thinkingLevel, contextUsage, sendMessage, interrupt, respondToPermission, selectModel, setBypassAll, setThinkingLevel } = useSession(sessionId, cwd);
  const { settings } = useSettings();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const ignoreScrollUntil = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  const uniqueMessages = useMemo(() => {
    const seen = new Set<string>();
    return messages.filter((msg) => {
      if (seen.has(msg.id)) return false;
      seen.add(msg.id);
      return true;
    });
  }, [messages]);

  const handleScroll = useCallback(() => {
    if (Date.now() < ignoreScrollUntil.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distanceFromBottom < 80;
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
    ignoreScrollUntil.current = Date.now() + 150;
  }, []);

  useEffect(() => {
    if (stickToBottom.current) {
      scrollToBottom();
    }
  }, [messages, isResponding, scrollToBottom]);

  // Re-scroll when virtual keyboard shows/hides (viewport resize)
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const handler = () => {
      if (stickToBottom.current) scrollToBottom();
    };
    vv.addEventListener("resize", handler);
    return () => vv.removeEventListener("resize", handler);
  }, [scrollToBottom]);

  const handleSend = useCallback((text: string) => {
    stickToBottom.current = true;
    sendMessage(text);
  }, [sendMessage]);

  return (
    <>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto p-4"
        onScroll={handleScroll}
      >
        <div className="mx-auto max-w-3xl space-y-4">
          {uniqueMessages.length === 0 && (
            <div className="flex flex-col items-center pt-20 text-sm text-muted-foreground">
              {historyLoaded ? (
                <p>Send a message to start the conversation.</p>
              ) : (
                <Loader2 className="h-5 w-5 animate-spin" />
              )}
            </div>
          )}
          {uniqueMessages.map((msg, i) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              collapsedByDefault={
                i > 0 && uniqueMessages[i - 1].content === "__compacted__"
              }
            />
          ))}
          {isResponding && (
            <div className="flex items-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
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
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="shrink-0">
        <InputArea
          onSend={handleSend}
          onInterrupt={interrupt}
          isResponding={isResponding}
          bypassActive={bypassActive}
          onSetBypass={setBypassAll}
          thinkingLevel={thinkingLevel}
          onSetThinking={setThinkingLevel}
          contextUsage={contextUsage}
          dismissKeyboard={settings.dismissKeyboardOnSend}
        />
      </div>
    </>
  );
}
