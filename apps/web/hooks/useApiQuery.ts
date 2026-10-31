"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";

export interface QueryState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: React.Dispatch<React.SetStateAction<T | undefined>>;
}

/**
 * Minimal data-fetching hook. `key` identifies the request; pass null to skip.
 * Re-runs when the key changes and ignores responses from stale keys.
 */
export function useApiQuery<T>(key: string | null, fetcher: () => Promise<T>): QueryState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(key !== null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const latestKey = useRef(key);
  latestKey.current = key;

  const run = useCallback(async () => {
    const k = latestKey.current;
    if (k === null) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetcherRef.current();
      if (latestKey.current === k) setData(result);
    } catch (e) {
      if (latestKey.current === k) setError(errorMessage(e));
    } finally {
      if (latestKey.current === k) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (key === null) {
      setLoading(false);
      return;
    }
    void run();
  }, [key, run]);

  return { data, error, loading, reload: run, setData };
}
