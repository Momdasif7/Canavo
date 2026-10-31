import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, endpoints, errorMessage } from "../lib/api";
import type { ActiveOffer, CustomerLookupResult, FreeItemSuggestion, PromotionPreview } from "../lib/types";
import { isIndianMobile, toOrderInput, type CartState } from "./cart";

const PREVIEW_DEBOUNCE_MS = 450;
const LOOKUP_DEBOUNCE_MS = 300;
const OFFERS_REFRESH_MS = 5 * 60_000;

/**
 * Live server pricing (offers, coupon, points, delivery/packaging charges) for
 * the cart via POST /customers/preview-promotions, debounced. Returns null
 * while offline or when the server can't be reached — callers fall back to the
 * local computeBill.
 *
 * - Coupon / points / delivery problems come back in `preview.warnings` (the
 *   server keeps the totals valid); `error` is only for real failures.
 * - `suggestions` are the Buy-X-Get-Y free items for the cart WITHOUT its
 *   auto-added free lines, i.e. the total each offer should have in the cart
 *   (see ./freeItems). `fresh` says they match the current cart, so the caller
 *   may sync free lines without acting on a stale answer.
 */
export function usePromotionPreview(state: CartState, online: boolean, settingsKey = "") {
  const [preview, setPreview] = useState<PromotionPreview | null>(null);
  const [suggestions, setSuggestions] = useState<FreeItemSuggestion[]>([]);
  const [resultKey, setResultKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const lastSettings = useRef(settingsKey);

  const { body, baseBody } = useMemo(() => {
    if (!state.lines.length) return { body: null, baseBody: null };
    const hasFree = state.lines.some((l) => l.free);
    const full = toOrderInput(state, { preview: true });
    const base = hasFree ? toOrderInput(state, { preview: true, withoutFree: true }) : null;
    return { body: full, baseBody: base && base.items.length ? base : null };
  }, [state]);
  // Outlet tax settings are part of the key so switching GST off re-prices an open cart.
  const key = body ? `${settingsKey}|${JSON.stringify(body)}` : "";

  useEffect(() => {
    const id = ++seq.current;
    if (!body || !online) {
      setPreview(null);
      setSuggestions([]);
      setResultKey("");
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    // Totals priced under different outlet settings (e.g. before GST was switched off) must not linger.
    if (lastSettings.current !== settingsKey) setPreview(null);
    lastSettings.current = settingsKey;
    const onlyFree = state.lines.every((l) => l.free);
    const timer = setTimeout(async () => {
      try {
        const [res, base] = await Promise.all([
          endpoints.previewPromotions(body),
          baseBody ? endpoints.previewPromotions(baseBody) : Promise.resolve(null),
        ]);
        if (id !== seq.current) return;
        setPreview(res);
        // Only free lines left (the buy items were removed) → nothing qualifies.
        setSuggestions(onlyFree ? [] : (baseBody ? base?.suggestions : res.suggestions) ?? []);
        setResultKey(key);
        setError(null);
      } catch (e) {
        if (id !== seq.current) return;
        setPreview(null);
        setSuggestions([]);
        setResultKey("");
        setError(e instanceof ApiError && e.isNetwork ? null : errorMessage(e));
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `key` captures every field of `body` (and baseBody is derived from the same state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, online]);

  return { preview, error, loading, suggestions, fresh: !!key && resultKey === key, warnings: preview?.warnings ?? [] };
}

/** GET /customers/lookup once a valid 10-digit number is typed. */
export function useCustomerLookup(phone: string, online: boolean, enabled: boolean) {
  const [customer, setCustomer] = useState<CustomerLookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !online || !isIndianMobile(phone)) {
      setCustomer(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const c = await endpoints.customerLookup(phone.trim());
        if (!cancelled) {
          setCustomer(c);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phone, online, enabled]);

  return { customer, loading, error };
}

/** Offers live right now at this outlet, for the POS chips. */
export function useActiveOffers(outletId: string | null, online: boolean) {
  const [offers, setOffers] = useState<ActiveOffer[]>([]);
  const load = useCallback(async () => {
    if (!outletId) return;
    try {
      setOffers((await endpoints.activeOffers()).offers);
    } catch {
      // Offers are informational; keep the last list.
    }
  }, [outletId]);

  useEffect(() => {
    if (!online) return;
    void load();
    const t = setInterval(load, OFFERS_REFRESH_MS);
    return () => clearInterval(t);
  }, [load, online]);

  return offers;
}
