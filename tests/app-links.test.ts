// Which links written in Markdown are pages of Cockpit itself.

import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAppPath } from "@/lib/app-links";

describe("a link to one of Cockpit's own pages", () => {
  it("is a path under a section the app has", () => {
    expect(isAppPath("/issues/CK-12")).toBe(true);
    expect(isAppPath("/issues")).toBe(true);
    expect(isAppPath("/issues?project=CK")).toBe(true);
    expect(isAppPath("/sessions/abc?historyView=true")).toBe(true);
    expect(isAppPath("/inbox/1#top")).toBe(true);
    expect(isAppPath("/settings/workflows/p1")).toBe(true);
  });

  it("is not another site, a bare root, or a path that only looks local", () => {
    expect(isAppPath("https://example.com/issues/CK-12")).toBe(false);
    expect(isAppPath("//example.com/issues")).toBe(false);
    expect(isAppPath("/home/dev/repos/cockpit/server.ts")).toBe(false);
    expect(isAppPath("/issuesandmore")).toBe(false);
    expect(isAppPath("/")).toBe(false);
    expect(isAppPath("issues/CK-12")).toBe(false);
    expect(isAppPath("#heading")).toBe(false);
    expect(isAppPath("mailto:someone@example.com")).toBe(false);
    expect(isAppPath("")).toBe(false);
    expect(isAppPath(undefined)).toBe(false);
    expect(isAppPath(null)).toBe(false);
  });

  it("knows every section the app has", () => {
    const sections = readdirSync(path.join(__dirname, "..", "src", "app", "(app)"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(sections.length).toBeGreaterThan(5);
    for (const section of sections) expect(isAppPath(`/${section}`), section).toBe(true);
  });
});
