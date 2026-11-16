import { describe, expect, it } from "vitest";
import { attachmentHref, attachmentIdFromHref, isImagePath, mapImageTargets } from "@/lib/markdown-images";

describe("isImagePath", () => {
  it("knows the image files a comment can show, whatever their case", () => {
    for (const name of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp"]) expect(isImagePath(`/tmp/${name}`)).toBe(true);
  });

  it("looks past a query or fragment", () => {
    expect(isImagePath("https://example.com/a.png?size=2#top")).toBe(true);
  });

  it("refuses everything else, SVG included", () => {
    for (const name of ["a.svg", "a.pdf", "a.txt", "png", "a.png.txt"]) expect(isImagePath(`/tmp/${name}`)).toBe(false);
  });
});

describe("attachmentHref / attachmentIdFromHref", () => {
  it("round-trips an attachment's address", () => {
    const href = attachmentHref("CK-12", "abc-123");
    expect(href).toBe("/api/issues/CK-12/attachments/abc-123");
    expect(attachmentIdFromHref("CK-12", href)).toBe("abc-123");
  });

  it("matches the issue key in any case", () => {
    expect(attachmentIdFromHref("ck-12", "/api/issues/CK-12/attachments/abc")).toBe("abc");
  });

  it("is undefined for another issue's attachment and for anything else", () => {
    expect(attachmentIdFromHref("CK-12", "/api/issues/CK-13/attachments/abc")).toBeUndefined();
    expect(attachmentIdFromHref("CK-12", "/api/issues/CK-12/attachments/abc/extra")).toBeUndefined();
    expect(attachmentIdFromHref("CK-12", "https://example.com/a.png")).toBeUndefined();
    expect(attachmentIdFromHref("CK-12", "/tmp/a.png")).toBeUndefined();
  });
});

describe("mapImageTargets", () => {
  const upper = (md: string) => mapImageTargets(md, (target) => target.toUpperCase());

  it("gives each image its new target and keeps its caption", () => {
    expect(upper("Before ![Phone](/tmp/a.png) and ![](/tmp/b.png) after")).toBe("Before ![Phone](/TMP/A.PNG) and ![](/TMP/B.PNG) after");
  });

  it("hands the caption to the mapper", () => {
    const seen: string[] = [];
    mapImageTargets("![Option A](/tmp/a.png)", (target, alt) => {
      seen.push(`${alt}|${target}`);
      return target;
    });
    expect(seen).toEqual(["Option A|/tmp/a.png"]);
  });

  it("keeps a title, and reads a target written in angle brackets", () => {
    expect(upper('![A](/tmp/a.png "The title")')).toBe('![A](/TMP/A.PNG "The title")');
    expect(mapImageTargets("![A](</tmp/my shots/a.png>)", () => "/api/x")).toBe("![A](/api/x)");
  });

  it("wraps a new target that has a space in it", () => {
    expect(mapImageTargets("![A](/api/x)", () => "/home/a b/c.png")).toBe("![A](</home/a b/c.png>)");
  });

  it("leaves an image exactly as written when its target does not change", () => {
    const md = "![A]( </tmp/a b.png> 'T' )";
    expect(mapImageTargets(md, (target) => target)).toBe(md);
  });

  it("leaves links alone: only images are rewritten", () => {
    expect(upper("[a link](/tmp/a.png)")).toBe("[a link](/tmp/a.png)");
  });

  it("leaves an image inside a fenced block as text", () => {
    const md = ["```md", "![A](/tmp/a.png)", "```", "![B](/tmp/b.png)"].join("\n");
    expect(upper(md)).toBe(["```md", "![A](/tmp/a.png)", "```", "![B](/TMP/B.PNG)"].join("\n"));
  });

  it("closes a fence only on its own kind and length", () => {
    const md = ["````", "```", "![A](/tmp/a.png)", "~~~", "````", "![B](/tmp/b.png)"].join("\n");
    expect(upper(md)).toBe(["````", "```", "![A](/tmp/a.png)", "~~~", "````", "![B](/TMP/B.PNG)"].join("\n"));
    const tilde = ["~~~", "![A](/tmp/a.png)", "~~~ not a close", "~~~", "![B](/tmp/b.png)"].join("\n");
    expect(upper(tilde)).toBe(["~~~", "![A](/tmp/a.png)", "~~~ not a close", "~~~", "![B](/TMP/B.PNG)"].join("\n"));
  });

  it("leaves an image inside a code span as text, and rewrites the ones around it", () => {
    expect(upper("![A](/a.png) `![B](/b.png)` ``![C](/c.png) ` `` ![D](/d.png)")).toBe(
      "![A](/A.PNG) `![B](/b.png)` ``![C](/c.png) ` `` ![D](/D.PNG)",
    );
  });

  it("treats a backtick with no partner as an ordinary character", () => {
    expect(upper("a ` b ![A](/a.png)")).toBe("a ` b ![A](/A.PNG)");
  });
});
