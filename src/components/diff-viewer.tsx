"use client";

import { Component, useMemo, type ReactNode } from "react";
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

function buildUnifiedDiff(
  filePath: string,
  oldStr: string,
  newStr: string
): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  const header = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];

  const deletions = oldLines.map((l) => `-${l}`);
  const additions = newLines.map((l) => `+${l}`);

  return [...header, ...deletions, ...additions].join("\n");
}

interface DiffViewerProps {
  filePath: string;
  oldString: string;
  newString: string;
  dark?: boolean;
}

export function DiffViewer({ filePath, oldString, newString, dark }: DiffViewerProps) {
  const { settings } = useSettings();
  const patch = useMemo(
    () => buildUnifiedDiff(filePath, oldString, newString),
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
          }}
        />
      </DiffErrorBoundary>
    </div>
  );
}
