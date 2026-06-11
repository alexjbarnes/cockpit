"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { usePageHeader } from "@/components/app-shell";
import { ProviderForm } from "@/components/provider-form";
import { Button } from "@/components/ui/button";

export default function NewProviderPage() {
  usePageHeader("Add Provider", { hideActions: true });
  const router = useRouter();

  const handleSave = useCallback(
    async (provider: Parameters<typeof ProviderForm>[0]["provider"]) => {
      await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(provider),
      });
      router.push("/settings");
    },
    [router],
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col p-4 gap-4">
      <Button variant="ghost" size="sm" className="self-start shrink-0" onClick={() => router.push("/settings")}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        Settings
      </Button>
      <div className="flex-1 min-h-0">
        <ProviderForm
          provider={{
            id: "",
            name: "",
            envVars: {
              ANTHROPIC_BASE_URL: "",
              ANTHROPIC_AUTH_TOKEN: "",
              ANTHROPIC_MODEL: "",
              ANTHROPIC_DEFAULT_OPUS_MODEL: "",
              ANTHROPIC_DEFAULT_SONNET_MODEL: "",
              ANTHROPIC_DEFAULT_HAIKU_MODEL: "",
              CLAUDE_CODE_SUBAGENT_MODEL: "",
            },
            models: [],
          }}
          isNew
          lockedEnvKeys={[
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "CLAUDE_CODE_SUBAGENT_MODEL",
          ]}
          onSave={handleSave}
          onCancel={() => router.push("/settings")}
        />
      </div>
    </div>
  );
}
