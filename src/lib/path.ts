export function pathBasename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
}

export function pathDirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? "" : p.slice(0, i);
}

export function shortPath(filePath: string, maxParts = 3): string {
  const parts = filePath.split(/[/\\]/);
  if (parts.length <= maxParts) return filePath;
  return ".../" + parts.slice(-2).join("/");
}

export function splitPathSegments(p: string): string[] {
  return p.split(/[/\\]/).filter(Boolean);
}
