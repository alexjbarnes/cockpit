"use client";

import { useSearchParams } from "next/navigation";
import { usePageHeader, useShellCwd } from "@/components/app-shell";
import { FilesView } from "@/components/files-view";

export default function FilesPage() {
  const searchParams = useSearchParams();
  const cwd = searchParams.get("cwd") || "";

  usePageHeader("Files");
  useShellCwd(cwd || undefined);

  if (!cwd) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No working directory specified.
      </div>
    );
  }

  return <FilesView cwd={cwd} />;
}
