"use client";

import { useEffect, useRef } from "react";
import { useWorkflowFlows } from "@/components/issues/issue-flow";

/** Reads the issues again when the workflows moved something: a run started
 *  or ended, or an issue was held. Their statuses changed with it. */
export function RefreshOnFlow({ onChange }: { onChange: () => void }) {
  const { activity } = useWorkflowFlows();
  const mark = activity
    ? [activity.running, activity.queued, activity.waiting, activity.attention]
        .map((list) => list.map((r) => r.issueKey).join(","))
        .join("|")
    : "";
  const seen = useRef(mark);
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    if (seen.current === mark) return;
    const first = seen.current === "";
    seen.current = mark;
    if (!first) changed.current();
  }, [mark]);
  return null;
}
