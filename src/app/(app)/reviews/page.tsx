"use client";

import { Building2, Globe, Loader2, Lock, RefreshCw, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SELECTED_ORG_KEY = "cockpit_review_org";

interface Repo {
  name: string;
  nameWithOwner: string;
  description: string | null;
  primaryLanguage: { name: string } | null;
  pushedAt: string;
  isPrivate: boolean;
}

// Module-level caches so data survives navigation
let cachedOrgs: string[] | null = null;
const repoCache = new Map<string, Repo[]>();

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
  const [orgs, setOrgs] = useState<string[]>(cachedOrgs || []);
  const [orgsLoading, setOrgsLoading] = useState(!cachedOrgs);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [selectedOrg, setSelectedOrg] = useState<string | null>(() => {
    if (cachedOrgs) {
      const stored = localStorage.getItem(SELECTED_ORG_KEY);
      if (stored && cachedOrgs.includes(stored)) return stored;
      if (cachedOrgs.length > 0) return cachedOrgs[0];
    }
    return null;
  });
  const [repos, setRepos] = useState<Repo[]>(() => {
    if (selectedOrg) return repoCache.get(selectedOrg) || [];
    return [];
  });
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Fetch orgs on mount (skip if cached)
  useEffect(() => {
    if (cachedOrgs) return;
    fetch("/api/github/orgs")
      .then((res) => {
        if (!res.ok) return res.json().then((d) => Promise.reject(d.error));
        return res.json();
      })
      .then((data: string[]) => {
        cachedOrgs = data;
        setOrgs(data);
        const stored = localStorage.getItem(SELECTED_ORG_KEY);
        if (stored && data.includes(stored)) {
          setSelectedOrg(stored);
        } else if (data.length > 0) {
          setSelectedOrg(data[0]);
        }
      })
      .catch((err) => setOrgsError(String(err)))
      .finally(() => setOrgsLoading(false));
  }, []);

  const fetchRepos = useCallback((org: string) => {
    // Use cache if available
    const cached = repoCache.get(org);
    if (cached) {
      setRepos(cached);
      return;
    }
    setReposLoading(true);
    setReposError(null);
    fetch(`/api/github/repos?owner=${encodeURIComponent(org)}`)
      .then((res) => {
        if (!res.ok) return res.json().then((d) => Promise.reject(d.error));
        return res.json();
      })
      .then((data: Repo[]) => {
        repoCache.set(org, data);
        setRepos(data);
      })
      .catch((err) => setReposError(String(err)))
      .finally(() => setReposLoading(false));
  }, []);

  const refreshRepos = useCallback(() => {
    if (!selectedOrg) return;
    repoCache.delete(selectedOrg);
    setReposLoading(true);
    setReposError(null);
    fetch(`/api/github/repos?owner=${encodeURIComponent(selectedOrg)}`)
      .then((res) => {
        if (!res.ok) return res.json().then((d) => Promise.reject(d.error));
        return res.json();
      })
      .then((data: Repo[]) => {
        repoCache.set(selectedOrg, data);
        setRepos(data);
      })
      .catch((err) => setReposError(String(err)))
      .finally(() => setReposLoading(false));
  }, [selectedOrg]);

  // Fetch repos when selected org changes
  useEffect(() => {
    if (!selectedOrg) return;
    localStorage.setItem(SELECTED_ORG_KEY, selectedOrg);
    fetchRepos(selectedOrg);
  }, [selectedOrg, fetchRepos]);

  const sorted = [...repos].sort((a, b) => a.name.localeCompare(b.name));
  const filtered = search
    ? sorted.filter(
        (r) => r.name.toLowerCase().includes(search.toLowerCase()) || r.description?.toLowerCase().includes(search.toLowerCase()),
      )
    : sorted;

  if (orgsLoading) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (orgsError) {
    return (
      <div className="flex-1 p-4">
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">{orgsError}</div>
      </div>
    );
  }

  if (orgs.length === 0) {
    return (
      <div className="flex-1 p-4">
        <div className="text-center py-12 text-sm text-muted-foreground">
          No organizations found. Make sure you have run{" "}
          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">gh auth refresh -s read:org</code>.
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      {/* Org selector */}
      <div className="flex gap-2 flex-wrap">
        {orgs.map((org) => (
          <button
            key={org}
            onClick={() => setSelectedOrg(org)}
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors",
              selectedOrg === org
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
          >
            <Building2 className="h-3.5 w-3.5" />
            {org}
          </button>
        ))}
      </div>

      {/* Search filter + refresh */}
      <div className="flex gap-2">
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
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 h-9 w-9 text-muted-foreground hover:text-foreground"
          onClick={refreshRepos}
          disabled={reposLoading}
          title="Refresh"
        >
          <RefreshCw className={cn("h-4 w-4", reposLoading && "animate-spin")} />
        </Button>
      </div>

      {reposLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {reposError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">{reposError}</div>
      )}

      {!reposLoading && !reposError && filtered.length === 0 && (
        <div className="text-center py-12 text-sm text-muted-foreground">
          {repos.length === 0 ? "No repositories found." : "No matches."}
        </div>
      )}

      {!reposLoading && filtered.length > 0 && (
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
                <span className="font-medium text-sm truncate">{repo.name}</span>
                {repo.primaryLanguage && <span className="text-xs text-muted-foreground shrink-0">{repo.primaryLanguage.name}</span>}
                <span className="text-xs text-muted-foreground shrink-0 ml-auto">{timeAgo(repo.pushedAt)}</span>
              </div>
              {repo.description && <p className="text-xs text-muted-foreground mt-1 truncate">{repo.description}</p>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
