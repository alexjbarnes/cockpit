"use client";

import { useEffect, useRef } from "react";
import { slashCommands, type SlashCommand } from "@/lib/commands";

interface SlashCommandMenuProps {
  query: string;
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
}

export function SlashCommandMenu({
  query,
  selectedIndex,
  onSelect,
}: SlashCommandMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = slashCommands.filter((cmd) =>
    cmd.command.startsWith("/" + query)
  );

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const selected = el.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 mb-1 w-80 max-h-60 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md"
    >
      {filtered.map((cmd, i) => (
        <button
          key={cmd.command}
          type="button"
          className={`flex w-full items-baseline gap-3 px-3 py-2 text-sm text-left ${
            i === selectedIndex ? "bg-accent text-accent-foreground" : ""
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(cmd);
          }}
        >
          <span className="font-mono font-bold shrink-0">{cmd.command}</span>
          <span className="text-muted-foreground truncate">
            {cmd.description}
          </span>
        </button>
      ))}
    </div>
  );
}

export function getFilteredCommands(query: string) {
  return slashCommands.filter((cmd) => cmd.command.startsWith("/" + query));
}
