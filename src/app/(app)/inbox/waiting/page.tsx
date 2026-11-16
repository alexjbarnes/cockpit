"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { useWorkflowFlows, WorkflowFlowsProvider } from "@/components/issues/issue-flow";
import { RefreshOnFlow } from "@/components/issues/refresh-on-flow";
import { WorkflowIssueSection } from "@/components/issues/workflow-issue-section";
import { InboxSwitch } from "@/components/nav/place-switch";
import { useSettings } from "@/hooks/use-settings";
import { activityIssues } from "@/lib/workflow-issues";
import type { Issue, Project } from "@/types";

/** The Inbox's second side: the workflow issues waiting on a decision from
 *  you, the same rows the Issues list uses. */
export default function InboxWaitingPage() {
  const headerActions = useMemo(() => <InboxSwitch side="waiting" />, []);
  usePageHeader("Inbox", { hideActions: true, actions: headerActions });
  const router = useRouter();
  const { settings, loaded } = useSettings();

  useEffect(() => {
    if (loaded && !settings.issuesEnabled) router.replace("/inbox");
  }, [loaded, settings.issuesEnabled, router]);

  if (!loaded || !settings.issuesEnabled) return null;
  return (
    <WorkflowFlowsProvider enabled={settings.workflowsEnabled}>
      <WaitingBody />
    </WorkflowFlowsProvider>
  );
}

function WaitingBody() {
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
  const { waiting } = useMemo(() => activityIssues(activity, issues), [activity, issues]);
  const openIssue = useCallback((issue: Issue) => router.push(`/issues/${encodeURIComponent(issue.key)}`), [router]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="max-w-3xl mx-auto space-y-4 pb-8">
        <RefreshOnFlow onChange={load} />
        <WorkflowIssueSection
          title="Waiting on you"
          dotClassName="bg-amber-500"
          issues={waiting}
          projectNames={projectNames}
          emptyText="Nothing is waiting on you."
          testId="inbox-waiting"
          onOpenIssue={openIssue}
        />
      </div>
    </div>
  );
}
