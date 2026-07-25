/**
 * Human label for the jobs a cockpit-config job tool targets, used as the
 * suffix on the approval card's title. Without it the card showed a bare uuid,
 * which tells the user nothing about what they are about to approve.
 *
 * Covers every argument shape the job tools accept: a single `id` (stop_job and
 * the simple form of the others), the `ids` array run_job and delete_job take,
 * and the `updates` array update_job takes. Ids that no longer resolve to a job
 * are dropped rather than shown raw, so a stale id degrades to the plain title
 * instead of putting a uuid back on screen.
 *
 * @param lookupName resolves a job id to its name, or undefined if it is gone.
 */
export function describeJobTargets(input: unknown, lookupName: (id: string) => string | undefined): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const source = input as Record<string, unknown>;

  const ids: string[] = [];
  if (typeof source.id === "string") ids.push(source.id);
  if (Array.isArray(source.ids)) {
    ids.push(...source.ids.filter((v): v is string => typeof v === "string"));
  }
  if (Array.isArray(source.updates)) {
    for (const entry of source.updates) {
      const id = (entry as Record<string, unknown> | null)?.id;
      if (typeof id === "string") ids.push(id);
    }
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const name = lookupName(id);
    if (name) names.push(name);
  }

  if (names.length === 0) return undefined;
  if (names.length <= 2) return names.join(", ");
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
