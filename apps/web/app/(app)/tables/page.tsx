"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowClockwise, CalendarBlank, PencilRuler } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import type { FloorResponse, FloorTable } from "@/lib/types-service";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useNow } from "@/hooks/useNow";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { FloorCanvas } from "@/components/tables/FloorCanvas";
import { FloorEditor } from "@/components/tables/FloorEditor";
import { OpenTabDialog } from "@/components/tables/OpenTabDialog";
import { TabPanel } from "@/components/tables/TabPanel";
import { STATUS_META, visualStatus } from "@/components/tables/common";

const AREA_KEY = "canavo.tablesArea";

export default function TablesPage() {
  const { outletId, can } = useSession();
  const floor = useApiQuery<FloorResponse>(outletId ? `floor:${outletId}` : null, () => api.get<FloorResponse>("/tables/floor"));
  const now = useNow(30_000);
  const [areaId, setAreaId] = useState<string | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [opening, setOpening] = useState<FloorTable | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const canManage = can("table:manage");
  const canServe = can("table:serve");

  // Debounced reload on live updates (several events can arrive per action).
  const timer = useRef<number | null>(null);
  const { reload } = floor;
  const softReload = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void reload(), 250);
  }, [reload]);
  useSocketEvent("table:updated", () => {
    if (!editing) softReload();
  });
  useSocketEvent("reservation:updated", () => !editing && softReload());
  useEffect(() => {
    const id = window.setInterval(() => !editing && void reload(), 60_000);
    return () => window.clearInterval(id);
  }, [reload, editing]);

  // Deep link from reservations: /tables?session=<id>
  useEffect(() => {
    const sid = new URLSearchParams(window.location.search).get("session");
    if (sid) setSessionId(sid);
    try {
      const saved = localStorage.getItem(AREA_KEY);
      if (saved !== null) setAreaId(saved === "" ? null : saved);
    } catch {
      /* ignore */
    }
  }, []);

  const areas = useMemo(() => floor.data?.areas ?? [], [floor.data]);
  const area = areas.find((a) => a.id === areaId) ?? areas[0];
  const allTables = useMemo(() => areas.flatMap((a) => a.tables), [areas]);

  const chooseArea = (id: string | null) => {
    setAreaId(id);
    try {
      localStorage.setItem(AREA_KEY, id ?? "");
    } catch {
      /* ignore */
    }
  };

  const onTable = (t: FloorTable) => {
    if (t.session) setSessionId(t.session.id);
    else if (canServe) setOpening(t);
  };

  const counts = useMemo(() => {
    const c = { AVAILABLE: 0, OCCUPIED: 0, NEEDS_ATTENTION: 0, RESERVED: 0 };
    allTables.forEach((t) => c[visualStatus(t)]++);
    return c;
  }, [allTables]);

  return (
    <PageContainer>
      <PageHeader
        title="Tables"
        subtitle={floor.data ? `${floor.data.stats.occupied} occupied · ${floor.data.stats.available} free · ${floor.data.stats.tables} tables` : undefined}
        actions={
          <>
            <IconButton label="Refresh" onClick={() => void reload()}>
              <ArrowClockwise size={22} />
            </IconButton>
            {canManage && !editing && (
              <Button variant="outline" icon={<PencilRuler size={20} />} onClick={() => setEditing(true)}>
                Edit floor
              </Button>
            )}
          </>
        }
      />

      {floor.loading && !floor.data ? (
        <LoadingState label="Loading floor plan…" />
      ) : floor.error && !floor.data ? (
        <ErrorState message={floor.error} onRetry={reload} />
      ) : !area ? (
        <EmptyState
          title="No tables yet"
          description={canManage ? "Create areas and tables in the floor editor." : "Ask a manager to set up the floor plan."}
          action={
            canManage && (
              <Button icon={<PencilRuler size={20} />} onClick={() => setEditing(true)}>
                Set up floor
              </Button>
            )
          }
        />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-2 overflow-x-auto" role="tablist" aria-label="Areas">
              {areas.map((a) => {
                const busy = a.tables.filter((t) => t.session).length;
                return (
                  <button
                    key={a.id ?? "none"}
                    type="button"
                    role="tab"
                    aria-selected={a.id === area.id}
                    onClick={() => chooseArea(a.id)}
                    className={clsx(
                      "min-h-tap shrink-0 rounded-xl border px-4 text-sm font-bold",
                      a.id === area.id ? "border-primary bg-primary text-white" : "border-line bg-surface hover:border-primary/60",
                    )}
                  >
                    {a.name}
                    <span className={clsx("ml-2 rounded-full px-1.5 text-xs", a.id === area.id ? "bg-white/25" : "bg-surface-2")}>
                      {busy}/{a.tables.length}
                    </span>
                  </button>
                );
              })}
            </div>
            {!editing && (
              <div className="ml-auto flex flex-wrap items-center gap-3 text-xs font-semibold text-muted" aria-label="Legend">
                {(Object.keys(STATUS_META) as (keyof typeof STATUS_META)[]).map((k) => (
                  <span key={k} className="flex items-center gap-1.5">
                    <span className={clsx("h-3 w-3 rounded-full", STATUS_META[k].dot)} /> {STATUS_META[k].label} ({counts[k]})
                  </span>
                ))}
              </div>
            )}
          </div>

          {editing ? (
            <FloorEditor areas={areas} area={area} now={now} onAreaChange={chooseArea} onReload={reload} onDone={() => setEditing(false)} />
          ) : (
            <FloorCanvas tables={area.tables} now={now} onSelect={onTable} />
          )}

          {!editing && floor.data && floor.data.unassignedReservations.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm dark:border-sky-500/30 dark:bg-sky-500/10">
              <CalendarBlank size={18} className="text-sky-700 dark:text-sky-300" />
              <span className="font-semibold">Arriving soon without a table:</span>
              {floor.data.unassignedReservations.map((r) => (
                <Badge key={r.id} tone="info">
                  {formatTime(r.reservedFor)} · {r.customerName} ({r.partySize})
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      <OpenTabDialog
        table={opening}
        onClose={() => setOpening(null)}
        onOpened={(s) => {
          setOpening(null);
          setSessionId(s.id);
          void reload();
        }}
      />
      <TabPanel
        sessionId={sessionId}
        floorTables={allTables}
        onClose={() => {
          setSessionId(null);
          if (window.location.search.includes("session=")) window.history.replaceState(null, "", "/tables");
          void reload();
        }}
        onChanged={softReload}
      />
    </PageContainer>
  );
}
