"use client";

import { Check, X } from "lucide-react";
import { useMemo } from "react";
import { CodeBlock } from "@/components/code-block";
import type { PendingPermission } from "@/hooks/use-session";
import { formatConfigChange } from "@/lib/config-change";
import type { PermissionMode } from "@/types";

interface ConfigProposalCardProps {
  permission: PendingPermission;
  onRespond: (requestId: string, allowed: boolean, permissionMode?: PermissionMode) => void;
}

export function ConfigProposalCard({ permission, onRespond }: ConfigProposalCardProps) {
  const { domain, action } = permission.configProposal || {};

  const display = useMemo(() => {
    if (domain && action && permission.input) {
      try {
        const parsed = JSON.parse(permission.input);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return formatConfigChange(domain, action, parsed);
        }
      } catch {
        // fall through to raw fallback
      }
      return {
        title: `${action || "Change"} ${(domain || "").replace(/_/g, " ")}`,
        rows: [{ label: "Change", value: permission.input, block: true }],
      };
    }
    return {
      title: "Configuration change",
      rows: [{ label: "Change", value: permission.input || "", block: false }],
    };
  }, [domain, action, permission.input]);

  return (
    <div className="mx-auto max-w-3xl" data-testid="config-proposal-card">
      <div className="rounded-lg border border-blue-500/50 bg-blue-500/10 p-4">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0 space-y-3">
            <div className="text-sm font-medium capitalize">{display.title}</div>
            <div className="space-y-1.5">
              {display.rows.map((row, i) => (
                <div key={i}>
                  <div className="text-[11px] text-muted-foreground">{row.label}</div>
                  {row.block ? (
                    <div className="mt-0.5">
                      <CodeBlock code={row.value} language="text" />
                    </div>
                  ) : (
                    <div className="text-sm">{row.value}</div>
                  )}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={() => onRespond(permission.requestId, true, "allow")}
                className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                data-testid="btn-approve"
              >
                <Check className="h-3 w-3 inline mr-1" />
                Approve
              </button>
              <button
                onClick={() => onRespond(permission.requestId, false, "deny")}
                className="rounded bg-muted px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/80"
              >
                <X className="h-3 w-3 inline mr-1" />
                Reject
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
