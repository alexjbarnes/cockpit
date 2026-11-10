import { describe, expect, it } from "vitest";
import { isCwdIgnored, isPathWithin, normaliseFolderPath, parseIgnoredFolders } from "@/lib/ignored-folders";

describe("normaliseFolderPath", () => {
  it("trims, drops trailing separators and keeps the root", () => {
    expect(normaliseFolderPath(" /a/b/ ")).toBe("/a/b");
    expect(normaliseFolderPath("/")).toBe("/");
  });

  it("expands a leading home shorthand only with a home directory", () => {
    expect(normaliseFolderPath("~/archive", "/home/alex")).toBe("/home/alex/archive");
    expect(normaliseFolderPath("~", "/home/alex")).toBe("/home/alex");
    expect(normaliseFolderPath("~/archive")).toBeUndefined();
  });

  it("rejects another user's home, relative paths and a bare drive", () => {
    expect(normaliseFolderPath("~alex/archive", "/home/me")).toBeUndefined();
    expect(normaliseFolderPath("archive/2026")).toBeUndefined();
    expect(normaliseFolderPath("C:")).toBeUndefined();
    expect(normaliseFolderPath("")).toBeUndefined();
  });

  it("normalises Windows separators and keeps a drive root", () => {
    expect(normaliseFolderPath("C:\\reviews\\ai\\")).toBe("C:/reviews/ai");
    expect(normaliseFolderPath("C:/")).toBe("C:/");
  });
});

describe("parseIgnoredFolders", () => {
  it("keeps only absolute strings, normalises them and removes duplicates", () => {
    expect(parseIgnoredFolders([" /a/ ", "/a", 42, "relative", "~/x", null], "/home/me")).toEqual(["/a", "/home/me/x"]);
  });

  it("returns an empty list for a missing or non-array value", () => {
    expect(parseIgnoredFolders(undefined)).toEqual([]);
    expect(parseIgnoredFolders(" /a ")).toEqual([]);
  });
});

describe("isPathWithin", () => {
  it("matches the folder itself and any descendant", () => {
    expect(isPathWithin("/a/b", "/a/b")).toBe(true);
    expect(isPathWithin("/a/b/c/d", "/a/b")).toBe(true);
    expect(isPathWithin("/a/b/", "/a/b")).toBe(true);
  });

  it("does not match a sibling that shares a prefix", () => {
    expect(isPathWithin("/a/bc", "/a/b")).toBe(false);
    expect(isPathWithin("/a/b-2", "/a/b")).toBe(false);
  });

  it("lets the root match every absolute path", () => {
    expect(isPathWithin("/a/b", "/")).toBe(true);
    expect(isPathWithin("C:/a/b", "/")).toBe(true);
  });

  it("handles Windows drive roots and separators", () => {
    expect(isPathWithin("C:\\reviews\\x", "C:/reviews")).toBe(true);
    expect(isPathWithin("C:/other", "C:/reviews")).toBe(false);
    expect(isPathWithin("C:/anything", "C:/")).toBe(true);
  });
});

describe("isCwdIgnored", () => {
  it("is false without a cwd or without folders", () => {
    expect(isCwdIgnored(undefined, ["/a"])).toBe(false);
    expect(isCwdIgnored("/a/b", [])).toBe(false);
    expect(isCwdIgnored("/a/b", undefined)).toBe(false);
  });

  it("is true for a cwd inside any listed folder", () => {
    expect(isCwdIgnored("/a/b/c", ["/x", "/a/b"])).toBe(true);
    expect(isCwdIgnored("/a/bc", ["/x", "/a/b"])).toBe(false);
  });
});
