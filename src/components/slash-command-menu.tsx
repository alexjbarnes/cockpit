"use client";

import { useEffect, useRef, useState } from "react";
import { type SlashCommand, slashCommands } from "@/lib/commands";

// Commands handled client-side by Cockpit, always included
const cockpitCommands: SlashCommand[] = [
  { command: "/btw", description: "Nudge Claude while it's working" },
  { command: "/mcp", description: "Show MCP server status" },
];

interface SlashCommandMenuProps {
  query: string;
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  cwd?: string;
  onItemsChange?: (items: SlashCommand[]) => void;
  initCommands?: string[];
}

export function SlashCommandMenu({ query, selectedIndex, onSelect, cwd, onItemsChange, initCommands }: SlashCommandMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [custom, setCustom] = useState<SlashCommand[]>([]);

  useEffect(() => {
    if (initCommands) return;

    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);

    const skillsP = fetch(`/api/skills?${params}`)
      .then((res) => res.json())
      .then((data: { skills: Array<{ name: string; description?: string }> }) =>
        data.skills.map((s) => ({
          command: "/" + s.name,
          description: s.description || "Custom skill",
        })),
      )
      .catch(() => [] as SlashCommand[]);

    const commandsP = fetch(`/api/commands?${params}`)
      .then((res) => res.json())
      .then((data: { commands: Array<{ name: string; description?: string }> }) =>
        data.commands.map((c) => ({
          command: "/" + c.name,
          description: c.description || "Custom command",
        })),
      )
      .catch(() => [] as SlashCommand[]);

    Promise.all([skillsP, commandsP]).then(([skills, commands]) => {
      // Skills take precedence over commands with the same name
      const seen = new Set<string>();
      const merged: SlashCommand[] = [];
      for (const s of skills) {
        seen.add(s.command);
        merged.push(s);
      }
      for (const c of commands) {
        if (!seen.has(c.command)) merged.push(c);
      }
      setCustom(merged);
    });
  }, [cwd, initCommands]);

  const cliCommands = initCommands
    ? (() => {
        const builtinMap = new Map(slashCommands.map((c) => [c.command, c]));
        const fromInit = initCommands.map((name) => {
          const cmd = name.startsWith("/") ? name : "/" + name;
          return builtinMap.get(cmd) || { command: cmd, description: "" };
        });
        const initNames = new Set(fromInit.map((c) => c.command));
        return [...fromInit, ...slashCommands.filter((c) => !initNames.has(c.command))];
      })()
    : (() => {
        const builtinNames = new Set(slashCommands.map((c) => c.command));
        return [...slashCommands, ...custom.filter((s) => !builtinNames.has(s.command))];
      })();

  // Always include Cockpit-local commands, dedup by command name
  const seen = new Set<string>();
  const allCommands: SlashCommand[] = [];
  for (const cmd of [...cliCommands, ...cockpitCommands]) {
    if (!seen.has(cmd.command)) {
      seen.add(cmd.command);
      allCommands.push(cmd);
    }
  }

  const filtered = allCommands.filter((cmd) => cmd.command.startsWith("/" + query));

  useEffect(() => {
    onItemsChange?.(filtered);
  }, [filtered.length, onItemsChange, filtered]);

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
          <span className="text-muted-foreground truncate">{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}
