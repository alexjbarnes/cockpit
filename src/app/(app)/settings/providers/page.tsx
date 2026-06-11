"use client";

import { ArrowLeft, ChevronRight, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
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

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
      <Button variant="ghost" size="sm" className="mb-4" onClick={() => router.push("/settings")}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        Settings
      </Button>
      <div className="max-w-lg mx-auto space-y-1" data-testid="settings-content">
        {providers.map((provider) => (
          <button
            key={provider.id}
            type="button"
            onClick={() => !provider.isBuiltin && router.push(`/settings/providers/${provider.id}`)}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-3 text-sm transition-colors text-left ${
              provider.isBuiltin ? "cursor-default" : "hover:bg-muted/50"
            }`}
          >
            <span className="font-medium">{provider.name}</span>
            {provider.isBuiltin && <span className="text-xs text-muted-foreground">(built-in)</span>}
            <span className="ml-auto text-xs text-muted-foreground">
              {provider.models.length} model{provider.models.length !== 1 ? "s" : ""}
            </span>
            {!provider.isBuiltin && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          </button>
        ))}
        <button
          type="button"
          onClick={() => router.push("/settings/providers/new")}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Add provider
        </button>
      </div>
    </div>
  );
}
