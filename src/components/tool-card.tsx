"use client";

import { ChevronRight, ClipboardList, ExternalLink, Loader2 } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "@/hooks/use-settings";
import { shortPath } from "@/lib/path";
import { cn } from "@/lib/utils";
import type { ToolUse } from "@/types";
import { useShell } from "./app-shell";
import { CodeBlock, languageFromPath, prehighlight } from "./code-block";
import { DiffViewer } from "./diff-viewer";
import { PlanViewModal } from "./plan-view-modal";

function parseInput(input: string): Record<string, unknown> {
  if (!input) return {};
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const check = () => {
      setDark(document.documentElement.classList.contains("dark"));
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return dark;
}

function isPlanFile(toolName: string, filePath: string): boolean {
  const name = toolName.toLowerCase();
  return (
    (name === "write" || name === "edit") &&
    (filePath.includes("/.claude/plans/") || filePath.startsWith("~/.claude/plans/")) &&
    filePath.endsWith(".md")
  );
}

interface ToolCardProps {
  tool: ToolUse;
  expandedToolIds?: React.RefObject<Set<string>>;
}

function settingDefault(toolName: string, settings: ReturnType<typeof useSettings>["settings"]): boolean {
  const name = toolName.toLowerCase();
  if (name === "read") return settings.readExpanded;
  if (name === "edit") return settings.editExpanded;
  return settings.toolCallsExpanded;
}

export function ToolCard({ tool, expandedToolIds }: ToolCardProps) {
  const dark = useIsDark();
  const { backgroundTasks } = useShell();
  const { settings, loaded } = useSettings();
  const input = useMemo(() => parseInput(tool.input), [tool.input]);
  const [expanded, setExpanded] = useState(() => expandedToolIds?.current?.has(tool.id) ?? false);
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const userToggledRef = useRef(expandedToolIds?.current?.has(tool.id) ?? false);

  useEffect(() => {
    if (loaded && !userToggledRef.current) {
      setExpanded(settingDefault(tool.name, settings));
    }
  }, [loaded, tool.name, settings]);

  const filePath = (input.file_path as string) || tool.filePath || "";
  const planFile = isPlanFile(tool.name, filePath);
  const planWriteContent = (input.content as string) || "";
  const isPlanWrite = planFile && (tool.name === "Write" || tool.name === "write") && planWriteContent;

  // Pre-highlight code for Read/Write tools so expanding is instant
  useEffect(() => {
    const name = tool.name;
    if ((name === "Read" || name === "read") && tool.output) {
      const fp = (input.file_path as string) || tool.filePath || "";
      const lang = fp ? languageFromPath(fp) : undefined;
      if (lang) prehighlight(tool.output, lang, dark);
    } else if ((name === "Write" || name === "write") && input.content) {
      const fp = (input.file_path as string) || tool.filePath || "";
      const lang = fp ? languageFromPath(fp) : undefined;
      if (lang) prehighlight(input.content as string, lang, dark);
    }
  }, [tool.name, tool.output, tool.filePath, input, dark]);

  const isStatusOnly =
    tool.name === "EnterPlanMode" ||
    tool.name === "ExitPlanMode" ||
    tool.name === "TaskCreate" ||
    tool.name === "TaskUpdate" ||
    tool.name === "TaskList" ||
    tool.name === "TaskGet" ||
    tool.name === "TodoWrite";
  const hasContent = !isStatusOnly && (tool.input || tool.output);

  // Track whether this expansion was user-initiated (click) vs automatic
  const userToggled = useMemo(() => ({ current: false }), []);

  const contentRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || !userToggled.current) return;
      userToggled.current = false;
      requestAnimationFrame(() => {
        const scrollParent = el.closest("[tabindex]");
        if (!scrollParent) return;
        const parentRect = scrollParent.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        if (elRect.bottom > parentRect.bottom) {
          el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      });
    },
    [userToggled],
  );

  return (
    <>
      <div className="rounded border border-border bg-card text-card-foreground text-xs overflow-hidden">
        <button
          onClick={() => {
            if (isPlanWrite) {
              setPlanModalOpen(true);
              return;
            }
            if (!hasContent) return;
            const next = !expanded;
            userToggled.current = next;
            userToggledRef.current = true;
            setExpanded(next);
            if (expandedToolIds?.current) {
              if (next) expandedToolIds.current.add(tool.id);
              else expandedToolIds.current.delete(tool.id);
            }
          }}
          className={cn(
            "flex w-full items-start gap-2 px-3 py-1.5 text-left",
            hasContent && "cursor-pointer hover:bg-muted/50",
            !hasContent && "cursor-default",
          )}
        >
          {isPlanWrite ? (
            <ClipboardList className="h-3 w-3 shrink-0 text-blue-500" />
          ) : (
            <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
          )}
          {tool.name === "Agent" ? (
            <AgentHeader tool={tool} input={input} backgroundTasks={backgroundTasks} />
          ) : (
            <>
              <span className="font-mono font-medium">{tool.name}</span>
              <ToolSummary tool={tool} input={input} />
            </>
          )}
        </button>

        {expanded && hasContent && (
          <div ref={contentRef} className="border-t border-border px-3 py-2 space-y-2">
            <ToolContent tool={tool} input={input} dark={dark} expandedToolIds={expandedToolIds} />
          </div>
        )}
      </div>
      {isPlanWrite && <PlanViewModal open={planModalOpen} onOpenChange={setPlanModalOpen} content={planWriteContent} filePath={filePath} />}
    </>
  );
}

function FilePathIcon({ filePath }: { filePath: string }) {
  const { tabActions } = useShell();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        tabActions?.openFile(filePath);
      }}
      title={filePath}
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      <ExternalLink className="h-3 w-3" />
    </button>
  );
}

function FilePathLink({ filePath, children }: { filePath: string; children: React.ReactNode }) {
  const { tabActions } = useShell();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        tabActions?.openFile(filePath);
      }}
      title={filePath}
      className="font-mono text-muted-foreground break-all hover:underline text-left"
    >
      {children}
    </button>
  );
}

function AgentHeader({
  tool,
  input,
  backgroundTasks,
}: {
  tool: ToolUse;
  input: Record<string, unknown>;
  backgroundTasks: Array<{ toolUseId: string; status: string }>;
}) {
  const desc = (input.description as string) || (input.prompt as string) || "";
  const short = desc.length > 80 ? desc.slice(0, 80) + "..." : desc;
  const model = input.model as string | undefined;
  const agentType = input.subagent_type as string | undefined;
  const tags = [agentType, model].filter(Boolean);
  const spinning = tool.status === "running" || backgroundTasks.some((t) => t.toolUseId === tool.id && t.status === "running");

  return (
    <div className="flex flex-col gap-0.5 min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="font-mono font-medium">Agent</span>
        {spinning && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
        {tags.map((tag) => (
          <span key={tag} className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {tag}
          </span>
        ))}
      </div>
      {short && <span className="text-muted-foreground truncate">{short}</span>}
    </div>
  );
}

function ToolSummary({ tool, input }: { tool: ToolUse; input: Record<string, unknown> }) {
  const name = tool.name;

  if (name === "Edit" || name === "edit") {
    const fp = (input.file_path as string) || tool.filePath || "";
    if (!fp) return null;
    const plan = isPlanFile(name, fp);
    return (
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="text-muted-foreground truncate">
          {shortPath(fp)}
          {plan ? " (plan edit)" : ""}
        </span>
        <FilePathIcon filePath={fp} />
      </span>
    );
  }

  if (name === "Write" || name === "write") {
    const fp = (input.file_path as string) || tool.filePath || "";
    if (!fp) return null;
    const content = (input.content as string) || "";
    if (isPlanFile(name, fp) && content) {
      return <span className="text-blue-500 truncate">View plan</span>;
    }
    return (
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="text-muted-foreground truncate">{shortPath(fp)}</span>
        <FilePathIcon filePath={fp} />
      </span>
    );
  }

  if (name === "Read" || name === "read") {
    const fp = (input.file_path as string) || tool.filePath || "";
    return fp ? (
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="text-muted-foreground truncate">{shortPath(fp)}</span>
        <FilePathIcon filePath={fp} />
      </span>
    ) : null;
  }

  if (name === "Bash" || name === "bash") {
    const cmd = (input.command as string) || "";
    const short = cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
    return short ? <span className="font-mono text-muted-foreground truncate">{short}</span> : null;
  }

  if (name === "Grep" || name === "grep") {
    const pattern = (input.pattern as string) || "";
    return pattern ? <span className="font-mono text-muted-foreground truncate">/{pattern}/</span> : null;
  }

  if (name === "Glob" || name === "glob") {
    const pattern = (input.pattern as string) || "";
    return pattern ? <span className="font-mono text-muted-foreground truncate">{pattern}</span> : null;
  }

  if (name === "EnterPlanMode") {
    return <span className="text-muted-foreground">Entering plan mode</span>;
  }

  if (name === "ExitPlanMode") {
    return <span className="text-muted-foreground">Exiting plan mode</span>;
  }

  if (name === "TaskCreate") {
    const subject = (input.subject as string) || (input.content as string) || "";
    return subject ? <span className="text-muted-foreground truncate">{subject}</span> : null;
  }

  if (name === "TaskUpdate") {
    const taskId = (input.taskId as string) || "";
    const status = (input.status as string) || "";
    return taskId ? (
      <span className="text-muted-foreground truncate">
        #{taskId} {status}
      </span>
    ) : null;
  }

  if (name === "TaskList") {
    return <span className="text-muted-foreground">Listing tasks</span>;
  }

  if (name === "TaskGet") {
    const taskId = (input.taskId as string) || "";
    return taskId ? <span className="text-muted-foreground">#{taskId}</span> : null;
  }

  return null;
}

function ToolContent({
  tool,
  input,
  dark,
  expandedToolIds,
}: {
  tool: ToolUse;
  input: Record<string, unknown>;
  dark: boolean;
  expandedToolIds?: React.RefObject<Set<string>>;
}) {
  const name = tool.name;

  if (name === "Edit" || name === "edit") {
    return <EditContent input={input} tool={tool} dark={dark} />;
  }

  if (name === "Write" || name === "write") {
    return <WriteContent input={input} tool={tool} dark={dark} />;
  }

  if (name === "Read" || name === "read") {
    return <ReadContent input={input} tool={tool} dark={dark} />;
  }

  if (name === "Bash" || name === "bash") {
    return <BashContent input={input} tool={tool} />;
  }

  if (name === "Grep" || name === "grep" || name === "Glob" || name === "glob") {
    return <SearchContent input={input} tool={tool} />;
  }

  if (name === "Agent") {
    return <AgentContent input={input} tool={tool} dark={dark} expandedToolIds={expandedToolIds} />;
  }

  return <DefaultContent input={input} tool={tool} />;
}

function EditContent({ input, tool, dark }: { input: Record<string, unknown>; tool: ToolUse; dark: boolean }) {
  const filePath = (input.file_path as string) || tool.filePath || "file";
  const oldString = (input.old_string as string) || "";
  const newString = (input.new_string as string) || "";

  if (!oldString && !newString) {
    return <DefaultContent input={input} tool={tool} />;
  }

  return <DiffViewer filePath={filePath} oldString={oldString} newString={newString} dark={dark} />;
}

function WriteContent({ input, tool, dark }: { input: Record<string, unknown>; tool: ToolUse; dark: boolean }) {
  const filePath = (input.file_path as string) || tool.filePath || "";
  const content = (input.content as string) || "";
  const lang = filePath ? languageFromPath(filePath) : undefined;

  return (
    <div className="space-y-1">
      {filePath && <FilePathLink filePath={filePath}>{filePath}</FilePathLink>}
      {content && <CodeBlock code={content} language={lang} dark={dark} />}
      {tool.output && (
        <pre className="overflow-x-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed max-h-32 overflow-y-auto text-muted-foreground">
          {tool.output}
        </pre>
      )}
    </div>
  );
}

function ReadContent({ input, tool, dark }: { input: Record<string, unknown>; tool: ToolUse; dark: boolean }) {
  const filePath = (input.file_path as string) || tool.filePath || "";
  const lang = filePath ? languageFromPath(filePath) : undefined;

  return (
    <div className="space-y-1">
      {filePath && <FilePathLink filePath={filePath}>{filePath}</FilePathLink>}
      {tool.output && <CodeBlock code={tool.output} language={lang} dark={dark} />}
    </div>
  );
}

function BashContent({ input, tool }: { input: Record<string, unknown>; tool: ToolUse }) {
  const command = (input.command as string) || "";

  return (
    <div className="space-y-1">
      {command && (
        <div className="font-mono text-muted-foreground break-all">
          <span className="text-foreground/60">$</span> {command}
        </div>
      )}
      {tool.output && (
        <pre className="whitespace-pre-wrap break-all rounded bg-muted/50 p-2 text-[11px] leading-relaxed max-h-64 overflow-y-auto">
          {tool.output}
        </pre>
      )}
    </div>
  );
}

function SearchContent({ input, tool }: { input: Record<string, unknown>; tool: ToolUse }) {
  const pattern = (input.pattern as string) || "";
  const path = (input.path as string) || "";

  return (
    <div className="space-y-1">
      <div className="font-mono text-muted-foreground">
        {pattern && <span>/{pattern}/</span>}
        {path && <span> in {shortPath(path)}</span>}
      </div>
      {tool.output && (
        <pre className="overflow-x-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed max-h-64 overflow-y-auto">{tool.output}</pre>
      )}
    </div>
  );
}

function AgentContent({
  input,
  tool,
  expandedToolIds,
}: {
  input: Record<string, unknown>;
  tool: ToolUse;
  dark?: boolean;
  expandedToolIds?: React.RefObject<Set<string>>;
}) {
  const prompt = (input.prompt as string) || "";
  const children = tool.children || [];

  return (
    <div className="space-y-2">
      {prompt && (
        <pre className="overflow-x-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed max-h-32 overflow-y-auto text-muted-foreground">
          {prompt}
        </pre>
      )}
      {children.length > 0 && (
        <div className="pl-3 border-l-2 border-border space-y-1">
          {children.map((child) => (
            <ToolCard key={child.id} tool={child} expandedToolIds={expandedToolIds} />
          ))}
        </div>
      )}
      {tool.output && (
        <pre className="overflow-x-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed max-h-48 overflow-y-auto text-muted-foreground">
          {tool.output}
        </pre>
      )}
    </div>
  );
}

function DefaultContent({ input, tool }: { input: Record<string, unknown>; tool: ToolUse }) {
  const hasInput = Object.keys(input).length > 0;

  return (
    <div className="space-y-1">
      {hasInput && (
        <pre className="overflow-x-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed max-h-48 overflow-y-auto">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
      {tool.output && (
        <pre className="overflow-x-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed max-h-48 overflow-y-auto text-muted-foreground">
          {tool.output}
        </pre>
      )}
    </div>
  );
}
