import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolCard } from "@/components/tool-card";
import type { ToolUse } from "@/types";

function readTool(name: string, filePath: string): ToolUse {
  return {
    id: "toolu_test",
    name,
    input: JSON.stringify({ file_path: filePath }),
    output: "",
    status: "done",
  };
}

describe("ToolCard button nesting", () => {
  it("Read tool with file path has exactly one <button> and a role=button span", () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCard, { tool: readTool("Read", "/home/dev/repos/cockpit/src/app/page.tsx") }),
    );
    expect((html.match(/<button/g) || []).length).toBe(1);
    expect(html.includes('role="button"')).toBe(true);
  });

  it("Edit tool with file path has exactly one <button> and a role=button span", () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCard, { tool: readTool("Edit", "/home/dev/repos/cockpit/src/app/page.tsx") }),
    );
    expect((html.match(/<button/g) || []).length).toBe(1);
    expect(html.includes('role="button"')).toBe(true);
  });

  it("Write tool with file path has exactly one <button> and a role=button span", () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCard, { tool: readTool("Write", "/home/dev/repos/cockpit/src/app/page.tsx") }),
    );
    expect((html.match(/<button/g) || []).length).toBe(1);
    expect(html.includes('role="button"')).toBe(true);
  });
});

describe("ToolCard images", () => {
  it("shows a picture the tool returned, which its output line cannot carry", () => {
    const tool: ToolUse = {
      ...readTool("Read", "/tmp/shot.png"),
      images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }],
    };
    const html = renderToStaticMarkup(
      React.createElement(ToolCard, {
        tool,
        expandedToolIds: { current: new Set([tool.id]) } as React.RefObject<Set<string>>,
      }),
    );

    expect(html).toContain('data-testid="tool-image"');
    expect(html).toContain("data:image/png;base64,iVBORw0KGgo=");
  });
});
