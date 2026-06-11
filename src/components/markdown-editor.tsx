"use client";

import { Eye, Pencil } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { CodeEditor } from "@/components/code-editor";
import { MarkdownRender } from "@/components/markdown-render";
import { cn } from "@/lib/utils";

const PREVIEW_KEY = "cockpit-md-editor-preview";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  className?: string;
}

/**
 * Markdown editor with an Edit/Preview toggle — raw CodeMirror source or a
 * rendered preview, mirroring the raw/preview affordance in the file viewer.
 * The mode is remembered across editors via localStorage.
 */
export function MarkdownEditor({ value, onChange, onSave, className }: MarkdownEditorProps) {
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(PREVIEW_KEY) === "1") setPreview(true);
  }, []);

  const choose = useCallback((next: boolean) => {
    setPreview(next);
    localStorage.setItem(PREVIEW_KEY, next ? "1" : "0");
  }, []);

  return (
    <div className={cn("flex flex-col min-h-0 overflow-hidden rounded-md border bg-background", className)}>
      <div className="shrink-0 flex items-center gap-1 border-b bg-muted/30 px-2 py-1">
        <TabButton active={!preview} icon={<Pencil className="h-3.5 w-3.5" />} label="Edit" onClick={() => choose(false)} />
        <TabButton active={preview} icon={<Eye className="h-3.5 w-3.5" />} label="Preview" onClick={() => choose(true)} />
      </div>
      {preview ? (
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {value.trim() ? <MarkdownRender content={value} /> : <p className="text-sm text-muted-foreground italic">Nothing to preview.</p>}
        </div>
      ) : (
        <CodeEditor
          value={value}
          onChange={onChange}
          language="markdown"
          onSave={onSave}
          className="flex-1 min-h-0 rounded-none border-0 [&_.cm-editor]:h-full [&_.cm-editor]:min-h-[300px]"
        />
      )}
    </div>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
