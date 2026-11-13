import { describe, expect, it } from "vitest";
import { replaceTerminalTabId, restoreSplit, tabLayoutSignature } from "@/lib/tab-restore";

const open = ["chat", "file::/repo/NOTE.md", "terminal::t1"];

describe("restoreSplit", () => {
  it("brings back a split whose tabs are still open", () => {
    expect(restoreSplit("file::/repo/NOTE.md", ["file::/repo/NOTE.md"], open)).toEqual({
      splitTabId: "file::/repo/NOTE.md",
      rightPaneTabIds: ["file::/repo/NOTE.md"],
    });
  });

  it("adds the split tab to the right pane when it was left out", () => {
    expect(restoreSplit("file::/repo/NOTE.md", [], open).rightPaneTabIds).toEqual(["file::/repo/NOTE.md"]);
  });

  it("drops right-pane tab ids that are no longer open", () => {
    expect(restoreSplit("file::/repo/NOTE.md", ["file::/gone.md", "terminal::t1"], open).rightPaneTabIds).toEqual([
      "terminal::t1",
      "file::/repo/NOTE.md",
    ]);
  });

  it("is no split when the split tab is gone, or the chat tab", () => {
    expect(restoreSplit("file::/gone.md", ["file::/gone.md"], open)).toEqual({ splitTabId: null, rightPaneTabIds: [] });
    expect(restoreSplit("chat", ["chat"], open)).toEqual({ splitTabId: null, rightPaneTabIds: [] });
    expect(restoreSplit(null, ["file::/repo/NOTE.md"], open)).toEqual({ splitTabId: null, rightPaneTabIds: [] });
  });

  it("survives a payload of the wrong shape", () => {
    expect(restoreSplit(42, "nope", open)).toEqual({ splitTabId: null, rightPaneTabIds: [] });
  });
});

describe("replaceTerminalTabId", () => {
  const state = {
    tabs: [
      { type: "chat" as const, id: "chat" },
      { type: "terminal" as const, id: "terminal::old", terminalId: "old" },
      { type: "file" as const, id: "file::/repo/NOTE.md" },
    ],
    activeTabId: "terminal::old",
    splitTabId: "terminal::old",
    rightPaneTabIds: ["terminal::old", "file::/repo/NOTE.md"],
  };

  it("moves the tab, the active tab and the split to the new terminal", () => {
    const next = replaceTerminalTabId(state, "old", "new");
    expect(next.tabs).toEqual([
      { type: "chat", id: "chat" },
      { type: "terminal", id: "terminal::new", terminalId: "new" },
      { type: "file", id: "file::/repo/NOTE.md" },
    ]);
    expect(next.activeTabId).toBe("terminal::new");
    expect(next.splitTabId).toBe("terminal::new");
    expect(next.rightPaneTabIds).toEqual(["terminal::new", "file::/repo/NOTE.md"]);
  });

  it("leaves the state alone when no tab holds that terminal", () => {
    expect(replaceTerminalTabId(state, "gone", "new")).toBe(state);
  });
});

describe("tabLayoutSignature", () => {
  it("changes when a tab opens, the split moves, or the pane list changes", () => {
    const base = tabLayoutSignature(["chat", "file::/a"], null, []);
    expect(tabLayoutSignature(["chat", "file::/a", "file::/b"], null, [])).not.toBe(base);
    expect(tabLayoutSignature(["chat", "file::/a"], "file::/a", ["file::/a"])).not.toBe(base);
    expect(tabLayoutSignature(["chat", "file::/a"], null, ["file::/a"])).not.toBe(base);
  });

  it("does not change when only the active tab does", () => {
    expect(tabLayoutSignature(["chat", "file::/a"], null, [])).toBe(tabLayoutSignature(["chat", "file::/a"], null, []));
  });
});
