import { describe, expect, it } from "vitest";
import { headerActionsVisibility } from "@/lib/header-actions";

describe("headerActionsVisibility", () => {
  it("hideActions: true -> nothing shows", () => {
    expect(headerActionsVisibility({ hideActions: true })).toEqual({
      showSessionActions: false,
      showUsage: false,
    });
  });

  it("usageOnly: true -> only usage shows", () => {
    expect(headerActionsVisibility({ usageOnly: true })).toEqual({
      showSessionActions: false,
      showUsage: true,
    });
  });

  it("neither flag -> everything shows", () => {
    expect(headerActionsVisibility({})).toEqual({
      showSessionActions: true,
      showUsage: true,
    });
  });

  it("undefined config -> nothing shows (guard)", () => {
    expect(headerActionsVisibility(undefined as any)).toEqual({
      showSessionActions: false,
      showUsage: false,
    });
  });

  it("hideActions overrides usageOnly", () => {
    expect(headerActionsVisibility({ hideActions: true, usageOnly: true })).toEqual({
      showSessionActions: false,
      showUsage: false,
    });
  });
});
