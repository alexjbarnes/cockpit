"use client";

import { AlertCircle, AlertTriangle, Check, CheckCheck, Info, Loader2, Mail, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

  const router = useRouter();
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

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

  const handleMarkAllRead = async () => {
    await fetch("/api/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_all_read" }),
    });
    setMessages((prev) => prev.map((m) => ({ ...m, read: true })));
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

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {messages.length > 0 && (
            <>
              {messages.length} message{messages.length !== 1 ? "s" : ""}
              {unreadCount > 0 && ` (${unreadCount} unread)`}
            </>
          )}
        </div>
        {messages.length > 0 && (
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <Button variant="outline" size="sm" onClick={handleMarkAllRead}>
                <CheckCheck className="h-3.5 w-3.5 mr-1" />
                Mark all read
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)}>
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Clear all
            </Button>
          </div>
        )}
      </div>

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
            className={`rounded-lg border bg-card transition-colors cursor-pointer hover:bg-accent/50 ${!msg.read ? "border-l-2 border-l-blue-500" : ""}`}
            role="button"
            onClick={() => router.push(`/inbox/${msg.id}`)}
          >
            <div className="flex items-center gap-3 p-4">
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
