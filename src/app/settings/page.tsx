"use client";

import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSettings, type DiffStyle } from "@/hooks/use-settings";

const diffOptions: { value: DiffStyle; label: string }[] = [
  { value: "split", label: "Side-by-side" },
  { value: "unified", label: "Inline" },
];

export default function SettingsPage() {
  const { settings, updateSetting } = useSettings();

  return (
    <AppShell title="Settings" showBack>
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Diff display</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              {diffOptions.map((opt) => (
                <Button
                  key={opt.value}
                  variant={settings.diffStyle === opt.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => updateSetting("diffStyle", opt.value)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Keyboard</CardTitle>
          </CardHeader>
          <CardContent>
            <button
              onClick={() => updateSetting("dismissKeyboardOnSend", !settings.dismissKeyboardOnSend)}
              className="flex w-full items-center justify-between rounded px-2 py-2 text-sm hover:bg-muted transition-colors"
            >
              <span>Dismiss keyboard on send</span>
              <span
                className={`inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                  settings.dismissKeyboardOnSend ? "bg-green-500" : "bg-muted-foreground/30"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                    settings.dismissKeyboardOnSend ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </span>
            </button>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
