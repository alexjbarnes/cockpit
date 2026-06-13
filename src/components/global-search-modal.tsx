"use client";

import { ArrowUpRight, Check, Copy, Folder, Loader2, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { GlobalSearchResult } from "@/types";
import { MessageContextModal } from "./message-context-modal";

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

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
    [text],
  );

  return (
    <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={handleCopy} title="Copy full message">
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

function GlobalSearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const [stats, setStats] = useState<{ total: number; truncated: boolean } | null>(null);
  const [contextResult, setContextResult] = useState<GlobalSearchResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const router = useRouter();

  const openSession = useCallback(
    (result: GlobalSearchResult) => {
      router.push(`/sessions/${result.sessionId}?cwd=${encodeURIComponent(result.cwd)}&historyView=true`);
      onClose();
    },
    [router, onClose],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSearch = useCallback((q: string, offset: number, signal: AbortSignal) => {
    return fetch(`/api/sessions/search?q=${encodeURIComponent(q)}&offset=${offset}`, { signal }).then((res) => res.json());
  }, []);

  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      setSearched(false);
      setStats(null);
      return;
    }

    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      doSearch(query, 0, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) {
            setResults(data.results || []);
            setStats({ total: data.totalFilesSearched || 0, truncated: !!data.truncated });
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
    }, 500);

    return () => {
      clearTimeout(timer);
    };
  }, [query, doSearch]);

  const loadMore = useCallback(() => {
    if (loadingMore || !stats?.truncated) return;
    setLoadingMore(true);
    const controller = new AbortController();
    doSearch(query, results.length, controller.signal)
      .then((data) => {
        setResults((prev) => [...prev, ...(data.results || [])]);
        setStats({ total: data.totalFilesSearched || 0, truncated: !!data.truncated });
        setLoadingMore(false);
      })
      .catch(() => {
        setLoadingMore(false);
      });
  }, [query, results.length, loadingMore, stats?.truncated, doSearch]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

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

  return (
    <>
      {/* The results list stays mounted while the context modal overlays it, so
          its scroll position is preserved when you close the modal and continue
          browsing. */}
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={handleOverlayClick}>
        <Card className="w-full max-w-2xl flex flex-col" style={{ maxHeight: "calc(100dvh - 2rem)" }}>
          <div className="flex items-center gap-2 p-4 border-b">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search all session messages..."
              className="flex-1 bg-transparent outline-none text-sm"
            />
            {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />}
            <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {searched && results.length === 0 && <div className="p-8 text-center text-sm text-muted-foreground">No results</div>}
            {results.map((result, i) => (
              <div
                key={`${result.messageId}-${i}`}
                role="button"
                tabIndex={0}
                onClick={() => setContextResult(result)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setContextResult(result);
                  }
                }}
                className="w-full text-left p-4 border-b last:border-b-0 hover:bg-muted/50 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant={result.role === "user" ? "default" : "secondary"} className="text-[10px] px-1.5 py-0">
                    {result.role === "user" ? "User" : "Assistant"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{new Date(result.timestamp).toLocaleString()}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      title="Open session"
                      onClick={(e) => {
                        e.stopPropagation();
                        openSession(result);
                      }}
                    >
                      <ArrowUpRight className="h-3 w-3" />
                    </Button>
                    <CopyButton text={result.fullContent} />
                  </div>
                </div>
                <div className="mb-1.5 text-[11px] text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <Folder className="h-3 w-3 shrink-0" />
                    <span className="truncate">{result.dirName}</span>
                  </div>
                  <div className="truncate pl-[18px]">{result.sessionName}</div>
                </div>
                <HighlightedPreview preview={result.preview} matchStart={result.matchStart} matchLength={result.matchLength} />
              </div>
            ))}
          </div>
          {stats && searched && results.length > 0 && (
            <div className="px-4 py-2 border-t text-[11px] text-muted-foreground flex items-center justify-between">
              <span>
                {results.length} result{results.length !== 1 ? "s" : ""} across {stats.total} session{stats.total !== 1 ? "s" : ""}
              </span>
              {stats.truncated && (
                <button onClick={loadMore} disabled={loadingMore} className="text-[11px] text-primary hover:underline disabled:opacity-50">
                  {loadingMore ? "Loading..." : "Load more"}
                </button>
              )}
            </div>
          )}
        </Card>
      </div>
      {contextResult && (
        <MessageContextModal
          timestamp={contextResult.timestamp}
          sessionId={contextResult.sessionId}
          cwd={contextResult.cwd}
          onClose={() => setContextResult(null)}
        />
      )}
    </>
  );
}

export function GlobalSearchButton() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "f") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground hover:bg-accent/50 transition-colors"
      >
        <Search className="h-4 w-4" />
        <span>Search all session messages...</span>
        <kbd className="ml-auto hidden sm:inline text-[10px] border rounded px-1.5 py-0.5">Ctrl+Shift+F</kbd>
      </button>
      {open && <GlobalSearchModal onClose={() => setOpen(false)} />}
    </>
  );
}
