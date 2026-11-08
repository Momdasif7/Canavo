"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Bell, BellRinging, Checks, GearSix, Trash, X } from "@phosphor-icons/react";
import { useNotificationFeed, useNotifications } from "@/components/providers/NotificationsProvider";
import { DesktopAlertBanner, GroupedNotifications } from "@/components/notifications/NotificationList";
import { IconButton } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { Spinner } from "@/components/ui/Spinner";

type Tab = "all" | "unread";

/**
 * Header bell: live unread badge and a dropdown (a full-height sheet on phones)
 * with All / Unread, Today / Yesterday / Earlier groups, click-to-open,
 * per-item read, mark all read, clear read and load more.
 */
export function NotificationBell() {
  const { unread, markAllRead, clearRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("all");
  const [busy, setBusy] = useState<"all" | "clear" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const feed = useNotificationFeed({ unreadOnly: tab === "unread", enabled: open, limit: 20 });

  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /** Arrow keys move between notifications. */
  const onListKey = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const rows = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("[data-notif-main]") ?? []);
    if (!rows.length) return;
    e.preventDefault();
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
    rows[next]?.focus();
  };

  const run = async (which: "all" | "clear") => {
    setBusy(which);
    await (which === "all" ? markAllRead() : clearRead());
    setBusy(null);
  };

  const hasRead = feed.items.some((n) => n.read);
  // "Notifications 4 unread": the badge number appears as a word of the name (axe label-content-name-mismatch).
  const label = `Notifications${unread ? ` ${unread > 99 ? "99+" : unread} unread` : ""}`;

  return (
    <div className="relative" ref={ref}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        data-testid="notification-bell"
        className="relative inline-flex min-h-tap min-w-tap items-center justify-center rounded-xl text-fg transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        {unread > 0 ? <BellRinging size={24} weight={open ? "fill" : "regular"} /> : <Bell size={24} weight={open ? "fill" : "regular"} />}
        {unread > 0 && (
          <span
            className="absolute right-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-fg ring-2 ring-surface"
            data-testid="notification-badge"
            aria-hidden
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Notifications"
          tabIndex={-1}
          onKeyDown={onListKey}
          data-testid="notification-panel"
          className={clsx(
            "z-50 flex animate-fade-in flex-col overflow-hidden bg-surface focus:outline-none",
            // Phones: full-height sheet. Larger screens: anchored dropdown.
            "fixed inset-0 sm:absolute sm:inset-auto sm:right-0 sm:mt-2 sm:max-h-[min(640px,calc(100vh-88px))] sm:w-[420px] sm:rounded-2xl sm:border sm:border-line sm:shadow-xl",
          )}
        >
          <div className="flex items-center gap-2 border-b border-line px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <h2 className="flex-1 text-base font-bold">
              Notifications
              {unread > 0 && <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-bold text-primary-700 dark:text-primary-200">{unread} new</span>}
            </h2>
            <Link href="/notifications#alert-settings" onClick={() => close()} aria-label="Alert settings" title="Alert settings" className="flex h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg">
              <GearSix size={20} />
            </Link>
            <IconButton label="Close notifications" className="sm:hidden" onClick={() => close(true)}>
              <X size={22} />
            </IconButton>
          </div>

          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
            <Segmented<Tab>
              size="sm"
              value={tab}
              onChange={setTab}
              options={[
                { value: "all", label: "All" },
                { value: "unread", label: unread ? `Unread (${unread > 99 ? "99+" : unread})` : "Unread" },
              ]}
            />
            <button
              type="button"
              onClick={() => void run("all")}
              disabled={!unread || busy !== null}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2 text-sm font-semibold text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent"
              data-testid="mark-all-read"
            >
              {busy === "all" ? <Spinner className="h-4 w-4" /> : <Checks size={18} />} Mark all read
            </button>
          </div>

          <DesktopAlertBanner className="border-b border-line" />

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain sm:min-h-[200px]" aria-busy={feed.loading}>
            {feed.loading && !feed.items.length ? (
              <div className="flex justify-center py-12">
                <Spinner className="h-6 w-6" />
              </div>
            ) : feed.error && !feed.items.length ? (
              <div className="px-4 py-10 text-center text-sm">
                <p className="text-muted">{feed.error}</p>
                <button type="button" onClick={() => void feed.reload()} className="mt-2 font-semibold text-primary hover:underline">
                  Try again
                </button>
              </div>
            ) : feed.items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
                <Bell size={36} weight="duotone" className="text-muted" />
                <p className="font-semibold">{tab === "unread" ? "No unread notifications" : "You're all caught up"}</p>
                <p className="text-sm text-muted">New orders, alerts and requests show up here.</p>
              </div>
            ) : (
              <>
                <GroupedNotifications items={feed.items} onOpened={() => close()} />
                {feed.hasMore && (
                  <div className="p-3">
                    <button
                      type="button"
                      onClick={() => void feed.loadMore()}
                      disabled={feed.loadingMore}
                      className="flex min-h-[40px] w-full items-center justify-center gap-2 rounded-xl border border-line text-sm font-semibold hover:bg-surface-2"
                    >
                      {feed.loadingMore && <Spinner className="h-4 w-4" />} Load more
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            <button
              type="button"
              onClick={() => void run("clear")}
              disabled={busy !== null || (feed.loaded && !hasRead && tab === "all")}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-muted hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="clear-read"
            >
              {busy === "clear" ? <Spinner className="h-4 w-4" /> : <Trash size={18} />} Clear read
            </button>
            <Link
              href="/notifications"
              onClick={() => close()}
              className="inline-flex min-h-[40px] items-center rounded-lg px-3 text-sm font-semibold text-primary hover:bg-primary/10"
              data-testid="view-all"
            >
              View all
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
