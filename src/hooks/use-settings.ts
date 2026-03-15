"use client";

import { useState, useEffect, useCallback } from "react";

export type DiffStyle = "split" | "unified";
export type ThinkingLevel = "low" | "medium" | "high";

export interface Settings {
  diffStyle: DiffStyle;
  dismissKeyboardOnSend: boolean;
  thinkingLevel: ThinkingLevel;
  bypassAllPermissions: boolean;
  thinkingExpanded: boolean;
}

const defaultSettings: Settings = {
  diffStyle: "split",
  dismissKeyboardOnSend: true,
  thinkingLevel: "high",
  bypassAllPermissions: false,
  thinkingExpanded: false,
};

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/defaults")
      .then((res) => res.json())
      .then((data) => {
        setSettings({ ...defaultSettings, ...data });
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const updateSetting = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      setSettings((prev) => {
        const next = { ...prev, [key]: value };
        fetch("/api/defaults", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: value }),
        }).catch(() => {});
        return next;
      });
    },
    []
  );

  return { settings, updateSetting, loaded };
}
