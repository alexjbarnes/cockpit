"use client";

import { AlertTriangle, ArrowDown, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMessageSelection } from "@/hooks/use-message-selection";
import { useSession } from "@/hooks/use-session";
import { useSettings } from "@/hooks/use-settings";
import { useWebSocket } from "@/hooks/use-websocket";
import { pathBasename } from "@/lib/path";
import { splitAtQuestion } from "@/lib/split-question-blocks";
import { cn } from "@/lib/utils";
import { useShell } from "./app-shell";
import { InputArea } from "./input-area";
import { MessageBubble } from "./message-bubble";
import { ModelPicker } from "./model-picker";
import { PermissionPrompt } from "./permission-prompt";
import { PlanApprovalPrompt } from "./plan-approval-prompt";
import { parseQuestionsFromInput, QuestionCard, QuestionPrompt } from "./question-card";
import { SelectionToolbar } from "./selection-toolbar";

const INITIAL_WINDOW = 50;
const WINDOW_INCREMENT = 30;

export function ChatView({
  sessionId,
  cwd,
  initialName,
  initialContext,
  historyView,
  onSendMessage,
  className,
}: {
  sessionId: string;
  cwd?: string;
  initialName?: string;
  initialContext?: string;
  historyView?: boolean;
  onSendMessage?: (fn: (text: string) => void) => void;
  className?: string;
}) {
  const {
    messages,
    historyLoaded,
    isResponding,
    pendingPermissions,
    pendingQuestions,
    modelPicker,
    currentModel,
    bypassActive,
    planMode,
    thinkingLevel,
    contextUsage,
    rateLimitStatus,
    apiError,
    sessionName,
    initData,
    activeModelId,
    hasQueuedMessage,
    queuedMessages,
    queuePaused,
    backgroundTasks,
    todos,
    btw,
    hasMoreHistory,
    loadingMore,
    requestMoreHistory,
    sendMessage,
    interrupt,
    respondToPermission,
    respondToQuestion,
    selectModel,
    setModel,
    setBypassAll,
    setPlanMode,
    setThinkingLevel,
    cancelQueuedMessage,
    deleteQueuedMessage,
    editQueuedMessage,
    resumeQueue,
    restoredText,
    clearRestoredText,
    dismissBtw,
    retry,
    restartSession,
  } = useSession(sessionId, cwd, historyView);
  const { settings } = useSettings();
  const { setHeader, setBackgroundTasks, setTodos, setInitData: setShellInitData } = useShell();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const ignoreScrollUntil = useRef(0);
  const [renderWindow, setRenderWindow] = useState(INITIAL_WINDOW);
  const expandThrottleRef = useRef(0);
  const prevScrollHeightRef = useRef(0);
  const { selectedIds, selectionMode, enterSelection, toggleSelect, clearSelection, copySelected } = useMessageSelection();
  const expandedToolIdsRef = useRef<Set<string>>(new Set());
  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => {
    setIsTouch(matchMedia("(pointer: coarse)").matches);
  }, []);

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
  const visibleMessages = useMemo(() => uniqueMessages.slice(startIndex), [uniqueMessages, startIndex]);
  const hasMoreAbove = startIndex > 0;

  // Reset window on session change
  useEffect(() => {
    setRenderWindow(INITIAL_WINDOW);
  }, []);

  // Update header with session name
  const { send: wsSend } = useWebSocket();
  const handleRename = useCallback(
    (name: string) => {
      wsSend({ type: "message:send", sessionId, text: `/rename ${name}` });
    },
    [wsSend, sessionId],
  );

  useEffect(() => {
    const title = sessionName || initialName || (cwd ? pathBasename(cwd) : "") || "Session";
    setHeader({ title, onRename: handleRename });
  }, [sessionName, initialName, cwd, setHeader, handleRename]);

  // Sync background tasks and todos to shell header
  useEffect(() => {
    setBackgroundTasks(backgroundTasks);
  }, [backgroundTasks, setBackgroundTasks]);

  useEffect(() => {
    setTodos(todos);
  }, [todos, setTodos]);

  useEffect(() => {
    setShellInitData(initData);
  }, [initData, setShellInitData]);

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
  }, []);

  const handleScroll = useCallback(() => {
    if (Date.now() < ignoreScrollUntil.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distanceFromBottom < 80;
    setShowScrollDown(distanceFromBottom > 300);

    if (el.scrollTop < 800 && Date.now() > expandThrottleRef.current) {
      expandThrottleRef.current = Date.now() + 100;
      if (hasMoreAbove) {
        prevScrollHeightRef.current = el.scrollHeight;
        setRenderWindow((w) => w + WINDOW_INCREMENT);
      } else if (hasMoreHistory && !loadingMore) {
        prevScrollHeightRef.current = el.scrollHeight;
        requestMoreHistory();
      }
    }
  }, [hasMoreAbove, hasMoreHistory, loadingMore, requestMoreHistory]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    ignoreScrollUntil.current = Date.now() + 150;
    setShowScrollDown(false);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional re-trigger on content changes to auto-scroll
  useEffect(() => {
    if (stickToBottom.current) {
      scrollToBottom();
    }
  }, [messages, isResponding, pendingQuestions, pendingPermissions, scrollToBottom]);

  // Restore scroll position when navigating back from the file viewer
  useEffect(() => {
    if (!historyLoaded) return;
    const key = "cockpit:scrollPos:" + window.location.pathname;
    const saved = sessionStorage.getItem(key);
    if (!saved) return;
    sessionStorage.removeItem(key);
    const pos = Number(saved);
    const el = scrollRef.current;
    if (el && pos > 0) {
      stickToBottom.current = false;
      requestAnimationFrame(() => {
        el.scrollTop = pos;
      });
    }
  }, [historyLoaded]);

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

  // On Mac (and some Linux WMs), switching back to the window doesn't give
  // keyboard focus to the document, so keydown events (like Escape to
  // interrupt) don't fire until the user clicks. Fix: on pointermove and
  // window focus, ensure the scroll container (tabIndex={-1}) has focus so
  // keyboard events reach window handlers. The scroll container only gets
  // tabIndex on non-touch devices; on touch devices the entire mechanism is
  // skipped since it interferes with native focus management (dictation,
  // keyboard popups, etc).
  //
  // Also re-scroll to bottom when returning. Browsers throttle layout for
  // background apps, so scrollTop assignments may not stick. When focus
  // returns, the reconciled scrollHeight can be larger than scrollTop,
  // making the scroll handler think the user scrolled up.
  useEffect(() => {
    if (isTouch) return;
    const el = scrollRef.current;
    const handler = () => {
      if (document.activeElement?.closest("textarea, input, [contenteditable]")) return;
      if (document.activeElement === el) return;
      el?.focus({ preventScroll: true });
      if (stickToBottom.current) scrollToBottom();
    };
    const visHandler = () => {
      if (document.visibilityState === "visible" && stickToBottom.current) {
        scrollToBottom();
      }
    };
    el?.addEventListener("pointermove", handler);
    window.addEventListener("focus", handler);
    document.addEventListener("visibilitychange", visHandler);
    return () => {
      el?.removeEventListener("pointermove", handler);
      window.removeEventListener("focus", handler);
      document.removeEventListener("visibilitychange", visHandler);
    };
  }, [isTouch, scrollToBottom]);

  // Escape key: modal → queued message → interrupt.
  // Input area also handles Escape with stopPropagation when textarea has focus,
  // so this only fires when focus is elsewhere.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !isResponding) return;
      if (document.querySelector(".fixed.inset-0.z-50")) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      e.preventDefault();
      interrupt();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isResponding, interrupt]);

  const contextInjected = useRef(false);
  const handleSend = useCallback(
    (
      text: string,
      images?: import("@/types").ImageAttachment[],
      documents?: import("@/types").DocumentAttachment[],
      textFiles?: import("@/types").TextFileAttachment[],
    ) => {
      stickToBottom.current = true;
      if (initialContext && !contextInjected.current && messages.length === 0) {
        contextInjected.current = true;
        sendMessage(`${text}\n\n---\n${initialContext}`, images, documents, textFiles);
      } else {
        sendMessage(text, images, documents, textFiles);
      }
    },
    [sendMessage, initialContext, messages.length],
  );

  useEffect(() => {
    if (onSendMessage) onSendMessage((text: string) => handleSend(text));
  }, [onSendMessage, handleSend]);

  const handleCompact = useCallback(() => {
    sendMessage("/compact");
  }, [sendMessage]);

  const handleCopySelected = useCallback(() => {
    copySelected(uniqueMessages);
  }, [copySelected, uniqueMessages]);

  return (
    <div className={cn("flex flex-col flex-1 min-h-0", className)}>
      <div
        ref={scrollRef}
        data-chat-scroll
        tabIndex={isTouch ? undefined : -1}
        className="flex-1 min-h-0 overflow-y-auto p-4 outline-none"
        onScroll={handleScroll}
      >
        <div className="mx-auto max-w-3xl lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl space-y-4">
          {uniqueMessages.length === 0 && (
            <div className="flex flex-col items-center pt-20 text-sm text-muted-foreground">
              {historyLoaded ? <p>Send a message to start the conversation.</p> : <Loader2 className="h-5 w-5 animate-spin" />}
            </div>
          )}
          {(hasMoreAbove || loadingMore) && (
            <div className="flex justify-center py-2">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {visibleMessages.map((msg, i) => {
            const collapsedByDefault = i > 0 && visibleMessages[i - 1].content === "__compacted__";

            // Split any assistant message at AskUserQuestion so the question
            // renders as a standalone element between content before and after it.
            // Works for both streaming and finalized messages.
            if (msg.role === "assistant") {
              const { before, questionBlock, after } = splitAtQuestion(msg.blocks || []);

              if (questionBlock) {
                const pending = pendingQuestions.find(() => true);
                const hasOutput = !!questionBlock.toolUse.output;

                return (
                  <div key={msg.id} data-message-id={msg.id} className="space-y-4">
                    {before.length > 0 && (
                      <MessageBubble
                        message={{ ...msg, blocks: before, content: "" }}
                        collapsedByDefault={collapsedByDefault}
                        expandedToolIds={expandedToolIdsRef}
                        selectionMode={selectionMode}
                        selected={selectedIds.has(msg.id)}
                        onEnterSelection={enterSelection}
                        onToggleSelect={toggleSelect}
                      />
                    )}
                    <div className="flex w-full justify-start">
                      <div className="max-w-[85%]">
                        {hasOutput ? (
                          <QuestionCard tool={questionBlock.toolUse} />
                        ) : pending ? (
                          <QuestionPrompt
                            questions={parseQuestionsFromInput(pending.questions)}
                            onSubmit={respondToQuestion}
                            requestId={pending.requestId}
                          />
                        ) : null}
                      </div>
                    </div>
                    {after.length > 0 && (
                      <MessageBubble
                        message={{ ...msg, blocks: after, content: "" }}
                        collapsedByDefault={false}
                        expandedToolIds={expandedToolIdsRef}
                        selectionMode={selectionMode}
                        selected={selectedIds.has(msg.id)}
                        onEnterSelection={enterSelection}
                        onToggleSelect={toggleSelect}
                      />
                    )}
                  </div>
                );
              }
            }

            return (
              <div key={msg.id} data-message-id={msg.id} className="space-y-4">
                <MessageBubble
                  message={msg}
                  collapsedByDefault={collapsedByDefault}
                  expandedToolIds={expandedToolIdsRef}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(msg.id)}
                  onEnterSelection={enterSelection}
                  onToggleSelect={toggleSelect}
                />
              </div>
            );
          })}
          {isResponding && pendingPermissions.length === 0 && !pendingQuestions.some((q) => !q.answered) && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {rateLimitStatus && <span className="text-xs">Rate limited, retrying...</span>}
            </div>
          )}
          {apiError && !isResponding && (
            <div className="flex w-full justify-start">
              <div className="max-w-[85%] rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
                <div className="flex items-center gap-2 text-red-500 mb-1">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span className="text-sm font-medium">API Error</span>
                </div>
                <p className="text-xs text-muted-foreground mb-3">{apiError}</p>
                <button
                  onClick={retry}
                  className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                >
                  <RotateCcw className="h-3 w-3" />
                  Retry
                </button>
              </div>
            </div>
          )}
          {pendingPermissions.map((p) =>
            p.toolName === "ExitPlanMode" ? (
              <PlanApprovalPrompt
                key={p.requestId}
                permission={p}
                bypassActive={bypassActive}
                onRespond={respondToPermission}
                onSendMessage={sendMessage}
                onSetBypass={setBypassAll}
                onSetPlanMode={setPlanMode}
              />
            ) : (
              <PermissionPrompt key={p.requestId} permission={p} onRespond={respondToPermission} />
            ),
          )}
          {pendingQuestions.length > 0 &&
            !visibleMessages.some(
              (m) => m.role === "assistant" && (m.blocks || []).some((b) => b.type === "tool_use" && b.toolUse.name === "AskUserQuestion"),
            ) &&
            pendingQuestions.map((q) => (
              <div key={q.requestId} className="flex w-full justify-start">
                <div className="max-w-[85%]">
                  <QuestionPrompt questions={parseQuestionsFromInput(q.questions)} onSubmit={respondToQuestion} requestId={q.requestId} />
                </div>
              </div>
            ))}
          {modelPicker !== null && <ModelPicker currentModel={modelPicker} activeModelId={activeModelId} onSelect={selectModel} />}
          <div />
        </div>
      </div>
      {selectionMode && <SelectionToolbar count={selectedIds.size} onCopy={handleCopySelected} onCancel={clearSelection} />}
      {showScrollDown && (
        <div className="relative z-10 flex justify-center pointer-events-none" style={{ marginTop: -52 }}>
          <button
            onClick={() => {
              scrollToBottom();
              stickToBottom.current = true;
              setShowScrollDown(false);
            }}
            className="pointer-events-auto rounded-full border bg-background/90 backdrop-blur p-3 shadow-md text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowDown className="h-5 w-5" />
          </button>
        </div>
      )}
      <div className="shrink-0">
        <InputArea
          sessionId={sessionId}
          onSend={handleSend}
          onInterrupt={interrupt}
          isResponding={isResponding}
          bypassActive={bypassActive}
          onSetBypass={setBypassAll}
          planMode={planMode}
          onSetPlanMode={setPlanMode}
          thinkingLevel={thinkingLevel}
          onSetThinking={setThinkingLevel}
          currentModel={currentModel}
          onSetModel={setModel}
          contextUsage={contextUsage}
          dismissKeyboard={settings.dismissKeyboardOnSend}
          cwd={cwd}
          onCompact={handleCompact}
          initData={initData}
          activeModelId={activeModelId}
          hasQueuedMessage={hasQueuedMessage}
          queuedMessages={queuedMessages}
          queuePaused={queuePaused}
          onCancelQueued={cancelQueuedMessage}
          onDeleteQueued={deleteQueuedMessage}
          onEditQueued={editQueuedMessage}
          onResumeQueue={resumeQueue}
          restoredText={restoredText}
          onClearRestoredText={clearRestoredText}
          btw={btw}
          onDismissBtw={dismissBtw}
          onRestart={restartSession}
        />
      </div>
    </div>
  );
}
