/**
 * The page modal: with the experimental `modalPagesEnabled` setting on, the
 * sidebar footer's pages (jobs, inbox, issues, settings) open in a modal over
 * the current page instead of replacing it. The modal shows the real page in
 * an iframe, and the document inside talks to the one outside through
 * postMessage.
 */

/** The modal's iframe name. Set on the frame, it marks the document inside as
 *  embedded for its whole life, through every navigation made within it. */
export const PAGE_MODAL_FRAME_NAME = "cockpit-page-modal";

/** Sections the modal shows, by first path segment: the footer's pages and the
 *  ones their pages link to. Anything else, such as a session, the home page or
 *  a review, opens in the main window. */
const MODAL_SECTIONS = new Set([
  "jobs",
  "inbox",
  "issues",
  "settings",
  "agents",
  "commands",
  "hooks",
  "skills",
  "mcp-servers",
  "plugins",
  "claude-md",
]);

export function isModalPath(pathname: string): boolean {
  return MODAL_SECTIONS.has(pathname.split("/")[1] ?? "");
}

/** From the embedded document to the window holding the modal. */
export type PageModalMessage = { type: "ready" } | { type: "close" } | { type: "open-in-app"; url: string };

const SOURCE = "cockpit-page-modal";

export function pageModalMessage(msg: PageModalMessage): PageModalMessage & { source: string } {
  return { source: SOURCE, ...msg };
}

/** The message, or null for anything else a window might be sent. A url must
 *  be a path on this origin. */
export function parsePageModalMessage(data: unknown): PageModalMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.source !== SOURCE) return null;
  if (d.type === "ready" || d.type === "close") return { type: d.type };
  if (d.type === "open-in-app" && typeof d.url === "string" && d.url.startsWith("/") && !d.url.startsWith("//")) {
    return { type: "open-in-app", url: d.url };
  }
  return null;
}
