"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useShell } from "@/components/app-shell";
import { FileTree } from "@/components/file-tree";
import { CodeBlock, languageFromPath } from "@/components/code-block";
import { Loader2 } from "lucide-react";

interface FileContent {
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
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

export function FilesView({ cwd }: { cwd: string }) {
  const { setSidebarContent, closeSidebar } = useShell();
  const [selectedFile, setSelectedFile] = useState<string | null>(
    () => selectedFileCache.get(cwd) || null
  );
  const [fileData, setFileData] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchRef = useRef(0);

  const handleSelectFile = useCallback(
    (filePath: string) => {
      setSelectedFile(filePath);
      selectedFileCache.set(cwd, filePath);
      // Close sidebar on mobile
      if (typeof window !== "undefined" && window.innerWidth < 768) {
        closeSidebar();
      }
    },
    [cwd, closeSidebar]
  );

  // Push file tree into sidebar
  useEffect(() => {
    setSidebarContent(
      <FileTree cwd={cwd} selectedFile={selectedFile} onSelectFile={handleSelectFile} />
    );
    return () => setSidebarContent(null);
  }, [cwd, selectedFile, handleSelectFile, setSidebarContent]);

  // Fetch file content when selection changes
  useEffect(() => {
    if (!selectedFile) {
      setFileData(null);
      return;
    }

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

  // No file selected
  if (!selectedFile) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a file to view
      </div>
    );
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
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Failed to read file
      </div>
    );
  }

  const rel = relativePath(cwd, selectedFile);
  const fileName = selectedFile.split("/").pop() || selectedFile;
  const dirPart = rel.slice(0, rel.length - fileName.length);
  const lang = languageFromPath(selectedFile);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-center gap-1 border-b px-4 py-2 font-mono text-xs">
        {dirPart && (
          <span className="text-muted-foreground">{dirPart}</span>
        )}
        <span className="font-bold">{fileName}</span>
        {fileData.truncated && (
          <span className="ml-2 text-muted-foreground">(truncated to 100KB)</span>
        )}
      </div>

      {fileData.binary ? (
        <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
          Binary file
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <CodeBlock
            code={fileData.content}
            language={lang}
            dark={isDark()}
            fullHeight
          />
        </div>
      )}
    </div>
  );
}
