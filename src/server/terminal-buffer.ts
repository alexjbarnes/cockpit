export const MAX_BUFFER = 100 * 1024;

// Appends PTY output to a terminal's sliding-window buffer, keeping detachOffset
// pointing at the same stream position when the front of the buffer is trimmed.
export function appendToBuffer(state: { buffer: string; detachOffset: number }, data: string, maxBuffer = MAX_BUFFER): void {
  state.buffer += data;
  if (state.buffer.length > maxBuffer) {
    const trimmed = state.buffer.length - maxBuffer; // measure BEFORE slicing
    state.buffer = state.buffer.slice(-maxBuffer);
    if (state.detachOffset > 0) {
      state.detachOffset = Math.max(0, state.detachOffset - trimmed);
    }
  }
}
