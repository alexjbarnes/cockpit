import { describe, expect, it } from "vitest";
import { effectivePermissionMode, permissionModeMismatch } from "@/lib/permission-mode";

describe("effectivePermissionMode", () => {
  it("trusts the request until the CLI has reported", () => {
    expect(effectivePermissionMode("bypass", null)).toBe("bypass");
    expect(effectivePermissionMode("auto", null)).toBe("auto");
  });

  // Cockpit's bypass keeps the CLI in manual and approves every prompt itself.
  it("reads a CLI in manual under a chosen bypass as bypass", () => {
    expect(effectivePermissionMode("bypass", "manual")).toBe("bypass");
    expect(effectivePermissionMode("bypass", "default")).toBe("bypass");
    expect(effectivePermissionMode("manual", "default")).toBe("manual");
  });

  // A CLI in auto decides for itself whatever was chosen, so a session whose
  // selector says Bypass can be running under the CLI's classifier.
  it("takes a CLI in auto at its word, whatever was chosen", () => {
    expect(effectivePermissionMode("bypass", "auto")).toBe("auto");
    expect(effectivePermissionMode("manual", "auto")).toBe("auto");
  });

  it("maps the CLI's other modes", () => {
    expect(effectivePermissionMode("manual", "bypassPermissions")).toBe("bypass");
    expect(effectivePermissionMode("manual", "acceptEdits")).toBe("acceptEdits");
    expect(effectivePermissionMode("manual", "dontAsk")).toBe("dontAsk");
  });

  it("leaves the permission axis alone in plan mode, and for a mode it does not know", () => {
    expect(effectivePermissionMode("bypass", "plan")).toBe("bypass");
    expect(effectivePermissionMode("auto", "someFutureMode")).toBe("auto");
  });
});

describe("permissionModeMismatch", () => {
  it("says nothing when the CLI agrees, or has not reported", () => {
    expect(permissionModeMismatch("bypass", "manual")).toBeNull();
    expect(permissionModeMismatch("auto", "auto")).toBeNull();
    expect(permissionModeMismatch("manual", null)).toBeNull();
  });

  it("names the real mode and what it means", () => {
    expect(permissionModeMismatch("bypass", "auto")).toBe(
      "Claude Code is running in Auto, not Bypass: its classifier approves or blocks calls before cockpit is asked.",
    );
    expect(permissionModeMismatch("auto", "default")).toBe(
      "Claude Code is running in Manual, not Auto: every prompt comes to cockpit to answer.",
    );
    expect(permissionModeMismatch("manual", "dontAsk")).toContain("anything not already allowed is refused");
  });
});
