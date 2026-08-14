import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getClaudeDir, getCockpitDir } from "@/server/paths";

/**
 * The sidebar's pinned session and review lists.
 *
 * These are cockpit's own state and used to live under the CLI's directory
 * (`~/.claude/cockpit/`), the only two things that did. Two consequences, both
 * real: uninstalling or relocating Claude took cockpit's sidebar with it, and
 * because `COCKPIT_CONFIG_DIR` does not reach into the Claude dir, a test run
 * read and rewrote the developer's actual pinned lists.
 *
 * They now live in `getCockpitDir()` alongside everything else cockpit owns,
 * with a one-way migration on read.
 */
export type PinnedList = "pinned_sessions.json" | "pinned_reviews.json";

function currentFile(list: PinnedList): string {
  return path.join(getCockpitDir(), list);
}

/** Where these lived before this moved. Read once, never written again. */
function legacyFile(list: PinnedList): string {
  return path.join(getClaudeDir(), "cockpit", list);
}

async function readList(file: string): Promise<string[] | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8"));
    // A hand-edited or truncated file must not throw a 500 at the caller: an
    // unreadable list is the same as no list, which is what it was before.
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return null;
  }
}

/**
 * Read a pinned list, migrating it out of the Claude dir on first sight.
 *
 * The old file is copied, not moved, and never deleted: a user who drops back
 * to an older cockpit still finds their pins where that version looks. The
 * copy is best effort — failing it costs an empty sidebar section, which is not
 * worth failing the request over.
 */
export async function readPinned(list: PinnedList): Promise<string[]> {
  const current = await readList(currentFile(list));
  if (current !== null) return current;

  const legacy = await readList(legacyFile(list));
  if (legacy === null) return [];

  try {
    await mkdir(getCockpitDir(), { recursive: true });
    await copyFile(legacyFile(list), currentFile(list));
  } catch {
    // Fall through: the list is still returned, and the next read tries again.
  }
  return legacy;
}

export async function writePinned(list: PinnedList, ids: string[]): Promise<void> {
  const file = currentFile(list);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(ids, null, 2)}\n`);
}
