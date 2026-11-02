"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, X } from "@phosphor-icons/react";
import clsx from "clsx";
import { api, errorMessage } from "@/lib/api";
import type { Notification, NotificationEvent, NotificationPage } from "@/lib/types";
import {
  claimOnce,
  desktopPermission,
  desktopSupported,
  getBannerDismissed,
  getDesktopPref,
  getSoundPref,
  isUrgent,
  playBeep,
  safeLink,
  setBannerDismissed,
  setDesktopPref,
  setSoundPref,
  unlockAudio,
  type DesktopPermission,
} from "@/lib/notifications";
import { NotificationIcon } from "@/components/ui/NotificationIcon";
import { useSocketEvent } from "./SocketProvider";
import { useSession } from "./SessionProvider";
import { useToast } from "./ToastProvider";

/** Changes every feed (bell list, /notifications page) applies to its own copy. */
export type FeedEvent = { type: "refresh" } | { type: "read"; id?: string; all?: boolean } | { type: "cleared" };

/** Anything that can be opened: a stored row, or a live event that has no id yet. */
export type Openable = Pick<Notification, "title" | "kind" | "link" | "outletId" | "createdAt"> & { id?: string; read?: boolean };

interface NotificationsValue {
  unread: number;
  setUnread: (n: number) => void;
  subscribe: (fn: (e: FeedEvent) => void) => () => void;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  clearRead: () => Promise<void>;
  /** Mark read, switch outlet if needed, then navigate to the notification's link. */
  open: (n: Openable) => Promise<void>;
  sound: boolean;
  setSound: (on: boolean) => void;
  /** Desktop alerts wanted on this device (and permitted) */
  desktop: boolean;
  permission: DesktopPermission;
  enableDesktop: () => Promise<boolean>;
  disableDesktop: () => void;
  /** Beep + sample toast (+ desktop alert when allowed) */
  testAlert: () => void;
  /** The small "turn on desktop alerts" banner */
  showBanner: boolean;
  dismissBanner: () => void;
}

const Ctx = createContext<NotificationsValue | null>(null);

interface LiveToast extends NotificationEvent {
  key: number;
  urgent: boolean;
}

const NO_OUTLET = { outletId: null, businessId: null } as const;
let toastKey = 1;

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const { me, outletId, setOutlet } = useSession();
  const [unread, setUnread] = useState(0);
  const [sound, setSoundState] = useState(true);
  const [desktopWanted, setDesktopWanted] = useState(false);
  const [permission, setPermission] = useState<DesktopPermission>("unsupported");
  const [bannerDismissed, setBannerDismissedState] = useState(true);
  const [toasts, setToasts] = useState<LiveToast[]>([]);
  const listeners = useRef(new Set<(e: FeedEvent) => void>());

  // Preferences live in localStorage: read after mount (no SSR mismatch, never prompts).
  useEffect(() => {
    setSoundState(getSoundPref());
    setDesktopWanted(getDesktopPref());
    setPermission(desktopPermission());
    setBannerDismissedState(getBannerDismissed());
  }, []);

  // Audio needs one user gesture before it may play.
  useEffect(() => {
    const unlock = () => unlockAudio();
    document.addEventListener("pointerdown", unlock, true);
    document.addEventListener("keydown", unlock, true);
    return () => {
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
    };
  }, []);

  const emit = useCallback((e: FeedEvent) => listeners.current.forEach((fn) => fn(e)), []);
  const subscribe = useCallback((fn: (e: FeedEvent) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const refreshUnread = useCallback(async () => {
    try {
      const res = await api.get<NotificationPage>("/notifications", { ...NO_OUTLET, query: { limit: 1 } });
      setUnread(res.unread);
    } catch {
      /* offline — keep the last count */
    }
  }, []);

  // Coalesce bursts (e.g. 5 KOTs at once) into one refresh.
  const syncTimer = useRef<number>();
  const scheduleSync = useCallback(
    (refreshFeeds: boolean) => {
      window.clearTimeout(syncTimer.current);
      syncTimer.current = window.setTimeout(() => {
        void refreshUnread();
        if (refreshFeeds) emit({ type: "refresh" });
      }, 250);
    },
    [emit, refreshUnread],
  );
  useEffect(() => () => window.clearTimeout(syncTimer.current), []);

  useEffect(() => {
    if (me) void refreshUnread();
  }, [me, refreshUnread]);

  // Catch up after the tab was in the background or the device was offline.
  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      setPermission(desktopPermission());
      if (document.visibilityState !== "visible" || Date.now() - last < 2000) return;
      last = Date.now();
      scheduleSync(true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [scheduleSync]);

  useSocketEvent("connect", () => scheduleSync(true));

  // ----- actions -----

  const markRead = useCallback(
    async (id: string) => {
      emit({ type: "read", id });
      try {
        const res = await api.post<{ unread: number }>(`/notifications/${id}/read`, undefined, NO_OUTLET);
        setUnread(res.unread);
      } catch (e) {
        toast(errorMessage(e), "error");
        scheduleSync(true);
      }
    },
    [emit, scheduleSync, toast],
  );

  const markAllRead = useCallback(async () => {
    try {
      await api.post("/notifications/read-all", undefined, NO_OUTLET);
      emit({ type: "read", all: true });
      setUnread(0);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }, [emit, toast]);

  const clearRead = useCallback(async () => {
    try {
      const res = await api.del<{ deleted: number }>("/notifications/read", NO_OUTLET);
      emit({ type: "cleared" });
      toast(res.deleted ? `Cleared ${res.deleted} read notification${res.deleted === 1 ? "" : "s"}` : "No read notifications to clear", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }, [emit, toast]);

  /** Live events carry no id: find the stored row by time + title. */
  const findId = useCallback(async (n: Openable): Promise<string | null> => {
    try {
      const res = await api.get<NotificationPage>("/notifications", { ...NO_OUTLET, query: { limit: 30 } });
      const t = new Date(n.createdAt).getTime();
      return res.items.find((x) => new Date(x.createdAt).getTime() === t && x.title === n.title && x.kind === n.kind)?.id ?? null;
    } catch {
      return null;
    }
  }, []);

  const open = useCallback(
    async (n: Openable) => {
      const link = safeLink(n.link) ?? "/notifications";
      if (n.id) {
        if (!n.read) void markRead(n.id);
      } else {
        void findId(n).then((id) => {
          if (id) void markRead(id);
        });
      }
      if (n.outletId && n.outletId !== outletId && me?.outlets.some((o) => o.id === n.outletId)) {
        try {
          await setOutlet(n.outletId);
        } catch (e) {
          toast(errorMessage(e), "error");
          return;
        }
      }
      router.push(link);
    },
    [findId, markRead, me, outletId, router, setOutlet, toast],
  );

  // ----- preferences -----

  const setSound = useCallback((on: boolean) => {
    setSoundPref(on);
    setSoundState(on);
    if (on) {
      unlockAudio();
      playBeep();
    }
  }, []);

  const enableDesktop = useCallback(async () => {
    if (!desktopSupported()) return false;
    let p = window.Notification.permission;
    if (p === "default") {
      try {
        p = await window.Notification.requestPermission();
      } catch {
        p = window.Notification.permission;
      }
    }
    setPermission(p);
    const ok = p === "granted";
    setDesktopPref(ok);
    setDesktopWanted(ok);
    if (ok) {
      setBannerDismissed();
      setBannerDismissedState(true);
    } else if (p === "denied") {
      toast("Desktop alerts are blocked for this site. Allow notifications in your browser's site settings.", "error");
    }
    return ok;
  }, [toast]);

  const disableDesktop = useCallback(() => {
    setDesktopPref(false);
    setDesktopWanted(false);
  }, []);

  const dismissBanner = useCallback(() => {
    setBannerDismissed();
    setBannerDismissedState(true);
  }, []);

  // ----- live alerts -----

  const dismissToast = useCallback((key: number) => setToasts((t) => t.filter((x) => x.key !== key)), []);

  const showDesktop = useCallback(
    (n: NotificationEvent, force = false) => {
      if (!desktopSupported() || window.Notification.permission !== "granted") return;
      if (!force && !claimOnce("desktop", `${n.createdAt}|${n.title}`)) return;
      try {
        const d = new window.Notification(n.title, { body: n.body, tag: `${n.createdAt}|${n.title}`, icon: "/icon.svg", requireInteraction: isUrgent(n) });
        d.onclick = () => {
          window.focus();
          d.close();
          void open(n);
        };
      } catch {
        /* some mobile browsers only allow notifications from a service worker */
      }
    },
    [open],
  );

  const liveAlert = useCallback(
    (n: NotificationEvent) => {
      const urgent = isUrgent(n);
      const key = toastKey++;
      setToasts((t) => [...t.slice(-2), { ...n, key, urgent }]);
      window.setTimeout(() => dismissToast(key), urgent ? 12_000 : 7000);

      const hidden = document.visibilityState === "hidden";
      if (urgent && getSoundPref()) {
        const id = `${n.createdAt}|${n.title}`;
        if (!hidden) {
          claimOnce("sound", id);
          playBeep();
        } else {
          // Let a visible tab claim it first; one hidden tab beeps otherwise.
          window.setTimeout(() => claimOnce("sound", id) && playBeep(), 200);
        }
      }
      if (hidden && getDesktopPref()) showDesktop(n);
    },
    [dismissToast, showDesktop],
  );

  useSocketEvent<NotificationEvent>("notification", (n) => {
    if (!n?.title) return;
    setUnread((u) => u + 1);
    liveAlert(n);
    scheduleSync(true);
  });

  useSocketEvent<{ id?: string; all?: boolean }>("notification:read", (p) => {
    if (p?.all) {
      emit({ type: "read", all: true });
      setUnread(0);
    } else if (p?.id) {
      emit({ type: "read", id: p.id });
      scheduleSync(false);
    }
  });

  const testAlert = useCallback(() => {
    unlockAudio();
    const sample: NotificationEvent = {
      title: "Test alert",
      body: "This is how new orders and urgent events will look and sound on this device.",
      kind: "kot.new",
      link: "/notifications",
      outletId: null,
      createdAt: new Date().toISOString(),
    };
    const key = toastKey++;
    setToasts((t) => [...t.slice(-2), { ...sample, key, urgent: true }]);
    window.setTimeout(() => dismissToast(key), 6000);
    if (getSoundPref()) window.setTimeout(playBeep, 50);
    if (getDesktopPref()) showDesktop(sample, true);
  }, [dismissToast, showDesktop]);

  const value = useMemo<NotificationsValue>(
    () => ({
      unread,
      setUnread,
      subscribe,
      markRead,
      markAllRead,
      clearRead,
      open,
      sound,
      setSound,
      desktop: desktopWanted && permission === "granted",
      permission,
      enableDesktop,
      disableDesktop,
      testAlert,
      showBanner: permission === "default" && !desktopWanted && !bannerDismissed,
      dismissBanner,
    }),
    [unread, subscribe, markRead, markAllRead, clearRead, open, sound, setSound, desktopWanted, permission, enableDesktop, disableDesktop, testAlert, bannerDismissed, dismissBanner],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-2 top-[72px] z-[70] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-4 sm:w-[380px] print:hidden"
        aria-live="polite"
        aria-relevant="additions"
        data-testid="notification-toasts"
      >
        {toasts.map((t) => (
          <div
            key={t.key}
            role="status"
            data-testid="notification-toast"
            className={clsx(
              "pointer-events-auto flex animate-slide-in-right gap-3 rounded-2xl border bg-surface p-3 shadow-xl",
              t.urgent ? "border-primary/50 ring-1 ring-primary/30" : "border-line",
            )}
          >
            <NotificationIcon kind={t.kind} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-fg">{t.title}</p>
              {t.body && <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-sm text-muted">{t.body}</p>}
              <button
                type="button"
                onClick={() => {
                  dismissToast(t.key);
                  void open(t);
                }}
                className="mt-2 inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-fg hover:bg-primary-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                Open <ArrowRight size={14} weight="bold" />
              </button>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismissToast(t.key)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useNotifications(): NotificationsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNotifications must be used inside NotificationsProvider");
  return v;
}

/**
 * A paginated list of my notifications that stays in sync with live events,
 * read receipts from other tabs/devices and local actions. Loads lazily while
 * `enabled` (the bell only fetches when opened).
 */
export function useNotificationFeed({ unreadOnly, enabled, limit = 30 }: { unreadOnly: boolean; enabled: boolean; limit?: number }) {
  const { subscribe, setUnread } = useNotifications();
  const [feed, setFeed] = useState<{ items: Notification[]; hasMore: boolean; nextBefore: string | null }>({ items: [], hasMore: false, nextBefore: null });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);
  const stale = useRef(true);

  const fetchPage = useCallback(
    (before?: string) =>
      api.get<NotificationPage>("/notifications", { ...NO_OUTLET, query: { unread: unreadOnly ? 1 : undefined, before, limit } }),
    [limit, unreadOnly],
  );

  /** Reload the newest page; a soft reload keeps older pages already scrolled into view. */
  const reload = useCallback(
    async (reset: boolean) => {
      const id = ++req.current;
      stale.current = false;
      if (reset) setLoading(true);
      try {
        const res = await fetchPage();
        if (id !== req.current) return;
        setUnread(res.unread);
        setError(null);
        setLoaded(true);
        setFeed((old) => {
          if (reset || !res.hasMore) return { items: res.items, hasMore: res.hasMore, nextBefore: res.nextBefore };
          const ids = new Set(res.items.map((x) => x.id));
          const oldest = res.items[res.items.length - 1]?.createdAt ?? "";
          const tail = old.items.filter((x) => !ids.has(x.id) && x.createdAt < oldest);
          return tail.length ? { items: [...res.items, ...tail], hasMore: old.hasMore, nextBefore: old.nextBefore } : { items: res.items, hasMore: true, nextBefore: res.nextBefore };
        });
      } catch (e) {
        if (id === req.current) setError(errorMessage(e));
      } finally {
        if (id === req.current) setLoading(false);
      }
    },
    [fetchPage, setUnread],
  );

  const loadMore = useCallback(async () => {
    if (!feed.nextBefore || loadingMore) return;
    setLoadingMore(true);
    const id = req.current;
    try {
      const res = await fetchPage(feed.nextBefore);
      if (id !== req.current) return;
      setFeed((old) => {
        const ids = new Set(old.items.map((x) => x.id));
        return { items: [...old.items, ...res.items.filter((x) => !ids.has(x.id))], hasMore: res.hasMore, nextBefore: res.nextBefore };
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, loadingMore, feed.nextBefore]);

  // Full reload when the filter changes or the list (re)opens with stale data.
  useEffect(() => {
    stale.current = true;
  }, [unreadOnly]);
  useEffect(() => {
    if (enabled && stale.current) void reload(true);
  }, [enabled, reload]);

  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === "read") {
          setFeed((f) => ({ ...f, items: f.items.map((n) => (e.all || n.id === e.id ? { ...n, read: true } : n)) }));
        } else if (e.type === "cleared") {
          setFeed((f) => ({ ...f, items: f.items.filter((n) => !n.read) }));
        } else if (enabled) {
          void reload(false);
        } else {
          stale.current = true;
        }
      }),
    [enabled, reload, subscribe],
  );

  return { items: feed.items, hasMore: feed.hasMore, loading, loadingMore, loaded, error, loadMore, reload: () => reload(true) };
}
