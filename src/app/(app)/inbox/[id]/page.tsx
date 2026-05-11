"use client";

import { AlertCircle, AlertTriangle, ArrowLeft, Info, Loader2, Mail, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { MarkdownRender } from "@/components/markdown-render";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { InboxMessage } from "@/types";

function priorityIcon(priority: string) {
  switch (priority) {
    case "error":
      return <AlertCircle className="h-5 w-5 text-destructive shrink-0" />;
    case "warning":
      return <AlertTriangle className="h-5 w-5 text-yellow-500 shrink-0" />;
    default:
      return <Info className="h-5 w-5 text-blue-500 shrink-0" />;
  }
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

export default function InboxMessagePage() {
  usePageHeader("Inbox");
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [message, setMessage] = useState<InboxMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const fetchMessage = useCallback(async () => {
    const res = await fetch("/api/inbox");
    if (res.ok) {
      const data = await res.json();
      const msg = (data.messages || []).find((m: InboxMessage) => m.id === id);
      setMessage(msg || null);
      if (msg && !msg.read) {
        await fetch(`/api/inbox/${msg.id}`, { method: "PATCH" });
      }
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    fetchMessage();
  }, [fetchMessage]);

  const handleMarkUnread = async () => {
    await fetch(`/api/inbox/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: false }),
    });
    router.push("/inbox");
  };

  const handleDelete = async () => {
    await fetch(`/api/inbox/${id}`, { method: "DELETE" });
    router.push("/inbox");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!message) {
    return (
      <div className="flex-1 p-4">
        <Button variant="ghost" size="sm" onClick={() => router.push("/inbox")}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <p className="text-sm text-muted-foreground mt-8 text-center">Message not found.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => router.push("/inbox")}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={handleMarkUnread}>
            <Mail className="h-4 w-4 mr-1" />
            Mark unread
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="h-4 w-4 mr-1" />
            Delete
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-3">
        {priorityIcon(message.priority)}
        <div>
          <h1 className="text-lg font-semibold">{message.title}</h1>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            {message.jobName && <span>{message.jobName}</span>}
            <span>{formatDate(message.createdAt)}</span>
          </div>
        </div>
      </div>

      <div className="border-t pt-4">
        <MarkdownRender content={message.body} variant="full" />
      </div>

      <Dialog open={confirmDelete} onOpenChange={() => setConfirmDelete(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Message</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">Delete this message? This cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
