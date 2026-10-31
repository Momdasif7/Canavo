"use client";

import { useEffect, useState } from "react";
import type { OrderCreateInput } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { PromotionPreview } from "@/lib/types-service";
import { useDebouncedValue } from "./useDebounced";

/**
 * Debounced POST /customers/preview-promotions for a cart.
 * `key` is `JSON.stringify({ settings, body })` (null = nothing to preview).
 * Results are tagged with the key they were computed for, so callers can tell
 * fresh answers from stale ones.
 */
export function usePromotionPreview(key: string | null, online: boolean, delay = 350) {
  const debounced = useDebouncedValue(key, delay);
  const [result, setResult] = useState<{ key: string; data: PromotionPreview } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!debounced || !online) return;
    const ctrl = new AbortController();
    setLoading(true);
    api
      .post<PromotionPreview>("/customers/preview-promotions", (JSON.parse(debounced) as { body: OrderCreateInput }).body, { signal: ctrl.signal })
      .then((data) => {
        setResult({ key: debounced, data });
        setError(null);
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError({ key: debounced, message: errorMessage(e) });
      })
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [debounced, online]);

  return { result, error, pending: !!key && (loading || debounced !== key) };
}
