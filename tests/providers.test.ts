import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:os", () => ({ homedir: () => "/home/user" }));
vi.mock("node:path", async () => {
  const actual = await vi.importActual("node:path");
  return { ...actual, join: (...args: string[]) => args.join("/") };
});

describe("providers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns built-in Anthropic provider when no file exists", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { getProviders } = await import("@/server/providers");
    const providers = getProviders();

    expect(providers.length).toBeGreaterThanOrEqual(1);
    const anthropic = providers.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.isBuiltin).toBe(true);
    expect(anthropic!.models.length).toBeGreaterThan(0);
  });

  it("merges custom providers with built-in Anthropic", async () => {
    const fs = await import("node:fs");
    const custom = [
      {
        id: "or-123",
        name: "OpenRouter",
        envVars: { ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1" },
        models: [{ modelId: "deepseek/deepseek-chat", displayName: "DeepSeek Chat", effortLevels: [] }],
      },
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(custom));

    const { getProviders } = await import("@/server/providers");
    const providers = getProviders();

    expect(providers.length).toBe(2);
    expect(providers[0].id).toBe("anthropic");
    expect(providers[1].id).toBe("or-123");
  });

  it("resolveProviderModel finds Anthropic model", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { resolveProviderModel } = await import("@/server/providers");
    const result = resolveProviderModel("claude-opus-4-7");

    expect(result).not.toBeNull();
    expect(result!.provider.id).toBe("anthropic");
    expect(result!.model.modelId).toBe("claude-opus-4-7");
  });

  it("resolveProviderModel finds custom provider model", async () => {
    const fs = await import("node:fs");
    const custom = [
      {
        id: "or-123",
        name: "OpenRouter",
        envVars: {},
        models: [{ modelId: "deepseek/deepseek-chat", displayName: "DeepSeek Chat", effortLevels: [] }],
      },
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(custom));

    const { resolveProviderModel } = await import("@/server/providers");
    const result = resolveProviderModel("deepseek/deepseek-chat");

    expect(result).not.toBeNull();
    expect(result!.provider.id).toBe("or-123");
    expect(result!.model.displayName).toBe("DeepSeek Chat");
  });

  it("resolveProviderModel returns null for unknown model", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { resolveProviderModel } = await import("@/server/providers");
    expect(resolveProviderModel("nonexistent-model")).toBeNull();
  });

  it("resolveProviderModel prefers Anthropic for duplicate model IDs", async () => {
    const fs = await import("node:fs");
    const custom = [
      {
        id: "proxy-1",
        name: "My Proxy",
        envVars: { ANTHROPIC_BASE_URL: "http://localhost:8080" },
        models: [{ modelId: "claude-opus-4-7", displayName: "Proxied Opus", effortLevels: [] }],
      },
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(custom));

    const { resolveProviderModel } = await import("@/server/providers");
    const result = resolveProviderModel("claude-opus-4-7");

    expect(result!.provider.id).toBe("anthropic");
  });

  it("resolveProviderModel supports qualified providerId:modelId form", async () => {
    const fs = await import("node:fs");
    const custom = [
      {
        id: "proxy-1",
        name: "My Proxy",
        envVars: { ANTHROPIC_BASE_URL: "http://localhost:8080" },
        models: [{ modelId: "claude-opus-4-7", displayName: "Proxied Opus", effortLevels: [] }],
      },
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(custom));

    const { resolveProviderModel } = await import("@/server/providers");
    const result = resolveProviderModel("proxy-1:claude-opus-4-7");

    expect(result).not.toBeNull();
    expect(result!.provider.id).toBe("proxy-1");
  });

  it("addProvider generates UUID and persists", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => "");

    const { addProvider } = await import("@/server/providers");
    const provider = addProvider({
      name: "Test",
      envVars: {},
      models: [],
    });

    expect(provider.id).toBeTruthy();
    expect(provider.name).toBe("Test");
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("deleteProvider throws for built-in provider", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { deleteProvider } = await import("@/server/providers");
    expect(() => deleteProvider("anthropic")).toThrow();
  });
});
