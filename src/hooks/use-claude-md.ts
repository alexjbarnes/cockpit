"use client";

import { useCallback, useEffect, useState } from "react";

export interface ClaudeMdFile {
  scope: "user" | "project" | "project-hidden";
  cwd?: string;
  dirName?: string;
  content: string;
  exists: boolean;
}

export function useClaudeMd() {
  const [files, setFiles] = useState<ClaudeMdFile[]>([]);
  const [cwds, setCwds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    fetch("/api/claude-md")
      .then((res) => res.json())
      .then((data: { files: ClaudeMdFile[]; cwds: string[] }) => {
        setFiles(data.files);
        setCwds(data.cwds);
      })
      .catch(() => {
        setFiles([]);
        setCwds([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { files, cwds, loading, refresh };
}
