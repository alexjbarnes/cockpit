"use client";

import {
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
import { useMemo, useState } from "react";
import { boardColumns, dropIndex, sortIssuesByOrder } from "@/lib/issue-display";
import { cn } from "@/lib/utils";
import type { Issue, Project } from "@/types";

function priorityStripe(priority?: number): string | null {
  if (priority === 1) return "bg-red-500";
  if (priority === 2) return "bg-orange-500";
  if (priority === 3) return "bg-amber-500";
  return null;
}

function IssueCard({ issue, projectName }: { issue: Issue; projectName?: string }) {
  const stripe = priorityStripe(issue.priority);
  return (
    <div className="relative rounded-md border bg-card p-2.5 text-left shadow-sm">
      {stripe && <span className={cn("absolute left-0 top-0 h-full w-1 rounded-l-md", stripe)} />}
      <div className="pl-1">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="font-mono">{issue.key}</span>
          {projectName && <span className="truncate">· {projectName}</span>}
        </div>
        <p className="mt-0.5 text-xs font-medium leading-snug line-clamp-3">{issue.title}</p>
      </div>
    </div>
  );
}

function SortableCard({ issue, projectName, onClick }: { issue: Issue; projectName?: string; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: issue.id,
    data: { status: issue.status },
  });
  return (
    <button
      type="button"
      ref={setNodeRef}
      data-testid={`board-card-${issue.key}`}
      onClick={onClick}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("w-full cursor-grab active:cursor-grabbing touch-none", isDragging && "opacity-40")}
      {...listeners}
      {...attributes}
    >
      <IssueCard issue={issue} projectName={projectName} />
    </button>
  );
}

function Column({
  name,
  color,
  issues,
  projectNames,
  showProject,
  onIssueClick,
}: {
  name: string;
  color: string;
  issues: Issue[];
  projectNames: Map<string, string>;
  showProject: boolean;
  onIssueClick: (issue: Issue) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: name });
  return (
    <div className="flex w-72 shrink-0 flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", color)} />
        <h3 className="truncate text-sm font-semibold">{name}</h3>
        <span className="text-xs text-muted-foreground">{issues.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-2 rounded-lg border border-dashed p-2 transition-colors",
          isOver ? "border-primary bg-primary/5" : "border-transparent bg-muted/30",
        )}
      >
        <SortableContext id={name} items={issues.map((issue) => issue.id)} strategy={verticalListSortingStrategy}>
          {issues.map((issue) => (
            <SortableCard
              key={issue.id}
              issue={issue}
              projectName={showProject ? projectNames.get(issue.projectId) : undefined}
              onClick={() => onIssueClick(issue)}
            />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}

export function KanbanBoard({
  issues,
  project,
  projectNames,
  showProject,
  onIssueClick,
  onDrop,
}: {
  issues: Issue[];
  project?: Project;
  projectNames: Map<string, string>;
  showProject: boolean;
  onIssueClick: (issue: Issue) => void;
  /** A card dropped at a position in a column (or in another column, which is
   *  a status change too). The page applies it optimistically and PUTs; the
   *  board only reports the drop. `index` counts the target column without the
   *  dragged card, like the list's. */
  onDrop: (key: string, toStatus: string, index: number) => void;
}) {
  const [dragging, setDragging] = useState<Issue | null>(null);
  // 5px activation distance so a plain click still opens the issue rather than
  // starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const columns = useMemo(() => boardColumns(issues, project), [issues, project]);
  const byStatus = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const issue of issues) {
      const list = map.get(issue.status);
      if (list) list.push(issue);
      else map.set(issue.status, [issue]);
    }
    // The order inside a column is the manual one, the same sequence the list
    // shows, so a card dropped between two others means the same thing in both.
    for (const [status, list] of map) map.set(status, sortIssuesByOrder(list));
    return map;
  }, [issues]);

  function handleStart(e: DragStartEvent): void {
    setDragging(issues.find((i) => i.id === e.active.id) ?? null);
  }
  function handleEnd(e: DragEndEvent): void {
    setDragging(null);
    const { over } = e;
    if (!over) return;
    const issue = issues.find((i) => i.id === e.active.id);
    if (!issue) return;

    // `over` is a card while hovering one and the column itself while hovering
    // its empty space; the status is the card's container either way.
    const data = over.data.current as { sortable?: { containerId?: string }; status?: string } | undefined;
    const targetStatus = data?.sortable?.containerId ?? data?.status ?? (typeof over.id === "string" ? over.id : undefined);
    if (!targetStatus) return;

    // The hovered card's place in its column as shown, taken with the dragged
    // card still in it (see dropIndex): an index from the column without it is
    // a row short on every downward drag. Null means the drop was on the
    // column's own body, which is the end of it.
    const column = sortIssuesByOrder(issues.filter((i) => i.status === targetStatus && i.id !== issue.id));
    const overIndex = dropIndex(issues, targetStatus, String(over.id));
    if (overIndex === null && targetStatus === issue.status && issue.order === undefined) {
      // Dropped back where it started at the end of its own column: nothing to do.
      return;
    }
    onDrop(issue.key, targetStatus, overIndex ?? column.length);
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleStart} onDragEnd={handleEnd} onDragCancel={() => setDragging(null)}>
      <div className="flex gap-3 overflow-x-auto pb-4">
        {columns.map((col) => (
          <Column
            key={col.name}
            name={col.name}
            color={col.color}
            issues={byStatus.get(col.name) ?? []}
            projectNames={projectNames}
            showProject={showProject}
            onIssueClick={onIssueClick}
          />
        ))}
      </div>
      <DragOverlay>
        {dragging ? (
          <div className="w-72">
            <IssueCard issue={dragging} projectName={showProject ? projectNames.get(dragging.projectId) : undefined} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
