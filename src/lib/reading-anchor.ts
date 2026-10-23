/**
 * Keeping the reader's place in the chat while older messages are added above
 * them. The browser's scroll anchoring normally does this, but Chromium skips it
 * when the list is at exactly the top, which is where a flick on a phone comes
 * to rest, and Safari has none at all. So the chat records which message is at
 * the top of the view and puts it back if an insertion moved it.
 */

/** The message at the top of the view, and how far its top sits below the top
 *  of the scroller (negative when it starts above it). */
export interface ReadingAnchor {
  id: string;
  offset: number;
}

/** One message as the chat measures it, in the same coordinates as the top of
 *  the view. */
export interface MeasuredItem {
  id: string;
  top: number;
  bottom: number;
}

/**
 * The first message whose bottom is below the top of the view: the one being
 * read. Messages stack in document order, so their bottoms only grow, and
 * halving finds it in a few measurements rather than one per message above the
 * reader, which matters on every scroll of a long chat.
 */
export function anchorFromItems(count: number, itemAt: (index: number) => MeasuredItem, viewTop: number): ReadingAnchor | null {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (itemAt(mid).bottom > viewTop) hi = mid;
    else lo = mid + 1;
  }
  for (let i = lo; i < count; i++) {
    const item = itemAt(i);
    if (item.id) return { id: item.id, offset: item.top - viewTop };
  }
  return null;
}

/** How far to scroll to put the anchor back where it was. Zero when it has not
 *  moved, which is what the browser's own anchoring leaves when it worked. */
export function anchorCorrection(anchor: ReadingAnchor, currentOffset: number): number {
  const drift = currentOffset - anchor.offset;
  return Math.abs(drift) > 1 ? drift : 0;
}
