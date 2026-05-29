// Boot the integration harness for interactive use (Playwright MCP, manual
// browser, etc.). Prints the cockpit URL + auth token and stays alive until
// SIGINT.
//
//   npx tsx tests/integration/scripts/launch.ts

import { startHarness } from "../harness";

async function main(): Promise<void> {
  const h = await startHarness();
  console.log("");
  console.log("=== cockpit integration harness ===");
  console.log(`Cockpit:      ${h.cockpitUrl}`);
  console.log(`Mock API:     http://127.0.0.1:${h.mock.port}`);
  console.log(`Token:        ${h.cockpitToken}`);
  console.log(`Config dir:   ${h.configDir}`);
  console.log(`Claude dir:   ${h.claudeDir}`);
  console.log("");
  console.log('Auth cookie:  document.cookie = "cockpit_session=" + TOKEN + "; path=/"');
  console.log("");
  console.log("Ctrl+C to stop.");

  const stop = async (): Promise<void> => {
    console.log("\nshutting down...");
    await h.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
