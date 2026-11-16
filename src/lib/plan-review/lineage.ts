// Which versions belong to the same plan. A session keeps every plan it
// proposes in one numbered list, and it can plan one thing, finish it, and
// plan something else: the second plan is the next number, but it is not a
// revision of the first, and showing it as a diff of the first says it is.

import type { PlanVersion } from "./types";

/** Share of the smaller text's lines that the other must also have before two
 *  texts with different titles count as one plan. A revision keeps most of its
 *  lines; two plans share the odd stock sentence. */
const SAME_PLAN_SHARE = 0.2;

/** A plan's title: its first top-level heading. A lower heading is a section,
 *  and two plans that both open with "Context" are not thereby one plan. */
export function planTitle(content: string): string {
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(content);
  return heading ? heading[1].trim() : "";
}

/** The lines that make a plan this plan: headings are left out, since every
 *  plan has a Context and a Verification. */
function bodyLines(content: string): Set<string> {
  const lines = new Set<string>();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line !== "" && !line.startsWith("#")) lines.add(line);
  }
  return lines;
}

/** Whether `next` is `previous` revised, and not a plan for something else. */
export function isRevision(previous: string, next: string): boolean {
  const before = planTitle(previous);
  if (before !== "" && before.toLowerCase() === planTitle(next).toLowerCase()) return true;
  const a = bodyLines(previous);
  const b = bodyLines(next);
  const smaller = Math.min(a.size, b.size);
  if (smaller === 0) return false;
  let shared = 0;
  for (const line of b) if (a.has(line)) shared++;
  return shared / smaller >= SAME_PLAN_SHARE;
}

/**
 * For each version, the number of the first version of the plan it belongs
 * to. Worked out from the texts in order, so records written before plans
 * were told apart come out right without being rewritten.
 */
export function planRoots(versions: readonly Pick<PlanVersion, "n" | "content">[]): number[] {
  const roots: number[] = [];
  for (let i = 0; i < versions.length; i++) {
    const revised = i > 0 && isRevision(versions[i - 1].content, versions[i].content);
    roots.push(revised ? roots[i - 1] : versions[i].n);
  }
  return roots;
}
