"use client";

import { useRouter } from "next/navigation";
import { Segmented } from "@/components/ui/segmented";

/** Issues and Workflows are the two sides of one place. The switch is the
 *  page's own header control; each side is a route, so Back and links work. */
export function IssuesWorkflowsSwitch({ side }: { side: "issues" | "workflows" }) {
  const router = useRouter();
  return (
    <Segmented
      variant="switch"
      label="Issues and workflows"
      testId="issues-workflows-switch"
      value={side}
      options={[
        { value: "issues", label: "Issues" },
        { value: "workflows", label: "Workflows" },
      ]}
      onChange={(v) => router.push(v === "workflows" ? "/workflows" : "/issues")}
    />
  );
}

/** Inbox and the workflow issues waiting on you, the same way round. */
export function InboxSwitch({ side }: { side: "inbox" | "waiting" }) {
  const router = useRouter();
  return (
    <Segmented
      variant="switch"
      label="Inbox and what is waiting on you"
      testId="inbox-switch"
      value={side}
      options={[
        { value: "inbox", label: "Inbox" },
        { value: "waiting", label: "Waiting on you" },
      ]}
      onChange={(v) => router.push(v === "waiting" ? "/inbox/waiting" : "/inbox")}
    />
  );
}
