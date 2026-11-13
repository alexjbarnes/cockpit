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

import { openPlanTab } from "@/lib/tab-restore";

describe("openPlanTab", () => {
  const plan = { id: "plan" };
  const base = { tabs: [{ id: "chat" }], activeTabId: "chat", splitTabId: null as string | null, rightPaneTabIds: [] as string[] };

  it("shows the plan when simply asked to", () => {
    const next = openPlanTab(base, plan);
    expect(next.tabs.map((t) => t.id)).toEqual(["chat", "plan"]);
    expect(next.activeTabId).toBe("plan");
    expect(next.splitTabId).toBeNull();
  });

  it("opens it beside the chat when nothing is split", () => {
    const next = openPlanTab(base, plan, { beside: true });
    expect(next).toMatchObject({ activeTabId: "chat", splitTabId: "plan", rightPaneTabIds: ["plan"] });
    // A plan that was the tab in front moves over, and the chat takes its place.
    const fromFront = openPlanTab({ ...base, tabs: [{ id: "chat" }, plan], activeTabId: "plan" }, plan, { beside: true });
    expect(fromFront).toMatchObject({ activeTabId: "chat", splitTabId: "plan" });
  });

  it("leaves a split the user arranged alone", () => {
    const split = {
      tabs: [{ id: "chat" }, { id: "file::/a" }],
      activeTabId: "chat",
      splitTabId: "file::/a",
      rightPaneTabIds: ["file::/a"],
    };
    const shown = openPlanTab(split, plan, { beside: true });
    expect(shown).toMatchObject({ splitTabId: "file::/a", rightPaneTabIds: ["file::/a"], activeTabId: "plan" });
    const quiet = openPlanTab(split, plan, { beside: true, quiet: true });
    expect(quiet).toMatchObject({ splitTabId: "file::/a", activeTabId: "chat" });
    expect(quiet.tabs.map((t) => t.id)).toContain("plan");
  });

  it("adds the tab without taking the screen when quiet", () => {
    const next = openPlanTab(base, plan, { quiet: true });
    expect(next.tabs.map((t) => t.id)).toEqual(["chat", "plan"]);
    expect(next.activeTabId).toBe("chat");
    // Already open and nothing to change: the same state, so nothing re-renders or is saved.
    expect(openPlanTab(next, plan, { quiet: true })).toBe(next);
  });

  it("brings a plan already in the right pane to its front, unless quiet", () => {
    const behind = {
      tabs: [{ id: "chat" }, { id: "file::/a" }, plan],
      activeTabId: "chat",
      splitTabId: "file::/a",
      rightPaneTabIds: ["file::/a", "plan"],
    };
    expect(openPlanTab(behind, plan).splitTabId).toBe("plan");
    expect(openPlanTab(behind, plan, { quiet: true }).splitTabId).toBe("file::/a");
  });
});
