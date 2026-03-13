"use client";

import { useState, useEffect, useCallback } from "react";

export type DiffStyle = "split" | "unified";

export interface Settings {
  diffStyle: DiffStyle;
  dismissKeyboardOnSend: boolean;
}

const STORAGE_KEY = "aperture-settings";

const defaultSettings: Settings = {
  diffStyle: "split",
  dismissKeyboardOnSend: true,
};

function loadSettings(): Settings {
  if (typeof window === "undefined") return defaultSettings;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings;
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return defaultSettings;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);

  useEffect(() => {
    setSettings(loadSettings());

    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setSettings(loadSettings());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const updateSetting = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      setSettings((prev) => {
        const next = { ...prev, [key]: value };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    },
    []
  );

  return { settings, updateSetting };
}
