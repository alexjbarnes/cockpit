"use client";

import { AlertTriangle } from "lucide-react";

export interface RepoSkillView {
  name: string;
  description?: string;
  path: string;
}

/** The same select the issue page uses for a status, so one looks like the other. */
const SELECT = "w-full min-w-0 rounded-md border bg-background px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

/**
 * Pick the skill an agent runs, from the ones in the project's repo. Under it,
 * what the skill says it does and where it is. A skill the workflow names
 * that is not in the repo is still shown, marked, with where to add it:
 * nothing starts at that status until it exists.
 */
export function SkillSelect({
  value,
  skills,
  noRepo,
  onChange,
}: {
  value: string;
  skills: RepoSkillView[];
  /** Why there are none to choose from, when the project has no repo to read. */
  noRepo?: string;
  onChange: (skill: string) => void;
}) {
  const found = skills.find((s) => s.name === value);
  const missing = !!value && !found;

  return (
    <div className="space-y-2">
      <select
        aria-label="The skill the agent runs"
        data-testid="rule-skill"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT}
      >
        {!value && <option value="">Choose a skill</option>}
        {missing && <option value={value}>{value} (not found)</option>}
        {skills.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>

      {found && (
        <div className="rounded-md border px-2.5 py-2 text-xs" data-testid="rule-skill-info">
          {found.description && <p>{found.description}</p>}
          <p className="font-mono text-muted-foreground">{found.path}</p>
        </div>
      )}

      {missing && !noRepo && (
        <p
          className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 text-xs"
          data-testid="rule-skill-missing"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
          <span>
            There is no skill called <span className="font-mono">{value}</span> in this repo, so nothing can start here. Add it at{" "}
            <span className="font-mono">.claude/skills/{value}/SKILL.md</span>, or ask an agent working in the project to write it.
          </span>
        </p>
      )}

      {noRepo && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 text-xs" data-testid="rule-skill-norepo">
          {noRepo}
        </p>
      )}

      {!noRepo && skills.length === 0 && !missing && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 text-xs" data-testid="rule-skill-none">
          This repo has no skills yet. Add one at <span className="font-mono">.claude/skills/&lt;name&gt;/SKILL.md</span>, or ask an agent
          working in the project to write it.
        </p>
      )}
    </div>
  );
}
