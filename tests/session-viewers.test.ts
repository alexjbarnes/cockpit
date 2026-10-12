// Who is watching which session: a notification skips a session a visible
// client is looking at, and nothing else counts as looking.
import { beforeEach, describe, expect, it } from "vitest";
import { forgetViewer, isSessionViewed, resetViewers, setViewer } from "@/server/session-viewers";

beforeEach(() => resetViewers());

describe("isSessionViewed", () => {
  it("is false with nobody connected at all", () => {
    expect(isSessionViewed("sess-1")).toBe(false);
  });

  it("is true for the session a visible client is on", () => {
    setViewer("client-1", "sess-1", true);
    expect(isSessionViewed("sess-1")).toBe(true);
    expect(isSessionViewed("sess-2")).toBe(false);
  });

  it("is false for a client whose tab is in the background", () => {
    setViewer("client-1", "sess-1", false);
    expect(isSessionViewed("sess-1")).toBe(false);
  });

  it("stops counting a client that navigated away or disconnected", () => {
    setViewer("client-1", "sess-1", true);
    setViewer("client-1", null, false);
    expect(isSessionViewed("sess-1")).toBe(false);

    setViewer("client-2", "sess-1", true);
    forgetViewer("client-2");
    expect(isSessionViewed("sess-1")).toBe(false);
  });

  it("counts anyone still watching when one of several looks away", () => {
    setViewer("client-1", "sess-1", false);
    setViewer("client-2", "sess-1", true);
    expect(isSessionViewed("sess-1")).toBe(true);
  });
});
