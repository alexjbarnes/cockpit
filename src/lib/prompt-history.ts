/** The CLI session IDs whose prompt histories make up a cockpit session, in
 *  recency order. `previous` runs oldest to newest, so it is visited backwards
 *  after the session running now. */
export function promptHistorySessionIds(current: string, previous: readonly string[]): string[] {
  return [current, ...[...previous].reverse()];
}

/** Flattens prompt histories into one newest-first list. Each segment is
 *  itself newest-first and comes from promptHistorySessionIds, so the first
 *  occurrence of a repeated prompt is also the most recent one. */
export function mergePromptHistory(segments: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const segment of segments) {
    for (const prompt of segment) {
      if (seen.has(prompt)) continue;
      seen.add(prompt);
      merged.push(prompt);
    }
  }
  return merged;
}
