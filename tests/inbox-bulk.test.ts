// Bulk actions on inbox messages picked in select mode: one write for the lot.
// COCKPIT_CONFIG_DIR is a throwaway directory per test file (tests/global-setup.ts).
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));
vi.mock("@/server/notifications", () => ({ dispatchNotification: () => ({ attempted: [], delivered: [], failed: [] }) }));

import { POST } from "@/app/api/inbox/route";
import { addInboxMessage, clearInbox, deleteInboxMessages, getInboxMessages, markManyRead } from "@/server/inbox";

function seed(n: number): string[] {
  return Array.from({ length: n }, (_, i) => addInboxMessage({ title: `Message ${i + 1}`, body: "b" }).entry.id);
}

function post(body: unknown, token = "valid") {
  return POST(
    new NextRequest("http://localhost/api/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `cockpit_session=${token}` },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => clearInbox());

describe("deleteInboxMessages", () => {
  it("deletes only the given messages and counts them", () => {
    const [a, b, c] = seed(3);

    expect(deleteInboxMessages([a, c, "missing"])).toBe(2);
    expect(getInboxMessages().map((m) => m.id)).toEqual([b]);
  });

  it("changes nothing for ids it does not hold", () => {
    seed(2);
    expect(deleteInboxMessages(["missing"])).toBe(0);
    expect(getInboxMessages()).toHaveLength(2);
  });
});

describe("markManyRead", () => {
  it("marks the given messages read, then unread, leaving the rest alone", () => {
    const [a, b, c] = seed(3);

    expect(markManyRead([a, b], true)).toBe(2);
    const read = new Map(getInboxMessages().map((m) => [m.id, m.read]));
    expect([read.get(a), read.get(b), read.get(c)]).toEqual([true, true, false]);

    expect(markManyRead([a], false)).toBe(1);
    expect(getInboxMessages().find((m) => m.id === a)?.read).toBe(false);
  });
});

describe("POST /api/inbox bulk actions", () => {
  it("deletes the selected messages", async () => {
    const [a, b] = seed(3);
    const res = await post({ action: "delete", ids: [a, b] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 2 });
    expect(getInboxMessages()).toHaveLength(1);
  });

  it("marks the selected messages read or unread", async () => {
    const [a] = seed(2);
    await post({ action: "mark_read", ids: [a], read: true });
    expect(getInboxMessages().find((m) => m.id === a)?.read).toBe(true);

    await post({ action: "mark_read", ids: [a], read: false });
    expect(getInboxMessages().find((m) => m.id === a)?.read).toBe(false);
  });

  it("refuses a bulk action without ids", async () => {
    seed(2);
    for (const body of [{ action: "delete" }, { action: "delete", ids: [] }, { action: "delete", ids: [1, null] }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(getInboxMessages()).toHaveLength(2);
  });

  it("refuses an unauthenticated caller", async () => {
    const [a] = seed(1);
    const res = await post({ action: "delete", ids: [a] }, "nope");
    expect(res.status).toBe(401);
    expect(getInboxMessages()).toHaveLength(1);
  });
});
