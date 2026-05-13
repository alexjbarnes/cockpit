"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { usePageHeader } from "@/components/app-shell";
import { ProviderForm } from "@/components/provider-form";
import { Button } from "@/components/ui/button";

export default function NewProviderPage() {
  usePageHeader("Add Provider");
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
    <>
      <Button variant="ghost" size="sm" onClick={() => router.push("/settings")}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        Settings
      </Button>
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
            CLAUDE_CODE_EFFORT_LEVEL: "",
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
          "CLAUDE_CODE_EFFORT_LEVEL",
        ]}
        onSave={handleSave}
        onCancel={() => router.push("/settings")}
      />
    </>
  );
}
