"use client";

import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, GripVertical } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { type IssueStatusGroup, priorityLabel, sortIssuesByOrder, statusColor } from "@/lib/issue-display";
import { cn } from "@/lib/utils";
import type { Issue, Project } from "@/types";

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface RowProps {
  issue: Issue;
  projectName?: string;
  onClick: () => void;
  /** The grip. Absent when the list is not draggable (the project view). */
  handle?: React.ReactNode;
  className?: string;
}

/** One issue in a list. Also the drag overlay's content, which is why it is
 *  exported: the overlay draws the same row, minus the handle. */
export function IssueRow({ issue, projectName, onClick, handle, className }: RowProps) {
  const priority = priorityLabel(issue.priority);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "flex items-center gap-3 px-4 py-3 border-b last:border-b-0 hover:bg-accent/50 transition-colors cursor-pointer",
        className,
      )}
    >
      {handle}
      <span className="font-mono text-xs text-muted-foreground shrink-0">{issue.key}</span>
      <div className="flex-1 min-w-0">
        <div className="truncate text-sm font-medium">{issue.title}</div>
        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
          {projectName && <span>{projectName}</span>}
          {priority !== "No priority" && <span>{priority}</span>}
          {issue.labels && issue.labels.length > 0 && <span className="truncate">{issue.labels.join(", ")}</span>}
          <span>{timeAgo(issue.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}

function SortableIssueRow({ issue, projectName, onClick }: { issue: Issue; projectName?: string; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: issue.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}>
      <IssueRow
        issue={issue}
        projectName={projectName}
        onClick={onClick}
        handle={
          // A real button so the gesture has something to grab: the row itself is
          // a button too (it opens the issue), and a drag must not be a click.
          <button
            type="button"
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
            title="Drag to reorder"
            aria-label="Drag to reorder"
            className="-ml-2 shrink-0 cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-accent active:cursor-grabbing"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        }
      />
    </div>
  );
}

/** A status heading plus the card its rows live in. While a drag is in flight
 *  it is also a drop target, and the group body is a drop target even with no
 *  rows in it, so an issue can be moved into a status that has none. */
function StatusGroup({
  group,
  project,
  projectNames,
  onIssueClick,
  dragging,
  showEmpty,
}: {
  group: IssueStatusGroup;
  project?: Project;
  projectNames: Map<string, string>;
  onIssueClick: (issue: Issue) => void;
  dragging: boolean;
  showEmpty: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: group.status, data: { status: group.status } });
  if (group.issues.length === 0 && !showEmpty) return null;

  return (
    <div data-testid={`issue-group-${group.status}`}>
      <div className="flex items-center gap-2 mb-1.5 px-1">
        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", statusColor(group.status, project))} />
        <h2 className="text-sm font-semibold">{group.status}</h2>
        <Badge variant="secondary">{group.issues.length}</Badge>
      </div>
      <Card className={cn("py-0 overflow-hidden", dragging && "border-dashed", dragging && isOver && "ring-1 ring-primary")}>
        <CardContent ref={setNodeRef} className="p-0">
          {/* The id is the status: dnd-kit reports it as the hovered item's
              containerId, which is how a drop knows which status it landed in. */}
          <SortableContext id={group.status} items={group.issues.map((issue) => issue.id)} strategy={verticalListSortingStrategy}>
            {group.issues.map((issue) => (
              <SortableIssueRow
                key={issue.id}
                issue={issue}
                projectName={projectNames.get(issue.projectId)}
                onClick={() => onIssueClick(issue)}
              />
            ))}
          </SortableContext>
          {group.issues.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground" data-testid={`issue-group-empty-${group.status}`}>
              Drop here
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export interface IssueListProps {
  /** Every issue the list is allowed to show, any status. */
  issues: Issue[];
  /** Statuses to render, in order. Empty statuses are dropped unless a drag is
   *  in flight, when they become drop targets. */
  statusGroups: IssueStatusGroup[];
  project?: Project;
  projectNames: Map<string, string>;
  onIssueClick: (issue: Issue) => void;
  /** Resolved drop: where it goes and what the list should look like meanwhile. */
  onDrop: (activeKey: string, targetStatus: string, targetIndex: number) => void;
  /** Shown while the server is being told; the row is dragged either way. */
  className?: string;
}

/**
 * The status-grouped list of issues, draggable: reorder inside a group, or drop
 * a row into another group to change its status. Shared by the Issues page and
 * the session header's modal so the two cannot drift.
 */
export function IssueList({ issues, statusGroups, project, projectNames, onIssueClick, onDrop, className }: IssueListProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { delay: 150, tolerance: 5 } }));
  const byId = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);

  const endDrag = useCallback(
    (event: DragEndEvent) => {
      setDraggingId(null);
      const { active, over } = event;
      if (!over) return;

      // `over` is a row while hovering one, and a status name while hovering a
      // group's empty body — the container id is what a drop means either way.
      const overData = over.data.current as { sortable?: { containerId?: string }; status?: string } | undefined;
      const targetStatus = overData?.sortable?.containerId ?? overData?.status;
      if (!targetStatus) return;

      const activeIssue = byId.get(String(active.id));
      if (!activeIssue) return;

      const group = sortIssuesByOrder(issues.filter((issue) => issue.status === targetStatus && issue.id !== activeIssue.id));
      const overIndex = group.findIndex((issue) => issue.id === over.id);
      const targetIndex = overIndex >= 0 ? overIndex : group.length;

      if (targetStatus === activeIssue.status && targetIndex === group.findIndex((i) => i.id === activeIssue.id)) return;
      onDrop(activeIssue.key, targetStatus, targetIndex);
    },
    [byId, issues, onDrop],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(event: DragStartEvent) => setDraggingId(String(event.active.id))}
      onDragEnd={endDrag}
      onDragCancel={() => setDraggingId(null)}
    >
      <div className={cn("space-y-4", className)} data-testid="issue-list">
        {statusGroups.map((group) => (
          <StatusGroup
            key={group.status}
            group={group}
            project={project}
            projectNames={projectNames}
            onIssueClick={onIssueClick}
            dragging={draggingId !== null}
            showEmpty={draggingId !== null}
          />
        ))}
      </div>
      <DragOverlay>
        {draggingId && byId.get(draggingId) ? (
          <div className="rounded-md border bg-card shadow-lg">
            <IssueRow
              issue={byId.get(draggingId) as Issue}
              projectName={projectNames.get((byId.get(draggingId) as Issue).projectId)}
              onClick={() => {}}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/** Chevron + label + count, shared by the page's project and label groups. */
export function GroupHeader({
  open,
  onToggle,
  label,
  count,
  dot,
  className,
  labelClassName,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  count: number;
  dot?: React.ReactNode;
  className?: string;
  labelClassName?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn("flex w-full items-center gap-2 py-3 pr-4 text-left hover:bg-accent/50 transition-colors min-w-0", className)}
    >
      <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      {dot}
      <span className={cn("flex-1 min-w-0 truncate text-sm", labelClassName)}>{label}</span>
      <Badge variant="secondary">{count}</Badge>
    </button>
  );
}
