"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { useWorkflowFlows, WorkflowFlowsProvider } from "@/components/issues/issue-flow";
import { RefreshOnFlow } from "@/components/issues/refresh-on-flow";
import { WorkflowIssueSection } from "@/components/issues/workflow-issue-section";
import { IssuesWorkflowsSwitch } from "@/components/nav/place-switch";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/hooks/use-settings";
import { activityIssues } from "@/lib/workflow-issues";
import type { Issue, Project } from "@/types";

/**
 * The Workflows side of Issues: what the workflows are waiting on you for, and
 * what they are working on. Its settings are their own page, reached from the
 * button at the top.
 */
export default function WorkflowsPage() {
  const headerActions = useMemo(() => <IssuesWorkflowsSwitch side="workflows" />, []);
  usePageHeader("Workflows", { hideActions: true, actions: headerActions });
  const router = useRouter();
  const { settings, loaded } = useSettings();

  useEffect(() => {
    if (loaded && !settings.issuesEnabled) router.replace("/");
  }, [loaded, settings.issuesEnabled, router]);

  if (!loaded || !settings.issuesEnabled) return null;
  return (
    <WorkflowFlowsProvider enabled={settings.workflowsEnabled}>
      <WorkflowsBody />
    </WorkflowFlowsProvider>
  );
}

function WorkflowsBody() {
  const router = useRouter();
  const { activity } = useWorkflowFlows();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  const load = useCallback(async () => {
    const [issuesRes, projectsRes] = await Promise.all([
      fetch("/api/issues")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch("/api/projects")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);
    if (issuesRes) setIssues(issuesRes.issues ?? []);
    if (projectsRes) setProjects(projectsRes.projects ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const { waiting, active } = useMemo(() => activityIssues(activity, issues), [activity, issues]);
  const openIssue = useCallback((issue: Issue) => router.push(`/issues/${encodeURIComponent(issue.key)}`), [router]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="max-w-3xl mx-auto space-y-4 pb-8">
        <RefreshOnFlow onChange={load} />
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" data-testid="workflows-settings" onClick={() => router.push("/settings/workflows")}>
            Workflow settings
          </Button>
        </div>
        <WorkflowIssueSection
          title="Waiting on you"
          dotClassName="bg-amber-500"
          issues={waiting}
          projectNames={projectNames}
          emptyText="Nothing is waiting on you."
          testId="workflows-waiting"
          onOpenIssue={openIssue}
        />
        <WorkflowIssueSection
          title="Active"
          dotClassName="bg-blue-500"
          issues={active}
          projectNames={projectNames}
          emptyText="Nothing is running or queued."
          testId="workflows-active"
          onOpenIssue={openIssue}
        />
      </div>
    </div>
  );
}
