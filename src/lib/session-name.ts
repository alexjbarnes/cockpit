/** The longest name cockpit derives from a session's first prompt. */
export const SESSION_NAME_MAX_CHARS = 120;

export interface PromptNameCandidate {
  role: "user" | "assistant" | "system";
  content: string;
  /** Claude Code wrote this message itself when a context ran out. It is a
   *  summary of the conversation, not something the user typed. */
  isCompactSummary?: boolean;
}

/**
 * The name a session takes from its first real prompt, or null when the loaded
 * transcript has none. System-generated messages and context compaction
 * summaries are not prompts: a long session's summary can be the oldest user
 * message in the loaded window, and naming a session after its opening words
 * produces a meaningless, truncated title.
 */
export function promptName(messages: readonly PromptNameCandidate[]): string | null {
  const first = messages.find(
    (m) => m.role === "user" && m.content && !m.isCompactSummary && !m.content.startsWith("[") && !m.content.startsWith("<"),
  );
  return first ? first.content.slice(0, SESSION_NAME_MAX_CHARS) : null;
}
