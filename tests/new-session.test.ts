// The new-session dialog's decisions: which models can run Auto, what step two
// inherits, how a model pick settles context/thinking, and the POST body.
import { describe, expect, it } from "vitest";
import { applyModelPick, clampPermissionMode, draftFromDefaults, modelIsAnthropic, newSessionBody } from "@/lib/new-session";
import type { Provider, ProviderModel } from "@/types";

function model(modelId: string, extra: Partial<ProviderModel> = {}): ProviderModel {
  return { modelId, displayName: modelId, effortLevels: [], contextSizes: [], ...extra };
}

function provider(id: string, models: ProviderModel[]): Provider {
  return { id, name: `${id} name`, envVars: {}, models };
}

const zen = provider("zen", [
  model("kimi-k3", { effortLevels: ["medium", "high"], contextSizes: ["200k", "1m"] }),
  model("ds-free", { effortLevels: [], contextSizes: ["200k"] }),
]);

const defaults = {
  modelSlots: { main: "sonnet", mainContext: "200k" as const },
  thinkingLevel: "high" as const,
  permissionMode: "manual" as const,
  sandbox: { enabled: false },
};

describe("modelIsAnthropic", () => {
  it("counts catalogue aliases, full ids and the anthropic prefix", () => {
    expect(modelIsAnthropic("sonnet", [zen])).toBe(true);
    expect(modelIsAnthropic("claude-opus-4-8", [zen])).toBe(true);
    expect(modelIsAnthropic("anthropic:claude-sonnet-4-6", [zen])).toBe(true);
  });

  it("counts a provider-qualified id as that provider's, even before its models load", () => {
    expect(modelIsAnthropic("zen:kimi-k3", [zen])).toBe(false);
    expect(modelIsAnthropic("zen:kimi-k3", undefined)).toBe(false);
  });

  it("counts a bare id a connected provider serves as that provider's", () => {
    expect(modelIsAnthropic("kimi-k3", [zen])).toBe(false);
  });

  it("counts an unclaimed bare id as Anthropic's, as the server does", () => {
    expect(modelIsAnthropic("mystery-model", [zen])).toBe(true);
    expect(modelIsAnthropic("mystery-model", undefined)).toBe(true);
  });
});

describe("clampPermissionMode", () => {
  it("drops Auto to Manual off Anthropic and leaves everything else alone", () => {
    expect(clampPermissionMode("auto", "zen:kimi-k3", [zen])).toBe("manual");
    expect(clampPermissionMode("auto", "sonnet", [zen])).toBe("auto");
    expect(clampPermissionMode("bypass", "zen:kimi-k3", [zen])).toBe("bypass");
    expect(clampPermissionMode("manual", "sonnet", [zen])).toBe("manual");
  });
});

describe("draftFromDefaults", () => {
  it("inherits the session defaults, with notifications off", () => {
    expect(draftFromDefaults(defaults, [zen])).toEqual({
      model: "sonnet",
      contextSize: "200k",
      thinkingLevel: "high",
      permissionMode: "manual",
      sandbox: { enabled: false },
      notifications: null,
    });
  });

  it("settles a context the model does not offer and clamps Auto", () => {
    const draft = draftFromDefaults(
      {
        modelSlots: { main: "zen:ds-free", mainContext: "1m" },
        thinkingLevel: "high",
        permissionMode: "auto",
        sandbox: { enabled: true },
      },
      [zen],
    );
    expect(draft.contextSize).toBe("200k");
    expect(draft.permissionMode).toBe("manual");
    expect(draft.sandbox).toEqual({ enabled: true });
  });
});

describe("applyModelPick", () => {
  it("keeps context and thinking when the new model can run them", () => {
    const draft = draftFromDefaults({ ...defaults, modelSlots: { main: "sonnet", mainContext: "200k" }, thinkingLevel: "high" }, [zen]);
    expect(applyModelPick(draft, "zen:kimi-k3", [zen])).toMatchObject({
      model: "zen:kimi-k3",
      contextSize: "200k",
      thinkingLevel: "high",
    });
  });

  it("clamps Auto when the pick leaves Anthropic, and does not restore it on the way back", () => {
    const auto = { ...draftFromDefaults(defaults, [zen]), permissionMode: "auto" as const };
    const providerPick = applyModelPick(auto, "zen:kimi-k3", [zen]);
    expect(providerPick.permissionMode).toBe("manual");
    expect(applyModelPick(providerPick, "sonnet", [zen]).permissionMode).toBe("manual");
  });
});

describe("newSessionBody", () => {
  it("trims cwd and name and omits an empty name and null notifications", () => {
    expect(newSessionBody({ cwd: "  /repo  ", name: "   ", runtime: "pty", notifications: null })).toEqual({
      cwd: "/repo",
      runtime: "pty",
    });
  });

  it("carries every setting it was given", () => {
    expect(
      newSessionBody({
        cwd: "/repo",
        name: " Work ",
        runtime: "stream",
        model: "zen:kimi-k3",
        contextSize: "1m",
        thinkingLevel: "medium",
        permissionMode: "bypass",
        sandbox: { enabled: true, allowedDomains: ["github.com"] },
        notifications: { providerId: "telegram", events: { finished: false } },
      }),
    ).toEqual({
      cwd: "/repo",
      name: "Work",
      runtime: "stream",
      model: "zen:kimi-k3",
      contextSize: "1m",
      thinkingLevel: "medium",
      permissionMode: "bypass",
      sandbox: { enabled: true, allowedDomains: ["github.com"] },
      notifications: { providerId: "telegram", events: { finished: false } },
    });
  });
});
