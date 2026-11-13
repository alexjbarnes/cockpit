// The browser half of anchoring: turning a selection in the rendered plan
// into a span of its text and back. The text is the container's textContent,
// which is exactly what Range.toString() yields, so a span measured one way
// can be rebuilt the other.

import type { TextSpan } from "@/lib/plan-review/anchor";

/**
 * The part of a range that lies inside `root`, or null when none does. A
 * triple click selects up to the start of whatever follows the block, which
 * for the last block of the plan is outside the plan; that is still a
 * selection of the plan's text and must not be thrown away.
 */
export function clipRange(root: HTMLElement, range: Range): Range | null {
  if (!range.intersectsNode(root)) return null;
  const clipped = range.cloneRange();
  if (!root.contains(clipped.startContainer)) clipped.setStart(root, 0);
  if (!root.contains(clipped.endContainer)) clipped.setEnd(root, root.childNodes.length);
  return clipped.collapsed ? null : clipped;
}

/** A range's span within `root`, or null when it is not wholly inside it. */
export function spanFromRange(root: HTMLElement, range: Range): TextSpan | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { start, end: start + range.toString().length };
}

/** The range covering a span of `root`'s text, or null when it runs off the end. */
export function rangeFromSpan(root: HTMLElement, span: TextSpan): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let seen = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).data.length;
    if (!started && span.start < seen + length) {
      range.setStart(node, span.start - seen);
      started = true;
    }
    if (started && span.end <= seen + length) {
      range.setEnd(node, span.end - seen);
      return range;
    }
    seen += length;
  }
  return null;
}

/** The nearest block that knows which source lines it came from. */
export function blockOf(node: Node | null, root: HTMLElement): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  const block = el?.closest<HTMLElement>("[data-line-start]") ?? null;
  return block && root.contains(block) ? block : null;
}

function lineOf(el: HTMLElement | null, attr: "lineStart" | "lineEnd"): number | undefined {
  const value = Number(el?.dataset[attr]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The markdown source lines a range falls in, as far as the blocks say. */
export function linesOfRange(root: HTMLElement, range: Range): { lineStart?: number; lineEnd?: number } {
  const first = blockOf(range.startContainer, root);
  const last = blockOf(range.endContainer, root) ?? first;
  const lineStart = lineOf(first, "lineStart");
  const lineEnd = lineOf(last, "lineEnd") ?? lineOf(last, "lineStart");
  return { ...(lineStart !== undefined ? { lineStart } : {}), ...(lineEnd !== undefined ? { lineEnd } : {}) };
}

/** The position in `root`'s text under a point on screen, or null off the text. */
export function offsetAtPoint(root: HTMLElement, x: number, y: number): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | undefined;
  let offset = 0;
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) {
    node = position.offsetNode;
    offset = position.offset;
  } else {
    const caret = doc.caretRangeFromPoint?.(x, y);
    if (caret) {
      node = caret.startContainer;
      offset = caret.startOffset;
    }
  }
  if (!node || !root.contains(node)) return null;
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(node, offset);
  return before.toString().length;
}

// ── Painting ────────────────────────────────────────────────────────────
//
// Markup is painted with the CSS Custom Highlight API: ranges are registered
// under a name and styled with ::highlight(name) in globals.css. Nothing is
// wrapped or inserted, so React can re-render the plan without tripping over
// foreign nodes. Highlight names are global to the page, and more than one
// plan can be on screen (a tab and a modal), so each plan contributes its
// ranges under its own key and the registry paints the union.

export type PaintName = "plan-comment" | "plan-remove" | "plan-replace" | "plan-pending" | "plan-focus";
const PAINT_NAMES: PaintName[] = ["plan-comment", "plan-remove", "plan-replace", "plan-pending", "plan-focus"];

type HighlightRegistry = Map<string, unknown>;
interface HighlightGlobals {
  Highlight?: new (...ranges: Range[]) => unknown;
  CSS?: { highlights?: HighlightRegistry };
}

const painted = new Map<string, Partial<Record<PaintName, Range[]>>>();

export function canPaint(): boolean {
  const g = globalThis as unknown as HighlightGlobals;
  return typeof g.Highlight === "function" && !!g.CSS?.highlights;
}

/** Set, or with `null` clear, the ranges one plan contributes. */
export function paint(key: string, ranges: Partial<Record<PaintName, Range[]>> | null): void {
  if (ranges) painted.set(key, ranges);
  else painted.delete(key);
  if (!canPaint()) return;
  const g = globalThis as unknown as Required<HighlightGlobals> & { CSS: { highlights: HighlightRegistry } };
  for (const name of PAINT_NAMES) {
    const all: Range[] = [];
    for (const entry of painted.values()) all.push(...(entry[name] ?? []));
    if (all.length === 0) g.CSS.highlights.delete(name);
    else g.CSS.highlights.set(name, new g.Highlight(...all));
  }
}
