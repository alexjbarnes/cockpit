"use client";

import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCheck,
  Info,
  ListChecks,
  Loader2,
  Mail,
  MailOpen,
  Square,
  SquareCheck,
  SquareMinus,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { cn } from "@/lib/utils";
import type { InboxMessage } from "@/types";

function priorityIcon(priority: string) {
  switch (priority) {
    case "error":
      return <AlertCircle className="h-4 w-4 text-destructive shrink-0" />;
    case "warning":
      return <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />;
    default:
      return <Info className="h-4 w-4 text-blue-500 shrink-0" />;
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function InboxPage() {
  usePageHeader("Inbox", { hideActions: true });
  const scrollRef = useScrollRestoration<HTMLDivElement>("inbox-scroll");

  const router = useRouter();
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // Select mode: tapping a row picks it instead of opening it, and the
  // toolbar acts on everything picked at once.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const fetchMessages = useCallback(async () => {
    const res = await fetch("/api/inbox");
    if (res.ok) {
      const data = await res.json();
      setMessages(data.messages || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  const handleToggleRead = async (e: React.MouseEvent, msg: InboxMessage) => {
    e.stopPropagation();
    const newRead = !msg.read;
    await fetch(`/api/inbox/${msg.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: newRead }),
    });
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, read: newRead } : m)));
  };

  const handleDeleteClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setConfirmDelete(id);
  };

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return;
    await fetch(`/api/inbox/${confirmDelete}`, { method: "DELETE" });
    setMessages((prev) => prev.filter((m) => m.id !== confirmDelete));
    setConfirmDelete(null);
  };

  const handleToggleAllRead = async () => {
    const allRead = unreadCount === 0;
    const targetRead = !allRead;
    await fetch("/api/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_all_read", read: targetRead }),
    });
    setMessages((prev) => prev.map((m) => ({ ...m, read: targetRead })));
  };

  const handleClearConfirm = async () => {
    await fetch("/api/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear" }),
    });
    setMessages([]);
    setConfirmClear(false);
  };

  const unreadCount = messages.filter((m) => !m.read).length;
  const allSelected = messages.length > 0 && selected.size === messages.length;

  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(messages.map((m) => m.id)));

  const postBulk = (body: Record<string, unknown>) =>
    fetch("/api/inbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const handleBulkRead = async (read: boolean) => {
    const ids = new Set(selected);
    const res = await postBulk({ action: "mark_read", ids: [...ids], read });
    if (!res.ok) return;
    setMessages((prev) => prev.map((m) => (ids.has(m.id) ? { ...m, read } : m)));
    stopSelecting();
  };

  const handleBulkDeleteConfirm = async () => {
    const ids = new Set(selected);
    const res = await postBulk({ action: "delete", ids: [...ids] });
    setConfirmBulkDelete(false);
    if (!res.ok) return;
    setMessages((prev) => prev.filter((m) => !ids.has(m.id)));
    stopSelecting();
  };

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      {selecting ? (
        <div
          className="sticky -top-4 z-10 -mx-4 -mt-4 flex flex-wrap items-center gap-2 border-b bg-background px-4 py-3"
          data-testid="inbox-selection-bar"
        >
          <button
            type="button"
            onClick={toggleSelectAll}
            className="mr-auto flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            data-testid="inbox-select-all"
          >
            {allSelected ? (
              <SquareCheck className="h-4 w-4 text-primary" />
            ) : selected.size > 0 ? (
              <SquareMinus className="h-4 w-4 text-primary" />
            ) : (
              <Square className="h-4 w-4" />
            )}
            {selected.size} selected
          </button>
          {/* Beside the count on a phone, last on a wider screen. */}
          <Button variant="ghost" size="sm" onClick={stopSelecting} className="sm:order-last">
            Done
          </Button>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Button variant="outline" size="sm" disabled={selected.size === 0} onClick={() => handleBulkRead(true)}>
              <Check className="h-3.5 w-3.5 mr-1" />
              Mark read
            </Button>
            <Button variant="outline" size="sm" disabled={selected.size === 0} onClick={() => handleBulkRead(false)}>
              <MailOpen className="h-3.5 w-3.5 mr-1" />
              Mark unread
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={selected.size === 0}
              onClick={() => setConfirmBulkDelete(true)}
              className="hover:text-destructive"
              data-testid="inbox-bulk-delete"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Delete
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-muted-foreground">
            {messages.length > 0 && (
              <>
                {messages.length} message{messages.length !== 1 ? "s" : ""}
                {unreadCount > 0 && ` (${unreadCount} unread)`}
              </>
            )}
          </div>
          {messages.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setSelecting(true)} data-testid="inbox-select">
                <ListChecks className="h-3.5 w-3.5 mr-1" />
                Select
              </Button>
              <Button variant="outline" size="sm" onClick={handleToggleAllRead}>
                <CheckCheck className="h-3.5 w-3.5 mr-1" />
                {unreadCount === 0 ? "Mark all unread" : "Mark all read"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)}>
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Clear all
              </Button>
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && messages.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Check className="h-12 w-12 text-muted-foreground/50 mb-4" />
          <p className="text-sm text-muted-foreground">No messages.</p>
          <p className="text-xs text-muted-foreground mt-1">Messages from scheduled jobs will appear here.</p>
        </div>
      )}

      <div className="space-y-2">
        {messages.map((msg) => (
          <div
            key={msg.id}
            data-testid="inbox-row"
            className={cn(
              "rounded-lg border bg-card transition-colors cursor-pointer hover:bg-accent/50",
              !msg.read && "border-l-2 border-l-blue-500",
              selecting && selected.has(msg.id) && "bg-accent/50 ring-1 ring-primary",
            )}
            role="button"
            aria-pressed={selecting ? selected.has(msg.id) : undefined}
            onClick={() => (selecting ? toggleSelected(msg.id) : router.push(`/inbox/${msg.id}`))}
          >
            <div className="flex items-center gap-3 p-4">
              {selecting &&
                (selected.has(msg.id) ? (
                  <SquareCheck className="h-4 w-4 shrink-0 text-primary" />
                ) : (
                  <Square className="h-4 w-4 shrink-0 text-muted-foreground" />
                ))}
              {priorityIcon(msg.priority)}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-sm truncate ${!msg.read ? "font-semibold" : ""}`}>{msg.title}</span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                  {msg.jobName && <span>{msg.jobName}</span>}
                  <span>{timeAgo(msg.createdAt)}</span>
                </div>
              </div>
              {!selecting && (
                <div className="flex items-center shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    title={msg.read ? "Mark as unread" : "Mark as read"}
                    onClick={(e) => handleToggleRead(e, msg)}
                  >
                    {msg.read ? <Mail className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={(e) => handleDeleteClick(e, msg.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Message</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">Delete this message? This cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteConfirm}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmBulkDelete} onOpenChange={() => setConfirmBulkDelete(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Messages</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">
            Delete {selected.size} message{selected.size !== 1 ? "s" : ""}? This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmBulkDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleBulkDeleteConfirm} data-testid="inbox-bulk-delete-confirm">
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmClear} onOpenChange={() => setConfirmClear(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear All Messages</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">Delete all inbox messages? This cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleClearConfirm}>
              Clear All
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
