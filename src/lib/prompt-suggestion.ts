/** The history entry that completes `text`, or null when none starts with it.
 *
 *  History is newest-first, so the first match is the most recently used. A
 *  prompt typed in lowercase matches regardless of the history's casing, while
 *  typing a capital makes the match case-sensitive (smartcase), so the
 *  completion does not second-guess deliberate capitalisation. */
export function suggestCompletion(text: string, history: readonly string[]): string | null {
  if (!text.trim()) return null;
  const caseSensitive = text !== text.toLowerCase();
  for (const entry of history) {
    if (entry.length <= text.length) continue;
    const prefix = entry.slice(0, text.length);
    if (caseSensitive ? prefix === text : prefix.toLowerCase() === text) return entry;
  }
  return null;
}
