// Telling a link to one of Cockpit's own pages from a link to anywhere else.

/** The first path segment of every page the app has (the folders of src/app/(app)). */
const APP_SECTIONS = new Set([
  "agents",
  "claude-md",
  "commands",
  "hooks",
  "inbox",
  "insights",
  "issues",
  "jobs",
  "more",
  "mcp-servers",
  "plugins",
  "reviews",
  "sessions",
  "settings",
  "workflows",
  "skills",
]);

/**
 * Whether an href written in Markdown is a page of Cockpit itself, such as
 * the `/issues/CK-12` an inbox message links to. Such a link is followed in
 * the app. Anything else opens in a new tab: another site, and also a path
 * that only looks local, like the `/home/me/file.ts` an agent writes about,
 * which is no page of ours.
 */
export function isAppPath(href: string | null | undefined): boolean {
  if (!href?.startsWith("/") || href.startsWith("//")) return false;
  return APP_SECTIONS.has(href.split(/[/?#]/)[1] ?? "");
}
