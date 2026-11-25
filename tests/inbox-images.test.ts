// Pictures attached to inbox messages. COCKPIT_CONFIG_DIR is a throwaway
// directory per test file (tests/global-setup.ts), so downloads land there.
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import { clearInboxImages, downloadInboxImages, inboxImagePath, removeInboxImages } from "@/server/inbox-images";
import { getInboxAttachmentsRoot } from "@/server/paths";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PUBLIC = [{ address: "93.184.216.34", family: 4 }];

function pngResponse(): Response {
  return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  lookupMock.mockResolvedValue(PUBLIC);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearInboxImages();
});

describe("downloadInboxImages", () => {
  it("downloads and stores a supported image", async () => {
    fetchMock.mockResolvedValue(pngResponse());

    const images = await downloadInboxImages("message-1", ["https://example.com/thumbnail.png"]);

    expect(images).toHaveLength(1);
    expect(images[0].mime).toBe("image/png");
    const file = inboxImagePath("message-1", images[0]);
    expect(file).not.toBeNull();
    expect(existsSync(file!)).toBe(true);
  });

  it("refuses a host that resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    await expect(downloadInboxImages("message-2", ["https://example.com/a.png"])).rejects.toThrow(/private or local/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a non-http URL", async () => {
    await expect(downloadInboxImages("message-3", ["ftp://example.com/a.png"])).rejects.toThrow(/http or https/);
  });

  it("refuses bytes that are not an image, whatever the URL says", async () => {
    fetchMock.mockResolvedValue(new Response("<html>not an image</html>", { status: 200, headers: { "content-type": "image/png" } }));

    await expect(downloadInboxImages("message-4", ["https://example.com/a.png"])).rejects.toThrow(/supported image/);
    expect(existsSync(path.join(getInboxAttachmentsRoot(), "message-4"))).toBe(false);
  });

  it("refuses an image over the size cap", async () => {
    fetchMock.mockResolvedValue(new Response(PNG, { status: 200, headers: { "content-length": String(21 * 1024 * 1024) } }));

    await expect(downloadInboxImages("message-5", ["https://example.com/a.png"])).rejects.toThrow(/larger than 20 MB/);
  });

  it("follows a redirect only after checking the new host", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/a.png" } }));

    await expect(downloadInboxImages("message-6", ["https://example.com/a.png"])).rejects.toThrow(/private or local/);
  });

  it("caps the number of pictures on one message", async () => {
    await expect(
      downloadInboxImages("message-7", [
        "https://example.com/1.png",
        "https://example.com/2.png",
        "https://example.com/3.png",
        "https://example.com/4.png",
      ]),
    ).rejects.toThrow(/At most 3/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("inboxImagePath", () => {
  it("has no path for a mime that is not served", () => {
    expect(inboxImagePath("message-8", { id: "x", mime: "image/svg+xml" })).toBeNull();
  });

  it("removes a message's files", async () => {
    fetchMock.mockResolvedValue(pngResponse());
    await downloadInboxImages("message-9", ["https://example.com/a.png"]);
    expect(existsSync(path.join(getInboxAttachmentsRoot(), "message-9"))).toBe(true);

    removeInboxImages("message-9");
    expect(existsSync(path.join(getInboxAttachmentsRoot(), "message-9"))).toBe(false);
  });
});
