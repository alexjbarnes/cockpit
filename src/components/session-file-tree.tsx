"use client";

import { type GitStatusEntry, prepareFileTreeInput } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef } from "react";
import { newlySelectedPath } from "@/lib/session-tree";

export type SessionTreeMode = "changes" | "files" | "picker";

interface SessionFileTreeProps {
  mode: SessionTreeMode;
  /** Paths relative to the session's directory. */
  paths: readonly string[];
  gitStatus?: readonly GitStatusEntry[];
  /** `+N -M` for a changed file, keyed by path. */
  decorations?: ReadonlyMap<string, { text: string; title: string }>;
  onOpen: (path: string) => void;
  /** Override the sidebar's height when the tree is inside a dialog. */
  height?: string | number;
  testId?: string;
}

const DEFAULT_HEIGHT = "clamp(16rem, calc(100dvh - 22rem), 48rem)";

/** The tree sits in the shadows: map cockpit's tokens onto its variables so a
 *  theme switch needs no work here. */
const TREE_STYLE = {
  "--trees-bg-override": "transparent",
  "--trees-fg-override": "var(--color-foreground)",
  "--trees-fg-muted-override": "var(--color-muted-foreground)",
  "--trees-border-color-override": "var(--color-border)",
  "--trees-selected-bg-override": "var(--color-accent)",
  "--trees-selected-fg-override": "var(--color-foreground)",
  "--trees-focus-ring-color-override": "var(--color-ring)",
  "--trees-font-size-override": "12px",
  "--trees-git-added-color-override": "var(--color-green-500)",
  "--trees-git-untracked-color-override": "var(--color-green-500)",
  "--trees-git-deleted-color-override": "var(--color-red-500)",
  "--trees-git-modified-color-override": "var(--color-yellow-500)",
  "--trees-git-renamed-color-override": "var(--color-blue-500)",
  "--trees-git-ignored-color-override": "var(--color-muted-foreground)",
} as CSSProperties;

/** Every directory a path list implies, for re-expanding a Changes tree after
 *  its data is refreshed. */
function directoryPaths(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  return [...directories];
}

/**
 * One `@pierre/trees` file tree, shared by the sidebar's Changes and Files
 * views. The two differ only in the paths they are given and whether their
 * directories start open.
 */
export function SessionFileTree({ mode, paths, gitStatus, decorations, onOpen, height, testId }: SessionFileTreeProps) {
  const preparedInput = useMemo(() => prepareFileTreeInput(paths), [paths]);
  const pathsRef = useRef(new Set(paths));
  pathsRef.current = new Set(paths);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const decorationsRef = useRef(decorations);
  decorationsRef.current = decorations;
  const selectedRef = useRef<readonly string[]>([]);
  const modelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);

  const { model } = useFileTree({
    preparedInput,
    density: "compact",
    icons: { set: "complete", colored: true },
    initialExpansion: mode === "changes" ? "open" : "closed",
    gitStatus,
    renderRowDecoration: ({ row }) => {
      if (row.kind !== "file") return null;
      return decorationsRef.current?.get(row.path) ?? null;
    },
    onSelectionChange: (selected) => {
      const path = newlySelectedPath(selectedRef.current, selected, pathsRef.current);
      selectedRef.current = selected;
      if (!path) return;
      onOpenRef.current(path);
      // Leave the row unselected: clicking it again should reopen the tab it
      // opened, and the model reports no change for an already-selected row.
      queueMicrotask(() => modelRef.current?.getItem(path)?.deselect());
    },
  });

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  const resetRef = useRef(preparedInput);
  useEffect(() => {
    if (resetRef.current === preparedInput) return;
    resetRef.current = preparedInput;
    // resetPaths takes expanded paths, not an expansion policy, so a Changes
    // tree is reopened to the same depth it had on first render.
    model.resetPaths({
      preparedInput,
      ...(mode === "changes" ? { initialExpandedPaths: directoryPaths(paths) } : {}),
    });
  }, [model, mode, paths, preparedInput]);

  return (
    <FileTree
      model={model}
      className="w-full min-w-0 text-xs"
      style={{ height: height ?? DEFAULT_HEIGHT, ...TREE_STYLE }}
      data-testid={testId ?? `sidebar-files-changes-tree-${mode}`}
    />
  );
}
