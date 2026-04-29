"use client";

import { useCallback, useEffect, useState } from "react";

export interface CommandInfo {
  name: string;
  scope: "user" | "project";
  description?: string;
}

export function useCommands(cwd?: string) {
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);

    fetch(`/api/commands?${params}`)
      .then((res) => res.json())
      .then((data: { commands: CommandInfo[] }) => setCommands(data.commands))
      .catch(() => setCommands([]))
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const deleteCommand = useCallback(
    async (name: string, scope: "user" | "project"): Promise<boolean> => {
      const params = new URLSearchParams({ scope });
      if (scope === "project" && cwd) params.set("cwd", cwd);

      try {
        const res = await fetch(`/api/commands/${encodeURIComponent(name)}?${params}`, {
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

  return { commands, loading, refresh, deleteCommand };
}
