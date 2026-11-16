// Which sessions have a reply the user has not seen: a localStorage set, read
// by the sidebar's rows and written when a turn ends unseen. The assistant is
// an ordinary session here; its own provider reads and writes the same set.

const UNREAD_KEY = "cockpit_unread_sessions";

export function getUnreadSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(UNREAD_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

export function addUnreadSession(id: string): void {
  const set = getUnreadSessions();
  set.add(id);
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify([...set]));
  } catch {}
}

export function clearUnreadSession(id: string): void {
  const set = getUnreadSessions();
  set.delete(id);
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify([...set]));
  } catch {}
}
