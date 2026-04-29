"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { pathBasename, pathDirname } from "@/lib/path";
import type { InitAgentInfo } from "@/types";

const DEFAULT_AGENTS = [
  { name: "Explore", description: "Fast codebase exploration" },
  { name: "Plan", description: "Design implementation plans" },
  { name: "general-purpose", description: "Multi-step tasks and code changes" },
  { name: "claude-code-guide", description: "Claude Code documentation" },
];

interface CustomAgent {
  name: string;
  scope: "user" | "project";
  description?: string;
}

export interface MentionItem {
  value: string;
  label: string;
  description?: string;
  kind: "agent" | "file";
}

interface MentionMenuProps {
  query: string;
  cwd: string;
  selectedIndex: number;
  onSelect: (value: string) => void;
  onItemsChange?: (items: MentionItem[]) => void;
  initAgents?: InitAgentInfo[];
}

export function MentionMenu({ query, cwd, selectedIndex, onSelect, onItemsChange, initAgents }: MentionMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [customAgents, setCustomAgents] = useState<CustomAgent[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Fetch custom agents from filesystem only when initAgents not available
  useEffect(() => {
    if (initAgents) return;

    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    fetch(`/api/agents?${params}`)
      .then((res) => res.json())
      .then((data: { agents: CustomAgent[] }) => setCustomAgents(data.agents))
      .catch(() => {});
  }, [cwd, initAgents]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams({ cwd });
      if (query) params.set("query", query);

      fetch(`/api/filesystem/files?${params}`)
        .then((res) => res.json())
        .then((data: { files: string[] }) => setFiles(data.files))
        .catch(() => setFiles([]));
    }, 150);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, cwd]);

  const lowerQuery = query.toLowerCase();

  const allAgents = useMemo(() => {
    if (initAgents && initAgents.length > 0) {
      return initAgents.map((a) => ({ name: a.name, description: a.description }));
    }
    // Fallback: merge hardcoded defaults with filesystem custom agents
    const customNames = new Set(customAgents.map((a) => a.name));
    const builtins = DEFAULT_AGENTS.filter((a) => !customNames.has(a.name));
    return [
      ...builtins.map((a) => ({ name: a.name, description: a.description })),
      ...customAgents.map((a) => ({ name: a.name, description: a.description })),
    ];
  }, [initAgents, customAgents]);

  const matchedAgents: MentionItem[] = useMemo(
    () =>
      allAgents
        .filter((a) => a.name.toLowerCase().includes(lowerQuery))
        .map((a) => ({ value: a.name, label: a.name, description: a.description, kind: "agent" as const })),
    [lowerQuery, allAgents],
  );

  const fileItems: MentionItem[] = useMemo(() => files.map((f) => ({ value: f, label: f, kind: "file" as const })), [files]);

  const items = useMemo(() => [...matchedAgents, ...fileItems], [matchedAgents, fileItems]);

  useEffect(() => {
    onItemsChange?.(items);
  }, [items, onItemsChange]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const selected = el.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement | null;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (items.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 mb-1 w-80 max-h-60 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md"
    >
      {matchedAgents.length > 0 && fileItems.length > 0 && (
        <div className="px-3 py-1 text-xs text-muted-foreground font-medium">Agents</div>
      )}
      {matchedAgents.map((item, i) => (
        <button
          key={item.value}
          type="button"
          data-index={i}
          className={`flex w-full items-baseline gap-3 px-3 py-2 text-sm text-left ${
            i === selectedIndex ? "bg-accent text-accent-foreground" : ""
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(item.value);
          }}
        >
          <span className="font-mono font-bold shrink-0">{item.label}</span>
          <span className="text-muted-foreground truncate">{item.description}</span>
        </button>
      ))}
      {fileItems.length > 0 && matchedAgents.length > 0 && <div className="px-3 py-1 text-xs text-muted-foreground font-medium">Files</div>}
      {fileItems.map((item, i) => {
        const idx = matchedAgents.length + i;
        const fileName = pathBasename(item.value);
        const dir = pathDirname(item.value);
        const dirPath = dir || null;

        return (
          <button
            key={item.value}
            type="button"
            data-index={idx}
            className={`flex w-full items-baseline gap-3 px-3 py-2 text-sm text-left ${
              idx === selectedIndex ? "bg-accent text-accent-foreground" : ""
            }`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item.value);
            }}
          >
            <span className="font-mono font-bold shrink-0">{fileName}</span>
            {dirPath && <span className="text-muted-foreground truncate">{dirPath}</span>}
          </button>
        );
      })}
    </div>
  );
}
