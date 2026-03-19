"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { GitBranch, X, Loader2, Plus, Minus, FileQuestion, FilePlus, FileMinus, FileEdit, FileSymlink, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

interface GitFileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

interface GitStatus {
  branch: string;
  files: GitFileChange[];
}

function statusIcon(status: string) {
  switch (status) {
    case "added": return <FilePlus className="h-3.5 w-3.5 text-green-500" />;
    case "deleted": return <FileMinus className="h-3.5 w-3.5 text-red-500" />;
    case "renamed": return <FileSymlink className="h-3.5 w-3.5 text-blue-500" />;
    case "untracked": return <FileQuestion className="h-3.5 w-3.5 text-muted-foreground" />;
    default: return <FileEdit className="h-3.5 w-3.5 text-yellow-500" />;
  }
}

export function GitStatusButton({ cwd }: { cwd?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(() => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch");
        return res.json();
      })
      .then((data: GitStatus) => setStatus(data))
      .catch(() => setError("Not a git repository"))
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => {
    setStatus(null);
    setError(null);
  }, [cwd]);

  useEffect(() => {
    if (open) fetchStatus();
  }, [open, fetchStatus]);

  const totalAdded = status?.files.reduce((sum, f) => sum + f.additions, 0) ?? 0;
  const totalDeleted = status?.files.reduce((sum, f) => sum + f.deletions, 0) ?? 0;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => { setStatus(null); setError(null); setOpen(true); }}
        title="Git status"
        disabled={!cwd}
      >
        <GitBranch className="h-4 w-4" />
      </Button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-lg mx-4 rounded-lg border bg-background p-5 shadow-lg max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4" />
                <h2 className="text-base font-semibold">Git Status</h2>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {loading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {!loading && error && (
              <p className="text-sm text-muted-foreground py-4 text-center">{error}</p>
            )}

            {!loading && status && (
              <>
                <div className="flex items-center gap-2 mb-3 px-1">
                  <span className="text-sm text-muted-foreground">Branch:</span>
                  <span className="font-mono text-sm font-bold">{status.branch}</span>
                </div>

                {status.files.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    Working tree clean
                  </p>
                ) : (
                  <>
                    <div className="flex items-center gap-3 mb-2 px-1 text-xs text-muted-foreground">
                      <span>{status.files.length} file{status.files.length !== 1 ? "s" : ""} changed</span>
                      {totalAdded > 0 && (
                        <span className="flex items-center gap-0.5 text-green-500">
                          <Plus className="h-3 w-3" />{totalAdded}
                        </span>
                      )}
                      {totalDeleted > 0 && (
                        <span className="flex items-center gap-0.5 text-red-500">
                          <Minus className="h-3 w-3" />{totalDeleted}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto border rounded">
                      {status.files.map((file) => (
                        <div
                          key={file.path}
                          className="flex items-center gap-2 px-3 py-1.5 text-sm border-b last:border-b-0 hover:bg-muted/50"
                        >
                          {statusIcon(file.status)}
                          <span className="font-mono text-xs truncate flex-1 min-w-0">
                            {file.path}
                          </span>
                          <div className="flex items-center gap-2 shrink-0 text-xs">
                            {file.additions > 0 && (
                              <span className="text-green-500">+{file.additions}</span>
                            )}
                            {file.deletions > 0 && (
                              <span className="text-red-500">-{file.deletions}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 gap-1.5"
                      onClick={() => {
                        setOpen(false);
                        const sessionMatch = pathname.match(/^\/sessions\/([^/?]+)/);
                        const sessionParam = sessionMatch ? `&sessionId=${encodeURIComponent(sessionMatch[1])}` : "";
                        router.push(`/changes?cwd=${encodeURIComponent(cwd!)}${sessionParam}`);
                      }}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      View changes
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
