// The places the app has, for the navigation: one item per place, and each
// place remembers the screen you last had open in it. Kept apart from the
// components so the rules can be tested without a browser.

export type Place = "sessions" | "issues" | "inbox" | "jobs" | "insights" | "reviews" | "settings";

/** Everything the navigation points at: the places, and the phone's More page. */
export type NavPlace = Place | "more";

/** The first screen of each place: where its item goes when you are already
 *  there. Sessions' first screen is the pinned list, not the folder overview
 *  of every session, which is reached from it. */
export const PLACE_ROOTS: Record<Place, string> = {
  sessions: "/sessions",
  issues: "/issues",
  inbox: "/inbox",
  jobs: "/jobs",
  insights: "/insights",
  reviews: "/reviews",
  settings: "/settings",
};

/** Top-level pages that belong to the Settings place (they are reached from it). */
const SETTINGS_PAGES = new Set(["agents", "claude-md", "commands", "hooks", "mcp-servers", "plugins", "skills"]);

/**
 * Which place a pathname belongs to, or null for a page the navigation does
 * not own. Workflows is the second side of Issues and Waiting the second side
 * of Inbox, so they belong to those places.
 */
export function placeForPathname(pathname: string): NavPlace | null {
  const first = pathname.split(/[?#]/)[0].split("/")[1] ?? "";
  switch (first) {
    case "":
    case "sessions":
      return "sessions";
    case "issues":
    case "workflows":
      return "issues";
    case "inbox":
      return "inbox";
    case "jobs":
      return "jobs";
    case "insights":
      return "insights";
    case "reviews":
      return "reviews";
    case "settings":
      return "settings";
    case "more":
      return "more";
    default:
      return SETTINGS_PAGES.has(first) ? "settings" : null;
  }
}

/** Whether a pathname is worth remembering as its place's last screen. The
 *  More page is not a place, so it is not. */
export function isRememberedPath(pathname: string): boolean {
  const place = placeForPathname(pathname);
  return place !== null && place !== "more";
}

/** The sessionStorage key holding a place's last screen. */
export function memoryKey(place: Place): string {
  return `cockpit_last_${place}`;
}

/** The two sides of the Issues place. They are its list screens; an issue's
 *  own page is a detail of the place, not a side, so opening one does not
 *  change which side you are on. */
export type IssuesSide = "issues" | "workflows";

const ISSUES_SIDE_KEY = "cockpit_issues_side";

/** Where each side of the Issues place lives. */
export const ISSUES_SIDE_ROOTS: Record<IssuesSide, string> = {
  issues: PLACE_ROOTS.issues,
  workflows: "/workflows",
};

/** The side a pathname names, or null for any other screen. */
export function issuesSideForPath(pathname: string): IssuesSide | null {
  if (pathname === "/issues") return "issues";
  if (pathname === "/workflows") return "workflows";
  return null;
}

/** The Issues side to open: the one you last had, else the list. */
export function readIssuesSide(): IssuesSide {
  if (typeof window === "undefined") return "issues";
  try {
    return sessionStorage.getItem(ISSUES_SIDE_KEY) === "workflows" ? "workflows" : "issues";
  } catch {
    return "issues";
  }
}

/** Record the side a pathname shows, when it shows one. */
export function rememberIssuesSide(pathname: string): void {
  const side = issuesSideForPath(pathname);
  if (!side) return;
  try {
    sessionStorage.setItem(ISSUES_SIDE_KEY, side);
  } catch {
    // A private window with storage off simply gets no memory.
  }
}

/**
 * A stored path, if it is still a screen of `place`: the stored value may name
 * a page that has moved or been removed since, and a stale one must not send
 * the navigation somewhere odd.
 */
export function validRemembered(place: Place, stored: string | null): string | null {
  if (!stored) return null;
  return placeForPathname(stored) === place && isRememberedPath(stored) ? stored : null;
}

/** The remembered screen of a place, or null. */
export function readRemembered(place: Place): string | null {
  if (typeof window === "undefined") return null;
  try {
    return validRemembered(place, sessionStorage.getItem(memoryKey(place)));
  } catch {
    return null;
  }
}

/** Where pressing a place's item goes: its first screen when you are already
 *  in that place, else the screen you last had there, else its first screen. */
export function resolvePlaceTarget(place: Place, current: NavPlace | null, remembered: string | null): string {
  if (current === place) return PLACE_ROOTS[place];
  return validRemembered(place, remembered) ?? PLACE_ROOTS[place];
}
