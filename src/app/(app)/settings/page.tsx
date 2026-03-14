"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { usePageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSettings, type DiffStyle } from "@/hooks/use-settings";
import { ChevronRight } from "lucide-react";

type Theme = "light" | "dark" | "system";

const diffOptions: { value: DiffStyle; label: string }[] = [
  { value: "split", label: "Side-by-side" },
  { value: "unified", label: "Inline" },
];

const themeOptions: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  const resolved = theme === "system" ? getSystemTheme() : theme;
  if (resolved === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

export default function SettingsPage() {
  const { settings, updateSetting } = useSettings();
  const [theme, setTheme] = useState<Theme>("system");
  const router = useRouter();

  usePageHeader("Settings", true);

  useEffect(() => {
    const stored = localStorage.getItem("aperture-theme") as Theme | null;
    setTheme(stored || "system");
  }, []);

  const selectTheme = useCallback((t: Theme) => {
    setTheme(t);
    localStorage.setItem("aperture-theme", t);
    applyTheme(t);
  }, []);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Theme</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            {themeOptions.map((opt) => (
              <Button
                key={opt.value}
                variant={theme === opt.value ? "default" : "outline"}
                size="sm"
                onClick={() => selectTheme(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>
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
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agents</CardTitle>
        </CardHeader>
        <CardContent>
          <button
            onClick={() => router.push("/agents")}
            className="flex w-full items-center justify-between rounded px-2 py-2 text-sm hover:bg-muted transition-colors"
          >
            <span>Manage custom agents</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Skills</CardTitle>
        </CardHeader>
        <CardContent>
          <button
            onClick={() => router.push("/skills")}
            className="flex w-full items-center justify-between rounded px-2 py-2 text-sm hover:bg-muted transition-colors"
          >
            <span>Manage skills</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Commands</CardTitle>
        </CardHeader>
        <CardContent>
          <button
            onClick={() => router.push("/commands")}
            className="flex w-full items-center justify-between rounded px-2 py-2 text-sm hover:bg-muted transition-colors"
          >
            <span>Manage custom commands</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
