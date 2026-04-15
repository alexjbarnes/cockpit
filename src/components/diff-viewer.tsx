"use client";

import { Component, useMemo, type ReactNode } from "react";
import { createTwoFilesPatch } from "diff";
import { PatchDiff } from "@pierre/diffs/react";
import { useSettings } from "@/hooks/use-settings";

class DiffErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    if (this.state.error) {
      return this.props.fallback || (
        <pre className="p-3 text-xs text-muted-foreground">Unable to render diff</pre>
      );
    }
    return this.props.children;
  }
}

export { DiffErrorBoundary };

export const DIFF_SELECTABLE_CSS = "[data-column-content] { user-select: text; -webkit-user-select: text; }";

interface DiffViewerProps {
  filePath: string;
  oldString: string;
  newString: string;
  dark?: boolean;
}

export function DiffViewer({ filePath, oldString, newString, dark }: DiffViewerProps) {
  const { settings } = useSettings();
  const patch = useMemo(
    () => createTwoFilesPatch(`a/${filePath}`, `b/${filePath}`, oldString, newString, "", "", { context: 3 }),
    [filePath, oldString, newString]
  );

  return (
    <div className="overflow-x-auto rounded text-xs">
      <DiffErrorBoundary>
        <PatchDiff
          patch={patch}
          options={{
            theme: { dark: "pierre-dark", light: "pierre-light" },
            themeType: dark ? "dark" : "light",
            disableFileHeader: true,
            overflow: "wrap",
            diffStyle: settings.diffStyle,
            unsafeCSS: DIFF_SELECTABLE_CSS,
          }}
        />
      </DiffErrorBoundary>
    </div>
  );
}
