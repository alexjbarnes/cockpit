import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { parse } from "node:url";
import next from "next";
import { deletePasswordFile, needsSetup } from "./src/server/auth";
import { logDiag, logProxy } from "./src/server/debug-logger";
import { FormatProxy, setActiveFormatProxy } from "./src/server/format-proxy";
import { startHealthProbe } from "./src/server/health-probe";
import { HookRouter } from "./src/server/hook-router";
import { JobScheduler } from "./src/server/job-scheduler";
import { CockpitMcpServer } from "./src/server/mcp/cockpit-config-server";
import { getCockpitDir } from "./src/server/paths";
import { startCatalogSync } from "./src/server/provider-catalog";
import { resolveProxyUpstream, startBuiltinModelSync } from "./src/server/providers";
import { SessionManager } from "./src/server/session-manager";
import { setCockpitMcp, setHookRouter, setJobScheduler, setSessionManager, setTerminalManager } from "./src/server/singleton";
import { TerminalManager } from "./src/server/terminal-manager";
import { UsageMeter } from "./src/server/usage-meter";
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
  console.log("Enjoying Cockpit? Star it: https://github.com/alexjbarnes/cockpit");
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

  const terminalManager = new TerminalManager();
  setTerminalManager(terminalManager);

  const hookRouter = new HookRouter();
  const hookHost = process.env.COCKPIT_HOOK_HOST || "127.0.0.1";
  const hookPortPref = parseInt(process.env.COCKPIT_HOOK_PORT || "0", 10);
  await hookRouter.start(hookHost, Number.isFinite(hookPortPref) ? hookPortPref : 0);
  setHookRouter(hookRouter);
  // These three are internal loopback services, not somewhere the user
  // connects, so their addresses belong in the debug log rather than the
  // startup banner. Only the Cockpit URL above is worth printing.
  logDiag("-", "hook-router-listening", { url: hookRouter.getUrl(hookHost) });

  const cockpitMcp = new CockpitMcpServer();
  try {
    await cockpitMcp.start();
    setCockpitMcp(cockpitMcp);
    logDiag("-", "mcp-listening", { url: cockpitMcp.getUrl() });
  } catch (err) {
    // As with the format proxy, a start FAILURE stays on stderr: debug logging
    // is off by default, so a debug-only record would be written nowhere.
    logDiag("-", "mcp-start-failed", { error: err instanceof Error ? err.message : String(err) });
    console.error("Failed to start cockpit MCP server:", err);
  }

  // Anthropic ⇄ OpenAI translation proxy for providers without an
  // Anthropic-compatible endpoint (OpenCode Zen). Started before anything
  // that can resolve providers so derived spawn env always sees it.
  // Translated requests report token usage into the local meter — the spend
  // view for providers that expose no usage API of their own.
  const usageMeter = new UsageMeter();
  const formatProxy = new FormatProxy(resolveProxyUpstream, { onUsage: (u) => usageMeter.record({ ts: Date.now(), ...u }) });
  try {
    await formatProxy.start();
    setActiveFormatProxy(formatProxy);
  } catch (err) {
    // The proxy start line moved to the debug log, but a start FAILURE stays on
    // stderr: it silently breaks every OpenAI-format provider, and debug
    // logging is off by default, so hiding it would make it undiagnosable.
    logProxy("-", "start-failed", { error: err instanceof Error ? err.message : String(err) });
    console.error("Failed to start format proxy:", err);
  }

  const jobScheduler = new JobScheduler(sessionManager);
  setJobScheduler(jobScheduler);
  jobScheduler.start();

  // Boot-time OpenRouter catalog sync plus a daily refresh (D8: failures
  // alert through the inbox once per episode, never via UI degradation).
  startCatalogSync();
  // Same cadence for the other built-ins' model lists (zen /models and
  // models.dev are public, so counts show before any key is connected).
  startBuiltinModelSync();

  // Opt-in stall watchdog: COCKPIT_HEALTH=1 (independent of COCKPIT_DEBUG) logs
  // only when the process stalls, classifying it as event-loop-blocked vs
  // fs/disk contention. Run it with COCKPIT_DEBUG OFF to see whether slow
  // session switching survives without the debug-log flood, and what it is.
  if (process.env.COCKPIT_HEALTH === "1") {
    startHealthProbe(getCockpitDir());
    console.log("[health] stall watchdog enabled (event-loop lag + fs read probe)");
  }

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
