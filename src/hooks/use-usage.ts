"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageLimits } from "@/types";

interface UseUsageResult {
  usage: UsageLimits | null;
  loading: boolean;
  error: string | null;
  refresh: (force?: boolean) => void;
}

const POLL_INTERVAL = 5 * 60 * 1000;
const MIN_FETCH_INTERVAL = 30 * 1000;

let cachedUsage: UsageLimits | null = null;
let lastFetchTime = 0;
let inflightRequest: Promise<UsageLimits | null> | null = null;

async function fetchUsage(force = false): Promise<UsageLimits | null> {
  const now = Date.now();
  if (!force && cachedUsage && now - lastFetchTime < MIN_FETCH_INTERVAL) {
    return cachedUsage;
  }

  if (inflightRequest) {
    return inflightRequest;
  }

  inflightRequest = (async () => {
    try {
      const res = await fetch("/api/usage");
      if (!res.ok) return null;
      const data = await res.json();
      cachedUsage = data;
      lastFetchTime = Date.now();
      return data as UsageLimits;
    } catch {
      return null;
    } finally {
      inflightRequest = null;
    }
  })();

  return inflightRequest;
}

export function useUsage(): UseUsageResult {
  const [usage, setUsage] = useState<UsageLimits | null>(cachedUsage);
  const [loading, setLoading] = useState(cachedUsage === null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (force = false) => {
    if (force) setLoading(true);
    const data = await fetchUsage(force);
    if (!mountedRef.current) return;
    if (data) {
      setUsage(data);
      setError(null);
    } else if (!cachedUsage) {
      setError("Failed to load usage data");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  return { usage, loading, error, refresh };
}
