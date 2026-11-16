// Images written in markdown: `![caption](target)`. An issue's comments and
// its plan can show pictures this way. The target an agent writes is a file on
// disk, which the server copies into the issue and swaps for the address the
// page loads it from (src/server/issue-images.ts). What is here is the part
// with no disk in it, shared by that and by the page.

/** The image files a comment or a plan can show. No SVG: one opened by its
 *  address would run its scripts on Cockpit's own origin. */
export const INLINE_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

/** Whether a path or address names one of those image files. */
export function isImagePath(target: string): boolean {
  const path = target.split(/[?#]/)[0].toLowerCase();
  return INLINE_IMAGE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Where the page loads one of an issue's stored attachments from. */
export function attachmentHref(issueKey: string, id: string): string {
  return `/api/issues/${issueKey}/attachments/${id}`;
}

/** The attachment an address names, when it is one of this issue's. */
export function attachmentIdFromHref(issueKey: string, href: string): string | undefined {
  const match = /^\/api\/issues\/([^/]+)\/attachments\/([^/?#]+)$/.exec(href);
  if (!match || match[1].toUpperCase() !== issueKey.toUpperCase()) return undefined;
  return match[2];
}

const IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^\s()<>]+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'))?)\s*\)/g;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** The parts of one line, told apart as text and as code spans. */
function splitCodeSpans(line: string): Array<{ text: string; code: boolean }> {
  const parts: Array<{ text: string; code: boolean }> = [];
  let from = 0;
  let at = 0;
  while (at < line.length) {
    if (line[at] !== "`") {
      at++;
      continue;
    }
    let ticks = 1;
    while (line[at + ticks] === "`") ticks++;
    // A span closes on a run of exactly as many backticks as opened it.
    const close = new RegExp(`(?<!\`)\`{${ticks}}(?!\`)`, "g");
    close.lastIndex = at + ticks;
    const end = close.exec(line);
    if (!end) {
      at += ticks;
      continue;
    }
    if (at > from) parts.push({ text: line.slice(from, at), code: false });
    parts.push({ text: line.slice(at, end.index + ticks), code: true });
    from = end.index + ticks;
    at = from;
  }
  if (from < line.length) parts.push({ text: line.slice(from), code: false });
  return parts;
}

/**
 * Give every image in `markdown` a new target. An image inside a fenced block
 * or a code span is text about an image, so it is left as written. An image
 * whose target comes back unchanged is left exactly as it was.
 */
export function mapImageTargets(markdown: string, map: (target: string, alt: string) => string): string {
  let fence: { char: string; length: number } | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const mark = FENCE.exec(line)?.[1];
      if (fence) {
        if (mark && mark[0] === fence.char && mark.length >= fence.length && line.trim() === mark) fence = null;
        return line;
      }
      if (mark) {
        fence = { char: mark[0], length: mark.length };
        return line;
      }
      return splitCodeSpans(line)
        .map((part) =>
          part.code
            ? part.text
            : part.text.replace(IMAGE, (whole, alt: string, raw: string, title: string) => {
                const target = raw.startsWith("<") ? raw.slice(1, -1) : raw;
                const next = map(target, alt);
                if (next === target) return whole;
                return `![${alt}](${/\s/.test(next) ? `<${next}>` : next}${title})`;
              }),
        )
        .join("");
    })
    .join("\n");
}
