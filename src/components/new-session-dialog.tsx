"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DirectoryPicker } from "./directory-picker";
import { FolderOpen, GitBranch, Loader2 } from "lucide-react";

type Tab = "session" | "clone";

interface NewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (cwd: string, name: string) => void;
}

export function NewSessionDialog({ open, onOpenChange, onSubmit }: NewSessionDialogProps) {
  const [tab, setTab] = useState<Tab>("session");
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [browsing, setBrowsing] = useState(false);

  // Clone state
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneDest, setCloneDest] = useState("");
  const [cloneFolderName, setCloneFolderName] = useState("");
  const [cloneBrowsing, setCloneBrowsing] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState("");

  const reset = () => {
    setCwd("");
    setName("");
    setBrowsing(false);
    setCloneUrl("");
    setCloneDest("");
    setCloneFolderName("");
    setCloneBrowsing(false);
    setCloning(false);
    setCloneError("");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cwd.trim()) return;
    onSubmit(cwd.trim(), name.trim());
    reset();
    onOpenChange(false);
  };

  const handleClone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cloneUrl.trim() || !cloneDest.trim()) return;

    setCloning(true);
    setCloneError("");

    try {
      const res = await fetch("/api/git/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: cloneUrl.trim(),
          parentPath: cloneDest.trim(),
          folderName: cloneFolderName.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setCloneError(data.error || "Clone failed");
        return;
      }

      onSubmit(data.path, name.trim());
      reset();
      onOpenChange(false);
    } catch {
      setCloneError("Failed to connect");
    } finally {
      setCloning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent onClose={() => { reset(); onOpenChange(false); }}>
        <DialogHeader>
          <DialogTitle>New Session</DialogTitle>
        </DialogHeader>

        <div className="flex gap-1 border-b mt-2">
          <button
            type="button"
            onClick={() => setTab("session")}
            className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
              tab === "session" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Open Directory
          </button>
          <button
            type="button"
            onClick={() => setTab("clone")}
            className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
              tab === "clone" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <GitBranch className="h-3.5 w-3.5" />
            Clone Repo
          </button>
        </div>

        {tab === "session" && (
          <form onSubmit={handleSubmit} className="space-y-4 mt-2">
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
        )}

        {tab === "clone" && (
          <form onSubmit={handleClone} className="space-y-4 mt-2">
            <div>
              <label className="text-sm font-medium">Repository URL</label>
              <Input
                value={cloneUrl}
                onChange={(e) => setCloneUrl(e.target.value)}
                placeholder="https://github.com/user/repo.git"
                required
              />
            </div>
            <div>
              <label className="text-sm font-medium">Clone Into</label>
              <div className="flex gap-2">
                <Input
                  value={cloneDest}
                  onChange={(e) => setCloneDest(e.target.value)}
                  placeholder="/home/user/projects"
                  required
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setCloneBrowsing(!cloneBrowsing)}
                  title="Browse directories"
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {cloneBrowsing && (
              <DirectoryPicker
                onSelect={(path) => {
                  setCloneDest(path);
                  setCloneBrowsing(false);
                }}
                onCancel={() => setCloneBrowsing(false)}
              />
            )}
            <div>
              <label className="text-sm font-medium">Folder Name (optional)</label>
              <Input
                value={cloneFolderName}
                onChange={(e) => setCloneFolderName(e.target.value)}
                placeholder="Defaults to repository name"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Session Name (optional)</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Project"
              />
            </div>
            {cloneError && (
              <p className="text-sm text-destructive">{cloneError}</p>
            )}
            <Button type="submit" className="w-full" disabled={!cloneUrl.trim() || !cloneDest.trim() || cloning}>
              {cloning ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Cloning...
                </>
              ) : (
                "Clone & Create Session"
              )}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
