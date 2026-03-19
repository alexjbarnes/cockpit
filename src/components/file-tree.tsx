"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, ChevronDown, Folder, FolderOpen, File, Loader2 } from "lucide-react";

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
}

interface FileTreeProps {
  cwd: string;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}

// Module-level cache: directory path -> children nodes
const childrenCache = new Map<string, TreeNode[]>();

async function fetchChildren(dirPath: string): Promise<TreeNode[]> {
  const cached = childrenCache.get(dirPath);
  if (cached) return cached;

  const params = new URLSearchParams({
    path: dirPath,
    includeFiles: "true",
    showHidden: "true",
  });
  const res = await fetch(`/api/filesystem/browse?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  const nodes: TreeNode[] = (data.entries || []).map(
    (e: { name: string; path: string; type: "file" | "directory" }) => ({
      name: e.name,
      path: e.path,
      type: e.type,
    })
  );
  childrenCache.set(dirPath, nodes);
  return nodes;
}

// Module-level cache for expanded state per cwd
const expandedCache = new Map<string, Set<string>>();

function getExpandedSet(cwd: string): Set<string> {
  let set = expandedCache.get(cwd);
  if (!set) {
    set = new Set();
    expandedCache.set(cwd, set);
  }
  return set;
}

function TreeRow({
  node,
  depth,
  selectedFile,
  onSelectFile,
  expandedSet,
  onToggleExpand,
}: {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  expandedSet: Set<string>;
  onToggleExpand: (path: string) => void;
}) {
  const isDir = node.type === "directory";
  const isExpanded = expandedSet.has(node.path);
  const [children, setChildren] = useState<TreeNode[]>(
    childrenCache.get(node.path) || []
  );
  const [loading, setLoading] = useState(false);

  const handleClick = useCallback(() => {
    if (isDir) {
      onToggleExpand(node.path);
      if (!expandedSet.has(node.path) && !childrenCache.has(node.path)) {
        setLoading(true);
        fetchChildren(node.path).then((nodes) => {
          setChildren(nodes);
          setLoading(false);
        });
      }
    } else {
      onSelectFile(node.path);
    }
  }, [isDir, node.path, onToggleExpand, onSelectFile, expandedSet]);

  // Load children if already expanded (e.g. restored from cache)
  useEffect(() => {
    if (isDir && isExpanded && children.length === 0 && !loading) {
      const cached = childrenCache.get(node.path);
      if (cached) {
        setChildren(cached);
      } else {
        setLoading(true);
        fetchChildren(node.path).then((nodes) => {
          setChildren(nodes);
          setLoading(false);
        });
      }
    }
  }, [isDir, isExpanded, children.length, loading, node.path]);

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-1 px-2 py-1 text-sm cursor-pointer hover:bg-muted/50",
          !isDir && selectedFile === node.path && "bg-muted"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
      >
        {isDir ? (
          <>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            {isExpanded ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
          </>
        ) : (
          <>
            <span className="w-3.5 shrink-0" />
            <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </>
        )}
        <span className="font-mono text-xs truncate">{node.name}</span>
      </div>
      {isDir && isExpanded && children.map((child) => (
        <TreeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          expandedSet={expandedSet}
          onToggleExpand={onToggleExpand}
        />
      ))}
    </>
  );
}

export function FileTree({ cwd, selectedFile, onSelectFile }: FileTreeProps) {
  const [roots, setRoots] = useState<TreeNode[]>(childrenCache.get(cwd) || []);
  const [loading, setLoading] = useState(roots.length === 0);
  const [expanded, setExpanded] = useState<Set<string>>(() => getExpandedSet(cwd));
  const cwdRef = useRef(cwd);

  useEffect(() => {
    cwdRef.current = cwd;
    setExpanded(getExpandedSet(cwd));
    const cached = childrenCache.get(cwd);
    if (cached) {
      setRoots(cached);
      setLoading(false);
    } else {
      setLoading(true);
      fetchChildren(cwd).then((nodes) => {
        if (cwdRef.current === cwd) {
          setRoots(nodes);
          setLoading(false);
        }
      });
    }
  }, [cwd]);

  const toggleExpand = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        expandedCache.set(cwd, next);
        return next;
      });
    },
    [cwd]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (roots.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Empty directory
      </div>
    );
  }

  return (
    <div className="py-1">
      {roots.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          expandedSet={expanded}
          onToggleExpand={toggleExpand}
        />
      ))}
    </div>
  );
}
