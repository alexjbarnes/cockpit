import crypto from "node:crypto";
import { createServer } from "node:http";
import next from "next";
import { parse } from "node:url";

// Generate token before any other imports read it
if (!process.env.COCKPIT_TOKEN) {
  process.env.COCKPIT_TOKEN = crypto.randomBytes(32).toString("hex");
}

import { SessionManager } from "./src/server/session-manager";
import { setSessionManager } from "./src/server/singleton";
import { createWebSocketHandler } from "./src/server/ws-handler";
import { getToken } from "./src/server/auth";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT || "3001", 10);
const host = process.env.HOST || "0.0.0.0";

const app = next({ dev });
const handle = app.getRequestHandler();

async function main() {
  await app.prepare();

  const sessionManager = new SessionManager();
  setSessionManager(sessionManager);

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url || "", true);
    handle(req, res, parsedUrl);
  });

  createWebSocketHandler(server, sessionManager);

  server.listen(port, host, () => {
    console.log(`Cockpit running on http://${host}:${port}`);
    console.log(`Auth token: ${getToken()}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
