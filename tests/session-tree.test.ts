import { describe, expect, it } from "vitest";
import { absolutePath, changeDecoration, newlySelectedPath, toTreeGitStatus } from "@/lib/session-tree";

describe("toTreeGitStatus", () => {
  it("keeps the statuses the tree knows", () => {
    for (const status of ["added", "modified", "deleted", "ignored", "renamed", "untracked"]) {
      expect(toTreeGitStatus(status)).toBe(status);
    }
  });

  it("treats an unknown status as modified", () => {
    expect(toTreeGitStatus("copied")).toBe("modified");
    expect(toTreeGitStatus("")).toBe("modified");
  });
});

describe("newlySelectedPath", () => {
  const files = new Set(["src/a.ts", "src/b.ts", "README.md"]);

  it("returns the path a click added", () => {
    expect(newlySelectedPath([], ["src/a.ts"], files)).toBe("src/a.ts");
    expect(newlySelectedPath(["src/a.ts"], ["src/a.ts", "src/b.ts"], files)).toBe("src/b.ts");
  });

  it("takes the last newly selected path when several arrive at once", () => {
    expect(newlySelectedPath([], ["src/a.ts", "src/b.ts"], files)).toBe("src/b.ts");
  });

  it("ignores directories and paths that are not files", () => {
    expect(newlySelectedPath([], ["src"], files)).toBeNull();
    expect(newlySelectedPath([], ["src/"], files)).toBeNull();
  });

  it("returns nothing when the selection did not grow", () => {
    expect(newlySelectedPath(["src/a.ts"], ["src/a.ts"], files)).toBeNull();
    expect(newlySelectedPath(["src/a.ts"], [], files)).toBeNull();
  });
});

describe("changeDecoration", () => {
  it("shows additions and deletions", () => {
    expect(changeDecoration({ additions: 12, deletions: 3 })).toEqual({ text: "+12 -3", title: "12 additions, 3 deletions" });
  });

  it("shows only the side that changed", () => {
    expect(changeDecoration({ additions: 4, deletions: 0 })).toEqual({ text: "+4", title: "4 additions, 0 deletions" });
    expect(changeDecoration({ additions: 0, deletions: 2 })).toEqual({ text: "-2", title: "0 additions, 2 deletions" });
  });

  it("has nothing to show for a file with no line changes", () => {
    expect(changeDecoration({ additions: 0, deletions: 0 })).toBeNull();
  });
});

describe("absolutePath", () => {
  it("joins the session directory and the relative path", () => {
    expect(absolutePath("/repos/cockpit", "src/index.ts")).toBe("/repos/cockpit/src/index.ts");
  });

  it("does not double the separator", () => {
    expect(absolutePath("/repos/cockpit/", "src/index.ts")).toBe("/repos/cockpit/src/index.ts");
  });

  it("leaves an absolute path alone", () => {
    expect(absolutePath("/repos/cockpit", "/elsewhere/file.ts")).toBe("/elsewhere/file.ts");
  });
});
