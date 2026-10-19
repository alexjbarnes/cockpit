// One line describing a tool call, shared by the approval card and the
// notification about the same request.
import { describe, expect, it } from "vitest";
import { formatToolSummary } from "@/lib/tool-summary";

describe("formatToolSummary", () => {
  it("names the command for a Bash call", () => {
    expect(formatToolSummary("Bash", { command: "rm -rf build" })).toBe("rm -rf build");
  });

  it("shortens a long path rather than printing all of it", () => {
    const summary = formatToolSummary("Read", { file_path: "/home/dev/repos/cockpit/src/components/whatever/a.ts" });
    expect(summary).not.toBe("/home/dev/repos/cockpit/src/components/whatever/a.ts");
    expect(summary).toContain("a.ts");
  });

  it("prefers the url for a fetch, and the query for a search", () => {
    expect(formatToolSummary("WebFetch", { url: "https://example.com/x" })).toBe("https://example.com/x");
    expect(formatToolSummary("WebSearch", { query: "how tall is everest" })).toBe("how tall is everest");
  });

  it("cuts at eighty characters by default, and at the length a caller asks for", () => {
    const command = "y".repeat(120);

    expect(formatToolSummary("Bash", { command })).toHaveLength(83); // 80 + the ellipsis
    expect(formatToolSummary("Bash", { command }, { maxLength: 200 })).toBe(command);
  });

  it("has nothing to say about a tool it does not know", () => {
    expect(formatToolSummary("AskUserQuestion", { questions: [] })).toBe("");
  });
});
