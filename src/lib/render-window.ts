/** The chat's message list as the render window sees it. */
export interface ListShape {
  total: number;
  firstId: string | null;
}

/**
 * How many messages the chat renders, counted from the end of the list, after
 * the list changed from `before` to `after`.
 *
 * While the reader is scrolled up, messages arriving at the bottom grow the
 * window by as many. A window of a fixed size would slide instead, unmounting
 * its top messages from under the reader. At the bottom it keeps its size, and
 * older messages loaded at the top (the first id changes) stay hidden until
 * scrolling up asks for them.
 */
export function grownRenderWindow(window: number, before: ListShape, after: ListShape, following: boolean): number {
  if (following || after.firstId !== before.firstId || after.total <= before.total) return window;
  return window + (after.total - before.total);
}
