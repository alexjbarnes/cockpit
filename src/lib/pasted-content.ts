/**
 * Undo the Claude CLI's `<pasted_content>` wrapping of a user message.
 *
 * The CLI records a bracketed paste in the transcript as
 * `<pasted_content id="xxxx">\n…\n</pasted_content id="xxxx">`, and escapes any
 * such tag inside the paste by turning its `<` into `<\`. It is gated on the
 * CLI's remote `tengu_virtual_pancake` flag, which is on from 2.1.281
 * (2026-09-23) with no local override. Cockpit types every
 * multi-line message as one bracketed paste, because a raw newline would act as
 * Enter and submit it half-typed, so with the flag on every such message comes
 * back fully wrapped: the tags showed in the chat bubble, in the session title
 * and in prompt history, and the bubble no longer matched its optimistic copy.
 *
 * The parse mirrors the CLI's own display unwrapper (`Pct`/`xae` in 2.1.281),
 * so a message reads back exactly as it was typed:
 *  - the opener is `<pasted_content id="XXXX">` then a newline, XXXX being four
 *    lowercase hex digits; anything else is ordinary text
 *  - the body runs to a newline followed by the matching closer, and an
 *    unclosed block ends the parse, leaving the rest as it stands
 *  - up to two newlines are swallowed before each opener and after each closer,
 *    which are the separators the CLI adds when it writes the block
 *
 * Unlike the CLI's version it also reverses the escape, which it has no need
 * to. Only the literal tag name is restored: the CLI escapes look-alike Unicode
 * spellings too, and those keep their backslash, which costs nothing but a
 * visible `\` in text nobody types.
 */

const OPENER = '<pasted_content id="';
const ID_RE = /^[0-9a-f]{4}$/;
const ESCAPED_TAG_RE = /<\\(?=\/?pasted_content)/g;

export function unwrapPastedContent(text: string): string {
  if (!text.includes(OPENER)) return text;

  let out = "";
  let emitted = 0;
  let searchFrom = 0;
  let unwrapped = false;
  for (;;) {
    const start = text.indexOf(OPENER, searchFrom);
    if (start === -1) break;
    const idAt = start + OPENER.length;
    const id = text.slice(idAt, idAt + 4);
    if (!ID_RE.test(id) || !text.startsWith('">\n', idAt + 4)) {
      searchFrom = idAt;
      continue;
    }
    const bodyStart = idAt + 4 + 3;
    const closer = `</pasted_content id="${id}">`;
    // Searching from the opener's own newline lets an empty body close at once.
    const closerAt = text.indexOf(`\n${closer}`, bodyStart - 1) + 1;
    if (closerAt === 0) break;

    let before = start;
    for (let i = 0; i < 2 && before > emitted && text[before - 1] === "\n"; i++) before--;
    out += text.slice(emitted, before);
    out += text.slice(bodyStart, closerAt - 1).replace(ESCAPED_TAG_RE, "<");

    let after = closerAt + closer.length;
    for (let i = 0; i < 2 && text[after] === "\n"; i++) after++;
    emitted = after;
    searchFrom = after;
    unwrapped = true;
  }
  return unwrapped ? out + text.slice(emitted) : text;
}
