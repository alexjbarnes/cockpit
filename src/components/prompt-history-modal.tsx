"use client";

import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface PromptHistoryModalProps {
  open: boolean;
  prompts: string[];
  onSelect: (text: string) => void;
  onClose: () => void;
}

export function PromptHistoryModal({ open, prompts, onSelect, onClose }: PromptHistoryModalProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return prompts;
    const lower = query.toLowerCase();
    return prompts.filter((p) => p.toLowerCase().includes(lower));
  }, [prompts, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when search query changes
  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.children;
    if (items[selected]) {
      items[selected].scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => (s > 0 ? s - 1 : filtered.length - 1));
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => (s < filtered.length - 1 ? s + 1 : 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[selected]) {
          onSelect(filtered[selected]);
        }
        return;
      }
    },
    [filtered, selected, onSelect, onClose],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-3xl mb-24 mx-4 rounded-lg border bg-background shadow-lg overflow-hidden" onKeyDown={handleKeyDown}>
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">{query ? "No matching prompts" : "No prompt history"}</div>
          )}
          {filtered.map((prompt, i) => (
            <button
              key={`${i}-${prompt.slice(0, 20)}`}
              onClick={() => onSelect(prompt)}
              onMouseEnter={() => setSelected(i)}
              className={`flex w-full items-start gap-2 rounded px-3 py-2 text-left text-sm transition-colors ${
                selected === i ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="shrink-0 font-mono text-xs text-muted-foreground/50 w-5 text-right pt-0.5">{filtered.length - i}</span>
              <span className="line-clamp-2 break-all">{prompt}</span>
            </button>
          ))}
        </div>
        <div className="border-t px-3 py-2 flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search prompts..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <span className="text-xs text-muted-foreground shrink-0">
            {filtered.length} prompt{filtered.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
