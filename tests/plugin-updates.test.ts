// The one-line result of a bulk plugin update. Its value is naming the plugin
// that did not update and repeating the CLI's own reason, since that is where
// the answer is ("synced from your claude.ai account with no marketplace
// backing", for instance).
import { describe, expect, it } from "vitest";
import { summariseUpdateResults } from "@/lib/plugin-updates";

describe("summariseUpdateResults", () => {
  it("counts a clean run", () => {
    expect(summariseUpdateResults([{ id: "a@m", ok: true, message: "" }])).toBe("Updated 1 plugin.");
    expect(
      summariseUpdateResults([
        { id: "a@m", ok: true, message: "" },
        { id: "b@m", ok: true, message: "" },
      ]),
    ).toBe("Updated 2 plugins.");
  });

  it("names a failure and carries the CLI's reason", () => {
    expect(
      summariseUpdateResults([
        { id: "a@m", ok: true, message: "" },
        {
          id: "b@m",
          ok: false,
          message:
            "This plugin is synced from your claude.ai account with no marketplace backing — it cannot be updated here. Manage it on claude.ai.",
        },
      ]),
    ).toBe(
      "Updated 1 of 2. Failed: b@m: This plugin is synced from your claude.ai account with no marketplace backing — it cannot be updated here.",
    );
  });

  it("collapses a multi-line reason onto the one line", () => {
    expect(summariseUpdateResults([{ id: "b@m", ok: false, message: "first line\n\nsecond line" }])).toBe(
      "Updated 0 of 1. Failed: b@m: first line second line",
    );
  });

  it("trims a reason too long to read in a summary", () => {
    const summary = summariseUpdateResults([{ id: "b@m", ok: false, message: "x".repeat(300) }]);

    expect(summary).toContain("b@m: ");
    expect(summary.length).toBeLessThan(200);
  });

  it("keeps a failure that came with no message", () => {
    expect(summariseUpdateResults([{ id: "b@m", ok: false, message: "" }])).toBe("Updated 0 of 1. Failed: b@m");
  });

  it("says so when there was nothing to update", () => {
    expect(summariseUpdateResults([])).toBe("No plugins to update.");
  });
});
