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

export interface SessionNameSources {
  /** A name the user set, in Cockpit or Claude Code. It always wins. */
  userTitle?: string | null;
  /** The title Claude Code stores in the transcript. */
  aiTitle?: string | null;
  /** The first real prompt, from promptName. */
  prompt?: string | null;
  /** The session folder's basename. */
  folder: string;
}

/** The name to show for a session: user, then Claude Code's title, then the
 *  first prompt, then the folder. */
export function sessionName({ userTitle, aiTitle, prompt, folder }: SessionNameSources): string {
  for (const candidate of [userTitle, aiTitle, prompt, folder]) {
    const value = candidate?.trim();
    if (value) return value.length > SESSION_NAME_MAX_CHARS ? value.slice(0, SESSION_NAME_MAX_CHARS) : value;
  }
  return "Session";
}

/** Whether a stored name was chosen by the user rather than being the default
 *  the session was born with. Sessions persist their folder name at creation,
 *  so an equal name cannot be told apart from "no name chosen". */
export function isUserSetName(name: string | null | undefined, folder: string): boolean {
  const value = name?.trim();
  return !!value && value !== folder;
}

/** The name for a session with both a transcript scan and an in-memory entry:
 *  a name the user set, then what the scan found, then the memory entry. The
 *  memory entry is often just the folder's basename, and must not overwrite a
 *  title the transcript already has. */
export function scannedSessionName(scannedName: string | undefined, memoryName: string | undefined, userTitle?: string | null): string {
  const scanned = scannedName && scannedName !== "Untitled session" ? scannedName.trim() : null;
  return sessionName({ userTitle, prompt: scanned, folder: memoryName?.trim() || "Session" });
}
