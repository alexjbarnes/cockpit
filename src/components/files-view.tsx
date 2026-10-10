"use client";

import { AlertCircle, ChevronDown, ChevronUp, Eye, Loader2, Pencil, Plus, Save, Search, WrapText, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShell } from "@/components/app-shell";
import { CodeBlock, languageFromPath } from "@/components/code-block";
import { CodeEditor } from "@/components/code-editor";
import { FilePicker } from "@/components/file-picker";
import { FileTree } from "@/components/file-tree";
import { MarkdownRender } from "@/components/markdown-render";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useWebSocket } from "@/hooks/use-websocket";
import { pathBasename } from "@/lib/path";

interface FileContent {
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  image?: boolean;
  mediaType?: string;
  mtimeMs?: number;
}

// Module-level caches
const selectedFileCache = new Map<string, string | null>();
const fileContentCache = new Map<string, FileContent>();
const MAX_CONTENT_CACHE = 50;

function isDark(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

function relativePath(cwd: string, filePath: string): string {
  if (filePath.startsWith(cwd)) {
    const rel = filePath.slice(cwd.length);
    return rel.startsWith("/") ? rel.slice(1) : rel;
  }
  return filePath;
}

function clearSearchMarks(container: HTMLElement) {
  for (const mark of Array.from(container.querySelectorAll("mark.file-search-match"))) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

function applySearchMarks(container: HTMLElement, query: string): number {
  clearSearchMarks(container);
  if (!query) return 0;

  const lower = query.toLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const parentTag = walker.currentNode.parentNode?.nodeName;
    if (parentTag !== "STYLE" && parentTag !== "SCRIPT") {
      nodes.push(walker.currentNode as Text);
    }
  }

  let count = 0;
  for (const node of nodes) {
    const text = node.textContent ?? "";
    const textLower = text.toLowerCase();
    const positions: number[] = [];
    let from = 0;
    for (;;) {
      const idx = textLower.indexOf(lower, from);
      if (idx === -1) break;
      positions.push(idx);
      from = idx + 1;
    }
    if (!positions.length) continue;

    const frag = document.createDocumentFragment();
    let end = 0;
    for (const pos of positions) {
      if (pos > end) frag.appendChild(document.createTextNode(text.slice(end, pos)));
      const mark = document.createElement("mark");
      mark.className = "file-search-match";
      mark.style.backgroundColor = "rgba(250, 204, 21, 0.35)";
      mark.style.color = "inherit";
      mark.style.borderRadius = "1px";
      mark.textContent = text.slice(pos, pos + query.length);
      frag.appendChild(mark);
      count++;
      end = pos + query.length;
    }
    if (end < text.length) frag.appendChild(document.createTextNode(text.slice(end)));
    node.parentNode?.replaceChild(frag, node);
  }
  return count;
}

function scrollToNthMark(container: HTMLElement, n: number) {
  const marks = container.querySelectorAll("mark.file-search-match");
  marks.forEach((m) => {
    (m as HTMLElement).style.backgroundColor = "rgba(250, 204, 21, 0.35)";
  });
  const target = marks[n];
  if (target) {
    (target as HTMLElement).style.backgroundColor = "rgba(234, 88, 12, 0.5)";
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

export function FilesView({
  cwd,
  initialFile,
  manageSidebar = true,
}: {
  cwd: string;
  initialFile?: string | null;
  manageSidebar?: boolean;
}) {
  const { setSidebarSection, removeSidebarSection, closeSidebar, tabActions } = useShell();
  const { subscribe } = useWebSocket();
  const [selectedFile, setSelectedFile] = useState<string | null>(() => initialFile || selectedFileCache.get(cwd) || null);
  const [fileData, setFileData] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [pathInputOpen, setPathInputOpen] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [preview, setPreview] = useState(false);
  const [imgError, setImgError] = useState(false);
  // Editing. The draft lives here rather than inside the editor, so the
  // watcher's re-renders cannot lose it.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictMtime, setConflictMtime] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // The mtime the draft was opened from: saving sends it so the server can
  // refuse to write over a change made while the editor was open.
  const editBaseMtime = useRef<number | undefined>(undefined);
  const fetchRef = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const currentMatchRef = useRef(-1);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(-1);

  useEffect(() => {
    if (localStorage.getItem("cockpit-files-wrap") === "1") setWrap(true);
    if (localStorage.getItem("cockpit-files-preview") === "1") setPreview(true);
  }, []);

  const toggleWrap = useCallback(() => {
    setWrap((prev) => {
      const next = !prev;
      localStorage.setItem("cockpit-files-wrap", next ? "1" : "0");
      return next;
    });
  }, []);

  const togglePreview = useCallback(() => {
    setPreview((prev) => {
      const next = !prev;
      localStorage.setItem("cockpit-files-preview", next ? "1" : "0");
      return next;
    });
  }, []);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  const goToMatch = useCallback(
    (direction: 1 | -1) => {
      if (matchCount === 0 || !contentRef.current) return;
      const next = (((currentMatch + direction) % matchCount) + matchCount) % matchCount;
      currentMatchRef.current = next;
      setCurrentMatch(next);
      scrollToNthMark(contentRef.current, next);
    },
    [matchCount, currentMatch],
  );

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        closeSearch();
      } else if (e.key === "Enter") {
        e.preventDefault();
        goToMatch(e.shiftKey ? -1 : 1);
      }
    },
    [closeSearch, goToMatch],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-apply highlights when content or display mode changes
  useEffect(() => {
    // The marks are DOM nodes wrapped around rendered text; the editor owns its
    // own DOM, so highlighting is off while editing.
    if (!searchOpen || !searchQuery || !contentRef.current || editing) {
      if (contentRef.current) clearSearchMarks(contentRef.current);
      setMatchCount(0);
      currentMatchRef.current = -1;
      setCurrentMatch(-1);
      return;
    }

    const container = contentRef.current;
    let rafId: number;

    const apply = (resetPosition: boolean) => {
      const count = applySearchMarks(container, searchQuery);
      setMatchCount(count);
      let idx: number;
      if (!resetPosition && currentMatchRef.current >= 0 && count > 0) {
        idx = Math.min(currentMatchRef.current, count - 1);
      } else {
        idx = count > 0 ? 0 : -1;
      }
      currentMatchRef.current = idx;
      setCurrentMatch(idx);
      if (idx >= 0) scrollToNthMark(container, idx);
    };

    rafId = requestAnimationFrame(() => apply(true));

    const observer = new MutationObserver(() => {
      if (!container.querySelector("mark.file-search-match")) {
        rafId = requestAnimationFrame(() => apply(false));
      }
    });
    observer.observe(container, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [searchOpen, searchQuery, fileData, wrap, preview, editing]);

  const handleSelectFile = useCallback(
    (filePath: string) => {
      setSelectedFile(filePath);
      selectedFileCache.set(cwd, filePath);
      // Close sidebar on mobile
      if (typeof window !== "undefined" && window.innerWidth < 768) {
        closeSidebar();
      }
    },
    [cwd, closeSidebar],
  );

  const openExternalFile = useCallback(
    (filePath: string) => {
      if (tabActions) {
        tabActions.openFile(filePath);
      } else {
        handleSelectFile(filePath);
      }
      setPathInputOpen(false);
    },
    [tabActions, handleSelectFile],
  );

  useEffect(() => {
    if (!manageSidebar) return;
    setSidebarSection({
      id: "file-tree",
      title: "Files",
      content: <FileTree cwd={cwd} selectedFile={selectedFile} onSelectFile={handleSelectFile} />,
      order: 30,
      actions: (
        <button
          onClick={() => setPathInputOpen(true)}
          title="Open file"
          className="flex items-center justify-center rounded p-0.5 hover:bg-accent text-muted-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      ),
    });
    return () => removeSidebarSection("file-tree");
  }, [cwd, selectedFile, handleSelectFile, setSidebarSection, removeSidebarSection, manageSidebar]);

  // Fetch file content when selection changes
  useEffect(() => {
    // A draft belongs to the file it was opened from, so changing file ends
    // the edit rather than showing one file's text over another's path.
    setEditing(false);
    setDraft("");
    setSaveError(null);
    setConflictMtime(null);

    if (!selectedFile) {
      setFileData(null);
      return;
    }

    setImgError(false);

    const cached = fileContentCache.get(selectedFile);
    if (cached) {
      setFileData(cached);
      return;
    }

    const id = ++fetchRef.current;
    setLoading(true);
    fetch(`/api/filesystem/read?path=${encodeURIComponent(selectedFile)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to read file");
        return res.json();
      })
      .then((data: FileContent) => {
        if (fetchRef.current !== id) return;
        // Evict oldest if cache is full
        if (fileContentCache.size >= MAX_CONTENT_CACHE) {
          const first = fileContentCache.keys().next().value;
          if (first !== undefined) fileContentCache.delete(first);
        }
        fileContentCache.set(selectedFile, data);
        setFileData(data);
      })
      .catch(() => {
        if (fetchRef.current !== id) return;
        setFileData(null);
      })
      .finally(() => {
        if (fetchRef.current === id) setLoading(false);
      });
  }, [selectedFile]);

  useEffect(() => {
    if (!selectedFile) return;

    const refresh = async () => {
      const cached = fileContentCache.get(selectedFile);
      if (!cached?.mtimeMs) return;

      try {
        const res = await fetch(`/api/filesystem/read?path=${encodeURIComponent(selectedFile)}&stat=true`);
        if (!res.ok) return;
        const stat = await res.json();
        if (stat.mtimeMs !== cached.mtimeMs) {
          const savedScroll = scrollRef.current?.scrollTop ?? 0;
          const contentRes = await fetch(`/api/filesystem/read?path=${encodeURIComponent(selectedFile)}`);
          if (!contentRes.ok) return;
          const data: FileContent = await contentRes.json();
          fileContentCache.set(selectedFile, data);
          setFileData(data);
          requestAnimationFrame(() => {
            if (scrollRef.current) scrollRef.current.scrollTop = savedScroll;
          });
        }
      } catch {}
    };

    return subscribe((msg) => {
      if (msg.type !== "session:fs_changed") return;
      refresh();
    });
  }, [selectedFile, subscribe]);

  const startEditing = useCallback(() => {
    if (!fileData) return;
    setDraft(fileData.content);
    editBaseMtime.current = fileData.mtimeMs;
    setSaveError(null);
    setConflictMtime(null);
    setEditing(true);
  }, [fileData]);

  const stopEditing = useCallback(() => {
    setEditing(false);
    setDraft("");
    setSaveError(null);
    setConflictMtime(null);
  }, []);

  /** Save the draft. `expected` is the mtime to insist on; omitting it is what
   *  the conflict banner's Overwrite does. */
  const save = useCallback(
    async (expected?: number) => {
      if (!selectedFile || !fileData || saving) return;
      setSaving(true);
      setSaveError(null);
      try {
        const res = await fetch("/api/filesystem/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: selectedFile,
            content: draft,
            ...(expected !== undefined ? { expectedMtimeMs: expected } : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409) {
          setConflictMtime(typeof data.mtimeMs === "number" ? data.mtimeMs : null);
          setSaveError("The file changed on disk since you opened it.");
          return;
        }
        if (!res.ok) {
          setSaveError(data.error || "Could not save the file");
          return;
        }
        const next: FileContent = {
          ...fileData,
          content: draft,
          size: data.size ?? fileData.size,
          truncated: false,
          mtimeMs: data.mtimeMs ?? fileData.mtimeMs,
        };
        fileContentCache.set(selectedFile, next);
        setFileData(next);
        editBaseMtime.current = next.mtimeMs;
        stopEditing();
      } catch {
        setSaveError("Could not reach the server");
      } finally {
        setSaving(false);
      }
    },
    [draft, fileData, saving, selectedFile, stopEditing],
  );

  /** Take the disk's version, throwing the draft away. */
  const reloadFromDisk = useCallback(async () => {
    if (!selectedFile) return;
    const res = await fetch(`/api/filesystem/read?path=${encodeURIComponent(selectedFile)}`);
    if (!res.ok) {
      setSaveError("Could not read the file");
      return;
    }
    const data: FileContent = await res.json();
    fileContentCache.set(selectedFile, data);
    setFileData(data);
    setDraft(data.content);
    editBaseMtime.current = data.mtimeMs;
    setSaveError(null);
    setConflictMtime(null);
  }, [selectedFile]);

  const dirty = editing && !!fileData && draft !== fileData.content;

  // No file selected
  if (!selectedFile) {
    return <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Select a file to view</div>;
  }

  // Loading
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!fileData) {
    return <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Failed to read file</div>;
  }

  const rel = relativePath(cwd, selectedFile);
  const fileName = pathBasename(selectedFile) || selectedFile;
  const dirPart = rel.slice(0, rel.length - fileName.length);
  const lang = languageFromPath(selectedFile);
  const isMarkdown = lang === "markdown" || lang === "mdx";
  const showPreview = isMarkdown && preview;
  const isText = !fileData.binary && !fileData.image;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-center gap-1 border-b px-4 py-2 font-mono text-xs">
        {dirPart && <span className="text-muted-foreground">{dirPart}</span>}
        <span className="font-bold">{fileName}</span>
        {dirty && <span className="ml-1.5 h-1.5 w-1.5 rounded-full bg-primary" title="Unsaved changes" />}
        {fileData.truncated && <span className="ml-2 text-muted-foreground">(truncated to 100KB)</span>}
        <div className="ml-auto flex items-center gap-1">
          {editing && (
            <>
              <button
                type="button"
                onClick={() => save(editBaseMtime.current)}
                disabled={!dirty || saving}
                data-testid="file-save"
                title="Save (Ctrl+S)"
                className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save
              </button>
              <button
                type="button"
                onClick={() => (dirty ? setConfirmDiscard(true) : stopEditing())}
                data-testid="file-cancel"
                title="Stop editing"
                className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </button>
            </>
          )}
          {!editing && isText && !fileData.truncated && (
            <button
              type="button"
              onClick={startEditing}
              data-testid="file-edit"
              aria-label="Edit file"
              title="Edit file"
              className="flex items-center justify-center rounded p-1 hover:bg-accent text-muted-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {!editing && isText && (
            <button
              type="button"
              onClick={searchOpen ? closeSearch : openSearch}
              aria-label="Find in file"
              title="Find in file"
              className={`flex items-center justify-center rounded p-1 hover:bg-accent ${searchOpen ? "text-foreground" : "text-muted-foreground"}`}
            >
              <Search className="h-3.5 w-3.5" />
            </button>
          )}
          {!editing && isMarkdown && (
            <button
              type="button"
              onClick={togglePreview}
              aria-label={preview ? "Show source" : "Show preview"}
              aria-pressed={preview}
              title={preview ? "Show source" : "Show preview"}
              className={`flex items-center justify-center rounded p-1 hover:bg-accent ${preview ? "text-foreground" : "text-muted-foreground"}`}
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          )}
          {!editing && isText && !showPreview && (
            <button
              type="button"
              onClick={toggleWrap}
              aria-label={wrap ? "Disable line wrap" : "Enable line wrap"}
              aria-pressed={wrap}
              title={wrap ? "Disable line wrap" : "Enable line wrap"}
              className={`flex items-center justify-center rounded p-1 hover:bg-accent ${wrap ? "text-foreground" : "text-muted-foreground"}`}
            >
              <WrapText className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {saveError && (
        <div className="shrink-0 flex items-center gap-2 border-b px-4 py-1.5 text-xs" data-testid="file-save-error">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{saveError}</span>
          {conflictMtime !== null && (
            <>
              <button
                type="button"
                onClick={() => save()}
                data-testid="file-overwrite"
                className="rounded px-2 py-0.5 hover:bg-accent text-muted-foreground hover:text-foreground"
              >
                Overwrite
              </button>
              <button
                type="button"
                onClick={reloadFromDisk}
                data-testid="file-reload"
                className="rounded px-2 py-0.5 hover:bg-accent text-muted-foreground hover:text-foreground"
              >
                Reload from disk
              </button>
            </>
          )}
        </div>
      )}

      {!editing && searchOpen && (
        <div className="shrink-0 flex items-center gap-1.5 border-b px-4 py-1.5">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Find in file..."
            className="flex-1 min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          {searchQuery && (
            <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
              {matchCount > 0 ? `${currentMatch + 1} of ${matchCount}` : "No results"}
            </span>
          )}
          <button
            type="button"
            onClick={() => goToMatch(-1)}
            disabled={matchCount === 0}
            className="flex items-center justify-center rounded p-0.5 hover:bg-accent text-muted-foreground disabled:opacity-30"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => goToMatch(1)}
            disabled={matchCount === 0}
            className="flex items-center justify-center rounded p-0.5 hover:bg-accent text-muted-foreground disabled:opacity-30"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={closeSearch}
            className="flex items-center justify-center rounded p-0.5 hover:bg-accent text-muted-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div ref={contentRef} className="flex-1 min-h-0 flex flex-col">
        {fileData.image ? (
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4">
            {imgError ? (
              <div className="text-sm text-muted-foreground">Could not display image</div>
            ) : (
              <img
                src={`/api/filesystem/read?path=${encodeURIComponent(selectedFile)}&raw=true${fileData.mtimeMs ? `&t=${fileData.mtimeMs}` : ""}`}
                alt={fileName}
                className="max-w-full max-h-full object-contain"
                onError={() => setImgError(true)}
              />
            )}
          </div>
        ) : fileData.binary ? (
          <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">Binary file</div>
        ) : editing ? (
          <div className="flex min-h-0 flex-1 flex-col" data-testid="file-editor">
            <CodeEditor
              value={draft}
              onChange={setDraft}
              language={lang}
              onSave={() => save(editBaseMtime.current)}
              className="min-h-0 flex-1 rounded-none border-0 [&_.cm-editor]:h-full [&_.cm-editor]:min-h-0"
            />
          </div>
        ) : showPreview ? (
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4">
            <MarkdownRender content={fileData.content} />
          </div>
        ) : (
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
            <CodeBlock code={fileData.content} language={lang} dark={isDark()} fullHeight wrap={wrap} />
          </div>
        )}
      </div>

      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes</DialogTitle>
          </DialogHeader>
          <p className="mb-4 text-sm text-muted-foreground">Discard your changes to {fileName}? They cannot be recovered.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              data-testid="file-discard"
              onClick={() => {
                setConfirmDiscard(false);
                stopEditing();
              }}
            >
              Discard
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={pathInputOpen} onOpenChange={setPathInputOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Open File</DialogTitle>
          </DialogHeader>
          <FilePicker startPath={cwd} onSelect={openExternalFile} onCancel={() => setPathInputOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
