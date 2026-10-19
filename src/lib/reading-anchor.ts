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

/** The first message whose bottom is below the top of the view: the one being
 *  read. Items are in document order, measured in the same coordinates as
 *  `viewTop`. */
export function anchorFromItems(items: { id: string; top: number; bottom: number }[], viewTop: number): ReadingAnchor | null {
  for (const item of items) {
    if (item.id && item.bottom > viewTop) return { id: item.id, offset: item.top - viewTop };
  }
  return null;
}

/** How far to scroll to put the anchor back where it was. Zero when it has not
 *  moved, which is what the browser's own anchoring leaves when it worked. */
export function anchorCorrection(anchor: ReadingAnchor, currentOffset: number): number {
  const drift = currentOffset - anchor.offset;
  return Math.abs(drift) > 1 ? drift : 0;
}
