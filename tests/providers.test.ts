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

    expect(providers.length).toBe(4);
    expect(providers[0].id).toBe("anthropic");
    expect(providers[1].id).toBe("openrouter");
    expect(providers[2].id).toBe("zen");
    expect(providers[3].id).toBe("or-123");
  });

  it("openrouter built-in accepts key + enabled set, derives env, and rejects deletion", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { deleteProvider, getProviders, updateProvider } = await import("@/server/providers");

    const before = getProviders().find((p) => p.id === "openrouter");
    expect(before?.isBuiltin).toBe(true);
    expect(before?.envVars).toEqual({});

    const updated = updateProvider("openrouter", {
      envVars: { ANTHROPIC_AUTH_TOKEN: "sk-or-test" },
      enabledModels: ["vendor/model:free"],
    });
    expect(updated.envVars.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(updated.envVars.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-test");
    // must be explicitly empty, not unset — the CLI falls back to Anthropic otherwise
    expect(updated.envVars.ANTHROPIC_API_KEY).toBe("");
    expect(updated.enabledModels).toEqual(["vendor/model:free"]);

    const written = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1] as string;
    expect(written).toContain("sk-or-test");
    expect(written).toContain("vendor/model:free");

    expect(() => deleteProvider("openrouter")).toThrow(/built-in/);
  });

  it("zen built-in stores key + models, exposes proxy upstream, and rejects deletion", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { deleteProvider, getProviders, resolveProxyUpstream, updateProvider } = await import("@/server/providers");

    const before = getProviders().find((p) => p.id === "zen");
    expect(before?.isBuiltin).toBe(true);
    expect(before?.envVars).toEqual({});
    expect(resolveProxyUpstream("zen")).toBeNull();
    expect(resolveProxyUpstream("other")).toBeNull();

    const zenEntry = [
      {
        id: "zen",
        name: "OpenCode Zen",
        isBuiltin: true,
        envVars: { OPENCODE_API_KEY: "zk-1" },
        models: [{ modelId: "opencode/gpt-5.5", displayName: "opencode/gpt-5.5", effortLevels: [], contextSizes: [] }],
        enabledModels: ["opencode/gpt-5.5"],
      },
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(zenEntry));

    const upstream = resolveProxyUpstream("zen");
    expect(upstream).toEqual({ baseUrl: "https://opencode.ai/zen/v1", apiKey: "zk-1", modelIds: ["opencode/gpt-5.5"] });

    const updated = updateProvider("zen", { enabledModels: [] });
    expect(updated.id).toBe("zen");
    // without a running proxy in this graph only the connected marker shows
    expect(updated.envVars.OPENCODE_API_KEY).toBe("zk-1");
    expect(updated.envVars.ANTHROPIC_BASE_URL).toBeUndefined();

    expect(() => deleteProvider("zen")).toThrow(/built-in/);
  });

  it("openrouter routes through the format proxy when it is active, direct otherwise", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([
        {
          id: "openrouter",
          name: "OpenRouter",
          isBuiltin: true,
          models: [],
          envVars: { ANTHROPIC_AUTH_TOKEN: "sk-or-x" },
          enabledModels: [],
        },
      ]),
    );

    const { getActiveFormatProxy, setActiveFormatProxy } = await import("@/server/format-proxy");
    const { getProviders, resolveProxyUpstream } = await import("@/server/providers");

    const direct = getProviders().find((p) => p.id === "openrouter");
    expect(direct?.envVars.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");

    setActiveFormatProxy({ isRunning: true, getUrl: (id: string) => `http://127.0.0.1:9999/${id}` } as unknown as ReturnType<
      typeof getActiveFormatProxy
    > & { isRunning: boolean });
    // cache is mtime-gated; force a rebuild by re-importing fresh state
    vi.resetModules();
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([
        {
          id: "openrouter",
          name: "OpenRouter",
          isBuiltin: true,
          models: [],
          envVars: { ANTHROPIC_AUTH_TOKEN: "sk-or-x" },
          enabledModels: [],
        },
      ]),
    );
    const fresh = await import("@/server/providers");
    const proxied = fresh.getProviders().find((p) => p.id === "openrouter");
    expect(proxied?.envVars.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9999/openrouter");
    // the CLI keeps authenticating with the real key; the proxy only relays
    expect(proxied?.envVars.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-x");

    const up = fresh.resolveProxyUpstream("openrouter");
    expect(up).toMatchObject({ baseUrl: "https://openrouter.ai/api", apiKey: "sk-or-x", wireFormat: "anthropic" });
    expect(resolveProxyUpstream("openrouter")).toMatchObject({ wireFormat: "anthropic" });
  });

  it("openRouterModelEnv pins every default-model slot", async () => {
    const { openRouterModelEnv } = await import("@/server/providers");
    expect(openRouterModelEnv("vendor/main:free")).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: "vendor/main:free",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "vendor/main:free",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "vendor/main:free",
      CLAUDE_CODE_SUBAGENT_MODEL: "vendor/main:free",
    });
    expect(openRouterModelEnv("vendor/main", "vendor/small:free")).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "vendor/small:free",
      CLAUDE_CODE_SUBAGENT_MODEL: "vendor/small:free",
    });
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

  it("resolveProviderModel strips a legacy context suffix from a qualified model", async () => {
    const fs = await import("node:fs");
    const custom = [
      {
        id: "ds-1",
        name: "Deepseek",
        envVars: {},
        models: [{ modelId: "deepseek-v4-pro", displayName: "Deepseek V4 Pro", effortLevels: [], contextSizes: ["200k", "1m"] }],
      },
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(custom));

    const { resolveProviderModel } = await import("@/server/providers");
    // A job whose stored model still carries the legacy "[1m]" suffix must
    // resolve to the cleaned provider model.
    const result = resolveProviderModel("ds-1:deepseek-v4-pro[1m]");

    expect(result).not.toBeNull();
    expect(result!.provider.id).toBe("ds-1");
    expect(result!.model.modelId).toBe("deepseek-v4-pro");
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
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
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

    expect(() =>
      updateProvider(created!.id, {
        models: [{ modelId: "m1", displayName: "m1", effortLevels: [], contextSizes: [] }],
      }),
    ).toThrow(/contextSizes/);
  });

  it("reloads providers when providers.json changes out of band (different mtime)", async () => {
    const fs = await import("node:fs");
    const listA = [
      { id: "p-a", name: "A", envVars: {}, models: [{ modelId: "m-a", displayName: "m-a", effortLevels: [], contextSizes: ["200k"] }] },
    ];
    const listB = [
      { id: "p-b", name: "B", envVars: {}, models: [{ modelId: "m-b", displayName: "m-b", effortLevels: [], contextSizes: ["200k"] }] },
    ];
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(listA));
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1 } as unknown as ReturnType<typeof fs.statSync>);

    const { getProviders } = await import("@/server/providers");
    expect(getProviders().find((p) => p.id === "p-a")).toBeDefined();
    expect(getProviders().find((p) => p.id === "p-b")).toBeUndefined();

    // Another module graph (the settings route) or a hand edit rewrites the file:
    // content + mtime change, with no mutator called in THIS graph. mtime-gating
    // must pick it up so a session spawn sees the new provider without a restart.
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(listB));
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 2 } as unknown as ReturnType<typeof fs.statSync>);

    expect(getProviders().find((p) => p.id === "p-b")).toBeDefined();
    expect(getProviders().find((p) => p.id === "p-a")).toBeUndefined();
  });
});
