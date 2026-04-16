"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Search, Loader2, Copy, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useShell } from "./app-shell";
import { MessageContextModal } from "./message-context-modal";

interface SearchResult {
  messageId: string;
  role: "user" | "assistant";
  timestamp: number;
  preview: string;
  matchStart: number;
  matchLength: number;
  fullContent: string;
}

function HighlightedPreview({ preview, matchStart, matchLength }: { preview: string; matchStart: number; matchLength: number }) {
  const before = preview.slice(0, matchStart);
  const match = preview.slice(matchStart, matchStart + matchLength);
  const after = preview.slice(matchStart + matchLength);
  return (
    <span className="text-sm text-muted-foreground whitespace-pre-wrap break-words select-text">
      {before}
      <mark className="bg-yellow-300/30 text-foreground rounded-sm px-0.5">{match}</mark>
      {after}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={handleCopy} title="Copy full message">
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

function SearchModal({ onClose }: { onClose: () => void }) {
  const { sessionId, cwd } = useShell();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [contextTimestamp, setContextTimestamp] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }

    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      const params = new URLSearchParams({ q: query });
      if (cwd) params.set("cwd", cwd);

      fetch(`/api/sessions/${sessionId}/search?${params}`, { signal: controller.signal })
        .then((res) => res.json())
        .then((data) => {
          if (!controller.signal.aborted) {
            setResults(data.results || []);
            setSearched(true);
            setLoading(false);
          }
        })
        .catch((err) => {
          if (err.name !== "AbortError") {
            setLoading(false);
            setSearched(true);
          }
        });
    }, 300);

    return () => {
      clearTimeout(timer);
    };
  }, [query, sessionId, cwd]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleResultClick = useCallback((timestamp: number) => {
    setContextTimestamp(timestamp);
  }, []);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose]);

  if (contextTimestamp !== null) {
    return (
      <MessageContextModal
        timestamp={contextTimestamp}
        onClose={() => setContextTimestamp(null)}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={handleOverlayClick}>
      <Card className="w-full max-w-2xl flex flex-col" style={{ maxHeight: "calc(100dvh - 2rem)" }}>
        <div className="flex items-center gap-2 p-4 border-b">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages..."
            className="flex-1 bg-transparent outline-none text-sm"
          />
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />}
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {searched && results.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No results
            </div>
          )}
          {results.map((result, i) => (
            <button
              key={`${result.messageId}-${i}`}
              onClick={() => handleResultClick(result.timestamp)}
              className="w-full text-left p-4 border-b last:border-b-0 hover:bg-muted/50 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2 mb-1">
                <Badge variant={result.role === "user" ? "default" : "secondary"} className="text-[10px] px-1.5 py-0">
                  {result.role === "user" ? "User" : "Assistant"}
                </Badge>
                <span className="text-xs text-muted-foreground select-text">
                  {new Date(result.timestamp).toLocaleString()}
                </span>
                <div className="ml-auto">
                  <CopyButton text={result.fullContent} />
                </div>
              </div>
              <HighlightedPreview preview={result.preview} matchStart={result.matchStart} matchLength={result.matchLength} />
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function SearchButton() {
  const { sessionId } = useShell();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        if (!sessionId) return;
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sessionId]);

  if (!sessionId) return null;

  return (
    <>
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} title="Search messages (Ctrl+F)">
        <Search className="h-4 w-4" />
      </Button>
      {open && <SearchModal onClose={() => setOpen(false)} />}
    </>
  );
}
