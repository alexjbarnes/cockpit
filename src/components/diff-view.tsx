"use client";

import type { FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { Check, ExternalLink, FileEdit, FileMinus, FilePlus, FileSymlink, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShell } from "@/components/app-shell";
import { DIFF_SELECTABLE_CSS, DiffErrorBoundary } from "@/components/diff-viewer";
import { useSettings } from "@/hooks/use-settings";
import { useWebSocket } from "@/hooks/use-websocket";
import { useCheckedFiles } from "@/lib/checked-files";
import { cn } from "@/lib/utils";

function isDark(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

function statusIcon(status: string) {
  switch (status) {
    case "added":
    case "untracked":
      return <FilePlus className="h-3.5 w-3.5 text-green-500 shrink-0" />;
    case "deleted":
      return <FileMinus className="h-3.5 w-3.5 text-red-500 shrink-0" />;
    case "renamed":
      return <FileSymlink className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
    default:
      return <FileEdit className="h-3.5 w-3.5 text-yellow-500 shrink-0" />;
  }
}

function reindexForFullContent(meta: FileDiffMetadata, oldContent: string, newContent: string) {
  const oldLines = oldContent.split(/\r?\n/).map((l) => l + "\n");
  const newLines = newContent.split(/\r?\n/).map((l) => l + "\n");
  for (const hunk of meta.hunks) {
    const delDelta = hunk.deletionStart - 1 - hunk.deletionLineIndex;
    const addDelta = hunk.additionStart - 1 - hunk.additionLineIndex;
    hunk.deletionLineIndex = hunk.deletionStart - 1;
    hunk.additionLineIndex = hunk.additionStart - 1;
    for (const content of hunk.hunkContent) {
      content.deletionLineIndex += delDelta;
      content.additionLineIndex += addDelta;
    }
  }
  meta.deletionLines = oldLines;
  meta.additionLines = newLines;
  meta.isPartial = false;
}

interface DiffViewProps {
  cwd: string;
  filePath: string;
}

export function DiffView({ cwd, filePath }: DiffViewProps) {
  const { settings } = useSettings();
  const router = useRouter();
  const { tabActions } = useShell();
  const { subscribe } = useWebSocket();
  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiffMetadata | null>(null);
  const [fileStatus, setFileStatus] = useState<string>("modified");
  const { checkedFiles, toggleFile } = useCheckedFiles(cwd);
  const checked = checkedFiles.has(filePath);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchDiff = useCallback(() => {
    setLoading(true);
    setDiff(null);
    setFileDiff(null);

    fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(filePath)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed");
        return res.json();
      })
      .then((data: { diff: string; oldContent?: string; newContent?: string; status?: string }) => {
        setDiff(data.diff);
        if (data.status) setFileStatus(data.status);
        try {
          const parsed = parsePatchFiles(data.diff);
          if (parsed.length > 0 && parsed[0].files.length > 0) {
            const meta = parsed[0].files[0];
            if (data.oldContent != null && data.newContent != null) {
              reindexForFullContent(meta, data.oldContent, data.newContent);
            }
            setFileDiff(meta);
          }
        } catch {
          // Fall back to raw diff
        }
      })
      .catch(() => setDiff(null))
      .finally(() => setLoading(false));
  }, [cwd, filePath]);

  useEffect(() => {
    fetchDiff();
  }, [fetchDiff]);

  const refreshDiff = useCallback(() => {
    fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(filePath)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed");
        return res.json();
      })
      .then((data: { diff: string; oldContent?: string; newContent?: string; status?: string }) => {
        setDiff(data.diff);
        if (data.status) setFileStatus(data.status);
        try {
          const parsed = parsePatchFiles(data.diff);
          if (parsed.length > 0 && parsed[0].files.length > 0) {
            const meta = parsed[0].files[0];
            if (data.oldContent != null && data.newContent != null) {
              reindexForFullContent(meta, data.oldContent, data.newContent);
            }
            setFileDiff(meta);
          }
        } catch {}
      })
      .catch(() => {});
  }, [cwd, filePath]);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== "session:fs_changed") return;
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(refreshDiff, 300);
    });
  }, [subscribe, refreshDiff]);

  const handleToggle = useCallback(() => {
    toggleFile(filePath);
  }, [toggleFile, filePath]);

  const handleViewFile = useCallback(() => {
    const fullPath = filePath.startsWith("/") ? filePath : `${cwd}/${filePath}`;
    // Inside a session, open the file as a tab; only fall back to the
    // standalone /files page when there's no tab context (e.g. PR review).
    if (tabActions) {
      tabActions.openFile(fullPath);
    } else {
      router.push(`/files?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(fullPath)}`);
    }
  }, [cwd, filePath, router, tabActions]);

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!diff) {
    return <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">No diff available</div>;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-4">
          <div className="rounded-lg border overflow-hidden">
            <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-1.5 text-sm border-b bg-muted/80 backdrop-blur-sm">
              {statusIcon(fileStatus)}
              <span className="font-mono text-xs truncate flex-1 min-w-0 text-left" dir="rtl" title={filePath}>
                <bdo dir="ltr">{filePath}</bdo>
              </span>
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                onClick={handleToggle}
                className={cn(
                  "h-4 w-4 shrink-0 rounded border flex items-center justify-center transition-colors",
                  checked
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/40 bg-transparent hover:border-muted-foreground/60",
                )}
              >
                {checked && <Check className="h-3 w-3" strokeWidth={3} />}
              </button>
              <button
                onClick={handleViewFile}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                title="Open in editor"
              >
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>
            <DiffErrorBoundary fallback={<pre className="p-4 text-xs text-muted-foreground whitespace-pre-wrap">{diff}</pre>}>
              {fileDiff ? (
                <FileDiff
                  fileDiff={fileDiff}
                  options={{
                    theme: { dark: "pierre-dark", light: "pierre-light" },
                    themeType: isDark() ? "dark" : "light",
                    overflow: "wrap",
                    diffStyle: settings.diffStyle,
                    disableFileHeader: true,
                    hunkSeparators: "line-info",
                    expansionLineCount: 20,
                    unsafeCSS: DIFF_SELECTABLE_CSS,
                  }}
                />
              ) : (
                <pre className="p-4 text-xs text-muted-foreground whitespace-pre-wrap">{diff}</pre>
              )}
            </DiffErrorBoundary>
          </div>
        </div>
      </div>
    </div>
  );
}
