"use client";

import { MessageSquare, Pencil, Replace, StickyNote, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { sortAnnotations } from "@/lib/plan-review/feedback";
import { PLAN_LABELS, planLabel } from "@/lib/plan-review/labels";
import type { PlanAnnotation, PlanAnnotationKind } from "@/lib/plan-review/types";
import { cn } from "@/lib/utils";

export const KIND_META: Record<PlanAnnotationKind, { name: string; rail: string; text: string; Icon: typeof MessageSquare }> = {
  comment: { name: "Comment", rail: "border-l-amber-500", text: "text-amber-600 dark:text-amber-400", Icon: MessageSquare },
  remove: { name: "Remove", rail: "border-l-red-500", text: "text-red-600 dark:text-red-400", Icon: Trash2 },
  replace: { name: "Replace", rail: "border-l-blue-500", text: "text-blue-600 dark:text-blue-400", Icon: Replace },
  note: { name: "Note on the whole plan", rail: "border-l-amber-500", text: "text-amber-600 dark:text-amber-400", Icon: StickyNote },
};

interface NotesListProps {
  annotations: readonly PlanAnnotation[];
  detached: ReadonlySet<string>;
  focusedId: string | null;
  readOnly?: boolean;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onAddNote?: () => void;
  empty: string;
}

/** Every piece of markup on the plan, in the order it will be sent. */
export function NotesList({ annotations, detached, focusedId, readOnly, onOpen, onEdit, onDelete, onAddNote, empty }: NotesListProps) {
  const sorted = sortAnnotations(annotations);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="plan-notes">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {sorted.length === 0 && <p className="px-1 py-6 text-center text-xs leading-relaxed text-muted-foreground">{empty}</p>}
        {sorted.map((a) => {
          const meta = KIND_META[a.kind];
          const label = planLabel(a.label);
          return (
            <div
              key={a.id}
              data-testid={`plan-note-${a.id}`}
              className={cn("rounded-md border border-l-2 bg-card text-xs", meta.rail, focusedId === a.id && "ring-1 ring-ring")}
            >
              <button type="button" onClick={() => onOpen(a.id)} className="block w-full px-3 pt-2 text-left">
                <span className={cn("flex items-center gap-1.5 font-medium", meta.text)}>
                  <meta.Icon className="h-3 w-3 shrink-0" />
                  {meta.name}
                  {a.lineStart !== undefined && <span className="font-normal text-muted-foreground">line {a.lineStart}</span>}
                  {detached.has(a.id) && (
                    <span
                      className="rounded bg-muted px-1 py-px text-[10px] font-normal text-muted-foreground"
                      title="These words are no longer in the plan. The note is still sent."
                    >
                      text changed
                    </span>
                  )}
                </span>
                {a.quote && (
                  <span
                    className={cn(
                      "mt-1 line-clamp-2 block text-muted-foreground [overflow-wrap:anywhere]",
                      a.kind === "remove" && "line-through",
                    )}
                  >
                    {a.quote}
                  </span>
                )}
                {label && <span className="mt-1.5 inline-block rounded-full border px-2 py-px text-[11px]">{label.name}</span>}
                {a.body && <span className="mt-1 block whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">{a.body}</span>}
              </button>
              {readOnly ? (
                <div className="h-2" />
              ) : (
                <div className="flex justify-end gap-1 px-1.5 pb-1">
                  {a.kind !== "remove" && (
                    <button
                      type="button"
                      onClick={() => onEdit(a.id)}
                      aria-label="Edit this note"
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onDelete(a.id)}
                    aria-label="Delete this note"
                    data-testid={`plan-note-delete-${a.id}`}
                    className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {onAddNote && !readOnly && (
        <div className="shrink-0 border-t p-2">
          <button
            type="button"
            onClick={onAddNote}
            data-testid="plan-add-note"
            className="flex w-full items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs hover:bg-muted"
          >
            <StickyNote className="h-3.5 w-3.5" />
            Add a note on the whole plan
          </button>
        </div>
      )}
    </div>
  );
}

interface NoteComposerProps {
  kind: PlanAnnotationKind;
  quote: string;
  initialBody?: string;
  initialLabel?: string;
  onSave: (body: string, label: string | undefined) => void;
  onCancel: () => void;
}

const PLACEHOLDER: Record<PlanAnnotationKind, string> = {
  comment: "What should change here?",
  replace: "What should it say?",
  remove: "Why should this go? (optional)",
  note: "What should change about the plan?",
};

/** Where a comment, a replacement or a note is written. */
export function NoteComposer({ kind, quote, initialBody = "", initialLabel, onSave, onCancel }: NoteComposerProps) {
  const [body, setBody] = useState(initialBody);
  const [label, setLabel] = useState<string | undefined>(initialLabel);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const meta = KIND_META[kind];
  // A label can stand in for a comment's words; nothing else can be empty.
  const canSave = body.trim() !== "" || (kind === "comment" && label !== undefined) || kind === "remove";

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const save = () => {
    if (canSave) onSave(body.trim(), label);
  };

  return (
    <div className="flex min-h-0 flex-col" data-testid="plan-composer">
      <div className={cn("flex items-center gap-1.5 px-4 pt-3 text-xs font-medium", meta.text)}>
        <meta.Icon className="h-3.5 w-3.5" />
        {meta.name}
      </div>
      {quote && (
        <p
          className={cn(
            "mx-4 mt-2 line-clamp-3 border-l-2 pl-2 text-xs text-muted-foreground [overflow-wrap:anywhere]",
            kind === "remove" && "line-through",
          )}
        >
          {quote}
        </p>
      )}
      <div className="px-4 pt-3">
        <textarea
          ref={inputRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
          rows={3}
          placeholder={PLACEHOLDER[kind]}
          data-testid="plan-composer-input"
          // 16px on a phone: anything smaller makes iOS zoom the page on focus.
          className="w-full resize-none rounded-md border bg-background px-3 py-2 text-base outline-none focus:ring-1 focus:ring-ring sm:text-sm"
        />
      </div>
      {kind === "comment" && (
        <div className="flex gap-1.5 overflow-x-auto px-4 pt-2 pb-1" data-testid="plan-labels">
          {PLAN_LABELS.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => setLabel(label === l.id ? undefined : l.id)}
              aria-pressed={label === l.id}
              data-testid={`plan-label-${l.id}`}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-1 text-xs",
                label === l.id ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {l.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-2 px-4 py-3">
        <button type="button" onClick={onCancel} className="rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-muted">
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          data-testid="plan-composer-save"
          className="rounded-md bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          Save note
        </button>
      </div>
    </div>
  );
}
