"use client";

import { Bell, Check } from "lucide-react";
import type { NotificationProviderEntry, SessionNotifications } from "@/types";

/**
 * A session's outbound notifications: one provider, and which of the three
 * events it sends. Shared by the composer's Notifications tab and the
 * new-session dialog, which sets the same preference before the session has
 * ever spawned. The test-id prefix keeps the two apart in tests while the
 * composer keeps the ids it always had.
 */
export function SessionNotificationsSettings({
  notifications,
  providers,
  onChange,
  testIdPrefix = "notify",
}: {
  notifications?: SessionNotifications | null;
  providers: NotificationProviderEntry[];
  onChange: (notifications: SessionNotifications | null) => void;
  testIdPrefix?: string;
}) {
  const id = (suffix: string) => `${testIdPrefix}-${suffix}`;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Bell className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">Send notifications</span>
        </div>
        <p className="text-[11px] text-muted-foreground">One provider per session. Off means this session never messages you on its own.</p>
        <div className="space-y-1.5">
          <button
            onClick={() => onChange(null)}
            data-testid={id("off")}
            className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-xs transition-colors ${
              !notifications?.providerId ? "border-primary bg-primary/10" : "border-border hover:bg-muted/50"
            }`}
          >
            <span>Off</span>
            {!notifications?.providerId && <Check className="h-3.5 w-3.5 text-primary" />}
          </button>
          {providers.map((provider) => {
            const selected = notifications?.providerId === provider.id;
            return (
              <button
                key={provider.id}
                onClick={() =>
                  onChange({
                    providerId: provider.id,
                    events: notifications?.events ?? { finished: true, question: true, permission: true },
                  })
                }
                data-testid={id(`provider-${provider.id}`)}
                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-xs transition-colors ${
                  selected ? "border-primary bg-primary/10" : "border-border hover:bg-muted/50"
                }`}
              >
                <span className="flex items-center gap-2">
                  {provider.name}
                  <span className="text-muted-foreground">{provider.type}</span>
                  {!provider.enabled && <span className="text-muted-foreground">(disabled)</span>}
                </span>
                {selected && <Check className="h-3.5 w-3.5 text-primary" />}
              </button>
            );
          })}
          {/* A provider this session chose and that has since been deleted:
              saying so is better than silence. */}
          {notifications?.providerId && !providers.some((p) => p.id === notifications.providerId) && (
            <div className="flex items-center justify-between rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
              <span>This session&apos;s provider is no longer configured</span>
            </div>
          )}
          {providers.length === 0 && notifications?.providerId === undefined && (
            <p className="text-[11px] text-muted-foreground">No providers configured yet. Add one in Settings → Notifications.</p>
          )}
        </div>
      </div>

      {notifications?.providerId && (
        <div className="space-y-2">
          <span className="text-xs font-medium text-foreground">Tell me when</span>
          <div className="space-y-1.5">
            {(
              [
                ["finished", "A turn finishes"],
                ["question", "Claude asks a question"],
                ["permission", "A permission is waiting"],
              ] as const
            ).map(([key, label]) => {
              const on = notifications.events?.[key] !== false;
              return (
                <button
                  key={key}
                  onClick={() =>
                    onChange({
                      ...notifications,
                      events: { ...notifications.events, [key]: !on },
                    })
                  }
                  data-testid={id(`event-${key}`)}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-xs transition-colors ${
                    on ? "border-primary bg-primary/10" : "border-border hover:bg-muted/50"
                  }`}
                >
                  <span>{label}</span>
                  {on && <Check className="h-3.5 w-3.5 text-primary" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
