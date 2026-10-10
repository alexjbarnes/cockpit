/**
 * Which dot the cockpit assistant's footer button shows — the same states a
 * session row shows, so the assistant stops going quiet while its modal is
 * closed.
 *
 * Precedence matters: a pending question or permission prompt is the state that
 * needs the user, so it outranks a running turn, which outranks a turn that
 * ended unseen. Idle and read is no dot at all.
 */
export type AssistantDot = "pending" | "working" | "unread";

export function assistantDot(state: { status: "idle" | "running"; pendingRequestCount: number; unread: boolean }): AssistantDot | null {
  if (state.pendingRequestCount > 0) return "pending";
  if (state.status === "running") return "working";
  if (state.unread) return "unread";
  return null;
}
