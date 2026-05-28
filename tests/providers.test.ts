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

  it("updateProvider modifies and persists", async () => {
    const fs = await import("node:fs");
    const custom = [{ id: "p-1", name: "Old", envVars: {}, models: [] }];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(custom));
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => "");

    const { updateProvider } = await import("@/server/providers");
    const result = updateProvider("p-1", { name: "New" });
    expect(result.name).toBe("New");
    expect(result.id).toBe("p-1");
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("updateProvider throws for built-in provider", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { updateProvider } = await import("@/server/providers");
    expect(() => updateProvider("anthropic", { name: "X" })).toThrow("Cannot modify built-in");
  });

  it("updateProvider throws for unknown provider", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { updateProvider } = await import("@/server/providers");
    expect(() => updateProvider("nonexistent", { name: "X" })).toThrow("Provider not found");
  });

  it("deleteProvider removes and persists", async () => {
    const fs = await import("node:fs");
    const custom = [{ id: "p-1", name: "Test", envVars: {}, models: [] }];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(custom));
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => "");

    const { deleteProvider, getProviders } = await import("@/server/providers");
    deleteProvider("p-1");
    const remaining = getProviders().filter((p) => p.id === "p-1");
    expect(remaining.length).toBe(0);
  });

  it("deleteProvider throws for unknown provider", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { deleteProvider } = await import("@/server/providers");
    expect(() => deleteProvider("nonexistent")).toThrow("Provider not found");
  });

  it("setProviders replaces all custom providers", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => "");

    const { setProviders, getProviders } = await import("@/server/providers");
    setProviders([{ id: "new-1", name: "New", isBuiltin: false, envVars: {}, models: [] }]);
    const all = getProviders();
    expect(all.find((p) => p.id === "new-1")).toBeDefined();
  });

  it("resolveProviderModel returns null for empty string", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { resolveProviderModel } = await import("@/server/providers");
    expect(resolveProviderModel("")).toBeNull();
  });

  it("resolveProviderModel returns null for unknown qualified provider", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { resolveProviderModel } = await import("@/server/providers");
    expect(resolveProviderModel("unknown:model")).toBeNull();
  });

  it("rejects updateProvider with a model that has empty contextSizes", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => "");

    const { updateProvider, addProvider } = await import("@/server/providers");
    addProvider({
      name: "Custom",
      envVars: {},
      models: [{ modelId: "m1", displayName: "m1", effortLevels: [], contextSizes: ["200k"] }],
    });

    // Grab the created provider's id from the persisted list
    const { getProviders } = await import("@/server/providers");
    const created = getProviders().find((p) => p.name === "Custom" && !p.isBuiltin);
    expect(created).toBeDefined();

    expect(() => updateProvider(created!.id, {
      models: [{ modelId: "m1", displayName: "m1", effortLevels: [], contextSizes: [] }],
    })).toThrow(/contextSizes/);
  });
});
