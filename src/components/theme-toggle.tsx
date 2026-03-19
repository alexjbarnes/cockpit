"use client";

import { useState, useEffect, useCallback } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

type Theme = "light" | "dark" | "system";

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

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const stored = localStorage.getItem("cockpit-theme") as Theme | null;
    const initial = stored || "system";
    setTheme(initial);
    applyTheme(initial);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const current = localStorage.getItem("cockpit-theme") as Theme | null;
      if (!current || current === "system") {
        applyTheme("system");
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const cycle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "light" ? "dark" : prev === "dark" ? "system" : "light";
      localStorage.setItem("cockpit-theme", next);
      applyTheme(next);
      return next;
    });
  }, []);

  const resolved = theme === "system" ? getSystemTheme() : theme;

  return (
    <Button variant="ghost" size="icon" onClick={cycle} title={`Theme: ${theme}`}>
      {resolved === "dark" ? (
        <Moon className="h-4 w-4" />
      ) : (
        <Sun className="h-4 w-4" />
      )}
    </Button>
  );
}
