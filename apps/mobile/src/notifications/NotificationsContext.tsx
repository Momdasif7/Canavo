import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import { useAuth } from "../auth/AuthContext";
import { endpoints, errorMessage } from "../lib/api";
import { useSocketEvent, useSocketReconnect } from "../lib/socket";
import type { AppNotification, NotificationEvent } from "../lib/types";
import { NotificationBanner } from "./NotificationBanner";
import { HOME_ROUTE, isUrgentKind, routeForNotification } from "./links";
import { configureNotificationHandler, ensureAndroidChannels, playAlertSound, registerForPush, type PushResult } from "./push";

export type InboxFilter = "all" | "unread";
const PAGE_SIZE = 30;

/** What a tap needs: the inbox row, or a push / socket payload (no id). */
export type OpenTarget = Pick<AppNotification, "kind" | "title" | "body"> & Partial<Pick<AppNotification, "id" | "link" | "outletId" | "read" | "createdAt">>;

interface NotificationsState {
  items: AppNotification[] | null;
  unread: number;
  error: string | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  filter: InboxFilter;
  push: PushResult | null;
  setFilter: (f: InboxFilter) => void;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  clearRead: () => Promise<number>;
  /** Mark read, switch outlet if needed, and go to the matching screen. */
  open: (n: OpenTarget, opts?: { fallback?: "inbox" | "home" | "stay" }) => Promise<void>;
}

const Ctx = createContext<NotificationsState | null>(null);

configureNotificationHandler();

/**
 * Inbox (GET /notifications, paginated, "unread" filter), per-item / all read,
 * clear read, push registration and tap handling, plus the in-app banner for
 * live `notification` socket events (haptics; sound for urgent kinds).
 */
export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { status, stale, me, outlet, access, switchOutlet } = useAuth();
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilterState] = useState<InboxFilter>("all");
  const [push, setPush] = useState<PushResult | null>(null);
  const [banner, setBanner] = useState<(NotificationEvent & { key: number }) | null>(null);
  const registeredFor = useRef<string | null>(null);
  const pendingTap = useRef<OpenTarget | null>(null);
  const signedIn = status === "signedIn";
  const filterRef = useRef(filter);
  filterRef.current = filter;
  // Latest auth values for async handlers.
  const authRef = useRef({ me, outlet, access, switchOutlet });
  authRef.current = { me, outlet, access, switchOutlet };

  const refresh = useCallback(async () => {
    if (!signedIn) return;
    setLoading(true);
    try {
      const res = await endpoints.notifications({ unread: filterRef.current === "unread", limit: PAGE_SIZE });
      setItems(res.items);
      setUnread(res.unread);
      setHasMore(!!res.hasMore);
      setNextBefore(res.nextBefore ?? null);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [signedIn]);

  const loadMore = useCallback(async () => {
    if (!signedIn || !hasMore || !nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await endpoints.notifications({ unread: filterRef.current === "unread", before: nextBefore, limit: PAGE_SIZE });
      setItems((cur) => {
        const seen = new Set((cur ?? []).map((n) => n.id));
        return [...(cur ?? []), ...res.items.filter((n) => !seen.has(n.id))];
      });
      setUnread(res.unread);
      setHasMore(!!res.hasMore);
      setNextBefore(res.nextBefore ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }, [signedIn, hasMore, nextBefore, loadingMore]);

  const setFilter = useCallback((f: InboxFilter) => {
    setFilterState(f);
    filterRef.current = f;
    setItems(null);
    setHasMore(false);
    setNextBefore(null);
  }, []);
  useEffect(() => {
    if (signedIn) void refresh();
  }, [filter, signedIn, refresh]);

  const applyRead = useCallback((id: string) => {
    setItems((cur) => {
      if (!cur) return cur;
      // In the "Unread" view a read row leaves the list.
      return filterRef.current === "unread" ? cur.filter((n) => n.id !== id) : cur.map((n) => (n.id === id ? { ...n, read: true } : n));
    });
  }, []);

  const markRead = useCallback(
    async (id: string) => {
      const wasUnread = items?.find((n) => n.id === id)?.read === false;
      applyRead(id);
      if (wasUnread) setUnread((u) => Math.max(0, u - 1));
      try {
        const res = await endpoints.readNotification(id);
        if (typeof res?.unread === "number") setUnread(res.unread);
      } catch {
        void refresh();
      }
    },
    [items, applyRead, refresh],
  );

  const markAllRead = useCallback(async () => {
    setUnread(0);
    setItems((cur) => (filterRef.current === "unread" ? [] : cur?.map((n) => ({ ...n, read: true })) ?? cur));
    try {
      await endpoints.readAllNotifications();
    } catch {
      void refresh();
    }
  }, [refresh]);

  const clearRead = useCallback(async () => {
    const res = await endpoints.clearReadNotifications();
    setItems((cur) => cur?.filter((n) => !n.read) ?? cur);
    void refresh();
    return res?.deleted ?? 0;
  }, [refresh]);

  /**
   * Find the inbox row for a push / socket payload (they carry no id): the
   * newest unread row with the same kind, title and body.
   */
  const findRow = useCallback(async (n: OpenTarget): Promise<AppNotification | null> => {
    const match = (list: AppNotification[]) =>
      list.find((x) => !x.read && x.kind === n.kind && x.title === n.title && x.body === n.body) ??
      list.find((x) => x.kind === n.kind && x.title === n.title && x.body === n.body) ??
      null;
    try {
      const res = await endpoints.notifications({ unread: true, limit: 50 });
      return match(res.items);
    } catch {
      return null;
    }
  }, []);

  const open = useCallback(
    async (n: OpenTarget, opts: { fallback?: "inbox" | "home" | "stay" } = {}) => {
      const row = n.id ? n : (await findRow(n)) ?? n;
      if (row.id && row.read !== true) void markRead(row.id);
      const { me: user, outlet: current, access: acc, switchOutlet: sw } = authRef.current;
      // Event from another outlet the user works at → switch first so the screen shows its data.
      const target = row.outletId ?? n.outletId;
      if (target && current?.id !== target && user?.outlets.some((o) => o.id === target)) {
        await sw(target).catch(() => undefined);
      }
      const route = routeForNotification({ link: row.link ?? n.link, kind: row.kind }, acc);
      if (route) router.push(route);
      else if (opts.fallback === "home") router.push(HOME_ROUTE);
      else if (opts.fallback !== "stay") router.push("/notifications");
    },
    [findRow, markRead],
  );

  // Sign-in (online): load the inbox and register for push once per user.
  useEffect(() => {
    if (!signedIn || stale || !me) {
      if (!signedIn) {
        setItems(null);
        setUnread(0);
        setBanner(null);
        registeredFor.current = null;
      }
      return;
    }
    // (The inbox itself loads via the filter effect above.)
    if (registeredFor.current !== me.id) {
      registeredFor.current = me.id;
      void registerForPush().then((r) => {
        setPush(r);
        // Transient failure (e.g. the token upload hit a network error): try again on the next profile refresh.
        if (!r.ok && r.reason === "error") registeredFor.current = null;
      });
    }
  }, [signedIn, stale, me]);

  // Channels exist even when push registration is skipped (local alerts use them).
  useEffect(() => {
    void ensureAndroidChannels().catch(() => undefined);
  }, []);

  // Live: refresh the inbox and show the banner (haptics; sound for urgent kinds).
  // Notifications / read state changed while the socket was down: catch up on reconnect.
  useSocketReconnect(() => {
    if (signedIn && !stale) void refresh();
  });

  useSocketEvent("notification", (n) => {
    void refresh();
    const urgent = isUrgentKind(n.kind);
    setBanner({ ...n, key: Date.now() });
    void Haptics.notificationAsync(urgent ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success);
    if (urgent) void playAlertSound(n.kind, n.title, n.body);
  });
  // Read on another device (or the web console).
  useSocketEvent("notification:read", (p) => {
    if (p?.all) {
      setUnread(0);
      setItems((cur) => (filterRef.current === "unread" ? [] : cur?.map((x) => ({ ...x, read: true })) ?? cur));
    } else if (p?.cleared) {
      setItems((cur) => cur?.filter((x) => !x.read) ?? cur);
    } else if (p?.id && p.read === false) {
      // Marked unread on another device (rt-5): reload instead of marking it read here.
      void refresh();
    } else if (p?.id) {
      const id = p.id;
      setItems((cur) => {
        const was = cur?.find((x) => x.id === id && !x.read);
        if (was) setUnread((u) => Math.max(0, u - 1));
        return cur ? (filterRef.current === "unread" ? cur.filter((x) => x.id !== id) : cur.map((x) => (x.id === id ? { ...x, read: true } : x))) : cur;
      });
    }
  });

  useEffect(() => {
    if (!signedIn) return;
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void refresh();
    });
    return () => sub.remove();
  }, [signedIn, refresh]);

  // Push taps (also the one that launched the app): handled once signed in.
  const handledTaps = useRef(new Set<string>());
  const handleTap = useCallback(
    (resp: Notifications.NotificationResponse) => {
      // The launch response is returned again on every getLastNotificationResponseAsync call.
      const tapId = `${resp.notification.request.identifier}:${resp.actionIdentifier}`;
      if (handledTaps.current.has(tapId)) return;
      handledTaps.current.add(tapId);
      const c = resp.notification.request.content;
      const data = (c.data ?? {}) as { kind?: string; link?: string | null; outletId?: string | null; canavoLocal?: boolean };
      const target: OpenTarget = { kind: data.kind ?? "", title: c.title ?? "", body: c.body ?? "", link: data.link ?? null, outletId: data.outletId ?? null };
      if (status === "signedIn" && me) void open(target, { fallback: "inbox" });
      else pendingTap.current = target;
    },
    [status, me, open],
  );
  const handleTapRef = useRef(handleTap);
  handleTapRef.current = handleTap;

  useEffect(() => {
    if (Platform.OS === "web") return;
    const received = Notifications.addNotificationReceivedListener((n) => {
      if (!(n.request.content.data as { canavoLocal?: boolean } | undefined)?.canavoLocal) void refresh();
    });
    const tapped = Notifications.addNotificationResponseReceivedListener((r) => handleTapRef.current(r));
    // Cold start from a push.
    Notifications.getLastNotificationResponseAsync()
      .then((r) => {
        if (r) handleTapRef.current(r);
      })
      .catch(() => undefined);
    return () => {
      received.remove();
      tapped.remove();
    };
  }, [refresh]);

  useEffect(() => {
    if (status !== "signedIn" || !me || !pendingTap.current) return;
    const target = pendingTap.current;
    pendingTap.current = null;
    // Let the navigator mount first.
    const timer = setTimeout(() => void open(target, { fallback: "inbox" }), 400);
    return () => clearTimeout(timer);
  }, [status, me, open]);

  const value = useMemo(
    () => ({ items, unread, error, loading, loadingMore, hasMore, filter, push, setFilter, refresh, loadMore, markRead, markAllRead, clearRead, open }),
    [items, unread, error, loading, loadingMore, hasMore, filter, push, setFilter, refresh, loadMore, markRead, markAllRead, clearRead, open],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      {signedIn && banner ? (
        <NotificationBanner
          key={banner.key}
          n={banner}
          urgent={isUrgentKind(banner.kind)}
          onPress={() => {
            setBanner(null);
            void open({ kind: banner.kind ?? "", title: banner.title, body: banner.body, link: banner.link, outletId: banner.outletId }, { fallback: "inbox" });
          }}
          onDismiss={() => setBanner(null)}
        />
      ) : null}
    </Ctx.Provider>
  );
}

export function useNotifications(): NotificationsState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNotifications must be used inside <NotificationsProvider>");
  return ctx;
}
