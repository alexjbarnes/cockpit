"use client";

import { ArrowLeft, Loader2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { ProviderForm } from "@/components/provider-form";
import { Button } from "@/components/ui/button";
import type { Provider } from "@/types";

export default function EditProviderPage() {
  usePageHeader("Edit Provider", { hideActions: true });
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/providers")
      .then((res) => res.json())
      .then((data: Provider[]) => {
        const found = data.find((p) => p.id === id);
        setProvider(found || null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id]);

  const handleSave = useCallback(
    async (updated: Provider) => {
      await fetch(`/api/providers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
      router.push("/settings");
    },
    [id, router],
  );

  const handleDelete = useCallback(async () => {
    await fetch(`/api/providers/${id}`, { method: "DELETE" });
    router.push("/settings");
  }, [id, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!provider) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        <Button variant="ghost" size="sm" onClick={() => router.push("/settings")}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Settings
        </Button>
        <p className="text-sm text-muted-foreground">Provider not found.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col p-4 gap-4">
      <Button variant="ghost" size="sm" className="self-start shrink-0" onClick={() => router.push("/settings")}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        Settings
      </Button>
      <div className="max-w-xl mx-auto flex-1 min-h-0" data-testid="settings-content">
        <ProviderForm
          provider={provider}
          isNew={false}
          lockedEnvKeys={[
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "CLAUDE_CODE_SUBAGENT_MODEL",
            "CLAUDE_CODE_EFFORT_LEVEL",
          ]}
          onSave={handleSave}
          onCancel={() => router.push("/settings")}
          onDelete={handleDelete}
        />
      </div>
    </div>
  );
}
