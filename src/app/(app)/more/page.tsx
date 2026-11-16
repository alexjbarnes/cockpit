"use client";

import { useRouter } from "next/navigation";
import { usePageHeader } from "@/components/app-shell";
import { NAV_ITEMS } from "@/components/nav/nav-items";
import { NavRow } from "@/components/ui/nav-row";
import { useSettings } from "@/hooks/use-settings";

/** What does not fit along the phone's bottom bar. Desktop has all of these
 *  in the rail; the page still works there, it is just not linked. */
export default function MorePage() {
  usePageHeader("More", { hideActions: true });
  const router = useRouter();
  const { settings, loaded } = useSettings();
  if (!loaded) return null;

  const row = (key: "reviews" | "jobs" | "insights" | "settings", label: string, path: string) => {
    const Icon = NAV_ITEMS[key].icon;
    return (
      <NavRow
        key={key}
        label={label}
        testId={`more-${key}`}
        icon={<Icon className="h-4 w-4 text-muted-foreground" />}
        onClick={() => router.push(path)}
      />
    );
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
      <div className="max-w-2xl mx-auto space-y-0.5">
        {settings.reviewsEnabled && row("reviews", "Reviews", "/reviews")}
        {row("jobs", "Scheduled Jobs", "/jobs")}
        {settings.telemetryEnabled && row("insights", "Insights", "/insights")}
        {row("settings", "Settings", "/settings")}
      </div>
    </div>
  );
}
