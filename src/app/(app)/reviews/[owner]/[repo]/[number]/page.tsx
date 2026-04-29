"use client";

import { use } from "react";
import { PRReviewView } from "@/components/pr-review-view";

export default function PRDetailPage({ params }: { params: Promise<{ owner: string; repo: string; number: string }> }) {
  const { owner, repo, number } = use(params);
  return <PRReviewView owner={owner} repo={repo} number={parseInt(number, 10)} />;
}
