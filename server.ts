import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { deletePasswordFile, isAuthDisabled, needsSetup } from "./src/server/auth";
import { SessionManager } from "./src/server/session-manager";
import { setSessionManager } from "./src/server/singleton";
import { createWebSocketHandler } from "./src/server/ws-handler";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT || "3001", 10);
const host = process.env.HOST || "0.0.0.0";

const app = next({ dev, hostname: host, port });
const handle = app.getRequestHandler();

async function main() {
  // Handle password reset flag
  if (process.env.COCKPIT_RESET_PASSWORD === "true") {
    await deletePasswordFile();
    console.log("Password has been reset. You will be prompted to set a new password.");
  }

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
    if (isAuthDisabled()) {
      console.log("Authentication is disabled");
    } else if (needsSetup()) {
      console.log("No password set. Visit the UI to create one.");
    }
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
