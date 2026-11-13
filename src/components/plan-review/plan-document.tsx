"use client";

import { forwardRef, memo, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { anchorAt, locateAnchor, makeAnchor, placeAnchors, type TextAnchor, type TextSpan } from "@/lib/plan-review/anchor";
import type { PlanAnnotation } from "@/lib/plan-review/types";
import { cn } from "@/lib/utils";
import { blockOf, clipRange, linesOfRange, offsetAtPoint, type PaintName, paint, rangeFromSpan, spanFromRange } from "./dom";

/** A selection in the plan, kept as words so it outlives the native one. */
export interface PlanSelection extends TextAnchor {
  lineStart?: number;
  lineEnd?: number;
  /** Where it sits inside the document, for placing a toolbar beside it. */
  box: { top: number; bottom: number; left: number; right: number };
}

export interface PlanDocumentHandle {
  /** Where an anchor is on screen right now, or null when it cannot be found. */
  rectOf: (anchor: TextAnchor) => DOMRect | null;
}

interface PlanDocumentProps {
  content: string;
  annotations: readonly PlanAnnotation[];
  selection: PlanSelection | null;
  focusedId: string | null;
  /** Source lines that differ from the previous version, marked in the margin. */
  changed?: ReadonlySet<number>;
  /** One tap selects a whole block: the way to select without dragging handles. */
  tapMode?: boolean;
  readOnly?: boolean;
  onSelect: (selection: PlanSelection | null) => void;
  onOpen: (annotationId: string) => void;
  /** Markup whose words are no longer in the plan. */
  onDetached?: (ids: string[]) => void;
  /** Rendered inside the document, positioned against it. */
  overlay?: React.ReactNode;
  className?: string;
}

const BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "pre", "blockquote", "tr", "hr"]);

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start: { line: number }; end: { line: number } };
  children?: HastNode[];
}

/** Stamp each block with the markdown lines it was written on, so a selection
 *  can say where in the source it is. */
function rehypeSourceLines() {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (node.type === "element" && node.tagName && BLOCK_TAGS.has(node.tagName) && node.position) {
        node.properties = { ...node.properties, dataLineStart: node.position.start.line, dataLineEnd: node.position.end.line };
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

function ExternalLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

// Fenced code stays a plain <pre>: the chat's highlighted block re-renders
// itself and adds line numbers to the text, and markup is anchored to text.
const COMPONENTS = { a: ExternalLink };
const REMARK = [remarkGfm];
const REHYPE = [rehypeSourceLines];

const Rendered = memo(function Rendered({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
      {content}
    </ReactMarkdown>
  );
});

const PAINT_FOR: Record<Exclude<PlanAnnotation["kind"], "note">, PaintName> = {
  comment: "plan-comment",
  remove: "plan-remove",
  replace: "plan-replace",
};

const MARKER_COLOUR: Record<PlanAnnotation["kind"], string> = {
  comment: "bg-amber-500",
  remove: "bg-red-500",
  replace: "bg-blue-500",
  note: "bg-amber-500",
};

interface Marker {
  id: string;
  kind: PlanAnnotation["kind"];
  top: number;
  height: number;
}

interface Rail {
  top: number;
  height: number;
}

function sameBoxes(a: ReadonlyArray<{ top: number; height: number }>, b: ReadonlyArray<{ top: number; height: number }>): boolean {
  return a.length === b.length && a.every((x, i) => Math.abs(x.top - b[i].top) < 1 && Math.abs(x.height - b[i].height) < 1);
}

/**
 * The plan, rendered, with markup painted over it. It turns a text selection
 * into a `PlanSelection` and reports taps on existing markup; what happens
 * next is the surface's business.
 */
export const PlanDocument = forwardRef<PlanDocumentHandle, PlanDocumentProps>(function PlanDocument(
  { content, annotations, selection, focusedId, changed, tapMode, readOnly, onSelect, onOpen, onDetached, overlay, className },
  handle,
) {
  const key = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const placedRef = useRef<Array<{ item: PlanAnnotation; span: TextSpan }>>([]);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [rails, setRails] = useState<Rail[]>([]);
  const [layoutTick, setLayoutTick] = useState(0);

  const callbacks = useRef({ onSelect, onOpen, onDetached });
  callbacks.current = { onSelect, onOpen, onDetached };

  useImperativeHandle(
    handle,
    () => ({
      rectOf: (anchor) => {
        const root = textRef.current;
        if (!root) return null;
        const span = locateAnchor(root.textContent ?? "", anchor);
        return span ? (rangeFromSpan(root, span)?.getBoundingClientRect() ?? null) : null;
      },
    }),
    [],
  );

  // Place the markup in the rendered text, paint it, and measure where each
  // piece sits for the margin.
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutTick re-measures after a resize, content after a re-render
  useLayoutEffect(() => {
    const root = textRef.current;
    const wrap = wrapRef.current;
    if (!root || !wrap) return;
    const text = root.textContent ?? "";
    const anchored = annotations.filter((a) => a.kind !== "note");
    const { placed, detached } = placeAnchors(text, anchored);
    placedRef.current = placed;
    callbacks.current.onDetached?.(detached.map((d) => d.id));

    const origin = wrap.getBoundingClientRect();
    const ranges: Partial<Record<PaintName, Range[]>> = {};
    const nextMarkers: Marker[] = [];
    for (const { item, span } of placed) {
      const range = rangeFromSpan(root, span);
      if (!range || item.kind === "note") continue;
      const name = item.id === focusedId ? "plan-focus" : PAINT_FOR[item.kind];
      ranges[name] = [...(ranges[name] ?? []), range];
      const rect = range.getBoundingClientRect();
      nextMarkers.push({ id: item.id, kind: item.kind, top: rect.top - origin.top, height: Math.max(rect.height, 14) });
    }
    if (selection) {
      const span = locateAnchor(text, selection);
      const range = span && rangeFromSpan(root, span);
      if (range) ranges["plan-pending"] = [range];
    }
    paint(key, ranges);
    setMarkers((prev) => (sameBoxes(prev, nextMarkers) && prev.every((m, i) => m.id === nextMarkers[i].id) ? prev : nextMarkers));

    const nextRails: Rail[] = [];
    if (changed && changed.size > 0) {
      for (const block of root.querySelectorAll<HTMLElement>("[data-line-start]")) {
        // The innermost block carries the mark, or a list item and the
        // paragraph inside it would both be marked.
        if (block.querySelector("[data-line-start]")) continue;
        const from = Number(block.dataset.lineStart);
        const to = Number(block.dataset.lineEnd) || from;
        let hit = false;
        for (let line = from; line <= to && !hit; line++) hit = changed.has(line);
        if (!hit) continue;
        const rect = block.getBoundingClientRect();
        nextRails.push({ top: rect.top - origin.top, height: rect.height });
      }
    }
    setRails((prev) => (sameBoxes(prev, nextRails) ? prev : nextRails));
  }, [content, annotations, selection, focusedId, changed, key, layoutTick]);

  useEffect(() => () => paint(key, null), [key]);

  useEffect(() => {
    const root = textRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setLayoutTick((n) => n + 1));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Bring markup opened from the notes list into view.
  useEffect(() => {
    const root = textRef.current;
    if (!root || !focusedId) return;
    const hit = placedRef.current.find((p) => p.item.id === focusedId);
    const range = hit && rangeFromSpan(root, hit.span);
    const el = range?.startContainer.parentElement;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusedId]);

  // Turn the browser's selection into a PlanSelection once it has settled.
  // A mouse selection is finished when the button comes up. A touch selection
  // has no such moment: the handles can be dragged again and again, so it is
  // read once it has stopped changing with no finger on the screen. Reading it
  // any earlier takes the handles away mid-drag on iOS.
  useEffect(() => {
    const root = textRef.current;
    const wrap = wrapRef.current;
    if (!root || !wrap || readOnly) return;
    let touching = false;
    let lastPointer = "mouse";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const picked = clipRange(root, sel.getRangeAt(0));
      const span = picked && spanFromRange(root, picked);
      const anchor = span && makeAnchor(root.textContent ?? "", span);
      // Measured from the words themselves, not from the raw selection: a
      // triple click runs on to the start of the next block, which would put
      // the selection a line too long and its box a line too low.
      const range = anchor && rangeFromSpan(root, anchor);
      if (!anchor || !range) return;
      const rect = range.getBoundingClientRect();
      const origin = wrap.getBoundingClientRect();
      callbacks.current.onSelect({
        quote: anchor.quote,
        prefix: anchor.prefix,
        suffix: anchor.suffix,
        ...linesOfRange(root, range),
        box: {
          top: rect.top - origin.top,
          bottom: rect.bottom - origin.top,
          left: rect.left - origin.left,
          right: rect.right - origin.left,
        },
      });
    };
    const later = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!touching) read();
      }, ms);
    };

    const onPointerDown = (e: PointerEvent) => {
      lastPointer = e.pointerType || "mouse";
    };
    const onPointerUp = (e: PointerEvent) => {
      if ((e.pointerType || "mouse") !== "touch") later(0);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.shiftKey || e.key === "Shift") later(0);
    };
    const onTouchStart = () => {
      touching = true;
    };
    const onTouchEnd = () => {
      touching = false;
      later(350);
    };
    const onSelectionChange = () => {
      if (lastPointer === "touch") later(450);
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchEnd, { passive: true });
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchEnd);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [readOnly]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const root = textRef.current;
    const wrap = wrapRef.current;
    if (!root || !wrap) return;
    const sel = window.getSelection();
    // A drag that has just ended is a selection, not a tap.
    if (sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.getRangeAt(0).intersectsNode(root)) return;
    const offset = offsetAtPoint(root, e.clientX, e.clientY);
    const hit = offset === null ? undefined : anchorAt(placedRef.current, offset);
    if (hit) {
      onOpen(hit.id);
      return;
    }
    if (tapMode && !readOnly) {
      const block = blockOf(e.target as Node, root);
      if (block) {
        const range = document.createRange();
        range.selectNodeContents(block);
        const span = spanFromRange(root, range);
        const anchor = span && makeAnchor(root.textContent ?? "", span);
        if (anchor) {
          const rect = block.getBoundingClientRect();
          const origin = wrap.getBoundingClientRect();
          onSelect({
            quote: anchor.quote,
            prefix: anchor.prefix,
            suffix: anchor.suffix,
            ...linesOfRange(root, range),
            box: {
              top: rect.top - origin.top,
              bottom: rect.bottom - origin.top,
              left: rect.left - origin.left,
              right: rect.right - origin.left,
            },
          });
          return;
        }
      }
    }
    onSelect(null);
  };

  return (
    <div ref={wrapRef} className={cn("relative pl-5", className)}>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-5">
        {rails.map((rail) => (
          <span
            key={`${rail.top}-${rail.height}`}
            data-testid="plan-changed-rail"
            title="Changed since the previous version"
            className="absolute left-0 w-[3px] rounded-full bg-emerald-500/80"
            style={{ top: rail.top, height: rail.height }}
          />
        ))}
        {markers.map((marker) => (
          <button
            key={marker.id}
            type="button"
            data-testid={`plan-marker-${marker.id}`}
            aria-label="Open this note"
            onClick={() => onOpen(marker.id)}
            className={cn(
              "pointer-events-auto absolute left-2 w-1.5 rounded-full before:absolute before:-inset-x-2 before:inset-y-0 before:content-['']",
              MARKER_COLOUR[marker.kind],
              marker.id === focusedId ? "opacity-100" : "opacity-70",
            )}
            style={{ top: marker.top, height: marker.height }}
          />
        ))}
      </div>
      {/* Taps open markup. The notes list is the keyboard route to the same notes. */}
      <div
        ref={textRef}
        data-testid="plan-document"
        onClick={handleClick}
        className={cn(
          "message-prose prose prose-sm max-w-none select-text dark:prose-invert",
          tapMode && !readOnly && "cursor-pointer [&_[data-line-start]]:rounded-sm [&_[data-line-start]:hover]:bg-muted/60",
        )}
      >
        <Rendered content={content} />
      </div>
      {overlay}
    </div>
  );
});
