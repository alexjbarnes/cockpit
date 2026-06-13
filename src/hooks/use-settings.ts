"use client";

import { useCallback, useEffect, useState } from "react";
import { splitLegacyModel } from "@/lib/models";
import type { ModelSlots } from "@/types";

export type DiffStyle = "split" | "unified";
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";
export type TerminalTheme =
  | "cockpit"
  | "dark"
  | "dracula"
  | "catppuccin"
  | "tokyoNight"
  | "nord"
  | "gruvbox"
  | "solarized"
  | "monokai"
  | "oneDark";

export interface Settings {
  diffStyle: DiffStyle;
  dismissKeyboardOnSend: boolean;
  thinkingLevel: ThinkingLevel;
  bypassAllPermissions: boolean;
  thinkingExpanded: boolean;
  readExpanded: boolean;
  editExpanded: boolean;
  toolCallsExpanded: boolean;
  modelSlots: ModelSlots;
  messageStitching: boolean;
  reviewsEnabled: boolean;
  terminalFontSize: number;
  terminalTheme: TerminalTheme;
  terminalScrollback: number;
}

const defaultSettings: Settings = {
  diffStyle: "split",
  dismissKeyboardOnSend: true,
  thinkingLevel: "high",
  bypassAllPermissions: false,
  thinkingExpanded: false,
  readExpanded: false,
  editExpanded: false,
  toolCallsExpanded: false,
  modelSlots: { main: "sonnet" },
  messageStitching: true,
  reviewsEnabled: true,
  terminalFontSize: 14,
  terminalTheme: "dark" as TerminalTheme,
  terminalScrollback: 1000,
};

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/defaults")
      .then((res) => res.json())
      .then((data) => {
        if (data.model && !data.modelSlots) {
          data.modelSlots = { main: data.model };
          delete data.model;
        }
        if (data.modelSlots?.main?.includes("[")) {
          const split = splitLegacyModel(data.modelSlots.main);
          data.modelSlots = {
            ...data.modelSlots,
            main: split.model,
            mainContext: data.modelSlots.mainContext ?? split.contextSize,
          };
        }
        setSettings({ ...defaultSettings, ...data });
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const updateSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      fetch("/api/defaults", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      }).catch(() => {});
      return next;
    });
  }, []);

  return { settings, updateSetting, loaded };
}
