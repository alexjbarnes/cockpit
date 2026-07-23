"use client";

import { ArrowLeft, ChevronRight, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { DeepSeekCard, OpenRouterCard, ZenCard } from "@/components/openrouter-provider";
import { Button } from "@/components/ui/button";
import type { Provider } from "@/types";

export default function ProvidersPage() {
  usePageHeader("Model Providers", { hideActions: true });
  const router = useRouter();
  const [providers, setProviders] = useState<Provider[]>([]);

  const fetchProviders = useCallback(() => {
    fetch("/api/providers")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setProviders(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const anthropic = providers.find((p) => p.id === "anthropic");
  const openrouter = providers.find((p) => p.id === "openrouter");
  const zen = providers.find((p) => p.id === "zen");
  const deepseek = providers.find((p) => p.id === "deepseek");
  const custom = providers.filter((p) => !p.isBuiltin);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
      <Button variant="ghost" size="sm" className="mb-4" onClick={() => router.push("/settings")}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        Settings
      </Button>
      <div className="space-y-3">
        {anthropic && (
          <div className="rounded-lg border p-3 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Anthropic</span>
              <span className="rounded bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">connected</span>
              <span className="ml-auto text-xs text-muted-foreground">{anthropic.models.length} models · built-in catalog</span>
            </div>
            <p className="text-xs text-muted-foreground">Subscription via the Claude CLI. Always available.</p>
          </div>
        )}
        {openrouter && (
          <OpenRouterCard provider={openrouter} onChanged={fetchProviders} onManage={() => router.push("/settings/providers/openrouter")} />
        )}
        {zen && <ZenCard provider={zen} onChanged={fetchProviders} onManage={() => router.push("/settings/providers/zen")} />}
        {deepseek && (
          <DeepSeekCard provider={deepseek} onChanged={fetchProviders} onManage={() => router.push("/settings/providers/deepseek")} />
        )}

        <p className="pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Custom</p>
        <div className="space-y-1">
          {custom.map((provider) => (
            <button
              key={provider.id}
              type="button"
              onClick={() => router.push(`/settings/providers/${provider.id}`)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-sm transition-colors text-left hover:bg-muted/50"
            >
              <span className="font-medium">{provider.name}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {provider.models.length} model{provider.models.length !== 1 ? "s" : ""} · manual
              </span>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          ))}
          <button
            type="button"
            onClick={() => router.push("/settings/providers/new")}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add custom provider
          </button>
        </div>
      </div>
    </div>
  );
}
