"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DirectoryPicker } from "./directory-picker";
import { FolderOpen } from "lucide-react";

interface NewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (cwd: string, name: string) => void;
}

export function NewSessionDialog({ open, onOpenChange, onSubmit }: NewSessionDialogProps) {
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [browsing, setBrowsing] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cwd.trim()) return;
    onSubmit(cwd.trim(), name.trim());
    setCwd("");
    setName("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)}>
        <DialogHeader>
          <DialogTitle>New Session</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
          <div>
            <label className="text-sm font-medium">Working Directory</label>
            <div className="flex gap-2">
              <Input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/home/user/project"
                required
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setBrowsing(!browsing)}
                title="Browse directories"
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {browsing && (
            <DirectoryPicker
              onSelect={(path) => {
                setCwd(path);
                setBrowsing(false);
              }}
              onCancel={() => setBrowsing(false)}
            />
          )}
          <div>
            <label className="text-sm font-medium">Name (optional)</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
            />
          </div>
          <Button type="submit" className="w-full" disabled={!cwd.trim()}>
            Create Session
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
