"use client";

import { IssueRow } from "@/components/issues/issue-list";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types";

interface WorkflowIssueSectionProps {
  title: string;
  /** The colour of the heading's dot: amber for what needs you, blue for what is running. */
  dotClassName: string;
  issues: Issue[];
  projectNames: Map<string, string>;
  emptyText: string;
  testId: string;
  onOpenIssue: (issue: Issue) => void;
}

/** A heading and the issue rows under it, the same rows the issues list uses. */
export function WorkflowIssueSection({
  title,
  dotClassName,
  issues,
  projectNames,
  emptyText,
  testId,
  onOpenIssue,
}: WorkflowIssueSectionProps) {
  return (
    <section data-testid={testId}>
      <div className="flex items-center gap-2 mb-1.5 px-1">
        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dotClassName)} />
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          {issues.length}
        </div>
      </div>
      {issues.length === 0 ? (
        <p className="text-sm text-muted-foreground px-1 py-2" data-testid={`${testId}-empty`}>
          {emptyText}
        </p>
      ) : (
        <Card className="py-0 overflow-hidden">
          <CardContent className="p-0">
            {issues.map((issue) => (
              <IssueRow key={issue.key} issue={issue} projectName={projectNames.get(issue.projectId)} onClick={() => onOpenIssue(issue)} />
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
