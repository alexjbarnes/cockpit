// Which issues the workflows are waiting on a person for, and which they are
// working on. The activity view names the issues; the issues themselves carry
// the project, priority, labels and age a row shows, so the two are joined.

import type { WorkflowActivityView } from "@/lib/workflow-display";
import type { Issue } from "@/types";

export interface ActivityIssueSections {
  waiting: Issue[];
  active: Issue[];
}

/**
 * The activity lists as full issues, in two sections. An issue that appears in
 * more than one list (a held issue that also has a run, say) lands in the
 * first: what needs a person wins over what is running.
 */
export function activityIssues(activity: WorkflowActivityView | null | undefined, issues: readonly Issue[]): ActivityIssueSections {
  const byKey = new Map(issues.map((issue) => [issue.key.toUpperCase(), issue]));
  const seen = new Set<string>();
  const take = (rows: { issueKey: string }[] | undefined): Issue[] => {
    const out: Issue[] = [];
    for (const row of rows ?? []) {
      const key = row.issueKey.toUpperCase();
      if (seen.has(key)) continue;
      const issue = byKey.get(key);
      if (!issue) continue;
      seen.add(key);
      out.push(issue);
    }
    return out;
  };
  if (!activity) return { waiting: [], active: [] };
  return {
    waiting: [...take(activity.attention), ...take(activity.waiting)],
    active: [...take(activity.running), ...take(activity.queued)],
  };
}
