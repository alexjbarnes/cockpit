// A reset ~/.claude.json is invisible until a scheduled job quietly runs
// without the MCP servers it was configured with. The CLI resets the file from
// defaults after one unparseable read and says nothing, so cockpit keeps its
// own record of the servers and puts them back — but only when the file also
// looks reset, or an intentional deletion would be undone forever.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkClaudeUserConfig } from "@/server/claude-config-guard";
import { getInboxMessages } from "@/server/inbox";
import { configuredMcpServerNames } from "@/server/mcp-discovery";

let root: string;
let cockpitDir: string;
let claudeHome: string;
let prevCockpit: string | undefined;
let prevClaude: string | undefined;

const configFile = () => path.join(claudeHome, ".claude.json");
const snapshotFile = () => path.join(cockpitDir, "claude-config-snapshot.json");

function writeConfig(value: unknown): void {
  writeFileSync(configFile(), JSON.stringify(value, null, 2));
}
function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configFile(), "utf-8"));
}
function servers(): string[] {
  return Object.keys((readConfig().mcpServers ?? {}) as Record<string, unknown>).sort();
}
function snapshotServers(): string[] {
  const snapshot = JSON.parse(readFileSync(snapshotFile(), "utf-8")) as { servers: Record<string, unknown> };
  return Object.keys(snapshot.servers).sort();
}

const HEALTHY = {
  numStartups: 40,
  firstStartTime: "2026-06-01T10:00:00.000Z",
  mcpServers: { gmail: { command: "npx" }, conduit: { type: "http", url: "http://example" } },
  projects: {
    "/home/dev/repos/cockpit": { hasTrustDialogAccepted: true },
    "/home/dev/repos/HomeLab": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] },
    "/home/dev/tmp/scratch": { lastCost: 1.5 },
  },
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cockpit-guard-"));
  cockpitDir = path.join(root, "cockpit");
  claudeHome = path.join(root, "home");
  mkdirSync(cockpitDir, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  prevCockpit = process.env.COCKPIT_CONFIG_DIR;
  prevClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = cockpitDir;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
});

afterEach(() => {
  if (prevCockpit === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevCockpit;
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  rmSync(root, { recursive: true, force: true });
});

describe("the reset guard", () => {
  it("takes a snapshot of a healthy config and says nothing", () => {
    writeConfig(HEALTHY);

    const report = checkClaudeUserConfig();

    expect(report).toEqual({ action: "healthy", restored: [], missing: [] });
    expect(snapshotServers()).toEqual(["conduit", "gmail"]);
    expect(getInboxMessages()).toEqual([]);
  });

  // A reset takes the whole projects map, so every directory the user had
  // trusted starts asking again — the session that follows shows the CLI's
  // trust card instead of starting. The snapshot carries them, and only a
  // detected reset puts them back.
  describe("directory trust", () => {
    const trusted = (data: Record<string, unknown>) =>
      Object.entries((data.projects ?? {}) as Record<string, Record<string, unknown>>)
        .filter(([, e]) => e?.hasTrustDialogAccepted === true)
        .map(([dir]) => dir)
        .sort();

    it("remembers the trusted directories, and only those", () => {
      writeConfig(HEALTHY);
      checkClaudeUserConfig();

      const snapshot = JSON.parse(readFileSync(snapshotFile(), "utf-8")) as { trustedProjects: string[] };
      expect(snapshot.trustedProjects.sort()).toEqual(["/home/dev/repos/HomeLab", "/home/dev/repos/cockpit"]);
    });

    it("puts trust back when the config comes back reset", () => {
      writeConfig(HEALTHY);
      checkClaudeUserConfig();
      writeConfig({ numStartups: 2, firstStartTime: "2026-10-09T16:34:52.425Z", projects: {} });

      const report = checkClaudeUserConfig();

      expect(report.action).toBe("restored");
      expect(report.trustRestored?.sort()).toEqual(["/home/dev/repos/HomeLab", "/home/dev/repos/cockpit"]);
      expect(trusted(readConfig())).toEqual(["/home/dev/repos/HomeLab", "/home/dev/repos/cockpit"]);
      expect(getInboxMessages()[0].body).toMatch(/Trust put back for 2 directories/);
    });

    // The reset keeps whatever the CLI wrote for a directory, and only the
    // trust flag is cockpit's to restore.
    it("merges into a project entry the CLI kept rather than replacing it", () => {
      writeConfig(HEALTHY);
      checkClaudeUserConfig();
      writeConfig({
        numStartups: 2,
        firstStartTime: "2026-10-09T16:34:52.425Z",
        projects: { "/home/dev/repos/cockpit": { lastCost: 9, allowedTools: ["Read"] } },
      });

      checkClaudeUserConfig();

      expect(((readConfig().projects ?? {}) as Record<string, Record<string, unknown>>)["/home/dev/repos/cockpit"]).toEqual({
        lastCost: 9,
        allowedTools: ["Read"],
        hasTrustDialogAccepted: true,
      });
    });

    it("does not resurrect a directory the user untrusted on purpose", () => {
      writeConfig(HEALTHY);
      checkClaudeUserConfig();
      writeConfig({ ...HEALTHY, numStartups: 41, projects: { "/home/dev/repos/cockpit": { hasTrustDialogAccepted: true } } });

      expect(checkClaudeUserConfig().action, "a deletion is not a wipe").toBe("healthy");
      expect(trusted(readConfig())).toEqual(["/home/dev/repos/cockpit"]);
      const snapshot = JSON.parse(readFileSync(snapshotFile(), "utf-8")) as { trustedProjects: string[] };
      expect(snapshot.trustedProjects, "the snapshot follows the user").toEqual(["/home/dev/repos/cockpit"]);
    });

    it("restores trust along with the servers when the config is unreadable", () => {
      writeConfig(HEALTHY);
      checkClaudeUserConfig();
      writeFileSync(configFile(), "{ broken");

      const report = checkClaudeUserConfig();

      expect(report.action).toBe("restored");
      expect(servers()).toEqual(["conduit", "gmail"]);
      expect(trusted(readConfig())).toEqual(["/home/dev/repos/HomeLab", "/home/dev/repos/cockpit"]);
    });
  });

  // The wipe's signature: the CLI's fresh defaults, which carry a new
  // firstStartTime, a restarting numStartups and no mcpServers key at all.
  it("puts the servers back when the config comes back reset", () => {
    writeConfig(HEALTHY);
    checkClaudeUserConfig();
    writeConfig({ numStartups: 2, firstStartTime: "2026-10-09T16:34:52.425Z", projects: {} });

    const report = checkClaudeUserConfig();

    expect(report.action).toBe("restored");
    expect(report.restored.sort()).toEqual(["conduit", "gmail"]);
    expect(report.missing).toEqual([]);
    expect(servers()).toEqual(["conduit", "gmail"]);
    expect(readConfig().numStartups, "everything else the CLI wrote stays as it is").toBe(2);
    expect(snapshotServers()).toEqual(["conduit", "gmail"]);
    const messages = getInboxMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].title).toMatch(/restored/i);
    expect(messages[0].body).toContain("gmail");
  });

  // The two halves the job scheduler relies on: after a wipe and a restore, the
  // servers a job is configured with are findable again in the config files.
  it("makes the restored servers visible to a job's pre-flight", () => {
    writeConfig(HEALTHY);
    checkClaudeUserConfig();
    writeConfig({ numStartups: 2, firstStartTime: "2026-10-09T16:34:52.425Z" });
    expect(configuredMcpServerNames(claudeHome)).toEqual([]);

    checkClaudeUserConfig();

    expect(configuredMcpServerNames(claudeHome).sort()).toEqual(["conduit", "gmail"]);
  });

  it("does not resurrect a server the user deleted on purpose", () => {
    writeConfig(HEALTHY);
    checkClaudeUserConfig();
    writeConfig({ ...HEALTHY, numStartups: 41, mcpServers: { conduit: HEALTHY.mcpServers.conduit } });

    const report = checkClaudeUserConfig();

    expect(report.action, "a deletion is not a wipe").toBe("healthy");
    expect(servers()).toEqual(["conduit"]);
    expect(snapshotServers(), "the snapshot follows the user, so a later wipe cannot bring it back").toEqual(["conduit"]);
    expect(getInboxMessages()).toEqual([]);
  });

  it("rebuilds an unreadable config from the snapshot", () => {
    writeConfig(HEALTHY);
    checkClaudeUserConfig();
    writeFileSync(configFile(), "{ this is not json");

    const report = checkClaudeUserConfig();

    expect(report.action).toBe("restored");
    expect(servers()).toEqual(["conduit", "gmail"]);
    expect(getInboxMessages()[0].priority).toBe("warning");
  });

  // The CLI keeps five rotating backups and a copy of every file it quarantined
  // as corrupt. They carry the CLI's own state, so they make a better base than
  // an empty document when the live file is unreadable.
  it("rebuilds over the newest backup the CLI left behind", () => {
    writeConfig(HEALTHY);
    checkClaudeUserConfig();
    const backups = path.join(claudeHome, "backups");
    mkdirSync(backups, { recursive: true });
    writeFileSync(
      path.join(backups, ".claude.json.backup.1791560069128"),
      JSON.stringify({ numStartups: 39, projects: { "/keep/this": { allowedTools: ["Bash"] } } }),
    );
    writeFileSync(configFile(), "");

    const report = checkClaudeUserConfig();

    expect(report.action).toBe("restored");
    expect(servers()).toEqual(["conduit", "gmail"]);
    const projects = (readConfig().projects ?? {}) as Record<string, Record<string, unknown>>;
    expect(projects["/keep/this"], "the backup's own state comes back too").toEqual({ allowedTools: ["Bash"] });
    expect(Object.keys(projects).sort(), "alongside the trust the snapshot put back").toEqual([
      "/home/dev/repos/HomeLab",
      "/home/dev/repos/cockpit",
      "/keep/this",
    ]);
  });

  it("reports rather than throwing when there is nothing to restore from", () => {
    writeFileSync(configFile(), "{ broken");

    const report = checkClaudeUserConfig();

    expect(report.action).toBe("broken");
    expect(getInboxMessages()).toHaveLength(0);
  });

  // The first run after a wipe that cockpit never saw: no snapshot yet, but the
  // CLI's own quarantined copy is on disk. It becomes the base, and a snapshot
  // is taken from it, so the next wipe is covered by the faster path.
  it("recovers from a lone backup when no snapshot has been taken yet", () => {
    const backups = path.join(claudeHome, "backups");
    mkdirSync(backups, { recursive: true });
    writeFileSync(path.join(backups, ".claude.json.corrupted.1790024111444"), JSON.stringify(HEALTHY));
    writeFileSync(configFile(), "{ broken");

    const report = checkClaudeUserConfig();

    expect(report.action).toBe("restored");
    expect(report.source).toBe("backup");
    expect(report.restored.sort()).toEqual(["conduit", "gmail"]);
    expect(servers()).toEqual(["conduit", "gmail"]);
    expect(snapshotServers()).toEqual(["conduit", "gmail"]);
  });
});
