"use client";

import { useState, useEffect, useCallback } from "react";

export interface SkillInfo {
  name: string;
  scope: "user" | "project";
  description?: string;
}

export function useSkills(cwd?: string) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);

    fetch(`/api/skills?${params}`)
      .then((res) => res.json())
      .then((data: { skills: SkillInfo[] }) => setSkills(data.skills))
      .catch(() => setSkills([]))
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const deleteSkill = useCallback(
    async (name: string, scope: "user" | "project"): Promise<boolean> => {
      const params = new URLSearchParams({ scope });
      if (scope === "project" && cwd) params.set("cwd", cwd);

      try {
        const res = await fetch(`/api/skills/${encodeURIComponent(name)}?${params}`, {
          method: "DELETE",
        });
        if (res.ok) {
          refresh();
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [cwd, refresh],
  );

  return { skills, loading, refresh, deleteSkill };
}
