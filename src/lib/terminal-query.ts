/** The reply a VT220-class terminal gives to a Primary Device Attributes
 *  query (DA1): VT220 with ANSI colour. fish waits for this at startup and
 *  warns after ten seconds without one. */
export const DA1_RESPONSE = "\x1b[?62;22c";

const DA1_PREFIXES = ["\x1b[c", "\x1b[0c"];

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    count++;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

/** Count the DA1 queries in a websocket frame, carrying any partial query at
 *  its end into the next frame. */
export function takeDa1Queries(pending: string, data: string): { queries: number; pending: string } {
  const combined = pending + data;
  const queries = countOccurrences(combined, "\x1b[c") + countOccurrences(combined, "\x1b[0c");
  let tail = "";
  for (let length = 3; length >= 1; length--) {
    const suffix = combined.slice(-length);
    if (DA1_PREFIXES.some((query) => suffix.length < query.length && query.startsWith(suffix))) {
      tail = suffix;
      break;
    }
  }
  return { queries, pending: tail };
}

/** Whether the terminal itself has just answered a DA1 query, so the panel
 *  should not answer it as well. */
export function isDa1Response(data: string): boolean {
  return data.startsWith("\x1b[?") && data.endsWith("c");
}
