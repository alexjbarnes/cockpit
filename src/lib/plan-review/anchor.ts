// Finding a selection again. Markup is kept as the words that were selected
// plus a little of the text either side, never as positions: positions die the
// moment the plan is revised, edited or laid out on a different screen, and
// the words usually survive all three.

export interface TextAnchor {
  quote: string;
  prefix: string;
  suffix: string;
}

export interface TextSpan {
  start: number;
  end: number;
}

const CONTEXT_CHARS = 32;

/** Tighten a span so it neither starts nor ends on whitespace. */
export function trimSpan(text: string, span: TextSpan): TextSpan {
  let { start, end } = span;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}

/** The anchor for a span of `text`, or null when the span selects nothing. */
export function makeAnchor(text: string, span: TextSpan): (TextAnchor & TextSpan) | null {
  const { start, end } = trimSpan(text, { start: Math.max(0, span.start), end: Math.min(text.length, span.end) });
  if (end <= start) return null;
  return {
    start,
    end,
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: text.slice(end, end + CONTEXT_CHARS),
  };
}

/** Whitespace runs collapsed to one space, with each kept character's place
 *  in the original, so a match can be mapped back. */
function collapse(text: string): { flat: string; at: number[] } {
  let flat = "";
  const at: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (!inSpace && flat.length > 0) {
        flat += " ";
        at.push(i);
      }
      inSpace = true;
    } else {
      flat += text[i];
      at.push(i);
      inSpace = false;
    }
  }
  return { flat, at };
}

const flatten = (s: string) => s.replace(/\s+/g, " ");

/** How many characters two strings share, counted back from their ends. */
function sharedTail(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** The same, counted forward from their starts. */
function sharedHead(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Where an anchor's words are in `text` now. The same words can appear more
 * than once, so every occurrence is scored by how much of the remembered
 * surroundings it still has, and the best wins (the earliest, on a tie).
 * Whitespace is compared loosely: a re-rendered or re-wrapped plan breaks
 * lines in different places without changing a word. Null when the words are
 * gone.
 */
export function locateAnchor(text: string, anchor: TextAnchor): TextSpan | null {
  const quote = flatten(anchor.quote).trim();
  if (quote === "") return null;
  const { flat, at } = collapse(text);
  const prefix = flatten(anchor.prefix).trimStart();
  const suffix = flatten(anchor.suffix).trimEnd();

  let best: { index: number; score: number } | null = null;
  for (let index = flat.indexOf(quote); index !== -1; index = flat.indexOf(quote, index + 1)) {
    const before = flat.slice(Math.max(0, index - prefix.length - 1), index);
    const after = flat.slice(index + quote.length, index + quote.length + suffix.length + 1);
    // A space at the join is the same boundary whichever side it was kept on.
    const score = sharedTail(before.trimEnd(), prefix.trimEnd()) + sharedHead(after.trimStart(), suffix.trimStart());
    if (!best || score > best.score) best = { index, score };
  }
  if (!best) return null;
  return { start: at[best.index], end: at[best.index + quote.length - 1] + 1 };
}

/**
 * Sort markup into what can still be placed in `text` and what cannot. The
 * detached ones are kept, not dropped: the reviewer wrote them, and they are
 * still sent with the words they were about.
 */
export function placeAnchors<T extends TextAnchor>(
  text: string,
  items: readonly T[],
): { placed: Array<{ item: T; span: TextSpan }>; detached: T[] } {
  const placed: Array<{ item: T; span: TextSpan }> = [];
  const detached: T[] = [];
  for (const item of items) {
    const span = item.quote === "" ? null : locateAnchor(text, item);
    if (span) placed.push({ item, span });
    else detached.push(item);
  }
  placed.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  return { placed, detached };
}

/** The markup, if any, whose span covers a position: the shortest one, so a
 *  comment inside a larger removal is the one a tap opens. */
export function anchorAt<T>(placed: ReadonlyArray<{ item: T; span: TextSpan }>, offset: number): T | undefined {
  let hit: { item: T; span: TextSpan } | undefined;
  for (const p of placed) {
    if (offset < p.span.start || offset >= p.span.end) continue;
    if (!hit || p.span.end - p.span.start < hit.span.end - hit.span.start) hit = p;
  }
  return hit?.item;
}
