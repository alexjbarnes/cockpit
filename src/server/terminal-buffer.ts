// A terminal's replay buffer is the raw PTY stream, not just its text:
// progress bars spend thousands of bytes on carriage-return updates for one
// visible line, and a long command can fill the buffer with output the
// emulator later overwrites. 100KB was too small for a long `brew upgrade`,
// whose scrollback was trimmed away until only the final progress line was
// left. 2MB covers 10,000 lines of ordinary output, the largest scrollback
// the settings offer.
export const MAX_BUFFER = 2 * 1024 * 1024;

// Appends PTY output to a terminal's sliding-window buffer, keeping detachOffset
// pointing at the same stream position when the front of the buffer is trimmed.
export function appendToBuffer(state: { buffer: string; detachOffset: number }, data: string, maxBuffer = MAX_BUFFER): void {
  state.buffer += data;
  if (state.buffer.length > maxBuffer) {
    let cut = state.buffer.length - maxBuffer; // measure BEFORE slicing
    // Start a trimmed replay on a line boundary when one is close, so it does
    // not begin in the middle of an escape sequence or a character. A cut
    // already sitting just after a newline is a boundary; leave it.
    if (cut > 0 && state.buffer[cut - 1] !== "\n") {
      const newline = state.buffer.indexOf("\n", cut);
      if (newline !== -1 && newline - cut < 4096 && newline + 1 < state.buffer.length) {
        cut = newline + 1;
      }
    }
    // Never split a surrogate pair.
    const code = state.buffer.charCodeAt(cut);
    if (code >= 0xdc00 && code <= 0xdfff) cut++;
    const trimmed = cut;
    state.buffer = state.buffer.slice(cut);
    if (state.detachOffset > 0) {
      state.detachOffset = Math.max(0, state.detachOffset - trimmed);
    }
  }
}
