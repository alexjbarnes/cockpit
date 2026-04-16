"use client";

import { useState, useEffect, useRef, useCallback, type KeyboardEvent, type ClipboardEvent, type DragEvent } from "react";
import { Button } from "@/components/ui/button";
import { Send, Square, Settings2, ShieldOff, ShieldCheck, Brain, Cpu, Loader2, X, Paperclip, FileText, Maximize2, MessageSquare, Trash2, Eye, Hammer, Plug, ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useWebSocket } from "@/hooks/use-websocket";
import { SlashCommandMenu } from "@/components/slash-command-menu";
import { MentionMenu, type MentionItem } from "@/components/mention-menu";
import type { SlashCommand } from "@/lib/commands";
import type { ThinkingLevel, ContextUsage, ImageAttachment, DocumentAttachment, TextFileAttachment, InitData } from "@/types";
import { shouldCollapsePaste, extensionForLabel, detectLanguage } from "@/lib/paste-detect";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { CodeBlock, languageFromPath } from "@/components/code-block";
import { ContextIndicator } from "./context-indicator";
import { QueueModal } from "./queue-modal";
import { McpStatusModal } from "@/components/mcp-status-modal";

const models: { value: string; label: string }[] = [
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

const contextSizes: { value: string; label: string }[] = [
  { value: "default", label: "200K" },
  { value: "1m", label: "1M" },
];

function baseModel(model: string): string {
  return model.replace(/\[.*\]$/, "");
}

function hasExtendedContext(model: string): boolean {
  return model.includes("[1m]");
}

function buildModelId(base: string, extended: boolean): string {
  if (extended && (base === "opus" || base === "sonnet")) {
    return `${base}[1m]`;
  }
  return base;
}

const thinkingLevels: { value: ThinkingLevel; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".csv",
  ".xml", ".yaml", ".yml", ".html", ".css", ".log", ".sh", ".go", ".rs",
  ".java", ".c", ".cpp", ".h", ".rb", ".swift", ".kt", ".toml", ".cfg",
  ".ini", ".env", ".sql", ".r", ".lua", ".pl", ".php",
]);

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

// 5MB API limit on base64. Use 3.5MB raw file size as threshold since base64 is ~133% of raw.
const MAX_RAW_IMAGE_BYTES = 3_500_000;
const MAX_BASE64_BYTES = 4_500_000;

function readFileAsBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] || null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function processImageFile(file: File): Promise<ImageAttachment | null> {
  if (file.size <= MAX_RAW_IMAGE_BYTES) {
    return readFileAsBase64(file).then((data) =>
      data ? { mediaType: file.type as ImageAttachment["mediaType"], data } : null
    );
  }
  return resizeImageFile(file);
}

function resizeImageFile(file: File): Promise<ImageAttachment | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      // Scale dimensions based on how far over the limit we are
      const ratio = Math.sqrt(MAX_RAW_IMAGE_BYTES / file.size);
      const width = Math.round(img.width * ratio);
      const height = Math.round(img.height * ratio);

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(null); return; }
      ctx.drawImage(img, 0, 0, width, height);

      let quality = 0.85;
      let result = canvas.toDataURL("image/jpeg", quality).split(",")[1] || "";

      while (result.length > MAX_BASE64_BYTES && quality > 0.3) {
        quality -= 0.1;
        result = canvas.toDataURL("image/jpeg", quality).split(",")[1] || "";
      }

      resolve({ mediaType: "image/jpeg", data: result });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function readFileAsText(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });
}


const FILE_ACCEPT = [
  "image/*",
  ".pdf",
  ...Array.from(TEXT_EXTENSIONS),
].join(",");

interface InputAreaProps {
  sessionId: string;
  onSend: (text: string, images?: ImageAttachment[], documents?: DocumentAttachment[], textFiles?: TextFileAttachment[]) => void;
  onInterrupt: () => void;
  isResponding: boolean;
  bypassActive: boolean;
  onSetBypass: (enabled: boolean) => void;
  planMode: boolean;
  onSetPlanMode: (enabled: boolean) => void;
  thinkingLevel: ThinkingLevel;
  onSetThinking: (level: ThinkingLevel) => void;
  currentModel: string;
  onSetModel: (model: string) => void;
  contextUsage: ContextUsage | null;
  dismissKeyboard: boolean;
  cwd?: string;
  onCompact?: () => void;
  initData?: InitData | null;
  hasQueuedMessage?: boolean;
  queuedMessages?: Array<{ id: string; text: string }>;
  queuePaused?: boolean;
  onCancelQueued?: () => void;
  onDeleteQueued?: (id: string) => void;
  onEditQueued?: (id: string) => void;
  onResumeQueue?: () => void;
  restoredText?: string | null;
  onClearRestoredText?: () => void;
  btw?: { question: string; answer: string | null; loading: boolean; error: string | null } | null;
  onDismissBtw?: () => void;
}

const sessionDrafts = new Map<string, string>();

function getMentionContext(text: string, cursorPos: number): { active: boolean; query: string; start: number } {
  const before = text.slice(0, cursorPos);
  const match = before.match(/@([^\s]*)$/);
  if (!match) return { active: false, query: "", start: 0 };
  return { active: true, query: match[1], start: cursorPos - match[0].length };
}

export function InputArea({ sessionId, onSend, onInterrupt, isResponding, bypassActive, onSetBypass, planMode, onSetPlanMode, thinkingLevel, onSetThinking, currentModel, onSetModel, contextUsage, dismissKeyboard, cwd, onCompact, initData, hasQueuedMessage, queuedMessages, queuePaused, onCancelQueued, onDeleteQueued, onEditQueued, onResumeQueue, restoredText, onClearRestoredText, btw, onDismissBtw }: InputAreaProps) {
  const { connected } = useWebSocket();
  const [text, setText] = useState(() => sessionDrafts.get(sessionId) || "");
  const [queueModalOpen, setQueueModalOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);

  useEffect(() => {
    setText(sessionDrafts.get(sessionId) || "");
  }, [sessionId]);

  useEffect(() => {
    sessionDrafts.set(sessionId, text);
  }, [sessionId, text]);

  useEffect(() => {
    if (restoredText) {
      setText(restoredText);
      onClearRestoredText?.();
      textareaRef.current?.focus();
    }
  }, [restoredText, onClearRestoredText]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [cursorPos, setCursorPos] = useState(0);
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [pendingDocs, setPendingDocs] = useState<DocumentAttachment[]>([]);
  const [pendingTextFiles, setPendingTextFiles] = useState<TextFileAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<{ type: "image"; src: string; index: number } | { type: "text"; content: string; name: string; index: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentionItemsRef = useRef<MentionItem[]>([]);
  const slashItemsRef = useRef<SlashCommand[]>([]);
  const isPastingRef = useRef(false);

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

  const hasAttachments = pendingImages.length > 0 || pendingDocs.length > 0 || pendingTextFiles.length > 0;

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && !hasAttachments) return;
    if (!connected) return;

    // Intercept /mcp to open the MCP status modal
    if (/^\/mcp\s*$/i.test(trimmed)) {
      setText("");
      setMcpOpen(true);
      return;
    }

    onSend(
      trimmed,
      pendingImages.length > 0 ? pendingImages : undefined,
      pendingDocs.length > 0 ? pendingDocs : undefined,
      pendingTextFiles.length > 0 ? pendingTextFiles : undefined,
    );
    setText("");
    setPendingImages([]);
    setPendingDocs([]);
    setPendingTextFiles([]);
    setSelectedIndex(0);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      if (dismissKeyboard && "ontouchstart" in window) {
        textareaRef.current.blur();
      } else {
        textareaRef.current.focus();
      }
    }
  }, [text, hasAttachments, pendingImages, pendingDocs, pendingTextFiles, onSend, dismissKeyboard, connected]);

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
          e.stopPropagation();
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
          e.stopPropagation();
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

      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        onSetPlanMode(!planMode);
        return;
      }

      if (e.key === "Escape" && isResponding) {
        e.preventDefault();
        onInterrupt();
        return;
      }

      if (e.key === "Enter" && !e.shiftKey && !isPastingRef.current) {
        e.preventDefault();
        handleSend();
      }
    },
    [showMenu, showMention, query, selectedIndex, mentionSelectedIndex, handleSend, handleSelectCommand, handleSelectMention, text, mention.start, cursorPos, isResponding, onInterrupt, planMode, onSetPlanMode]
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  const pasteCountRef = useRef(0);

  const collapseText = useCallback((pastedText: string) => {
    pasteCountRef.current += 1;
    const count = pasteCountRef.current;
    const suffix = count > 1 ? `-${count}` : "";
    const tempName = `paste${suffix}`;
    setPendingTextFiles((prev) => [...prev, { name: tempName, content: pastedText }]);

    detectLanguage(pastedText).then((label) => {
      if (!label) return;
      const ext = extensionForLabel(label);
      if (!ext) return;
      const newName = `paste${suffix}.${ext}`;
      setPendingTextFiles((prev) =>
        prev.map((f) =>
          f.name === tempName && f.content === pastedText
            ? { ...f, name: newName, language: label }
            : f
        )
      );
    });
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;

    // Detect large insertions from keyboard paste suggestions (bypass paste event)
    const inserted = newValue.length - text.length;
    if (inserted > 0) {
      const cursor = e.target.selectionStart ?? newValue.length;
      const insertedText = newValue.slice(cursor - inserted, cursor);
      if (shouldCollapsePaste(insertedText)) {
        const before = newValue.slice(0, cursor - inserted);
        const after = newValue.slice(cursor);
        setText(before + after);
        collapseText(insertedText);
        setCursorPos(before.length);
        setSelectedIndex(0);
        setMentionSelectedIndex(0);
        return;
      }
    }

    setText(newValue);
    setCursorPos(e.target.selectionStart ?? 0);
    setSelectedIndex(0);
    setMentionSelectedIndex(0);
  }, [text, collapseText]);

  const addFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      if (IMAGE_TYPES.has(file.type)) {
        const attachment = await processImageFile(file);
        if (attachment) {
          setPendingImages((prev) => [...prev, attachment]);
        }
      } else if (file.type === "application/pdf") {
        const base64 = await readFileAsBase64(file);
        if (base64) {
          setPendingDocs((prev) => [...prev, { mediaType: "application/pdf", data: base64, name: file.name }]);
        }
      } else if (TEXT_EXTENSIONS.has(getFileExtension(file.name)) || file.type.startsWith("text/")) {
        const content = await readFileAsText(file);
        if (content !== null) {
          setPendingTextFiles((prev) => [...prev, { name: file.name, content }]);
        }
      }
    }
  }, []);

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    isPastingRef.current = true;
    requestAnimationFrame(() => { isPastingRef.current = false; });

    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    // Fallback: check clipboardData.files (Android often populates this instead of items)
    if (files.length === 0 && e.clipboardData?.files?.length) {
      for (let i = 0; i < e.clipboardData.files.length; i++) {
        files.push(e.clipboardData.files[i]);
      }
    }

    // Fallback: check for image in HTML content (Android pastes images as <img> tags)
    if (files.length === 0) {
      const html = e.clipboardData?.getData("text/html");
      if (html) {
        const match = html.match(/<img[^>]+src="(data:image\/[^;]+;base64,[^"]+)"/);
        if (match) {
          const dataUrl = match[1];
          const [header, b64] = dataUrl.split(",");
          const mimeMatch = header.match(/data:([^;]+)/);
          if (mimeMatch && b64) {
            const mime = mimeMatch[1];
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const blob = new Blob([bytes], { type: mime });
            files.push(new File([blob], `pasted-image.${mime.split("/")[1] || "png"}`, { type: mime }));
          }
        }
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
      return;
    }

    const pastedText = e.clipboardData?.getData("text/plain");
    if (pastedText && shouldCollapsePaste(pastedText)) {
      e.preventDefault();
      collapseText(pastedText);
    }
  }, [addFiles, collapseText]);


  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files: File[] = [];
    if (e.dataTransfer?.files) {
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        files.push(e.dataTransfer.files[i]);
      }
    }
    if (files.length > 0) addFiles(files);
  }, [addFiles]);

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const removeDoc = useCallback((index: number) => {
    setPendingDocs((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const removeTextFile = useCallback((index: number) => {
    setPendingTextFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleFilePick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    addFiles(Array.from(files));
    e.target.value = "";
  }, [addFiles]);

  return (
    <div
      className={`border-t bg-background px-1 py-1 ${dragOver ? "ring-2 ring-primary ring-inset" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="mx-auto max-w-3xl">
        {btw && (
          <div className="mb-2 rounded-md border border-input bg-muted/50 p-2">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <MessageSquare className="h-3.5 w-3.5" />
                <span>Side question</span>
              </div>
              <button onClick={onDismissBtw} className="text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="text-sm font-medium px-1 mb-1">{btw.question}</p>
            {btw.loading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground px-1 py-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Thinking...</span>
              </div>
            )}
            {btw.error && (
              <p className="text-xs text-destructive px-1">{btw.error}</p>
            )}
            {btw.answer && (
              <div className="text-xs prose prose-sm dark:prose-invert max-w-none px-1 border-t pt-1 max-h-48 overflow-y-auto">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{btw.answer}</ReactMarkdown>
              </div>
            )}
          </div>
        )}
        {optionsOpen && (
          <div className="mb-2 rounded-md border border-input bg-muted/50 p-2 space-y-1">
            <div className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs">
              <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Model</span>
              <div className="ml-auto flex gap-1">
                {models.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => onSetModel(buildModelId(opt.value, hasExtendedContext(currentModel) && opt.value !== "haiku"))}
                    className={`rounded px-2 py-0.5 text-xs transition-colors ${
                      baseModel(currentModel) === opt.value
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            {(baseModel(currentModel) === "opus" || baseModel(currentModel) === "sonnet") && (
              <div className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs">
                <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">Context</span>
                <div className="ml-auto flex gap-1">
                  {contextSizes.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => onSetModel(buildModelId(baseModel(currentModel), opt.value === "1m"))}
                      className={`rounded px-2 py-0.5 text-xs transition-colors ${
                        (opt.value === "1m") === hasExtendedContext(currentModel)
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
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
            {currentModel !== "haiku" && (
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
            )}
            {initData?.mcpServers && initData.mcpServers.length > 0 && (
              <button
                onClick={() => setMcpOpen(true)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted transition-colors"
              >
                <Plug className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">MCP Servers</span>
                <span className="ml-auto flex items-center gap-1 text-muted-foreground">
                  {initData.mcpServers.filter(s => s.status === "connected").length}/{initData.mcpServers.length}
                  <ChevronRight className="h-3 w-3" />
                </span>
              </button>
            )}
          </div>
        )}
        {hasAttachments && (
          <div className="mb-1 flex gap-2 flex-wrap px-9">
            {pendingImages.map((img, i) => (
              <div key={`img-${i}`} className="relative group">
                <img
                  src={`data:${img.mediaType};base64,${img.data}`}
                  className="h-16 rounded border object-contain cursor-pointer"
                  alt=""
                  onClick={() => setPreview({ type: "image", src: `data:${img.mediaType};base64,${img.data}`, index: i })}
                />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {pendingDocs.map((doc, i) => (
              <div key={`doc-${i}`} className="relative group flex items-center gap-1.5 rounded border px-2 py-1 text-xs bg-muted h-16">
                <FileText className="h-4 w-4 text-red-500 shrink-0" />
                <span className="truncate max-w-[120px]">{doc.name}</span>
                <button
                  onClick={() => removeDoc(i)}
                  className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {pendingTextFiles.map((file, i) => (
              <div
                key={`txt-${i}`}
                className="relative group flex items-center gap-1.5 rounded border px-2 py-1 text-xs bg-muted h-16 cursor-pointer"
                onClick={() => setPreview({ type: "text", content: file.content, name: file.name, index: i })}
              >
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="truncate max-w-[120px]">{file.name}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); removeTextFile(i); }}
                  className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        {hasQueuedMessage && (
          <div className="mb-1 flex items-center gap-2 px-9">
            <span className={`text-xs ${queuePaused ? "text-yellow-500" : "text-muted-foreground"}`}>
              {(queuedMessages?.length ?? 0)} message{(queuedMessages?.length ?? 0) !== 1 ? "s" : ""} {queuePaused ? "paused" : "queued"}
            </span>
            <button
              onClick={() => setQueueModalOpen(true)}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Manage queued messages"
            >
              <MessageSquare className="h-3 w-3" />
            </button>
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
              initCommands={initData?.slashCommands}
            />
          )}
          {showMention && cwd && (
            <MentionMenu
              query={mention.query}
              cwd={cwd}
              selectedIndex={mentionSelectedIndex}
              onSelect={handleSelectMention}
              onItemsChange={(items) => { mentionItemsRef.current = items; }}
              initAgents={initData?.agents}
            />
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={FILE_ACCEPT}
            multiple
            onChange={handleFileInputChange}
            className="hidden"
          />
          <div className="flex flex-col items-center justify-evenly w-8 shrink-0">
            {contextUsage && <ContextIndicator usage={contextUsage} onCompact={onCompact} />}
            <Button
              size="icon"
              variant="ghost"
              className={`h-8 w-8 ${bypassActive ? "text-orange-500" : ""}`}
              onClick={() => setOptionsOpen((v) => !v)}
            >
              <Settings2 className="h-4 w-4" />
            </Button>
          </div>
          <div className="relative flex-1 mr-1">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onInput={handleInput}
              onPaste={handlePaste}
              placeholder={hasQueuedMessage ? (queuePaused ? "Queue paused (send to discard, or manage in modal)" : "Message queued (Esc to interrupt)") : isResponding ? "Use /btw to nudge, or type to queue..." : planMode ? "Plan with Claude..." : "Send a message..."}
              rows={2}
              className={`w-full resize-none rounded-md border bg-background px-3 py-2 pb-7 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 overflow-y-auto scrollbar-none ${
                planMode ? "border-blue-500/50 focus-visible:ring-blue-500/50" : "border-input focus-visible:ring-ring"
              }`}
            />
            <button
              onClick={handleFilePick}
              title="Attach file"
              className="absolute bottom-2.5 right-1.5 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              <Paperclip className="h-4 w-4" />
            </button>
          </div>
          <div className="flex flex-col items-center justify-center w-12 shrink-0 overflow-visible">
            {!connected ? (
              <Button size="icon" variant="ghost" className="h-8 w-8" disabled title="Connecting...">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </Button>
            ) : isResponding && !text.trim() && !hasAttachments ? (
              <Button size="icon" variant="destructive" className="h-8 w-8" onClick={() => onInterrupt()}>
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button size="icon" className="h-8 w-8" onClick={handleSend} disabled={!text.trim() && !hasAttachments}>
                <Send className="h-4 w-4" />
              </Button>
            )}
            <button
              onClick={() => onSetPlanMode(!planMode)}
              title={planMode ? "Switch to Build mode (Tab)" : "Switch to Plan mode (Tab)"}
              className={`mt-4 flex items-center gap-0.5 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                planMode
                  ? "bg-blue-500/15 text-blue-500 hover:bg-blue-500/25"
                  : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              }`}
            >
              {planMode ? <Eye className="h-2.5 w-2.5" /> : <Hammer className="h-2.5 w-2.5" />}
              {planMode ? "Plan" : "Build"}
            </button>
          </div>
        </div>
      </div>
      <Dialog open={preview !== null} onOpenChange={() => setPreview(null)} className="max-w-3xl">
        <DialogContent className="max-h-[80vh] overflow-auto" onClose={() => setPreview(null)} onDelete={() => {
          if (!preview) return;
          if (preview.type === "image") removeImage(preview.index);
          else removeTextFile(preview.index);
          setPreview(null);
        }}>
          {preview?.type === "image" && (
            <img src={preview.src} className="w-full rounded object-contain" alt="" />
          )}
          {preview?.type === "text" && (() => {
            const lang = languageFromPath(preview.name);
            return lang
              ? <CodeBlock code={preview.content} language={lang} fullHeight />
              : <pre className="whitespace-pre-wrap text-sm font-mono">{preview.content}</pre>;
          })()}
        </DialogContent>
      </Dialog>
      <QueueModal
        open={queueModalOpen}
        onOpenChange={setQueueModalOpen}
        messages={queuedMessages ?? []}
        paused={queuePaused ?? false}
        onDelete={onDeleteQueued ?? (() => {})}
        onEdit={onEditQueued ?? (() => {})}
        onResume={onResumeQueue ?? (() => {})}
      />
      <McpStatusModal
        open={mcpOpen}
        onOpenChange={setMcpOpen}
        sessionId={sessionId}
        initData={initData}
      />
    </div>
  );
}
