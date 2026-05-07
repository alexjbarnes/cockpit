"use client";

import { ArrowLeft, CircleDot, CircleX, GitMerge, GitPullRequest, Loader2, RefreshCw, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { usePageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Module-level cache: "owner/repo:state" -> PullRequest[]
const prCache = new Map<string, PullRequest[]>();

interface PullRequest {
  number: number;
  title: string;
  author: { login: string };
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  labels: { name: string; color: string }[];
  reviewDecision: string;
  state: string;
}

function reviewBadge(decision: string) {
  switch (decision) {
    case "APPROVED":
      return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-500">Approved</span>;
    case "CHANGES_REQUESTED":
      return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-500">Changes requested</span>;
    case "REVIEW_REQUIRED":
      return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-500">Review required</span>;
    default:
      return null;
  }
}

function stateIcon(state: string) {
  switch (state) {
    case "OPEN":
      return <GitPullRequest className="h-4 w-4 text-green-500 shrink-0" />;
    case "MERGED":
      return <GitMerge className="h-4 w-4 text-purple-500 shrink-0" />;
    case "CLOSED":
      return <CircleX className="h-4 w-4 text-red-500 shrink-0" />;
    default:
      return <CircleDot className="h-4 w-4 text-muted-foreground shrink-0" />;
  }
}

export default function PRListPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { owner, repo } = use(params);
  const fullRepo = `${owner}/${repo}`;
  usePageHeader(fullRepo);

  const router = useRouter();
  const [state, setState] = useState<"open" | "closed">("open");
  const [prs, setPrs] = useState<PullRequest[]>(() => prCache.get(`${fullRepo}:open`) || []);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(!prCache.has(`${fullRepo}:open`));
  const [error, setError] = useState<string | null>(null);

  const fetchPRs = useCallback(
    (force = false) => {
      const key = `${fullRepo}:${state}`;
      if (!force && prCache.has(key)) {
        setPrs(prCache.get(key)!);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      fetch(`/api/github/prs?repo=${encodeURIComponent(fullRepo)}&state=${state}`)
        .then((res) => {
          if (!res.ok) return res.json().then((d) => Promise.reject(d.error));
          return res.json();
        })
        .then((data: PullRequest[]) => {
          prCache.set(key, data);
          setPrs(data);
        })
        .catch((err) => setError(String(err)))
        .finally(() => setLoading(false));
    },
    [fullRepo, state],
  );

  useEffect(() => {
    fetchPRs();
  }, [fetchPRs]);

  const filtered = search ? prs.filter((pr) => pr.title.toLowerCase().includes(search.toLowerCase())) : prs;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8" onClick={() => router.push("/reviews")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex gap-1">
          <Button variant={state === "open" ? "default" : "outline"} size="sm" onClick={() => setState("open")}>
            Open
          </Button>
          <Button variant={state === "closed" ? "default" : "outline"} size="sm" onClick={() => setState("closed")}>
            Closed
          </Button>
        </div>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Filter PRs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 pl-9 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={() => fetchPRs(true)}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-12 text-sm text-muted-foreground">No pull requests found.</div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="space-y-1">
          {filtered.map((pr) => (
            <button
              key={pr.number}
              onClick={() => router.push(`/reviews/${owner}/${repo}/${pr.number}`)}
              className="w-full text-left rounded-md border px-4 py-3 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                {stateIcon(pr.state)}
                <span className="font-medium text-sm truncate flex-1 min-w-0">{pr.title}</span>
                {pr.isDraft && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">Draft</span>
                )}
                {reviewBadge(pr.reviewDecision)}
              </div>
              <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground flex-wrap">
                <span>#{pr.number}</span>
                <span>{pr.author.login}</span>
                <span className="truncate max-w-[200px]">{pr.headRefName}</span>
                <span className="text-green-500 shrink-0">+{pr.additions}</span>
                <span className="text-red-500 shrink-0">-{pr.deletions}</span>
              </div>
              {pr.labels.length > 0 && (
                <div className="flex gap-1 mt-1.5 flex-wrap">
                  {pr.labels.map((label) => (
                    <span
                      key={label.name}
                      className="text-[10px] px-1.5 py-0.5 rounded-full border"
                      style={{ borderColor: `#${label.color}`, color: `#${label.color}` }}
                    >
                      {label.name}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
