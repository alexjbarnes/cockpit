import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { parse } from "node:url";
import next from "next";
import { deletePasswordFile, needsSetup } from "./src/server/auth";
import { HookRouter } from "./src/server/hook-router";
import { JobScheduler } from "./src/server/job-scheduler";
import { ensureCockpitConfigServer } from "./src/server/mcp/register";
import { SessionManager } from "./src/server/session-manager";
import { setHookRouter, setJobScheduler, setSessionManager, setTerminalManager } from "./src/server/singleton";
import { TerminalManager } from "./src/server/terminal-manager";
import { createWebSocketHandler } from "./src/server/ws-handler";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT || "3001", 10);
const host = process.env.HOST || "0.0.0.0";

const app = next({ dev, hostname: host, port });
const handle = app.getRequestHandler();

function getLanAddresses(): string[] {
  const addresses: string[] = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

function logStartupBanner(): void {
  console.log(`Cockpit listening on ${host}:${port}`);
  console.log("");
  console.log("Connect via:");

  const isWildcard = host === "0.0.0.0" || host === "::";
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";

  if (isWildcard) {
    console.log(`  Local:    http://localhost:${port}`);
    const network = getLanAddresses();
    if (network.length > 0) {
      console.log(`  Network:  http://${network[0]}:${port}`);
      for (let i = 1; i < network.length; i++) {
        console.log(`            http://${network[i]}:${port}`);
      }
    }
  } else if (isLoopback) {
    console.log(`  Local:    http://localhost:${port}`);
  } else {
    console.log(`  Network:  http://${host}:${port}`);
  }

  console.log("");
}

async function main() {
  // Handle password reset flag
  if (process.env.COCKPIT_RESET_PASSWORD === "true") {
    await deletePasswordFile();
    console.log("Password has been reset. You will be prompted to set a new password.");
  }

  await app.prepare();

  const sessionManager = new SessionManager();
  setSessionManager(sessionManager);
  ensureCockpitConfigServer();

  const terminalManager = new TerminalManager();
  setTerminalManager(terminalManager);

  const hookRouter = new HookRouter();
  const hookHost = process.env.COCKPIT_HOOK_HOST || "127.0.0.1";
  const hookPortPref = parseInt(process.env.COCKPIT_HOOK_PORT || "0", 10);
  await hookRouter.start(hookHost, Number.isFinite(hookPortPref) ? hookPortPref : 0);
  setHookRouter(hookRouter);
  console.log(`Hook router listening on ${hookRouter.getUrl(hookHost)}`);

  const jobScheduler = new JobScheduler(sessionManager);
  setJobScheduler(jobScheduler);
  jobScheduler.start();

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url || "", true);
    handle(req, res, parsedUrl);
  });

  createWebSocketHandler(server, sessionManager, terminalManager);

  server.listen(port, host, () => {
    logStartupBanner();
    if (needsSetup()) {
      console.log("No password set. Visit the UI to create one.");
    }
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
