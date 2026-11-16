"use client";

import { AlertTriangle, ArrowRight, Bot, ChevronRight, CircleDashed, Clock, User } from "lucide-react";
import { describeProviderModel } from "@/lib/models";
import { cn } from "@/lib/utils";
import { agentSummary, ruleProblem, type StatusRow, trackStops } from "@/lib/workflow-display";
import type { Provider, WorkflowStatusRule } from "@/types";
import { StatusName } from "./status-select";

type Rules = Record<string, WorkflowStatusRule>;

function Mark({ rule }: { rule: WorkflowStatusRule | undefined }) {
  const Icon = !rule ? CircleDashed : rule.kind === "queue" ? Clock : rule.kind === "agent" ? Bot : User;
  return (
    <span
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-muted-foreground",
        !rule && "border-dashed",
        rule?.kind === "human" && "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300",
        rule && rule.kind !== "human" && "bg-background",
      )}
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

function Then({ label, status }: { label: string; status: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="text-muted-foreground">{label}</span>
      <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
      <StatusName name={status} />
    </span>
  );
}

/**
 * A project's workflow drawn as its board reads: every status in board order,
 * and what happens to an issue at each. Nothing, it queues for an agent, an
 * agent runs a skill on it, or it waits for you. A status opens when pressed.
 */
export function StatusPath({
  rows,
  rules,
  providers,
  missingSkills,
  onOpen,
}: {
  rows: StatusRow[];
  rules: Rules;
  providers: Provider[];
  /** Skills the workflow names that are not in the repo. */
  missingSkills: ReadonlySet<string>;
  onOpen: (status: string) => void;
}) {
  return (
    <ol data-testid="workflow-path">
      {rows.map(({ status, rule }, i) => {
        const problem = ruleProblem(rules, status);
        const missing = rule?.kind === "agent" && !!rule.skill && missingSkills.has(rule.skill);
        return (
          <li key={status} className="flex gap-3">
            <div className="flex flex-col items-center">
              <Mark rule={rule} />
              {i < rows.length - 1 && <span className="my-1 w-px flex-1 bg-border" />}
            </div>
            <button
              type="button"
              onClick={() => onOpen(status)}
              data-testid={`status-row-${status}`}
              data-kind={rule?.kind ?? "none"}
              className={cn(
                "group mb-3 min-w-0 flex-1 rounded-lg border text-left transition-colors hover:bg-accent/40",
                rule ? "bg-card p-3" : "border-dashed px-3 py-2",
              )}
            >
              <div className={cn("flex gap-2", rule ? "items-start" : "items-center")}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <StatusName name={status} className={cn("text-sm", rule ? "font-semibold" : "font-medium")} />
                    <span className="text-xs text-muted-foreground">
                      {!rule
                        ? "Nothing happens here"
                        : rule.kind === "queue"
                          ? "A queue"
                          : rule.kind === "agent"
                            ? "An agent works on it"
                            : "Waits for you"}
                    </span>
                  </div>

                  {rule?.kind === "queue" && rule.to && (
                    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                      Issues wait here until an agent is free, then move to
                      <StatusName name={rule.to} className="font-medium text-foreground" />
                    </div>
                  )}

                  {rule?.kind === "agent" && rule.skill && !missing && (
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      Runs <span className="font-mono">{rule.skill}</span> ·{" "}
                      {agentSummary(rule, describeProviderModel(rule.model, providers)?.model)}
                    </p>
                  )}

                  {missing && rule?.kind === "agent" && (
                    <p
                      className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300"
                      data-testid={`status-missing-${status}`}
                    >
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        No skill called <span className="font-mono">{rule.skill}</span> in this repo. Nothing can start here.
                      </span>
                    </p>
                  )}

                  {rule?.kind === "human" && (
                    <p className="mt-1 text-xs text-muted-foreground">{rule.review === "plan" ? "You review the plan" : "You decide"}</p>
                  )}

                  {problem && (
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      {problem}
                    </p>
                  )}
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </div>

              {rule?.kind === "agent" && rule.next.some(Boolean) && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t pt-2 text-xs">
                  {rule.next.filter(Boolean).map((to, n) => (
                    <Then key={to} label={n === 0 ? "Then" : "or"} status={to} />
                  ))}
                </div>
              )}
              {rule?.kind === "human" && rule.next.some((c) => c.status) && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t pt-2 text-xs">
                  {rule.next
                    .filter((c) => c.status)
                    .map((c) => (
                      <Then key={c.status} label={c.label || "Then"} status={c.status} />
                    ))}
                </div>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** The same workflow in one line, for a list of projects: where an agent works or a person decides. */
export function TrackSummary({ rules, order }: { rules: Rules; order: readonly string[] }) {
  const stops = trackStops(rules, order);
  if (stops.length === 0) return <span className="text-xs text-muted-foreground">Nothing happens at any status yet</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {stops.map((s, i) => (
        <span key={s.status} className="flex items-center gap-1">
          {i > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground/60" />}
          <span
            className={cn(
              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
              s.kind === "human" ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "text-muted-foreground",
            )}
          >
            {s.kind === "agent" ? <Bot className="h-3 w-3" /> : <User className="h-3 w-3" />}
            {s.status}
          </span>
        </span>
      ))}
    </span>
  );
}
