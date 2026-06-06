"use client";

import { Check, X } from "lucide-react";
import { useMemo } from "react";
import type { PendingPermission } from "@/hooks/use-session";
import type { PermissionMode } from "@/types";

interface ConfigProposalCardProps {
  permission: PendingPermission;
  onRespond: (requestId: string, allowed: boolean, permissionMode?: PermissionMode) => void;
}

export function ConfigProposalCard({ permission, onRespond }: ConfigProposalCardProps) {
  const { domain, action } = permission.configProposal || {};
  const title = domain && action ? `${action} ${domain.replace(/_/g, " ")}` : "Configuration change";

  const formattedInput = useMemo(() => {
    if (!permission.input) return "";
    try {
      const parsed = JSON.parse(permission.input);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return permission.input;
    }
  }, [permission.input]);

  return (
    <div className="mx-auto max-w-3xl" data-testid="config-proposal-card">
      <div className="rounded-lg border border-blue-500/50 bg-blue-500/10 p-4">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0 space-y-2">
            <div className="text-sm font-medium capitalize">{title}</div>
            <pre className="overflow-x-auto rounded bg-black/10 dark:bg-white/5 p-2 text-[11px] leading-relaxed max-h-48 overflow-y-auto">
              {formattedInput}
            </pre>
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
