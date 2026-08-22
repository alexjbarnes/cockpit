const DAY_MS = 86_400_000;

function midnight(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Compact, relative timestamp for a chat message, mirroring Paseo's
 * "Sunday 22:27": time-only for today, "Yesterday"/weekday within the last
 * week, day + month (+ year when different) beyond that. 24-hour clock.
 * `now` is injectable for testing.
 */
export function formatMessageTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const daysAgo = Math.round((midnight(now) - midnight(ts)) / DAY_MS);

  if (daysAgo <= 0) return time;
  if (daysAgo === 1) return `Yesterday ${time}`;
  if (daysAgo < 7) return `${d.toLocaleDateString([], { weekday: "long" })} ${time}`;

  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString([], { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
  return `${date} ${time}`;
}

/**
 * "18s" / "2m 5s" / "1h 4m" — a bare elapsed duration. Rounds up to at least
 * 1s, so a turn that has only just started reads as 1s rather than 0s.
 *
 * Shared by the finished-turn label and the live counter beside the spinner,
 * so a turn does not change format the moment it ends.
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;

  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;

  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

/**
 * "Worked for 18s" / "Worked for 2m 5s" / "Worked for 1h 4m" — the elapsed
 * wall-clock of an assistant turn.
 */
export function formatWorkedFor(ms: number): string {
  return `Worked for ${formatDuration(ms)}`;
}
