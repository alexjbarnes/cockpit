import { describe, expect, it } from "vitest";
import { isRememberedPath, memoryKey, PLACE_ROOTS, placeForPathname, resolvePlaceTarget, validRemembered } from "@/lib/places";

describe("placeForPathname", () => {
  it("maps every place's pages", () => {
    expect(placeForPathname("/")).toBe("sessions");
    expect(placeForPathname("/sessions/abc")).toBe("sessions");
    expect(placeForPathname("/issues")).toBe("issues");
    expect(placeForPathname("/issues/CK-12")).toBe("issues");
    expect(placeForPathname("/inbox")).toBe("inbox");
    expect(placeForPathname("/inbox/abc")).toBe("inbox");
    expect(placeForPathname("/jobs/job-1/edit")).toBe("jobs");
    expect(placeForPathname("/insights")).toBe("insights");
    expect(placeForPathname("/reviews/acme/storefront/12")).toBe("reviews");
    expect(placeForPathname("/settings/workflows/acme")).toBe("settings");
  });

  it("puts Workflows with Issues and Waiting with Inbox", () => {
    expect(placeForPathname("/workflows")).toBe("issues");
    expect(placeForPathname("/inbox/waiting")).toBe("inbox");
  });

  it("puts the settings-adjacent pages with Settings", () => {
    for (const page of ["agents", "claude-md", "commands", "hooks", "mcp-servers", "plugins", "skills"]) {
      expect(placeForPathname(`/${page}`)).toBe("settings");
      expect(placeForPathname(`/${page}/thing`)).toBe("settings");
    }
  });

  it("knows More, and nothing else", () => {
    expect(placeForPathname("/more")).toBe("more");
    expect(placeForPathname("/login")).toBeNull();
    expect(placeForPathname("/nope")).toBeNull();
  });

  it("looks past a query or fragment", () => {
    expect(placeForPathname("/sessions/abc?cwd=%2Ftmp")).toBe("sessions");
    expect(placeForPathname("/insights?tab=spend#top")).toBe("insights");
  });
});

describe("isRememberedPath", () => {
  it("remembers every place's screens, including the second sides", () => {
    expect(isRememberedPath("/sessions/abc")).toBe(true);
    expect(isRememberedPath("/workflows")).toBe(true);
    expect(isRememberedPath("/inbox/waiting")).toBe(true);
    expect(isRememberedPath("/settings/appearance")).toBe(true);
  });

  it("does not remember More or pages the navigation does not own", () => {
    expect(isRememberedPath("/more")).toBe(false);
    expect(isRememberedPath("/login")).toBe(false);
  });
});

describe("validRemembered", () => {
  it("accepts a path of the same place", () => {
    expect(validRemembered("issues", "/issues/CK-12")).toBe("/issues/CK-12");
    expect(validRemembered("issues", "/workflows")).toBe("/workflows");
  });

  it("refuses a path of another place, More, or nothing", () => {
    expect(validRemembered("issues", "/inbox")).toBeNull();
    expect(validRemembered("issues", "/more")).toBeNull();
    expect(validRemembered("issues", null)).toBeNull();
    expect(validRemembered("issues", "/nope")).toBeNull();
  });
});

describe("resolvePlaceTarget", () => {
  it("goes to the place's first screen when you are already there", () => {
    expect(resolvePlaceTarget("issues", "issues", "/issues/CK-12")).toBe(PLACE_ROOTS.issues);
    expect(resolvePlaceTarget("issues", "issues", "/workflows")).toBe("/issues");
    // Sessions' first screen is the pinned list, not the folder overview.
    expect(resolvePlaceTarget("sessions", "sessions", "/sessions/abc?cwd=%2Ftmp")).toBe("/sessions");
  });

  it("returns to the remembered screen when coming from another place", () => {
    expect(resolvePlaceTarget("sessions", "issues", "/sessions/abc?cwd=%2Ftmp")).toBe("/sessions/abc?cwd=%2Ftmp");
    expect(resolvePlaceTarget("issues", "sessions", "/workflows")).toBe("/workflows");
    expect(resolvePlaceTarget("settings", "issues", "/settings/appearance")).toBe("/settings/appearance");
  });

  it("falls back to the first screen when nothing is remembered or it is stale", () => {
    expect(resolvePlaceTarget("inbox", "jobs", null)).toBe("/inbox");
    expect(resolvePlaceTarget("inbox", "jobs", "/settings")).toBe("/inbox");
  });
});

describe("memoryKey", () => {
  it("is one key per place", () => {
    expect(memoryKey("sessions")).toBe("cockpit_last_sessions");
    expect(memoryKey("issues")).not.toBe(memoryKey("inbox"));
  });
});
