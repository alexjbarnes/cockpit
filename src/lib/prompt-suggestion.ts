/** A prompt from the session's history worth offering, and how it relates to
 *  what is typed. `prefix` means the typed text is a true prefix, so accepting
 *  appends the rest; otherwise the match was fuzzy and accepting replaces the
 *  text with the whole prompt. */
export interface PromptSuggestion {
  prompt: string;
  prefix: boolean;
}

/** One character matches too much to be useful. */
const MIN_TEXT_LENGTH = 2;

/** A repeatable command is short. Long prose is a one-off task, not a prompt
 *  worth predicting, so it is never offered however well it matches. */
const MAX_LENGTH = 80;
const MAX_WORDS = 8;
const MAX_LINES = 2;

/** First words that read as an instruction. A match on one of these outranks
 *  an equally good match on something that does not. */
const COMMAND_VERBS = new Set([
  "accept",
  "add",
  "amend",
  "approve",
  "build",
  "bump",
  "check",
  "cherry-pick",
  "clean",
  "clear",
  "close",
  "commit",
  "compact",
  "continue",
  "create",
  "delete",
  "deploy",
  "document",
  "draft",
  "fetch",
  "fix",
  "format",
  "implement",
  "install",
  "land",
  "lint",
  "look",
  "make",
  "merge",
  "move",
  "open",
  "pin",
  "polish",
  "prep",
  "prepare",
  "publish",
  "pull",
  "push",
  "raise",
  "rebase",
  "release",
  "remove",
  "rename",
  "reopen",
  "replace",
  "restart",
  "retry",
  "revert",
  "review",
  "run",
  "send",
  "set",
  "ship",
  "simplify",
  "split",
  "squash",
  "stage",
  "start",
  "stop",
  "stash",
  "summarise",
  "summarize",
  "sync",
  "tag",
  "test",
  "tidy",
  "try",
  "unpin",
  "unstage",
  "update",
  "upgrade",
  "write",
]);

function normalise(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Whether a prompt looks like something worth repeating: short, not a
 *  question, not a paragraph, not pasted content. */
function isRepeatable(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < MIN_TEXT_LENGTH || trimmed.length > MAX_LENGTH) return false;
  if (trimmed.split("\n").length > MAX_LINES) return false;
  if (trimmed.includes("```") || /https?:\/\//.test(trimmed)) return false;
  if (/[?!]\s*$/.test(trimmed)) return false;
  // A sentence boundary followed by more text is prose.
  if (/[.!?]\s+\S/.test(trimmed)) return false;
  return normalise(trimmed).split(" ").length <= MAX_WORDS;
}

/** True when a and b differ by at most one insertion, deletion or
 *  substitution. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  edits += a.length - i + (b.length - j);
  return edits <= 1;
}

/** Score a typed text against one prompt: 100 for a prefix, lower for a word
 *  match (with a penalty for skipped filler words), lower still for a single
 *  typo in the prefix. Null when there is no match. */
function matchScore(text: string, prompt: string): { score: number; prefix: boolean } | null {
  if (text.length >= prompt.length) return null;

  // Smartcase, as before: a lowercase prefix ignores the history's casing, a
  // capital makes it case-sensitive.
  const caseSensitive = text !== text.toLowerCase();
  const prefix = caseSensitive ? prompt.startsWith(text) : prompt.toLowerCase().startsWith(text.toLowerCase());
  if (prefix) return { score: 100, prefix: true };
  // A capital is deliberate: keep the old smartcase rule and do not fuzzy
  // match across it, so accepting never rewrites the typed casing.
  if (caseSensitive) return null;

  const typedTokens = normalise(text).split(" ").filter(Boolean);
  const promptTokens = normalise(prompt).split(" ").filter(Boolean);
  let index = 0;
  let skipped = 0;
  let matched = 0;
  for (const token of typedTokens) {
    let found = -1;
    for (let i = index; i < promptTokens.length; i++) {
      if (promptTokens[i].startsWith(token)) {
        found = i;
        break;
      }
      skipped++;
    }
    if (found === -1) break;
    matched++;
    index = found + 1;
  }
  if (matched === typedTokens.length) {
    const coverage = matched / promptTokens.length;
    return { score: 40 + coverage * 30 - skipped * 2, prefix: false };
  }

  // A single typo in the start of the prompt, e.g. "comit" for "commit".
  const typed = normalise(text);
  const start = normalise(prompt);
  if (typed.length >= 3) {
    for (const length of [typed.length, typed.length + 1]) {
      if (withinOneEdit(typed, start.slice(0, length))) return { score: 50, prefix: false };
    }
  }
  return null;
}

/** The history entry worth completing `text` with, or null when none is.
 *
 *  History is newest-first. Candidates are filtered to short, repeatable
 *  prompts (long prose is a one-off, not a pattern), scored by how well they
 *  match, with a bonus for an imperative first word. A prefix beats a fuzzy
 *  match; among equals the newest wins. */
export function suggestCompletion(text: string, history: readonly string[]): PromptSuggestion | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH) return null;

  let best: { suggestion: PromptSuggestion; score: number } | null = null;
  for (const prompt of history) {
    if (!isRepeatable(prompt)) continue;
    const match = matchScore(trimmed, prompt);
    if (!match) continue;
    const first = normalise(prompt).split(" ")[0] ?? "";
    const score = match.score + (COMMAND_VERBS.has(first) ? 20 : 0);
    if (!best || score > best.score) {
      best = { suggestion: { prompt, prefix: match.prefix }, score };
    }
  }
  return best?.suggestion ?? null;
}
