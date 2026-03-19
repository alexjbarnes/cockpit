"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { usePageHeader } from "@/components/app-shell";
import { Loader2, Search, Lock, Globe } from "lucide-react";

const OWNER_KEY = "aperture_review_owner";

interface Repo {
  name: string;
  nameWithOwner: string;
  description: string | null;
  primaryLanguage: { name: string } | null;
  pushedAt: string;
  isPrivate: boolean;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export default function ReviewsPage() {
  usePageHeader("Reviews");

  const router = useRouter();
  const [owner, setOwner] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const stored = localStorage.getItem(OWNER_KEY);
    if (stored) setOwner(stored);
  }, []);

  const fetchRepos = useCallback((ownerValue: string) => {
    setLoading(true);
    setError(null);
    const params = ownerValue ? `?owner=${encodeURIComponent(ownerValue)}` : "";
    fetch(`/api/github/repos${params}`)
      .then((res) => {
        if (!res.ok) return res.json().then((d) => Promise.reject(d.error));
        return res.json();
      })
      .then((data: Repo[]) => setRepos(data))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      localStorage.setItem(OWNER_KEY, owner);
      fetchRepos(owner);
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [owner, fetchRepos]);

  const filtered = search
    ? repos.filter((r) =>
        r.name.toLowerCase().includes(search.toLowerCase()) ||
        r.description?.toLowerCase().includes(search.toLowerCase()),
      )
    : repos;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Organization or username"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 pl-9 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Filter repos..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 pl-9 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-12 text-sm text-muted-foreground">
          {repos.length === 0 ? "No repositories found." : "No matches."}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="space-y-1">
          {filtered.map((repo) => (
            <button
              key={repo.nameWithOwner}
              onClick={() => router.push(`/reviews/${repo.nameWithOwner}`)}
              className="w-full text-left rounded-md border px-4 py-3 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                {repo.isPrivate ? (
                  <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                ) : (
                  <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
                <span className="font-medium text-sm truncate">{repo.nameWithOwner}</span>
                {repo.primaryLanguage && (
                  <span className="text-xs text-muted-foreground shrink-0">{repo.primaryLanguage.name}</span>
                )}
                <span className="text-xs text-muted-foreground shrink-0 ml-auto">{timeAgo(repo.pushedAt)}</span>
              </div>
              {repo.description && (
                <p className="text-xs text-muted-foreground mt-1 truncate">{repo.description}</p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
