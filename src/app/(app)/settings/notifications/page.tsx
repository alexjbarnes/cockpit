"use client";

import { ArrowLeft, Bell, Loader2, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { InboxPriority, NotificationProviderEntry, NotificationSettings, NtfyConfig, TelegramConfig } from "@/types";

type ProviderType = "telegram" | "ntfy";

interface FormState {
  id: string;
  type: ProviderType;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  filterPriorities: InboxPriority[];
  filterSources: string[];
}

const emptyForm = (type: ProviderType): FormState => ({
  id: "",
  type,
  name: type === "telegram" ? "Telegram" : "ntfy",
  enabled: true,
  config: type === "telegram" ? { botToken: "", chatId: "" } : { serverUrl: "https://ntfy.sh", topic: "", token: "" },
  filterPriorities: [],
  filterSources: [],
});

function entryToForm(entry: NotificationProviderEntry): FormState {
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry.config)) {
    config[k] = v ?? "";
  }
  return {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    enabled: entry.enabled,
    config,
    filterPriorities: entry.filter?.priorities || [],
    filterSources: entry.filter?.sources || [],
  };
}

function formToEntry(form: FormState): NotificationProviderEntry {
  const filter =
    form.filterPriorities.length > 0 || form.filterSources.length > 0
      ? {
          priorities: form.filterPriorities.length > 0 ? form.filterPriorities : undefined,
          sources: form.filterSources.length > 0 ? form.filterSources : undefined,
        }
      : undefined;
  return {
    id: form.id || uuidv4(),
    type: form.type,
    name: form.name,
    enabled: form.enabled,
    config: form.config as unknown as TelegramConfig | NtfyConfig,
    filter,
  };
}

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  const bg = enabled ? "bg-green-500" : "bg-muted-foreground/30";
  return (
    <button type="button" onClick={onToggle} className="shrink-0">
      <span className={`inline-flex h-6 w-10 items-center rounded-full transition-colors ${bg}`}>
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-1"}`}
        />
      </span>
    </button>
  );
}

function PriorityFilter({ selected, onChange }: { selected: InboxPriority[]; onChange: (v: InboxPriority[]) => void }) {
  const all: InboxPriority[] = ["info", "warning", "error"];
  return (
    <div className="flex gap-1">
      {all.map((p) => {
        const active = selected.includes(p);
        return (
          <button
            key={p}
            type="button"
            onClick={() => onChange(active ? selected.filter((x) => x !== p) : [...selected, p])}
            className={`px-2 py-0.5 text-xs rounded border transition-colors ${active ? "bg-primary text-primary-foreground border-primary" : "border-input hover:bg-accent"}`}
          >
            {p}
          </button>
        );
      })}
    </div>
  );
}

function ProviderForm({
  form,
  onChange,
  onSave,
  onCancel,
  onTest,
  testing,
  testResult,
}: {
  form: FormState;
  onChange: (f: FormState) => void;
  onSave: () => void;
  onCancel: () => void;
  onTest: () => void;
  testing: boolean;
  testResult: string | null;
}) {
  const updateConfig = (key: string, value: string) => {
    onChange({ ...form, config: { ...form.config, [key]: value } });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground">Name</label>
          <Input value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} placeholder="My notification" />
        </div>

        <div>
          <label className="text-xs text-muted-foreground">Type</label>
          <div className="flex gap-1 mt-1">
            {(["telegram", "ntfy"] as ProviderType[]).map((t) => {
              const defaultNames = ["Telegram", "ntfy"];
              const nameIsDefault = defaultNames.includes(form.name);
              const newName = nameIsDefault ? (t === "telegram" ? "Telegram" : "ntfy") : form.name;
              return (
                <Button
                  key={t}
                  variant={form.type === t ? "default" : "outline"}
                  size="sm"
                  onClick={() => onChange({ ...emptyForm(t), id: form.id, name: newName })}
                >
                  {t === "telegram" ? "Telegram" : "ntfy.sh"}
                </Button>
              );
            })}
          </div>
        </div>

        {form.type === "telegram" && (
          <>
            <div>
              <label className="text-xs text-muted-foreground">Bot Token</label>
              <Input
                value={form.config.botToken || ""}
                onChange={(e) => updateConfig("botToken", e.target.value)}
                placeholder="123456:ABC-DEF..."
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Chat ID</label>
              <Input
                value={form.config.chatId || ""}
                onChange={(e) => updateConfig("chatId", e.target.value)}
                placeholder="-1001234567890"
              />
              <p className="text-xs text-muted-foreground mt-1">Message @userinfobot on Telegram to get your chat ID</p>
            </div>
          </>
        )}

        {form.type === "ntfy" && (
          <>
            <div>
              <label className="text-xs text-muted-foreground">Server URL</label>
              <Input
                value={form.config.serverUrl || ""}
                onChange={(e) => updateConfig("serverUrl", e.target.value)}
                placeholder="https://ntfy.sh"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Topic</label>
              <Input
                value={form.config.topic || ""}
                onChange={(e) => updateConfig("topic", e.target.value)}
                placeholder="my-cockpit-alerts"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Token (optional)</label>
              <Input
                value={form.config.token || ""}
                onChange={(e) => updateConfig("token", e.target.value)}
                placeholder="Bearer token for authenticated instances"
              />
            </div>
          </>
        )}

        <div>
          <label className="text-xs text-muted-foreground">Filter by priority (empty = all)</label>
          <div className="mt-1">
            <PriorityFilter selected={form.filterPriorities} onChange={(v) => onChange({ ...form, filterPriorities: v })} />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between pt-2 border-t">
        <Button variant="outline" size="sm" onClick={onTest} disabled={testing}>
          {testing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1" />}
          Test
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSave}>
            Save
          </Button>
        </div>
      </div>

      {testResult && (
        <p className={`text-xs ${testResult === "ok" ? "text-green-500" : "text-destructive"}`}>
          {testResult === "ok" ? "Test notification sent" : testResult}
        </p>
      )}
    </div>
  );
}

export default function NotificationsSettingsPage() {
  usePageHeader("Notifications", { hideActions: true });
  const router = useRouter();
  const [settings, setSettings] = useState<NotificationSettings>({ providers: [] });
  const [loading, setLoading] = useState(true);
  const [editForm, setEditForm] = useState<FormState | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState("");

  const fetchSettings = useCallback(async () => {
    const res = await fetch("/api/notifications");
    if (res.ok) {
      const data: NotificationSettings = await res.json();
      setSettings(data);
      setBaseUrl(data.baseUrl || "");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveSettings = async (updated: NotificationSettings) => {
    setSettings(updated);
    await fetch("/api/notifications", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
  };

  const handleSaveProvider = () => {
    if (!editForm) return;
    const entry = formToEntry(editForm);
    const providers = editForm.id ? settings.providers.map((p) => (p.id === entry.id ? entry : p)) : [...settings.providers, entry];
    saveSettings({ ...settings, providers });
    setEditForm(null);
    setTestResult(null);
  };

  const handleDeleteProvider = () => {
    if (!confirmDelete) return;
    const providers = settings.providers.filter((p) => p.id !== confirmDelete);
    saveSettings({ ...settings, providers });
    setConfirmDelete(null);
  };

  const handleToggleProvider = (id: string) => {
    if (!settings) return;
    const providers = settings.providers.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p));
    saveSettings({ ...settings, providers });
  };

  const handleTest = async () => {
    if (!editForm) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: formToEntry(editForm) }),
      });
      if (!res.ok && res.headers.get("content-type")?.includes("text/html")) {
        setTestResult("API route not available - rebuild required");
      } else {
        const data = await res.json();
        setTestResult(data.success ? "ok" : data.error || "Failed");
      }
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : "Network error");
    }
    setTesting(false);
  };

  const handleBaseUrlSave = () => {
    if (!settings) return;
    const trimmed = baseUrl.replace(/\/$/, "");
    saveSettings({ ...settings, baseUrl: trimmed || undefined });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <Button variant="ghost" size="sm" onClick={() => router.push("/settings")}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        Settings
      </Button>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Base URL</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-2">
            Used to build clickable links in notifications. Leave empty if Cockpit is not exposed externally.
          </p>
          <div className="flex gap-2">
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://cockpit.example.com"
              className="flex-1"
            />
            <Button size="sm" variant="outline" onClick={handleBaseUrlSave}>
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Providers</CardTitle>
            <Button size="sm" variant="outline" onClick={() => setEditForm(emptyForm("telegram"))}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {settings?.providers.length === 0 && !editForm && (
            <div className="flex flex-col items-center py-8 text-center">
              <Bell className="h-10 w-10 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">No notification providers configured.</p>
              <p className="text-xs text-muted-foreground mt-1">Add Telegram or ntfy.sh to receive alerts externally.</p>
            </div>
          )}

          {!editForm &&
            settings?.providers.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 py-2 border-b last:border-b-0">
                <Toggle enabled={entry.enabled} onToggle={() => handleToggleProvider(entry.id)} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{entry.name}</span>
                    <span className="text-xs text-muted-foreground">{entry.type}</span>
                  </div>
                  {entry.filter?.priorities && (
                    <span className="text-xs text-muted-foreground">{entry.filter.priorities.join(", ")} only</span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => {
                    setEditForm(entryToForm(entry));
                    setTestResult(null);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => setConfirmDelete(entry.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}

          {editForm && (
            <div className="pt-2">
              <ProviderForm
                form={editForm}
                onChange={setEditForm}
                onSave={handleSaveProvider}
                onCancel={() => {
                  setEditForm(null);
                  setTestResult(null);
                }}
                onTest={handleTest}
                testing={testing}
                testResult={testResult}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Provider</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">Remove this notification provider?</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteProvider}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
