"use client";

import Link from "next/link";
import clsx from "clsx";
import { BellRinging, BellSlash, Desktop, SpeakerHigh, SpeakerSlash, X } from "@phosphor-icons/react";
import type { Notification } from "@/lib/types";
import { groupByDay, isImportant, relativeTime } from "@/lib/notifications";
import { formatDateTime } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { useSession } from "@/components/providers/SessionProvider";
import { useNotifications } from "@/components/providers/NotificationsProvider";
import { NotificationIcon, notificationKind } from "@/components/ui/NotificationIcon";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Toggle } from "@/components/ui/Input";

/** One row: the body opens the notification (mark read + navigate); the dot marks it read. */
export function NotificationItem({ n, now, onOpened }: { n: Notification; now: number; onOpened?: () => void }) {
  const { open, markRead } = useNotifications();
  const important = isImportant(n);
  const outlet = useOutletName(n.outletId);
  return (
    <li
      className={clsx(
        "group relative flex items-stretch border-b border-line last:border-0",
        !n.read && "bg-primary-50/60 dark:bg-primary/10",
        important && !n.read && "before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-primary",
      )}
      data-testid="notification-item"
      data-read={n.read ? "1" : "0"}
      data-kind={n.kind}
    >
      <button
        type="button"
        data-notif-main
        onClick={() => {
          onOpened?.();
          void open(n);
        }}
        className="flex min-w-0 flex-1 gap-3 px-4 py-3 text-left hover:bg-surface-2/70 focus-visible:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
      >
        <NotificationIcon kind={n.kind} />
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-2">
            <span className={clsx("min-w-0 flex-1 text-sm", n.read ? "font-medium text-fg/80" : "font-bold text-fg")}>{n.title}</span>
            {important && (
              <span className="mt-0.5 shrink-0 rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-primary-700 dark:text-primary-200">
                Urgent
              </span>
            )}
          </span>
          {n.body && <span className="mt-0.5 line-clamp-2 block whitespace-pre-line text-sm text-muted">{n.body}</span>}
          <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            <time dateTime={n.createdAt} title={formatDateTime(n.createdAt)}>
              {relativeTime(n.createdAt, now)}
            </time>
            <span aria-hidden>·</span>
            <span>{notificationKind(n.kind).label}</span>
            {outlet && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{outlet}</span>
              </>
            )}
          </span>
        </span>
      </button>
      <div className="flex w-11 shrink-0 items-start justify-center pt-3">
        {n.read ? (
          <span className="mt-2.5 block h-2.5 w-2.5 rounded-full border-2 border-line" title="Read" aria-label="Read" role="img" />
        ) : (
          <button
            type="button"
            onClick={() => void markRead(n.id)}
            title="Mark as read"
            aria-label={`Mark "${n.title}" as read`}
            className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            data-testid="mark-read"
          >
            <span className="block h-2.5 w-2.5 rounded-full bg-primary" />
          </button>
        )}
      </div>
    </li>
  );
}

/** Outlet name when the user works in several outlets (so "Table 4" is unambiguous). */
function useOutletName(outletId: string | null) {
  const { me } = useSession();
  if (!outletId || !me || me.outlets.length < 2) return null;
  return me.outlets.find((o) => o.id === outletId)?.name ?? null;
}

/** Today / Yesterday / Earlier sections. */
export function GroupedNotifications({ items, onOpened }: { items: Notification[]; onOpened?: () => void }) {
  const now = useNow(60_000);
  return (
    <>
      {groupByDay(items).map((g) => (
        <section key={g.label} aria-label={g.label}>
          <h3 className="sticky top-0 z-[1] border-b border-line bg-surface/95 px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider text-muted backdrop-blur">{g.label}</h3>
          <ul>
            {g.items.map((n) => (
              <NotificationItem key={n.id} n={n} now={now} onOpened={onOpened} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** Asks for desktop alerts only after a click (never on page load). */
export function DesktopAlertBanner({ className }: { className?: string }) {
  const { showBanner, enableDesktop, dismissBanner } = useNotifications();
  if (!showBanner) return null;
  return (
    <div className={clsx("flex items-start gap-3 bg-sky-50 px-4 py-3 text-sm dark:bg-sky-500/10", className)} data-testid="desktop-banner">
      <BellRinging size={20} weight="duotone" className="mt-0.5 shrink-0 text-sky-700 dark:text-sky-200" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-fg">Get desktop alerts</p>
        <p className="text-muted">See new orders and urgent events even when CANAVO is in the background.</p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={() => void enableDesktop()}>
            Turn on
          </Button>
          <Button size="sm" variant="ghost" onClick={dismissBanner}>
            Not now
          </Button>
        </div>
      </div>
      <button type="button" aria-label="Dismiss" onClick={dismissBanner} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2">
        <X size={16} />
      </button>
    </div>
  );
}

/** Settings → Notifications: per-device alert switches. */
export function DeviceAlertSettings() {
  const { sound, setSound, desktop, permission, enableDesktop, disableDesktop, testAlert } = useNotifications();
  const { can } = useSession();
  const permissionNote =
    permission === "unsupported"
      ? "This browser doesn't support desktop notifications."
      : permission === "denied"
        ? "Blocked in this browser. Allow notifications for this site in the browser's site settings, then turn this on."
        : "Shows a system notification when CANAVO is in the background.";
  return (
    <Card>
      <CardHeader title="Alerts on this device" subtitle="These settings apply only to this browser. Each tablet, phone or computer has its own." />
      <div className="divide-y divide-line px-5">
        <div className="flex items-start gap-3 py-2">
          {sound ? <SpeakerHigh size={22} className="mt-3 shrink-0 text-secondary" /> : <SpeakerSlash size={22} className="mt-3 shrink-0 text-muted" />}
          <div className="flex-1">
            <Toggle
              checked={sound}
              onChange={setSound}
              label="Alert sounds"
              description="A short chime for new kitchen tickets, ready orders, delivery assignments, waiting tables and UPI payments."
            />
          </div>
        </div>
        <div className="flex items-start gap-3 py-2">
          {desktop ? <Desktop size={22} className="mt-3 shrink-0 text-secondary" /> : <BellSlash size={22} className="mt-3 shrink-0 text-muted" />}
          <div className="flex-1">
            <Toggle
              checked={desktop}
              disabled={permission === "unsupported"}
              onChange={(on) => (on ? void enableDesktop() : disableDesktop())}
              label="Desktop alerts"
              description={permissionNote}
            />
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
        <Button variant="outline" icon={<BellRinging size={18} />} onClick={testAlert} data-testid="test-alert">
          Send a test alert
        </Button>
        {can("settings:outlet") && (
          <Link href="/admin/settings" className="text-sm font-semibold text-primary hover:underline">
            Business-wide channels (SMS, email, push) →
          </Link>
        )}
      </div>
    </Card>
  );
}
