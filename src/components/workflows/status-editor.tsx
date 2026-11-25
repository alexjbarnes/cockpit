"use client";

import { AlertTriangle, Bot, ChevronRight, CircleDashed, Clock, Plus, User, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ModelPickerList } from "@/components/model-picker-list";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { ALL_PROVIDERS, modelTuning } from "@/lib/model-picker";
import { CONTEXT_SIZES, type ContextSize, DEFAULT_CONTEXT_SIZE, describeProviderModel } from "@/lib/models";
import { cn } from "@/lib/utils";
import { agentStatuses, newRule, ruleProblem } from "@/lib/workflow-display";
import type {
  Provider,
  ThinkingLevel,
  WorkflowAgentRule,
  WorkflowChoice,
  WorkflowHumanRule,
  WorkflowPermission,
  WorkflowStatusRule,
} from "@/types";
import { type RepoSkillView, SkillSelect } from "./skill-select";
import { StatusName, StatusSelect } from "./status-select";

const COMMON_TOOLS = ["Read", "Write", "Edit", "Bash", "Bash git", "Bash gh", "Bash npm", "Grep", "Glob", "Agent", "WebFetch", "WebSearch"];

const PERMISSIONS: { value: WorkflowPermission; label: string; hint: string }[] = [
  { value: "bypass", label: "Everything", hint: "It can run any command and use any tool without asking." },
  {
    value: "allowlist",
    label: "Only what I list",
    hint: "It can use the tools and servers listed here. Anything else is refused and it carries on without.",
  },
  {
    value: "ask",
    label: "Ask me",
    hint: "Each permission prompt comes to you, on the session and by notification, and the run waits for your answer.",
  },
];

const DEFAULT_LEVELS: { value: ThinkingLevel; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/** Statuses an issue comes to rest in: nothing is queued or worked there. */
const FINISHED = ["Done", "Cancelled"];

export interface StatusEditorData {
  /** The statuses to offer. A new one can still be named. */
  statuses: string[];
  /** The skills in the project's repo. */
  skills: RepoSkillView[];
  /** Why there are none to choose from, when the project has no repo to read. */
  noRepo?: string;
  providers: Provider[];
  mcpServers: string[];
  notifyTargets: { id: string; name: string; type: string }[];
}

function Toggle({ checked, onChange, testId }: { checked: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${checked ? "bg-primary" : "bg-muted"}`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg transition-transform ${checked ? "translate-x-4" : "translate-x-0"}`}
      />
    </button>
  );
}

/** One question a status answers, with its control under it. */
function Part({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </section>
  );
}

function Switch({
  title,
  hint,
  checked,
  onChange,
  testId,
}: {
  title: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 text-sm">
        {title}
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Toggle checked={checked} onChange={onChange} testId={testId} />
    </div>
  );
}

/** A number that may be left empty, meaning "use the default". */
function OptionalCount({
  value,
  onChange,
  placeholder,
  testId,
  label,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder: string;
  testId?: string;
  label: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      <Input
        inputMode="numeric"
        value={value ?? ""}
        placeholder={placeholder}
        data-testid={testId}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9]/g, "");
          onChange(raw === "" ? undefined : Number(raw));
        }}
      />
    </label>
  );
}

function ModelPart({
  status,
  rule,
  providers,
  onChange,
}: {
  status: string;
  rule: WorkflowAgentRule;
  providers: Provider[];
  onChange: (patch: Partial<WorkflowAgentRule>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState(ALL_PROVIDERS);
  const contextSize = (rule.contextSize && rule.contextSize in CONTEXT_SIZES ? rule.contextSize : DEFAULT_CONTEXT_SIZE) as ContextSize;
  const tuning = useMemo(() => modelTuning(rule.model ?? "", contextSize, providers, true), [rule.model, contextSize, providers]);
  const named = describeProviderModel(rule.model, providers);
  const levels = [{ value: "" as const, label: "Default" }, ...(tuning.thinkingLevels.length > 0 ? tuning.thinkingLevels : DEFAULT_LEVELS)];

  return (
    <Part title="Model and thinking">
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="rule-model"
        className="flex w-full items-center gap-2 rounded-md border bg-background px-3 py-2.5 text-left text-sm hover:bg-muted"
      >
        <span className="min-w-0 flex-1 truncate">{named ? named.model : "Your default model"}</span>
        {named && <span className="shrink-0 text-xs text-muted-foreground">{named.provider}</span>}
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      {rule.model && (
        <button
          type="button"
          onClick={() => onChange({ model: undefined, contextSize: undefined })}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          Use my default model instead
        </button>
      )}
      {rule.model && tuning.contextSizes.length > 1 && (
        <Segmented
          label="Context size"
          variant="track"
          value={tuning.contextSizes.includes(contextSize) ? contextSize : tuning.contextSizes[0]}
          options={tuning.contextSizes.map((s) => ({ value: s, label: `${CONTEXT_SIZES[s].label} context` }))}
          onChange={(s) => onChange({ contextSize: s })}
        />
      )}
      <fieldset className="flex flex-wrap gap-1">
        <legend className="sr-only">Thinking level</legend>
        {levels.map((opt) => (
          <button
            key={opt.value || "default"}
            type="button"
            aria-pressed={(rule.thinkingLevel ?? "") === opt.value}
            data-testid={`rule-thinking-${opt.value || "default"}`}
            onClick={() => onChange({ thinkingLevel: (opt.value || undefined) as ThinkingLevel | undefined })}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-xs transition-colors",
              (rule.thinkingLevel ?? "") === opt.value
                ? "bg-primary font-medium text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {opt.value ? `Thinking ${opt.label.toLowerCase()}` : "Default thinking"}
          </button>
        ))}
      </fieldset>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[80dvh] flex-col">
          <DialogHeader>
            <DialogTitle>Model for {status}</DialogTitle>
          </DialogHeader>
          <div className="mt-3 flex min-h-0 flex-1 flex-col">
            <ModelPickerList
              currentModel={rule.model ?? ""}
              providers={providers}
              recentModels={[]}
              onSelectModel={(value) => {
                onChange({ model: value, contextSize: undefined });
                setOpen(false);
              }}
              tuning={tuning}
              query={query}
              onQuery={setQuery}
              providerFilter={providerFilter}
              onProviderFilter={setProviderFilter}
            />
          </div>
        </DialogContent>
      </Dialog>
    </Part>
  );
}

/** Where an agent may send the issue when it finishes: plain statuses. The
 *  skill says when the issue goes to which. */
function Outcomes({ rule, statuses, onChange }: { rule: WorkflowAgentRule; statuses: string[]; onChange: (next: string[]) => void }) {
  return (
    <div className="space-y-2">
      {rule.next.map((status, i) => (
        // Keyed by position: a row has no identity of its own, and its status is being chosen.
        <div key={i} className="flex items-center gap-1" data-testid={`rule-next-${i}`}>
          <div className="min-w-0 flex-1">
            <StatusSelect
              label={`Outcome ${i + 1}`}
              value={status}
              onChange={(value) => onChange(rule.next.map((s, j) => (j === i ? value : s)))}
              statuses={statuses}
              testId={`rule-next-${i}-status`}
            />
          </div>
          {rule.next.length > 1 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={() => onChange(rule.next.filter((_, j) => j !== i))}
              aria-label="Remove this outcome"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...rule.next, ""])} data-testid="rule-add-next">
        <Plus className="mr-1 h-3.5 w-3.5" />
        Another outcome
      </Button>
    </div>
  );
}

/** The buttons a status of yours puts on the issue. */
function Choices({
  rule,
  statuses,
  onChange,
}: {
  rule: WorkflowHumanRule;
  statuses: string[];
  onChange: (next: WorkflowChoice[]) => void;
}) {
  const set = (i: number, patch: Partial<WorkflowChoice>) => onChange(rule.next.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <div className="space-y-2">
      {rule.next.map((t, i) => (
        // Keyed by position, as above.
        <div key={i} className="flex items-center gap-1 rounded-md border bg-background/50 p-2.5" data-testid={`rule-next-${i}`}>
          <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
            <Input
              value={t.label}
              onChange={(e) => set(i, { label: e.target.value })}
              placeholder="Button, e.g. Accept"
              data-testid={`rule-next-${i}-label`}
            />
            <StatusSelect
              label={`Where button ${i + 1} sends the issue`}
              value={t.status}
              onChange={(status) => set(i, { status, ...(t.label ? {} : { label: status }) })}
              statuses={statuses}
              testId={`rule-next-${i}-status`}
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={() => onChange(rule.next.filter((_, j) => j !== i))}
            aria-label="Remove this button"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...rule.next, { status: "", label: "" }])} data-testid="rule-add-next">
        <Plus className="mr-1 h-3.5 w-3.5" />
        Another button
      </Button>
    </div>
  );
}

/** A plan review has two answers, so it asks where each one sends the issue. */
function PlanAnswers({
  rule,
  statuses,
  onChange,
}: {
  rule: WorkflowHumanRule;
  statuses: string[];
  onChange: (next: WorkflowChoice[]) => void;
}) {
  const approve = rule.next.find((t) => t.role === "approve");
  const sendBack = rule.next.find((t) => t.role === "sendBack");
  const put = (role: "approve" | "sendBack", status: string) => {
    const mine: WorkflowChoice = { status, label: role === "approve" ? "Approve" : "Send back", role };
    const a = role === "approve" ? mine : approve;
    const b = role === "sendBack" ? mine : sendBack;
    onChange([...(a ? [a] : []), ...(b ? [b] : [])]);
  };
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-xs text-muted-foreground">Approving the plan moves the issue to</p>
        <StatusSelect
          label="Where approving the plan sends the issue"
          value={approve?.status ?? ""}
          onChange={(s) => put("approve", s)}
          statuses={statuses}
          testId="rule-approve-status"
        />
      </div>
      <div>
        <p className="mb-1 text-xs text-muted-foreground">Sending it back moves the issue to</p>
        <StatusSelect
          label="Where sending the plan back sends the issue"
          value={sendBack?.status ?? ""}
          onChange={(s) => put("sendBack", s)}
          statuses={statuses}
          testId="rule-sendback-status"
        />
      </div>
    </div>
  );
}

/** Turn a person's choices into a plan review's two answers, or back again. */
function asPlanReview(rule: WorkflowHumanRule, on: boolean): WorkflowHumanRule {
  if (!on) return { ...rule, review: undefined, next: rule.next.map(({ role: _role, ...t }) => t) };
  const approve = rule.next.find((t) => t.role === "approve") ?? rule.next[0];
  const sendBack = rule.next.find((t) => t.role === "sendBack") ?? rule.next.find((t) => t !== approve);
  return {
    ...rule,
    review: "plan",
    next: [
      { status: approve?.status ?? "", label: "Approve", role: "approve" },
      { status: sendBack?.status ?? "", label: "Send back", role: "sendBack" },
    ],
  };
}

type Kind = "none" | WorkflowStatusRule["kind"];

const KINDS: { kind: Kind; title: string; hint: string; Icon: typeof Bot }[] = [
  { kind: "none", title: "Nothing", hint: "It stays until someone moves it", Icon: CircleDashed },
  { kind: "queue", title: "It queues for an agent", hint: "It waits here, then moves on when an agent is free", Icon: Clock },
  { kind: "agent", title: "An agent works on it", hint: "A Claude session runs a workflow skill", Icon: Bot },
  { kind: "human", title: "It waits for me", hint: "Until I decide where it goes", Icon: User },
];

/**
 * One status of a project, as the question it answers: what happens to an
 * issue here. Nothing, it queues for an agent, an agent works on it, or it
 * waits for you, and then only what that answer needs. It edits the rule it is
 * given and hands back the changed one (or none); the page saves the workflow.
 */
export function StatusEditor({
  status,
  rule,
  rules,
  data,
  onChange,
  onDone,
}: {
  status: string;
  rule: WorkflowStatusRule | undefined;
  /** Every rule of the workflow as it is being edited, this one included. */
  rules: Record<string, WorkflowStatusRule>;
  data: StatusEditorData;
  onChange: (rule: WorkflowStatusRule | undefined) => void;
  onDone: () => void;
}) {
  const [tool, setTool] = useState("");
  const [more, setMore] = useState(false);
  const kind: Kind = rule?.kind ?? "none";
  const finished = FINISHED.includes(status);
  const others = data.statuses.filter((s) => s !== status);
  const problem = ruleProblem(rules, status);

  function choose(next: Kind) {
    if (next === kind) return;
    if (next === "none") return onChange(undefined);
    if (next === "queue") {
      // The only place it can go is where an agent works, so offer the first.
      return onChange({ kind: "queue", to: agentStatuses(rules).find((s) => s !== status) ?? "" });
    }
    onChange(newRule(next));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="status-editor">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <StatusName name={status} className="min-w-0 flex-1 text-[15px] font-semibold" />
        <Button size="sm" onClick={onDone} data-testid="status-done">
          Done
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        <Part
          title="What happens to an issue here?"
          hint={finished ? `${status} is where an issue comes to rest, so nothing is queued or worked here.` : undefined}
        >
          <div className="grid grid-cols-2 gap-2" data-testid="status-kind">
            {KINDS.map(({ kind: k, title, hint, Icon }) => {
              const off = finished && (k === "queue" || k === "agent");
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  disabled={off}
                  data-testid={`status-kind-${k}`}
                  onClick={() => choose(k)}
                  className={cn(
                    "min-w-0 rounded-lg border p-3 text-left transition-colors disabled:opacity-40",
                    kind === k ? "border-primary bg-primary/5" : "hover:bg-muted",
                  )}
                >
                  <Icon className={cn("mb-1.5 h-4 w-4", kind === k ? "text-foreground" : "text-muted-foreground")} />
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                </button>
              );
            })}
          </div>
        </Part>

        {rule?.kind === "queue" && (
          <Part
            title="Where does it go when an agent is free?"
            hint="The skill, the model and the limits are set on that status, where the work happens."
          >
            <StatusSelect
              label="The status an agent works these issues in"
              value={rule.to}
              onChange={(to) => onChange({ kind: "queue", to })}
              statuses={others}
              testId="rule-to"
            />
          </Part>
        )}

        {rule?.kind === "agent" && (
          <AgentParts
            status={status}
            rule={rule}
            data={data}
            others={others}
            onChange={onChange}
            tool={tool}
            setTool={setTool}
            more={more}
            setMore={setMore}
          />
        )}

        {rule?.kind === "human" && (
          <>
            <Part
              title="What do you do here?"
              hint={
                rule.review === "plan"
                  ? "You read the plan on the issue, mark it up, and approve it or send it back."
                  : "The issue shows a button for each choice below."
              }
            >
              <Segmented
                label="What you do at this status"
                variant="track"
                testId="rule-review"
                value={rule.review === "plan" ? "plan" : "decide"}
                options={[
                  { value: "plan", label: "Review the plan" },
                  { value: "decide", label: "Decide what's next" },
                ]}
                onChange={(value) => onChange(asPlanReview(rule, value === "plan"))}
              />
            </Part>
            <Part title="Where does the issue go next?">
              {rule.review === "plan" ? (
                <PlanAnswers rule={rule} statuses={others} onChange={(next) => onChange({ ...rule, next })} />
              ) : (
                <Choices rule={rule} statuses={others} onChange={(next) => onChange({ ...rule, next })} />
              )}
            </Part>
            <Notify
              title="Tell me when an issue is waiting here"
              targets={data.notifyTargets}
              value={rule.notifyProviders ?? []}
              onChange={(notifyProviders) =>
                onChange({ ...rule, notifyProviders: notifyProviders.length > 0 ? notifyProviders : undefined })
              }
            />
          </>
        )}

        {problem && (
          <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300" data-testid="rule-problem">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}

function Notify({
  title,
  targets,
  value,
  onChange,
}: {
  title: string;
  targets: StatusEditorData["notifyTargets"];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  if (targets.length === 0) return null;
  return (
    <Part title={title} hint="It always lands in your inbox as well.">
      <div className="space-y-1.5">
        {targets.map((p) => (
          <label key={p.id} className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.includes(p.id)}
              onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))}
              className="rounded border-input"
            />
            <span>{p.name}</span>
          </label>
        ))}
      </div>
    </Part>
  );
}

/** What an agent's status needs: the skill it runs, the model, where the
 *  issue can go, and the settings rarely changed under "More settings". */
function AgentParts({
  status,
  rule,
  data,
  others,
  onChange,
  tool,
  setTool,
  more,
  setMore,
}: {
  status: string;
  rule: WorkflowAgentRule;
  data: StatusEditorData;
  others: string[];
  onChange: (rule: WorkflowStatusRule) => void;
  tool: string;
  setTool: (value: string) => void;
  more: boolean;
  setMore: (update: (value: boolean) => boolean) => void;
}) {
  const set = (p: Partial<WorkflowAgentRule>) => onChange({ ...rule, ...p });
  const permission = rule.permission ?? "bypass";
  const tools = rule.allowedTools ?? [];
  const servers = rule.mcpServers ?? [];

  function addTool(value: string) {
    const trimmed = value.trim();
    if (trimmed && !tools.includes(trimmed)) set({ allowedTools: [...tools, trimmed] });
    setTool("");
  }

  return (
    <>
      <Part
        title="Which skill does it run?"
        hint="Skills come from this project's repo, so they are versioned with its code. Cockpit tells the skill which issue it has and where the issue can go next."
      >
        <SkillSelect value={rule.skill} skills={data.skills} noRepo={data.noRepo} onChange={(skill) => set({ skill })} />
      </Part>

      <ModelPart status={status} rule={rule} providers={data.providers} onChange={set} />

      <Part
        title="Where does the issue go when it finishes?"
        hint="The skill ends by moving the issue to one of these. Cockpit refuses a move anywhere else."
      >
        <Outcomes rule={rule} statuses={others} onChange={(next) => set({ next })} />
      </Part>

      <Notify
        title="Tell me if an issue gets stuck here"
        targets={data.notifyTargets}
        value={rule.notifyProviders ?? []}
        onChange={(notifyProviders) => set({ notifyProviders: notifyProviders.length > 0 ? notifyProviders : undefined })}
      />

      <section className="rounded-lg border">
        <button
          type="button"
          onClick={() => setMore((v) => !v)}
          aria-expanded={more}
          data-testid="rule-more"
          className="flex w-full items-center gap-2 px-3 py-3 text-left text-sm font-medium"
        >
          <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", more && "rotate-90")} />
          More settings
          <span className="min-w-0 flex-1 truncate text-right text-xs font-normal text-muted-foreground">
            permissions, limits, where it works
          </span>
        </button>
        {more && (
          <div className="space-y-6 border-t px-3 py-4">
            <Part title="What may it use?" hint={PERMISSIONS.find((p) => p.value === permission)?.hint}>
              <Segmented
                label="Permissions"
                variant="track"
                testId="rule-permission"
                value={permission}
                options={PERMISSIONS.map(({ value, label }) => ({ value, label }))}
                onChange={(value) => set({ permission: value })}
              />
              {permission === "allowlist" && (
                <div className="space-y-2 pt-1">
                  {tools.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {tools.map((v) => (
                        <span
                          key={v}
                          className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 font-mono text-xs text-primary"
                        >
                          {v}
                          <button
                            type="button"
                            onClick={() => set({ allowedTools: tools.filter((t) => t !== v) })}
                            aria-label={`Remove ${v}`}
                            className="hover:text-destructive"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Input
                      value={tool}
                      onChange={(e) => setTool(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addTool(tool);
                        }
                      }}
                      placeholder='A tool, or "Bash git"'
                      className="flex-1 font-mono"
                      data-testid="rule-tool-input"
                    />
                    <Button variant="outline" size="sm" onClick={() => addTool(tool)} disabled={!tool.trim()}>
                      Add
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {COMMON_TOOLS.filter((t) => !tools.includes(t)).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => addTool(t)}
                        className="rounded border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted"
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Part>

            {data.mcpServers.length > 0 && (
              <Part title="MCP servers" hint="The ones it may use. The rest are switched off for the run.">
                <div className="flex flex-wrap gap-1.5">
                  {data.mcpServers.map((server) => {
                    const on = servers.includes(server);
                    return (
                      <button
                        key={server}
                        type="button"
                        aria-pressed={on}
                        onClick={() => set({ mcpServers: on ? servers.filter((s) => s !== server) : [...servers, server] })}
                        className={cn(
                          "rounded-md border px-2 py-1 font-mono text-xs",
                          on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
                        )}
                      >
                        {server}
                      </button>
                    );
                  })}
                </div>
              </Part>
            )}

            <Part
              title="Where does it work?"
              hint={
                rule.workspace === "worktree"
                  ? "A git worktree and branch of the issue's own, shared by every agent that works on it, so several issues can be worked at once. Cockpit makes it and removes it when the issue is done."
                  : "The project's own folder. Fine for one issue at a time, or an agent that only reads."
              }
            >
              <Segmented
                label="Where the agent works"
                variant="track"
                testId="rule-workspace"
                value={rule.workspace ?? "repo"}
                options={[
                  { value: "worktree", label: "The issue's own worktree" },
                  { value: "repo", label: "The project folder" },
                ]}
                onChange={(workspace) => set({ workspace })}
              />
            </Part>

            <Switch
              title="Carry on in the same session"
              hint="When an issue comes back to this status, the session that worked on it last time picks it up again."
              checked={rule.continueSession === true}
              onChange={(on) => set({ continueSession: on || undefined })}
              testId="rule-continue"
            />
            <Switch
              title="Sandbox its commands"
              hint="Bash runs inside the CLI's sandbox, with your sandbox rules."
              checked={rule.sandbox === true}
              onChange={(on) => set({ sandbox: on || undefined })}
            />
            <div className="grid grid-cols-3 gap-2">
              <OptionalCount
                label="Minutes allowed"
                value={rule.maxDurationMinutes}
                onChange={(v) => set({ maxDurationMinutes: v })}
                placeholder="60"
                testId="rule-minutes"
              />
              <OptionalCount label="Retries" value={rule.maxRetries} onChange={(v) => set({ maxRetries: v })} placeholder="1" />
              <OptionalCount
                label="At once"
                value={rule.maxParallel}
                onChange={(v) => set({ maxParallel: v })}
                placeholder="Any"
                testId="rule-parallel"
              />
            </div>
          </div>
        )}
      </section>
    </>
  );
}
