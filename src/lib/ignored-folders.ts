/**
 * The folders whose sessions are hidden from every session list. Matching is
 * purely lexical and case-sensitive: a cwd matches when it is the folder or a
 * descendant at any depth. It never resolves symlinks.
 */

/** Trim and canonicalise a folder path, or undefined when it is not absolute.
 *  `homeDir` is only supplied on the server, where `~` can be expanded. */
export function normaliseFolderPath(raw: string, homeDir?: string): string | undefined {
  let value = raw.trim().replace(/\\/g, "/");
  if (!value) return undefined;
  if (value === "~" || value.startsWith("~/")) {
    if (!homeDir) return undefined;
    const home = homeDir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    value = value === "~" ? home : `${home}/${value.slice(2)}`;
  } else if (value.startsWith("~")) {
    return undefined;
  }
  if (value === "/") return "/";
  if (/^[A-Za-z]:\/$/.test(value)) return value;
  value = value.replace(/\/+$/, "");
  if (!value.startsWith("/") && !/^[A-Za-z]:\//.test(value)) return undefined;
  return value;
}

/** A stored or PATCHed list, cleaned: only absolute strings, no duplicates. */
export function parseIgnoredFolders(value: unknown, homeDir?: string): string[] {
  if (!Array.isArray(value)) return [];
  const folders: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const folder = normaliseFolderPath(item, homeDir);
    if (folder && !folders.includes(folder)) folders.push(folder);
  }
  return folders;
}

/** Is `cwd` the folder itself or anywhere below it? `/a/bc` is not inside
 *  `/a/b`. The root `/` is the deliberate "hide everything" entry and matches
 *  every absolute path, including a Windows drive. */
export function isPathWithin(cwd: string, folder: string): boolean {
  const target = normaliseFolderPath(cwd);
  const root = normaliseFolderPath(folder);
  if (!target || !root) return false;
  if (target === root) return true;
  if (root === "/") return target.startsWith("/") || /^[A-Za-z]:\//.test(target);
  if (root.endsWith("/")) return target.startsWith(root);
  return target.startsWith(`${root}/`);
}

export function isCwdIgnored(cwd: string | undefined, folders: readonly string[] | undefined): boolean {
  if (!cwd || !folders || folders.length === 0) return false;
  return folders.some((folder) => isPathWithin(cwd, folder));
}
