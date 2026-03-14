"use client";

import { useState, useRef, useCallback, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Send, Square, Settings2, ShieldOff, ShieldCheck, Brain } from "lucide-react";
import { SlashCommandMenu } from "@/components/slash-command-menu";
import { MentionMenu, type MentionItem } from "@/components/mention-menu";
import type { SlashCommand } from "@/lib/commands";
import type { ThinkingLevel, ContextUsage } from "@/types";
import { ContextIndicator } from "./context-indicator";

const thinkingLevels: { value: ThinkingLevel; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

interface InputAreaProps {
  onSend: (text: string) => void;
  onInterrupt: () => void;
  isResponding: boolean;
  bypassActive: boolean;
  onSetBypass: (enabled: boolean) => void;
  thinkingLevel: ThinkingLevel;
  onSetThinking: (level: ThinkingLevel) => void;
  contextUsage: ContextUsage | null;
  dismissKeyboard: boolean;
  cwd?: string;
}

function getMentionContext(text: string, cursorPos: number): { active: boolean; query: string; start: number } {
  const before = text.slice(0, cursorPos);
  const match = before.match(/@([^\s]*)$/);
  if (!match) return { active: false, query: "", start: 0 };
  return { active: true, query: match[1], start: cursorPos - match[0].length };
}

export function InputArea({ onSend, onInterrupt, isResponding, bypassActive, onSetBypass, thinkingLevel, onSetThinking, contextUsage, dismissKeyboard, cwd }: InputAreaProps) {
  const [text, setText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [cursorPos, setCursorPos] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionItemsRef = useRef<MentionItem[]>([]);
  const slashItemsRef = useRef<SlashCommand[]>([]);

  const showMenu = text.startsWith("/") && !text.includes(" ");
  const query = showMenu ? text.slice(1) : "";

  const mention = getMentionContext(text, cursorPos);
  const showMention = !showMenu && mention.active && !!cwd;

  const handleSelectCommand = useCallback((cmd: SlashCommand) => {
    setText(cmd.command + " ");
    setSelectedIndex(0);
    textareaRef.current?.focus();
  }, []);

  const handleSelectMention = useCallback((path: string) => {
    const before = text.slice(0, mention.start);
    const after = text.slice(cursorPos);
    const newText = before + "@" + path + " " + after;
    setText(newText);
    setMentionSelectedIndex(0);
    const newCursor = mention.start + 1 + path.length + 1;
    setCursorPos(newCursor);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(newCursor, newCursor);
      }
    });
  }, [text, mention.start, cursorPos]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
    setSelectedIndex(0);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      if (dismissKeyboard) {
        textareaRef.current.blur();
      }
    }
  }, [text, onSend, dismissKeyboard]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showMenu) {
        const items = slashItemsRef.current;
        if (items.length > 0) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIndex((i) => (i + 1) % items.length);
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIndex((i) => (i - 1 + items.length) % items.length);
            return;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            handleSelectCommand(items[selectedIndex]);
            return;
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setText("");
          return;
        }
      }

      if (showMention && mentionItemsRef.current.length > 0) {
        const count = mentionItemsRef.current.length;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionSelectedIndex((i) => (i + 1) % count);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionSelectedIndex((i) => (i - 1 + count) % count);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          handleSelectMention(mentionItemsRef.current[mentionSelectedIndex].value);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          const before = text.slice(0, mention.start);
          const after = text.slice(cursorPos);
          setText(before + after);
          const newPos = mention.start;
          setCursorPos(newPos);
          requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (el) {
              el.setSelectionRange(newPos, newPos);
            }
          });
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [showMenu, showMention, query, selectedIndex, mentionSelectedIndex, handleSend, handleSelectCommand, handleSelectMention, text, mention.start, cursorPos]
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    setCursorPos(e.target.selectionStart ?? 0);
    setSelectedIndex(0);
    setMentionSelectedIndex(0);
  }, []);

  return (
    <div className="border-t bg-background px-1 py-1">
      <div className="mx-auto max-w-3xl">
        {optionsOpen && (
          <div className="mb-2 rounded-md border border-input bg-muted/50 p-2 space-y-1">
            <button
              onClick={() => onSetBypass(!bypassActive)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted transition-colors"
            >
              {bypassActive ? (
                <ShieldOff className="h-3.5 w-3.5 text-orange-500" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span className={bypassActive ? "text-orange-500 font-medium" : "text-muted-foreground"}>
                Bypass all permissions
              </span>
              <span
                className={`ml-auto inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                  bypassActive ? "bg-orange-500" : "bg-muted-foreground/30"
                }`}
              >
                <span
                  className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
                    bypassActive ? "translate-x-3.5" : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>
            <div className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs">
              <Brain className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Thinking</span>
              <div className="ml-auto flex gap-1">
                {thinkingLevels.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => onSetThinking(opt.value)}
                    className={`rounded px-2 py-0.5 text-xs transition-colors ${
                      thinkingLevel === opt.value
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        <div className="relative flex items-stretch gap-1">
          {showMenu && (
            <SlashCommandMenu
              query={query}
              selectedIndex={selectedIndex}
              onSelect={handleSelectCommand}
              cwd={cwd}
              onItemsChange={(items) => { slashItemsRef.current = items; }}
            />
          )}
          {showMention && cwd && (
            <MentionMenu
              query={mention.query}
              cwd={cwd}
              selectedIndex={mentionSelectedIndex}
              onSelect={handleSelectMention}
              onItemsChange={(items) => { mentionItemsRef.current = items; }}
            />
          )}
          <div className="flex flex-col items-center justify-evenly w-8 shrink-0">
            {contextUsage && <ContextIndicator usage={contextUsage} />}
            <Button
              size="icon"
              variant="ghost"
              className={`h-8 w-8 ${bypassActive ? "text-orange-500" : ""}`}
              onClick={() => setOptionsOpen((v) => !v)}
            >
              <Settings2 className="h-4 w-4" />
            </Button>
          </div>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder="Send a message..."
            rows={3}
            className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={isResponding}
          />
          <div className="flex flex-col items-center justify-center w-8 shrink-0">
            {isResponding ? (
              <Button size="icon" variant="destructive" className="h-8 w-8" onClick={onInterrupt}>
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button size="icon" className="h-8 w-8" onClick={handleSend} disabled={!text.trim()}>
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
