"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowClockwise, Bell, Checks, Trash } from "@phosphor-icons/react";
import { FAMILY_LABELS, kindFamily, type KindFamily } from "@/lib/notifications";
import { useNotificationFeed, useNotifications } from "@/components/providers/NotificationsProvider";
import { DesktopAlertBanner, DeviceAlertSettings, GroupedNotifications } from "@/components/notifications/NotificationList";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { Spinner } from "@/components/ui/Spinner";
import { ErrorState } from "@/components/ui/States";

type Tab = "all" | "unread";
const FAMILIES = Object.keys(FAMILY_LABELS) as KindFamily[];

/** Full notification history: All / Unread, kind family filter, infinite scroll. */
export default function NotificationsPage() {
  const { unread, markAllRead, clearRead } = useNotifications();
  const [tab, setTab] = useState<Tab>("all");
  const [family, setFamily] = useState<KindFamily | "any">("any");
  const [busy, setBusy] = useState<"all" | "clear" | null>(null);
  const feed = useNotificationFeed({ unreadOnly: tab === "unread", enabled: true, limit: 50 });
  const sentinel = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(false);

  // The API has no kind filter: filter loaded pages here and keep paging while the sentinel is visible.
  const items = useMemo(() => (family === "any" ? feed.items : feed.items.filter((n) => kindFamily(n.kind) === family)), [feed.items, family]);
  const familiesSeen = useMemo(() => new Set(feed.items.map((n) => kindFamily(n.kind))), [feed.items]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setAtEnd(e.isIntersecting), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const { hasMore, loading, loadingMore, loadMore } = feed;
  useEffect(() => {
    if (atEnd && hasMore && !loading && !loadingMore) void loadMore();
  }, [atEnd, hasMore, loading, loadingMore, loadMore]);

  const run = async (which: "all" | "clear") => {
    setBusy(which);
    await (which === "all" ? markAllRead() : clearRead());
    setBusy(null);
  };

  return (
    <PageContainer>
      <PageHeader
        title="Notifications"
        subtitle={unread ? `${unread} unread` : "You're all caught up"}
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<ArrowClockwise size={18} />} onClick={() => void feed.reload()} aria-label="Refresh">
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <Button variant="outline" size="sm" icon={<Trash size={18} />} loading={busy === "clear"} disabled={busy !== null} onClick={() => void run("clear")} data-testid="page-clear-read">
              Clear read
            </Button>
            <Button size="sm" icon={<Checks size={18} />} loading={busy === "all"} disabled={!unread || busy !== null} onClick={() => void run("all")} data-testid="page-mark-all-read">
              Mark all read
            </Button>
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented<Tab>
              size="sm"
              value={tab}
              onChange={setTab}
              options={[
                { value: "all", label: "All" },
                { value: "unread", label: unread ? `Unread (${unread})` : "Unread" },
              ]}
            />
          </div>
          <div className="scrollbar-thin -mx-4 overflow-x-auto px-4 md:mx-0 md:px-0" role="group" aria-label="Filter by type">
            <div className="flex min-w-max gap-1.5 pb-1">
              {(["any", ...FAMILIES] as const).map((f) => {
                const on = family === f;
                const dim = f !== "any" && !familiesSeen.has(f) && !on;
                return (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setFamily(f)}
                    data-testid={`family-${f}`}
                    className={clsx(
                      "min-h-[36px] rounded-full border px-3 text-sm font-semibold transition-colors",
                      on ? "border-primary bg-primary text-white" : "border-line bg-surface text-fg hover:bg-surface-2",
                      dim && "text-muted",
                    )}
                  >
                    {f === "any" ? "All types" : FAMILY_LABELS[f]}
                  </button>
                );
              })}
            </div>
          </div>

          <Card className="overflow-hidden" data-testid="notification-history">
            <DesktopAlertBanner className="border-b border-line" />
            {feed.loading && !feed.items.length ? (
              <div className="flex justify-center py-16">
                <Spinner />
              </div>
            ) : feed.error && !feed.items.length ? (
              <ErrorState message={feed.error} onRetry={() => void feed.reload()} />
            ) : items.length === 0 && !hasMore ? (
              <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
                <Bell size={40} weight="duotone" className="text-muted" />
                <p className="font-semibold">{tab === "unread" ? "No unread notifications" : "Nothing here yet"}</p>
                <p className="text-sm text-muted">{family !== "any" ? `No ${FAMILY_LABELS[family].toLowerCase()} notifications.` : "New orders, alerts and requests show up here."}</p>
              </div>
            ) : (
              <GroupedNotifications items={items} />
            )}
            <div ref={sentinel} aria-hidden className="h-px" />
            {(loadingMore || (hasMore && items.length > 0)) && (
              <div className="flex justify-center border-t border-line p-3">
                <Button variant="ghost" size="sm" loading={loadingMore} onClick={() => void loadMore()}>
                  Load older
                </Button>
              </div>
            )}
            {!hasMore && feed.items.length > 0 && <p className="border-t border-line py-3 text-center text-xs text-muted">That&apos;s everything.</p>}
          </Card>
        </div>

        <div id="alert-settings" className="scroll-mt-4">
          <DeviceAlertSettings />
        </div>
      </div>
    </PageContainer>
  );
}
