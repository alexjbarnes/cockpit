"use client";

import { Check, ChevronDown, Hand, MessageSquare, Pencil, Replace, StickyNote, Tag, Trash2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffViewer } from "@/components/diff-viewer";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Sheet } from "@/components/ui/sheet";
import type { TextAnchor } from "@/lib/plan-review/anchor";
import { changedLines, changeSummary } from "@/lib/plan-review/diff";
import { PLAN_LABELS } from "@/lib/plan-review/labels";
import type { PlanAnnotation, PlanAnnotationKind, PlanDraft, PlanReviewOutcome, PlanVersion } from "@/lib/plan-review/types";
import { cn } from "@/lib/utils";
import { PlanDocument, type PlanDocumentHandle, type PlanSelection } from "./plan-document";
import { NoteComposer, NotesList } from "./plan-notes";

export interface PlanDecisionInput {
  version: PlanVersion;
  annotations: PlanAnnotation[];
  /** The plan as the reviewer edited it, when they did. */
  editedText?: string;
}

/** What the host does with a decision. A session answers the waiting plan; an
 *  issue stores the review and moves the issue on. */
export interface PlanReviewActions {
  approveOptions: ReadonlyArray<{ id: string; label: string }>;
  approve: (optionId: string, input: PlanDecisionInput) => void;
  requestChanges: (input: PlanDecisionInput) => void;
  dismiss?: () => void;
  /** Wording for the send button, e.g. "Send to Claude". */
  sendLabel?: string;
}

interface PlanReviewSurfaceProps {
  versions: readonly PlanVersion[];
  /** Markup in progress, as last stored. */
  draft: PlanDraft | null;
  /** The version waiting for a decision, or null when none is. */
  reviewable: number | null;
  actions?: PlanReviewActions;
  onDraftChange: (draft: Omit<PlanDraft, "hash"> | null) => void;
  empty?: React.ReactNode;
  className?: string;
}

type Composer = { mode: "new"; kind: PlanAnnotationKind; selection: PlanSelection | null } | { mode: "edit"; id: string };

const OUTCOME: Record<PlanReviewOutcome, { text: string; tone: string }> = {
  approved: { text: "Approved", tone: "text-emerald-600 dark:text-emerald-400" },
  changes_requested: { text: "Changes requested", tone: "text-amber-600 dark:text-amber-400" },
  dismissed: { text: "Dismissed", tone: "text-muted-foreground" },
};

const WIDE_PX = 860;

function newId(): string {
  // Not crypto.randomUUID: cockpit is often reached over plain http on a LAN,
  // where the browser withholds it.
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const read = () => setDark(document.documentElement.classList.contains("dark"));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(pointer: coarse)");
    setCoarse(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setCoarse(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * The plan review surface: the plan with its markup, the notes, the versions
 * and the decision. It is the same component in a session's Plan tab and in an
 * issue's review modal; only `actions` differs.
 */
export function PlanReviewSurface({ versions, draft, reviewable, actions, onDraftChange, empty, className }: PlanReviewSurfaceProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PlanDocumentHandle>(null);
  const dark = useIsDark();
  const coarse = useCoarsePointer();
  const [wide, setWide] = useState(false);

  const newest = versions[versions.length - 1];
  const [selectedN, setSelectedN] = useState<number | undefined>(reviewable ?? newest?.n);
  const [baseN, setBaseN] = useState<number | undefined>(undefined);
  const [view, setView] = useState<"plan" | "changes">("plan");
  const [editing, setEditing] = useState(false);
  const [tapMode, setTapMode] = useState(false);

  const [annotations, setAnnotations] = useState<PlanAnnotation[]>(() => draft?.annotations ?? []);
  const [editedText, setEditedText] = useState<string | undefined>(() =>
    draft && draft.version === reviewable ? draft.editedText : undefined,
  );
  const [selection, setSelection] = useState<PlanSelection | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [composerAnchor, setComposerAnchor] = useState<DOMRect | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [detached, setDetached] = useState<ReadonlySet<string>>(new Set());
  const [notesOpen, setNotesOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [sentOpen, setSentOpen] = useState(false);

  // ── Which version is on screen ──────────────────────────────────────
  const followed = useRef({ reviewable, newest: newest?.n });
  useEffect(() => {
    const prev = followed.current;
    followed.current = { reviewable, newest: newest?.n };
    // A new plan to answer takes the screen. Otherwise a reader who was on
    // the newest version stays on the newest, and one reading an old version
    // is left where they are.
    if (reviewable !== null && reviewable !== prev.reviewable) setSelectedN(reviewable);
    else if (newest && newest.n !== prev.newest)
      setSelectedN((current) => (current === undefined || current === prev.newest ? newest.n : current));
  }, [reviewable, newest]);

  const version = versions.find((v) => v.n === selectedN) ?? newest;
  const index = version ? versions.indexOf(version) : -1;
  const previous = index > 0 ? versions[index - 1] : undefined;
  const base = versions.find((v) => v.n === baseN && version && v.n < version.n) ?? previous;
  const canReview = !!actions && !!version && reviewable !== null && version.n === reviewable;

  // ── The draft: local first, stored a moment later ───────────────────
  const stamp = useRef(draft?.updatedAt ?? 0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const unsaved = useRef<Omit<PlanDraft, "hash"> | null | undefined>(undefined);
  const emit = useRef(onDraftChange);
  emit.current = onDraftChange;

  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    if (unsaved.current === undefined) return;
    emit.current(unsaved.current);
    unsaved.current = undefined;
  }, []);

  const change = useCallback(
    (next: PlanAnnotation[], nextEdited: string | undefined) => {
      setAnnotations(next);
      setEditedText(nextEdited);
      if (reviewable === null) return;
      stamp.current = Date.now();
      unsaved.current = {
        version: reviewable,
        annotations: next,
        ...(nextEdited !== undefined ? { editedText: nextEdited } : {}),
        updatedAt: stamp.current,
      };
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, 400);
    },
    [reviewable, flush],
  );

  useEffect(() => {
    // Leaving the page, or the tab going to the background on a phone, is
    // the last chance to store a note typed a moment ago.
    const onHide = () => flush();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [flush]);

  // A draft stored after this one was last touched came from another device
  // (or another tab), and it wins.
  useEffect(() => {
    if (!draft || draft.updatedAt <= stamp.current) return;
    stamp.current = draft.updatedAt;
    setAnnotations(draft.annotations);
    setEditedText(draft.version === reviewable ? draft.editedText : undefined);
  }, [draft, reviewable]);

  // The plan was answered somewhere else: what was drafted here is spent.
  const answered = useRef(reviewable);
  useEffect(() => {
    if (answered.current === reviewable) return;
    answered.current = reviewable;
    if (draft) return;
    clearTimeout(saveTimer.current);
    unsaved.current = undefined;
    setAnnotations([]);
    setEditedText(undefined);
    setEditing(false);
  }, [reviewable, draft]);

  // ── Layout ───────────────────────────────────────────────────────────
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= WIDE_PX));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const shown = canReview ? annotations : (version?.review?.annotations ?? []);
  const content = canReview && editedText !== undefined ? editedText : (version?.content ?? "");
  const edited = canReview && editedText !== undefined && editedText !== version?.content;
  const changed = useMemo(
    () => (previous && version && !edited ? changedLines(previous.content, version.content) : undefined),
    [previous, version, edited],
  );
  const summary = useMemo(() => (previous && version ? changeSummary(previous.content, version.content) : undefined), [previous, version]);

  // ── Selection and markup ─────────────────────────────────────────────
  const clearSelection = useCallback(() => {
    setSelection(null);
    setLabelsOpen(false);
    window.getSelection()?.removeAllRanges();
  }, []);

  const addFromSelection = useCallback(
    (kind: PlanAnnotationKind, body: string, label?: string, from: PlanSelection | null = selection) => {
      const anchor = kind === "note" ? null : from;
      if (kind !== "note" && !anchor) return;
      const annotation: PlanAnnotation = {
        id: newId(),
        kind,
        quote: anchor?.quote ?? "",
        prefix: anchor?.prefix ?? "",
        suffix: anchor?.suffix ?? "",
        ...(anchor?.lineStart !== undefined ? { lineStart: anchor.lineStart } : {}),
        ...(anchor?.lineEnd !== undefined ? { lineEnd: anchor.lineEnd } : {}),
        body,
        ...(label ? { label } : {}),
        createdAt: Date.now(),
      };
      change([...annotations, annotation], editedText);
      clearSelection();
    },
    [selection, annotations, editedText, change, clearSelection],
  );

  const openComposer = useCallback(
    (next: Composer, anchor: TextAnchor | null) => {
      setComposerAnchor(anchor && !coarse ? (docRef.current?.rectOf(anchor) ?? null) : null);
      setComposer(next);
      setLabelsOpen(false);
      setNotesOpen(false);
    },
    [coarse],
  );

  const startMarkup = useCallback(
    (kind: PlanAnnotationKind) => {
      if (kind === "remove") addFromSelection("remove", "");
      else openComposer({ mode: "new", kind, selection: kind === "note" ? null : selection }, kind === "note" ? null : selection);
    },
    [addFromSelection, openComposer, selection],
  );

  const editing_ = composer?.mode === "edit" ? annotations.find((a) => a.id === composer.id) : undefined;

  const saveComposer = (body: string, label: string | undefined) => {
    if (!composer) return;
    if (composer.mode === "new") addFromSelection(composer.kind, body, label, composer.selection);
    else
      change(
        annotations.map((a) => (a.id === composer.id ? { ...a, body, ...(label ? { label } : { label: undefined }) } : a)),
        editedText,
      );
    setComposer(null);
  };

  const removeAnnotation = (id: string) => {
    change(
      annotations.filter((a) => a.id !== id),
      editedText,
    );
    if (focusedId === id) setFocusedId(null);
  };

  const openAnnotation = useCallback((id: string) => {
    setFocusedId(id);
    setView("plan");
    setEditing(false);
  }, []);

  // Keys act on a selection wherever focus is: after a drag across the plan
  // nothing in particular has it. Escape is taken here, before it reaches the
  // chat, where it would stop Claude's turn and with it the plan being read.
  useEffect(() => {
    if (!canReview || !selection || composer) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "escape") clearSelection();
      else if (key === "c") startMarkup("comment");
      else if (key === "r") startMarkup("replace");
      else if (key === "d" || key === "backspace" || key === "delete") startMarkup("remove");
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [canReview, selection, composer, clearSelection, startMarkup]);

  // ── Decisions ────────────────────────────────────────────────────────
  const hasFeedback = annotations.length > 0 || edited;
  const decisionInput = (): PlanDecisionInput | null =>
    version ? { version, annotations, ...(edited && editedText !== undefined ? { editedText } : {}) } : null;

  const spend = () => {
    clearTimeout(saveTimer.current);
    unsaved.current = undefined;
    stamp.current = Date.now();
    setAnnotations([]);
    setEditedText(undefined);
    setEditing(false);
    setSelection(null);
    setApproveOpen(false);
  };

  const send = () => {
    const input = decisionInput();
    if (!input || !actions) return;
    flush();
    actions.requestChanges(input);
    spend();
  };

  const approve = (optionId: string) => {
    const input = decisionInput();
    if (!input || !actions) return;
    flush();
    actions.approve(optionId, input);
    spend();
  };

  // Cmd/Ctrl+Enter does the obvious thing: send what there is, or approve.
  useEffect(() => {
    if (!canReview || composer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      if (target && !rootRef.current?.contains(target) && target !== document.body) return;
      e.preventDefault();
      if (hasFeedback) send();
      else setApproveOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!version) {
    return (
      <div
        className={cn("flex h-full min-h-0 flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground", className)}
      >
        {empty ?? "No plan yet."}
      </div>
    );
  }

  const review = version.review;
  const toolbar = canReview && selection && !composer && !editing && view === "plan";
  const notes = (
    <NotesList
      annotations={shown}
      detached={detached}
      focusedId={focusedId}
      readOnly={!canReview}
      onOpen={(id) => {
        openAnnotation(id);
        setNotesOpen(false);
      }}
      onEdit={(id) => openComposer({ mode: "edit", id }, null)}
      onDelete={removeAnnotation}
      onAddNote={canReview ? () => startMarkup("note") : undefined}
      empty={
        canReview
          ? "Select text in the plan to comment on it, mark it for removal or suggest a replacement."
          : review
            ? "No notes were made on this version."
            : "This version was not reviewed."
      }
    />
  );

  const toolbarButtons = (
    <>
      <ToolbarButton testId="plan-act-comment" label="Comment" hint="C" onAct={() => startMarkup("comment")}>
        <MessageSquare className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton testId="plan-act-remove" label="Remove" hint="D" onAct={() => startMarkup("remove")}>
        <Trash2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton testId="plan-act-replace" label="Replace" hint="R" onAct={() => startMarkup("replace")}>
        <Replace className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton testId="plan-act-label" label="Label" onAct={() => setLabelsOpen((open) => !open)}>
        <Tag className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton testId="plan-act-cancel" label="Cancel" quiet onAct={clearSelection}>
        <X className="h-4 w-4" />
      </ToolbarButton>
    </>
  );

  const labelChips = labelsOpen && (
    <div className="flex flex-wrap gap-1.5" data-testid="plan-quick-labels">
      {PLAN_LABELS.map((l) => (
        <button
          key={l.id}
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => addFromSelection("comment", "", l.id)}
          data-testid={`plan-quick-label-${l.id}`}
          className="rounded-full border bg-background px-2.5 py-1 text-xs hover:bg-muted"
        >
          {l.name}
        </button>
      ))}
    </div>
  );

  return (
    <div ref={rootRef} data-testid="plan-review" className={cn("flex h-full min-h-0 flex-1 flex-col bg-background", className)}>
      {/* Header: which version, and how it is being looked at. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-3 py-2 text-xs">
        <select
          aria-label="Plan version"
          data-testid="plan-version-select"
          value={version.n}
          onChange={(e) => {
            setSelectedN(Number(e.target.value));
            setBaseN(undefined);
            setEditing(false);
            clearSelection();
          }}
          className="rounded-md border bg-background px-2 py-1.5 text-xs font-medium"
        >
          {[...versions].reverse().map((v) => (
            <option key={v.n} value={v.n}>
              {`Version ${v.n}${v.n === reviewable ? " (to review)" : v.review ? `, ${OUTCOME[v.review.outcome].text.toLowerCase()}` : ""}`}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground">{when(version.createdAt)}</span>
        {version.author?.kind === "user" && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">your edit</span>}
        {summary && (summary.added > 0 || summary.removed > 0) && (
          <span className="text-muted-foreground" data-testid="plan-change-summary">
            <span className="text-emerald-600 dark:text-emerald-400">+{summary.added}</span>{" "}
            <span className="text-red-600 dark:text-red-400">-{summary.removed}</span> since version {previous?.n}
          </span>
        )}
        <span className="flex-1" />
        {previous && (
          <div className="flex overflow-hidden rounded-md border" role="tablist" aria-label="View">
            {(["plan", "changes"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                data-testid={`plan-view-${v}`}
                onClick={() => {
                  setView(v);
                  setEditing(false);
                  clearSelection();
                }}
                className={cn("px-2.5 py-1.5", view === v ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
              >
                {v === "plan" ? "Plan" : "Changes"}
              </button>
            ))}
          </div>
        )}
        {canReview && view === "plan" && (
          <button
            type="button"
            data-testid="plan-edit-toggle"
            aria-pressed={editing}
            onClick={() => {
              setEditing((on) => !on);
              clearSelection();
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5",
              editing ? "bg-primary text-primary-foreground" : "hover:bg-muted",
            )}
          >
            {editing ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
            {editing ? "Done" : "Edit"}
          </button>
        )}
      </div>

      {edited && !editing && view === "plan" && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-blue-500/10 px-3 py-1.5 text-xs" data-testid="plan-edited-banner">
          <span className="flex-1">You have edited this plan. Your version is what gets approved, or is sent back as a diff.</span>
          <button
            type="button"
            onClick={() => change(annotations, undefined)}
            data-testid="plan-revert-edits"
            className="flex shrink-0 items-center gap-1 rounded px-2 py-1 hover:bg-muted"
          >
            <Undo2 className="h-3.5 w-3.5" />
            Revert
          </button>
        </div>
      )}

      {/* Body: the plan, and beside it the notes when there is room. */}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="plan-scroll">
          {view === "changes" && base ? (
            <div className="p-3">
              {versions.filter((v) => v.n < version.n).length > 1 && (
                <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  Compared with
                  <select
                    data-testid="plan-base-select"
                    value={base.n}
                    onChange={(e) => setBaseN(Number(e.target.value))}
                    className="rounded-md border bg-background px-2 py-1 text-xs text-foreground"
                  >
                    {versions
                      .filter((v) => v.n < version.n)
                      .reverse()
                      .map((v) => (
                        <option key={v.n} value={v.n}>
                          Version {v.n}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {base.content === version.content ? (
                <p className="p-6 text-center text-sm text-muted-foreground">These two versions are the same.</p>
              ) : (
                <div data-testid="plan-diff">
                  <DiffViewer filePath="plan.md" oldString={base.content} newString={version.content} dark={dark} />
                </div>
              )}
            </div>
          ) : editing ? (
            <MarkdownEditor
              value={content}
              onChange={(text) => change(annotations, text === version.content ? undefined : text)}
              className="h-full rounded-none border-0"
            />
          ) : (
            <div className="mx-auto max-w-3xl px-3 py-4 pb-24 sm:px-6">
              <PlanDocument
                ref={docRef}
                content={content}
                annotations={shown}
                selection={canReview ? selection : null}
                focusedId={focusedId}
                changed={changed}
                tapMode={tapMode}
                readOnly={!canReview}
                onSelect={(next) => {
                  // The document reports the selection again on every pointer
                  // release, including the one that presses a toolbar button.
                  // Only a different selection resets what the toolbar has open.
                  const same =
                    !!next &&
                    !!selection &&
                    next.quote === selection.quote &&
                    next.prefix === selection.prefix &&
                    next.suffix === selection.suffix;
                  setSelection(next);
                  if (same) return;
                  setLabelsOpen(false);
                  if (next) setFocusedId(null);
                }}
                onOpen={openAnnotation}
                onDetached={(ids) =>
                  setDetached((prev) => (prev.size === ids.length && ids.every((id) => prev.has(id)) ? prev : new Set(ids)))
                }
                overlay={
                  toolbar && !coarse ? (
                    <div
                      data-testid="plan-toolbar"
                      className="absolute z-20 max-w-[min(26rem,calc(100%-1rem))] rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
                      style={{ top: selection.box.bottom + 8, left: Math.max(4, selection.box.left) }}
                    >
                      <div className="flex items-center gap-0.5">{toolbarButtons}</div>
                      {labelsOpen && <div className="max-w-sm border-t p-2">{labelChips}</div>}
                    </div>
                  ) : null
                }
              />
            </div>
          )}
        </div>
        {wide && view === "plan" && !editing && <aside className="flex w-72 shrink-0 flex-col border-l bg-muted/20">{notes}</aside>}
      </div>

      {/* On a touch screen the actions dock here, clear of the system's own
          selection menu, which sits right beside the selected text. */}
      {toolbar && coarse && (
        <div className="shrink-0 border-t bg-popover px-2 py-2 text-popover-foreground" data-testid="plan-toolbar">
          {labelsOpen && <div className="max-h-32 overflow-y-auto pb-2">{labelChips}</div>}
          <p className="line-clamp-1 px-1 pb-1.5 text-xs text-muted-foreground">{selection.quote}</p>
          <div className="flex items-stretch justify-between gap-1">{toolbarButtons}</div>
        </div>
      )}

      {/* Footer: the decision, or what was decided. */}
      {canReview && !(toolbar && coarse) && (
        <div
          className="flex shrink-0 items-center gap-2 border-t px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
          data-testid="plan-decision"
        >
          {!wide && (
            <button
              type="button"
              data-testid="plan-notes-open"
              onClick={() => setNotesOpen(true)}
              className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs hover:bg-muted"
            >
              <StickyNote className="h-3.5 w-3.5" />
              Notes
              {annotations.length > 0 && (
                <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-medium text-white" data-testid="plan-notes-count">
                  {annotations.length}
                </span>
              )}
            </button>
          )}
          {coarse && view === "plan" && !editing && (
            <button
              type="button"
              data-testid="plan-tap-toggle"
              aria-pressed={tapMode}
              aria-label="Tap a paragraph to select all of it"
              title="Tap a paragraph to select all of it"
              onClick={() => {
                setTapMode((on) => !on);
                clearSelection();
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs",
                tapMode ? "bg-primary text-primary-foreground" : "hover:bg-muted",
              )}
            >
              <Hand className="h-3.5 w-3.5" />
              Tap
            </button>
          )}
          <span className="flex-1" />
          {!hasFeedback && actions?.dismiss && (
            <button
              type="button"
              data-testid="plan-dismiss"
              onClick={() => {
                actions.dismiss?.();
                spend();
              }}
              className="rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-muted"
            >
              Dismiss
            </button>
          )}
          {hasFeedback ? (
            <>
              <button
                type="button"
                data-testid="plan-approve-with-notes"
                onClick={() => setApproveOpen(true)}
                className="flex items-center gap-1 rounded-md border px-3 py-2 text-xs hover:bg-muted"
              >
                {edited && annotations.length === 0 ? "Approve my edit" : "Approve with notes"}
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                data-testid="plan-send-feedback"
                onClick={send}
                className="rounded-md bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                {actions?.sendLabel ?? "Send feedback"}
                {annotations.length > 0 ? ` (${annotations.length})` : ""}
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="plan-approve"
              onClick={() => setApproveOpen(true)}
              className="flex items-center gap-1 rounded-md bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              Approve
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      {!canReview && (
        <div className="shrink-0 border-t px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-xs" data-testid="plan-outcome">
          <div className="flex flex-wrap items-center gap-2">
            {!wide && (
              <button
                type="button"
                data-testid="plan-notes-open"
                onClick={() => setNotesOpen(true)}
                className="flex items-center gap-1.5 rounded-md border px-3 py-2 hover:bg-muted"
              >
                <StickyNote className="h-3.5 w-3.5" />
                Notes{shown.length > 0 ? ` (${shown.length})` : ""}
              </button>
            )}
            {review ? (
              <span>
                <span className={cn("font-medium", OUTCOME[review.outcome].tone)}>{OUTCOME[review.outcome].text}</span>
                <span className="text-muted-foreground"> {when(review.reviewedAt)}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">
                {version.n === newest?.n ? "Nothing is waiting for a decision." : "An earlier version."}
              </span>
            )}
            <span className="flex-1" />
            {review?.feedback && (
              <button
                type="button"
                data-testid="plan-sent-toggle"
                onClick={() => setSentOpen((open) => !open)}
                className="rounded-md border px-3 py-2 hover:bg-muted"
              >
                {sentOpen ? "Hide what was sent" : "Show what was sent"}
              </button>
            )}
          </div>
          {sentOpen && review?.feedback && (
            <pre
              className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs [overflow-wrap:anywhere]"
              data-testid="plan-sent"
            >
              {review.feedback}
            </pre>
          )}
        </div>
      )}

      <Sheet
        open={composer !== null}
        onClose={() => setComposer(null)}
        anchor={composerAnchor}
        label="Write a note"
        testId="plan-composer-sheet"
      >
        {composer && (
          <NoteComposer
            key={composer.mode === "edit" ? composer.id : `new-${composer.kind}`}
            kind={composer.mode === "new" ? composer.kind : (editing_?.kind ?? "comment")}
            quote={composer.mode === "new" ? (composer.selection?.quote ?? "") : (editing_?.quote ?? "")}
            initialBody={editing_?.body}
            initialLabel={editing_?.label}
            onSave={saveComposer}
            onCancel={() => setComposer(null)}
          />
        )}
      </Sheet>

      <Sheet
        open={notesOpen && !wide}
        onClose={() => setNotesOpen(false)}
        label="Notes on this plan"
        testId="plan-notes-sheet"
        className="h-[70dvh] sm:h-[32rem]"
      >
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-3 text-sm font-medium">
          Notes
          <button
            type="button"
            aria-label="Close"
            onClick={() => setNotesOpen(false)}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {notes}
      </Sheet>

      <Sheet open={approveOpen} onClose={() => setApproveOpen(false)} label="Approve the plan" testId="plan-approve-sheet">
        <div className="px-4 pt-3 text-sm font-medium">Approve this plan</div>
        <p className="px-4 pt-1 text-xs text-muted-foreground">
          {annotations.length > 0
            ? `Your ${annotations.length === 1 ? "note is" : `${annotations.length} notes are`} added to the plan as notes for the implementation.`
            : edited
              ? "Your edited version becomes the plan."
              : "The plan is approved as it stands."}
        </p>
        <div className="space-y-1 p-3">
          {actions?.approveOptions.map((option, i) => (
            <button
              key={option.id}
              type="button"
              data-testid={`plan-approve-${option.id}`}
              onClick={() => approve(option.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md border px-3 py-2.5 text-left text-sm hover:bg-muted",
                i === 0 && "border-primary/60",
              )}
            >
              <Check className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              {option.label}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

interface ToolbarButtonProps {
  label: string;
  hint?: string;
  testId: string;
  quiet?: boolean;
  onAct: () => void;
  children: React.ReactNode;
}

/** A selection action. The press is stopped from reaching the page, where it
 *  would clear the very selection the action is about. */
function ToolbarButton({ label, hint, testId, quiet, onAct, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={hint ? `${label} (${hint})` : label}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onAct}
      className={cn(
        "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-2.5 py-1.5 text-[11px] hover:bg-muted sm:min-h-0 sm:flex-row sm:gap-1.5 sm:text-xs",
        quiet && "flex-none text-muted-foreground",
      )}
    >
      {children}
      <span className={cn(quiet && "sr-only")}>{label}</span>
    </button>
  );
}
