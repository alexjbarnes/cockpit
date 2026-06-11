import { describe, expect, it } from "vitest";
import { formatConfigChange } from "@/lib/config-change";

describe("formatConfigChange", () => {
  it("formats job+create with block-flagged prompt", () => {
    const result = formatConfigChange("job", "create", {
      name: "nightly-build",
      schedule: { cron: "0 2 * * *" },
      prompt:
        "Run the nightly build script. This is a very long prompt that exceeds eighty characters so it should be rendered as a block value in the config proposal card.",
      cwd: "/home/dev/project",
      enabled: true,
      model: "sonnet",
      contextSize: "normal",
      thinkingLevel: "medium",
      bypassPermissions: false,
      maxDurationMinutes: 60,
      retentionDays: 7,
      skipIfMissed: false,
      inboxOutput: true,
    });

    expect(result.title).toBe("Create job");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.find((r) => r.label === "Name")?.value).toBe("nightly-build");
    expect(result.rows.find((r) => r.label === "Prompt")?.block).toBe(true);
    expect(result.rows.find((r) => r.label === "Enabled")?.value).toBe("Yes");
    expect(result.rows.find((r) => r.label === "Model")?.value).toBe("sonnet");
    expect(result.rows.find((r) => r.label === "Schedule")?.value).toBe("Cron: 0 2 * * *");
    expect(result.rows.find((r) => r.label === "Schedule")?.block).toBe(true);
  });

  it("formats job+delete with id only", () => {
    const result = formatConfigChange("job", "delete", { id: "job-123" });

    expect(result.title).toBe("Delete job");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].label).toBe("Job ID");
    expect(result.rows[0].value).toBe("job-123");
  });

  it("formats settings+update", () => {
    const result = formatConfigChange("settings", "update", {
      thinkingLevel: "high",
      diffStyle: "unified",
      reviewsEnabled: false,
    });

    expect(result.title).toBe("Update settings");
    expect(result.rows.find((r) => r.label === "Thinking level")?.value).toBe("high");
    expect(result.rows.find((r) => r.label === "Diff style")?.value).toBe("unified");
    expect(result.rows.find((r) => r.label === "Reviews enabled")?.value).toBe("No");
  });

  it("formats provider+add with envVars key list", () => {
    const result = formatConfigChange("provider", "add", {
      name: "custom-provider",
      envVars: { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" },
    });

    expect(result.title).toBe("Add provider");
    expect(result.rows.find((r) => r.label === "Name")?.value).toBe("custom-provider");
    const envRow = result.rows.find((r) => r.label === "Environment variables");
    expect(envRow).toBeDefined();
    expect(envRow!.value).toContain("ANTHROPIC API KEY");
    expect(envRow!.value).toContain("OPENAI API KEY");
    // No id row since add_provider input has no id
    expect(result.rows.find((r) => r.label === "Provider ID")).toBeUndefined();
  });

  it("formats provider+delete with id only", () => {
    const result = formatConfigChange("provider", "delete", { id: "prov-abc" });

    expect(result.title).toBe("Delete provider");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].label).toBe("Provider ID");
    expect(result.rows[0].value).toBe("prov-abc");
  });

  it("formats mcp_server+save with args joined", () => {
    const result = formatConfigChange("mcp_server", "save", {
      name: "my-server",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    });

    expect(result.title).toBe("Save mcp server");
    expect(result.rows.find((r) => r.label === "Name")?.value).toBe("my-server");
    expect(result.rows.find((r) => r.label === "Command")?.value).toBe("npx");
    const argsRow = result.rows.find((r) => r.label === "Arguments");
    expect(argsRow).toBeDefined();
    expect(argsRow!.value).toContain("-y");
    expect(argsRow!.value).toContain("/tmp");
  });

  it("formats mcp_server+delete with name only", () => {
    const result = formatConfigChange("mcp_server", "delete", { name: "old-server" });

    expect(result.title).toBe("Delete mcp server");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].label).toBe("Name");
    expect(result.rows[0].value).toBe("old-server");
  });

  it("formats notification_settings+update with baseUrl", () => {
    const result = formatConfigChange("notification_settings", "update", {
      baseUrl: "https://hooks.example.com/notify",
    });

    expect(result.title).toBe("Update notification settings");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].label).toBe("Base URL");
  });

  it("returns fallback row for empty input", () => {
    const result = formatConfigChange("job", "create", {});

    expect(result.title).toBe("Create job");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].label).toBe("Change");
  });

  it("formats notification_provider+add with telegram config flattened", () => {
    const result = formatConfigChange("notification_provider", "add", {
      type: "telegram",
      name: "My Bot",
      enabled: true,
      config: { botToken: "123:ABC", chatId: "-1001" },
    });

    expect(result.title).toBe("Add notification provider");
    expect(result.rows.find((r) => r.label === "Type")?.value).toBe("telegram");
    expect(result.rows.find((r) => r.label === "Name")?.value).toBe("My Bot");
    expect(result.rows.find((r) => r.label === "Bot token")?.value).toBe("123:ABC");
    expect(result.rows.find((r) => r.label === "Chat ID")?.value).toBe("-1001");
    expect(result.rows.find((r) => r.label === "Enabled")?.value).toBe("Yes");
  });

  it("formats job+update skips id row", () => {
    const result = formatConfigChange("job", "update", {
      id: "job-uuid-123",
      schedule: { cron: "0 3 * * *" },
      enabled: false,
    });

    expect(result.title).toBe("Update job");
    expect(result.rows.find((r) => r.label === "Job ID")).toBeUndefined();
    expect(result.rows.find((r) => r.label === "Enabled")?.value).toBe("No");
  });

  it("handles unknown domain with humanised-key fallback labels", () => {
    const result = formatConfigChange("unknown_domain", "create", {
      myCustomKey: "value1",
      anotherKey: 42,
    });

    expect(result.title).toBe("Create unknown domain");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0].label).toBe("My Custom Key");
    expect(result.rows[1].label).toBe("Another Key");
    expect(result.rows[1].value).toBe("42");
  });
});
