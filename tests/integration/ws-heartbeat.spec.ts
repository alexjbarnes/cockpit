// The page keeps a websocket that is slow but working.
//
// On a phone a pong can arrive seconds late, queued behind a transcript update
// of hundreds of KB, and a new connection can take seconds to open over a
// waking radio or a VPN. The page used to drop a socket whose pong took over
// two seconds, and replace a socket still opening at the next three-second
// health check, so a slow link either kept reconnecting or never connected.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import type { Harness } from "./harness";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_AVAILABLE = (() => {
  try {
    execSync(`${CLAUDE_BIN} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test.skip(!CLAUDE_AVAILABLE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);

async function createSession(page: Page, harness: Harness, workDir: string): Promise<string> {
  const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
  expect(res.ok()).toBe(true);
  return (await res.json()).sessionId;
}

/** A TCP proxy to cockpit that holds a websocket handshake for `delayMs`. */
function slowHandshakeProxy(targetPort: number, delayMs: number): Promise<{ url: string; close: () => void }> {
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    const held: Buffer[] = [];
    let passing: boolean | null = null;
    client.on("data", (chunk: Buffer) => {
      if (passing === null) {
        passing = !chunk.toString("latin1").startsWith("GET /ws");
        if (!passing) {
          setTimeout(() => {
            passing = true;
            for (const c of held) upstream.write(c);
          }, delayMs);
        }
      }
      if (passing) upstream.write(chunk);
      else held.push(chunk);
    });
    upstream.on("data", (chunk) => client.write(chunk));
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const s of [client, upstream]) {
      s.on("close", end);
      s.on("error", end);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => server.close() });
    });
  });
}

test.describe("websocket health on a slow link", () => {
  let workDir: string;

  test.beforeEach(({ harness }) => {
    workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-heartbeat-"));
    mkdirSync(path.join(workDir, ".git"), { recursive: true });
    harness.trustWorkDir(workDir);
  });

  test.afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("a pong that arrives late does not drop the connection", async ({ page, harness }) => {
    let sockets = 0;
    await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      sockets++;
      const server = ws.connectToServer();
      ws.onMessage((message) => server.send(message));
      server.onMessage((message) => {
        const deliver = () => {
          try {
            ws.send(message);
          } catch {
            // The page closed this socket meanwhile.
          }
        };
        if (typeof message === "string" && message.includes('"type":"pong"')) setTimeout(deliver, 3500);
        else deliver();
      });
    });

    const sessionId = await createSession(page, harness, workDir);
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("btn-send")).toBeVisible({ timeout: 15_000 });

    // Long enough for three health checks, each answered 3.5 s late.
    await page.waitForTimeout(13_000);
    expect(sockets).toBe(1);
    await expect(page.getByTestId("btn-send")).toBeVisible();
  });

  test("a socket that is slow to open is given time to", async ({ page, harness }) => {
    const proxy = await slowHandshakeProxy(harness.cockpitPort, 4500);
    try {
      const sessionId = await createSession(page, harness, workDir);
      const started = Date.now();
      await page.goto(`${proxy.url}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
      await expect(page.getByTitle("Connecting...")).toBeVisible();

      await expect(page.getByTestId("btn-send")).toBeVisible({ timeout: 12_000 });
      // The handshake really was held.
      expect(Date.now() - started).toBeGreaterThan(4000);
    } finally {
      proxy.close();
    }
  });
});
