"use client";

import { useEffect, useLayoutEffect, useRef, useCallback, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { useSettings } from "@/hooks/use-settings";
import { MessageBubble } from "./message-bubble";
import { InputArea } from "./input-area";
import { PermissionPrompt } from "./permission-prompt";
import { QuestionCard, QuestionPrompt, parseQuestionsFromInput } from "./question-card";
import { ModelPicker } from "./model-picker";

const INITIAL_WINDOW = 50;
const WINDOW_INCREMENT = 30;

export function ChatView({ sessionId, cwd }: { sessionId: string; cwd?: string }) {
  const { messages, historyLoaded, isResponding, pendingPermissions, pendingQuestions, modelPicker, bypassActive, thinkingLevel, contextUsage, sendMessage, interrupt, respondToPermission, respondToQuestion, selectModel, setBypassAll, setThinkingLevel } = useSession(sessionId, cwd);
  const { settings } = useSettings();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const ignoreScrollUntil = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [renderWindow, setRenderWindow] = useState(INITIAL_WINDOW);
  const expandThrottleRef = useRef(0);
  const prevScrollHeightRef = useRef(0);

  const uniqueMessages = useMemo(() => {
    const seen = new Set<string>();
    return messages.filter((msg) => {
      if (seen.has(msg.id)) return false;
      seen.add(msg.id);
      return true;
    });
  }, [messages]);

  const totalMessages = uniqueMessages.length;
  const startIndex = Math.max(0, totalMessages - renderWindow);
  const visibleMessages = useMemo(
    () => uniqueMessages.slice(startIndex),
    [uniqueMessages, startIndex]
  );
  const hasMoreAbove = startIndex > 0;

  // Reset window on session change
  useEffect(() => {
    setRenderWindow(INITIAL_WINDOW);
  }, [sessionId]);

  // Preserve scroll position after expanding the window
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || prevScrollHeightRef.current === 0) return;
    const delta = el.scrollHeight - prevScrollHeightRef.current;
    if (delta > 0) {
      el.scrollTop += delta;
      ignoreScrollUntil.current = Date.now() + 150;
    }
    prevScrollHeightRef.current = 0;
  }, [renderWindow]);

  const handleScroll = useCallback(() => {
    if (Date.now() < ignoreScrollUntil.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distanceFromBottom < 80;

    if (el.scrollTop < 800 && hasMoreAbove && Date.now() > expandThrottleRef.current) {
      expandThrottleRef.current = Date.now() + 100;
      prevScrollHeightRef.current = el.scrollHeight;
      setRenderWindow((w) => w + WINDOW_INCREMENT);
    }
  }, [hasMoreAbove]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
    ignoreScrollUntil.current = Date.now() + 150;
  }, []);

  useEffect(() => {
    if (stickToBottom.current) {
      scrollToBottom();
    }
  }, [messages, isResponding, pendingQuestions, pendingPermissions, scrollToBottom]);

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
          {hasMoreAbove && (
            <div className="flex justify-center py-2">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {visibleMessages.map((msg, i) => {
            const questionTools = msg.role === "assistant"
              ? msg.toolUses.filter((t) => t.name === "AskUserQuestion" && t.output)
              : [];
            return (
              <div key={msg.id} className="space-y-4">
                <MessageBubble
                  message={msg}
                  collapsedByDefault={
                    i > 0 && visibleMessages[i - 1].content === "__compacted__"
                  }
                />
                {questionTools.map((tool) => (
                  <div key={tool.id} className="flex w-full justify-start">
                    <div className="max-w-[85%]">
                      <QuestionCard tool={tool} />
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
          {isResponding && pendingQuestions.length === 0 && pendingPermissions.length === 0 && (
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
          {pendingQuestions.map((q) => (
            <QuestionPrompt
              key={q.requestId}
              questions={parseQuestionsFromInput(q.questions)}
              onSubmit={respondToQuestion}
              requestId={q.requestId}
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
          cwd={cwd}
        />
      </div>
    </>
  );
}
