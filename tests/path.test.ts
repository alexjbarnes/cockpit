import { describe, expect, it } from "vitest";
import { pathBasename, pathDirname, shortPath, splitPathSegments } from "@/lib/path";

describe("pathBasename", () => {
  it("extracts basename from Unix path", () => {
    expect(pathBasename("/foo/bar/baz.txt")).toBe("baz.txt");
  });

  it("extracts basename from Windows path", () => {
    expect(pathBasename("C:\\foo\\bar\\baz.txt")).toBe("baz.txt");
  });

  it("extracts basename from mixed separators", () => {
    expect(pathBasename("/foo\\bar/baz.txt")).toBe("baz.txt");
  });

  it("returns full string when no separators", () => {
    expect(pathBasename("file.txt")).toBe("file.txt");
  });

  it("handles trailing separator", () => {
    expect(pathBasename("/foo/bar/")).toBe("");
  });

  it("handles empty string", () => {
    expect(pathBasename("")).toBe("");
  });

  it("handles single character", () => {
    expect(pathBasename("a")).toBe("a");
  });

  it("handles root path", () => {
    expect(pathBasename("/")).toBe("");
  });
});

describe("pathDirname", () => {
  it("extracts dirname from Unix path", () => {
    expect(pathDirname("/foo/bar/baz.txt")).toBe("/foo/bar");
  });

  it("extracts dirname from Windows path", () => {
    expect(pathDirname("C:\\foo\\bar\\baz.txt")).toBe("C:\\foo\\bar");
  });

  it("extracts dirname from mixed separators", () => {
    expect(pathDirname("/foo\\bar/baz.txt")).toBe("/foo\\bar");
  });

  it("returns empty string when no separators", () => {
    expect(pathDirname("file.txt")).toBe("");
  });

  it("handles trailing separator", () => {
    expect(pathDirname("/foo/bar/")).toBe("/foo/bar");
  });

  it("handles empty string", () => {
    expect(pathDirname("")).toBe("");
  });

  it("handles root path", () => {
    expect(pathDirname("/")).toBe("");
  });

  it("handles single level path", () => {
    expect(pathDirname("/file.txt")).toBe("");
  });
});

describe("shortPath", () => {
  it("returns full path when parts <= maxParts", () => {
    expect(shortPath("/foo/bar")).toBe("/foo/bar");
  });

  it("truncates path when parts > maxParts", () => {
    expect(shortPath("/foo/bar/baz/qux")).toBe(".../baz/qux");
  });

  it("uses last 2 parts by default", () => {
    expect(shortPath("/a/b/c/d/e")).toBe(".../d/e");
  });

  it("respects custom maxParts for threshold only", () => {
    expect(shortPath("/a/b/c/d/e", 4)).toBe(".../d/e");
    expect(shortPath("/a/b/c/d/e", 7)).toBe("/a/b/c/d/e");
  });

  it("respects maxParts of 1", () => {
    expect(shortPath("/a/b/c/d", 1)).toBe(".../c/d");
  });

  it("normalizes Windows separators to forward slash in output", () => {
    expect(shortPath("C:\\a\\b\\c\\d\\e")).toBe(".../d/e");
  });

  it("normalizes mixed separators to forward slash in output", () => {
    expect(shortPath("/a\\b/c\\d")).toBe(".../c/d");
  });

  it("truncates when leading empty segment pushes count over maxParts", () => {
    expect(shortPath("/a/b/c", 3)).toBe(".../b/c");
    expect(shortPath("/a/b/c", 5)).toBe("/a/b/c");
  });

  it("handles single part path", () => {
    expect(shortPath("file.txt")).toBe("file.txt");
  });

  it("handles path with trailing slashes", () => {
    expect(shortPath("/a/b/c/d/")).toBe(".../d/");
  });
});

describe("splitPathSegments", () => {
  it("splits Unix path into segments", () => {
    expect(splitPathSegments("/foo/bar/baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("splits Windows path into segments", () => {
    expect(splitPathSegments("C:\\foo\\bar\\baz")).toEqual(["C:", "foo", "bar", "baz"]);
  });

  it("filters empty segments from leading slash", () => {
    expect(splitPathSegments("/foo/bar")).toEqual(["foo", "bar"]);
  });

  it("filters empty segments from trailing slash", () => {
    expect(splitPathSegments("foo/bar/")).toEqual(["foo", "bar"]);
  });

  it("filters empty segments from double slashes", () => {
    expect(splitPathSegments("foo//bar///baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("handles mixed separators", () => {
    expect(splitPathSegments("foo/bar\\baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("returns empty array for empty string", () => {
    expect(splitPathSegments("")).toEqual([]);
  });

  it("returns empty array for only separators", () => {
    expect(splitPathSegments("///")).toEqual([]);
  });

  it("returns single segment for no separators", () => {
    expect(splitPathSegments("file.txt")).toEqual(["file.txt"]);
  });

  it("handles relative paths", () => {
    expect(splitPathSegments("../foo/bar")).toEqual(["..", "foo", "bar"]);
  });
});
